import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  AgentBusyError,
  CursorAgentError,
  type Run,
  type SDKAgent,
  type SDKCustomTool,
} from "@cursor/sdk";
import { config } from "../config.ts";
import type { AuditLog } from "../audit.ts";
import { findRepo } from "../repos.ts";
import type { CodeRepo, VpsHost } from "../types.ts";
import type { ConfirmBroker, ConfirmEvent } from "../telegram/confirm.ts";
import type { SshPool } from "../ssh/client.ts";
import type { SessionStore } from "../session.ts";
import { buildLocalTools } from "./local-tools.ts";
import { buildVpsTools } from "./tools.ts";

export const LOCAL_AGENT_ID = "local";

const DISALLOWED = [
  "shell",
  "piBash",
  "task",
  "edit",
  "piEdit",
  "piWrite",
  "delete",
  "applyAgentDiff",
  "computerUse",
] as const;

export interface AgentDeps {
  ssh: SshPool;
  confirm: ConfirmBroker;
  audit: AuditLog;
  sessions: SessionStore;
}

interface Active {
  run: Run;
  vpsId: string;
  generation: number;
  startedAt: number;
  prompt: string;
  view: StreamView;
  onUpdate: (view: StreamView) => Promise<void>;
}

export interface AgentTrackStatus {
  busy: boolean;
  inflight: boolean;
  awaitingConfirm: boolean;
  remainSec?: number;
  scope?: string;
  startedAt?: number;
  prompt?: string;
  elapsedSec?: number;
  phase?: StreamView["phase"];
}

const INTERRUPT_SETTLE_MS = 300;

export class AgentManager {
  private handles = new Map<string, SDKAgent>();
  private active = new Map<number, Active>();
  /** 从占用检查到 agent.send 返回前，防止并发消息穿透 isBusy */
  private inflight = new Set<number>();
  /** 新消息会递增；旧 consumeRun 检测到代数落后则主动退出 */
  private generation = new Map<number, number>();
  /** 串行化同一用户的 send，避免并发穿透 */
  private userTail = new Map<number, Promise<void>>();
  private heartbeats = new Map<number, NodeJS.Timeout>();

  constructor(private deps: AgentDeps) {
    this.deps.confirm.subscribe((ev) => this.onConfirmEvent(ev));
  }

  isBusy(userId: number): boolean {
    return this.inflight.has(userId) || this.active.has(userId);
  }

  getTrackStatus(userId: number): AgentTrackStatus {
    const active = this.active.get(userId);
    const busy = this.isBusy(userId);
    const elapsedSec =
      active?.startedAt !== undefined
        ? Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000))
        : undefined;
    return {
      busy,
      inflight: this.inflight.has(userId),
      awaitingConfirm: this.deps.confirm.hasPending(userId),
      remainSec: this.deps.confirm.remainSec(userId),
      scope: active?.vpsId,
      startedAt: active?.startedAt,
      prompt: active?.prompt,
      elapsedSec,
      phase: active?.view.phase,
    };
  }

  private bumpGeneration(userId: number): number {
    const next = (this.generation.get(userId) ?? 0) + 1;
    this.generation.set(userId, next);
    return next;
  }

  private isStale(userId: number, generation: number): boolean {
    return this.generation.get(userId) !== generation;
  }

  private async withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.userTail.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.userTail.set(userId, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private emptySuperseded(): AgentResult {
    return { status: "cancelled", text: "", tools: [], superseded: true };
  }

  /** 有未完成任务时取消 run、重置 Agent，避免并发 error */
  private async interruptIfBusy(userId: number, targetScope: string): Promise<boolean> {
    if (!this.isBusy(userId)) return false;

    const active = this.active.get(userId);
    const scopes = new Set<string>([targetScope]);
    if (active?.vpsId) scopes.add(active.vpsId);

    console.warn(
      `interrupt stale run user=${userId} active=${active?.vpsId ?? "inflight"} -> ${targetScope}`,
    );
    this.deps.confirm.rejectAll(userId, "被新消息打断，这条确认作废");
    this.deps.audit.write({
      userId,
      vpsId: targetScope,
      action: "agent.interrupt",
      detail: active?.vpsId ?? "inflight",
      ok: true,
    });

    await this.cancelRun(userId);
    for (const scope of scopes) {
      this.resetAgentSession(userId, scope);
    }
    await sleep(INTERRUPT_SETTLE_MS);
    return true;
  }

  /** 取消进行中的 run，不递增 generation（供内部 interrupt 使用） */
  private async cancelRun(userId: number): Promise<boolean> {
    const hadInflight = this.inflight.delete(userId);
    const active = this.active.get(userId);
    if (!active) return hadInflight;
    if (active.run.supports("cancel")) {
      await active.run.cancel();
    }
    this.active.delete(userId);
    return true;
  }

  async cancel(userId: number): Promise<boolean> {
    this.bumpGeneration(userId);
    this.deps.confirm.rejectAll(userId, "已取消任务");
    return this.cancelRun(userId);
  }

  async stop(userId: number): Promise<{ cancelled: boolean }> {
    this.bumpGeneration(userId);
    this.deps.confirm.rejectAll(userId, "对话已停止");
    const cancelled = await this.cancelRun(userId);
    const prefix = `${userId}:`;
    for (const [key, agent] of [...this.handles.entries()]) {
      if (!key.startsWith(prefix)) continue;
      try {
        agent.close();
      } catch {
        /* ignore */
      }
      this.handles.delete(key);
    }
    return { cancelled };
  }

  async send(opts: {
    userId: number;
    chatId: number;
    vps: VpsHost;
    text: string;
    onUpdate: (view: StreamView) => Promise<void>;
  }): Promise<AgentResult> {
    if (!config.cursorApiKey) {
      throw new Error("还没配置 CURSOR_API_KEY，列表和添加机器可用，对话运维需要先填这个 key");
    }

    const generation = this.bumpGeneration(opts.userId);
    return this.withUserLock(opts.userId, async () => {
      if (this.isStale(opts.userId, generation)) return this.emptySuperseded();

      const interruptedPrevious = await this.interruptIfBusy(opts.userId, opts.vps.id);
      if (this.isStale(opts.userId, generation)) return this.emptySuperseded();

      this.inflight.add(opts.userId);
      try {
        const getAgent = (forceFresh = false) => this.getAgent(opts, forceFresh);
        const view: StreamView = { tools: [], text: "", thinking: false };
        const lastRepoId = this.deps.sessions.get(opts.userId).lastRepoId;
        const selectedRepo = lastRepoId ? findRepo(lastRepoId) : undefined;
        const prompt = wrapPrompt(opts.vps, opts.text, selectedRepo);
        const tools = buildVpsTools({
          vps: opts.vps,
          userId: opts.userId,
          chatId: opts.chatId,
          ssh: this.deps.ssh,
          confirm: this.deps.confirm,
          audit: this.deps.audit,
          lastRepoId: lastRepoId ?? undefined,
        });

        const run = await this.dispatchWithRetry(
          opts.userId,
          opts.vps.id,
          generation,
          getAgent,
          prompt,
          tools,
        );
        const result = await this.consumeRun(
          opts.userId,
          opts.vps.id,
          opts.text,
          run,
          view,
          opts.onUpdate,
          generation,
        );
        return interruptedPrevious ? { ...result, interruptedPrevious } : result;
      } finally {
        this.inflight.delete(opts.userId);
      }
    });
  }

  async sendLocal(opts: {
    userId: number;
    chatId: number;
    text: string;
    onUpdate: (view: StreamView) => Promise<void>;
  }): Promise<AgentResult> {
    if (!config.cursorApiKey) {
      throw new Error("还没配置 CURSOR_API_KEY");
    }

    const generation = this.bumpGeneration(opts.userId);
    return this.withUserLock(opts.userId, async () => {
      if (this.isStale(opts.userId, generation)) return this.emptySuperseded();

      const interruptedPrevious = await this.interruptIfBusy(opts.userId, LOCAL_AGENT_ID);
      if (this.isStale(opts.userId, generation)) return this.emptySuperseded();

      this.inflight.add(opts.userId);
      try {
        const getAgent = (forceFresh = false) => this.getLocalAgent(opts.userId, forceFresh);
        const view: StreamView = { tools: [], text: "", thinking: false };
        const prompt = wrapLocalPrompt(opts.text);
        const tools = buildLocalTools({ userId: opts.userId, audit: this.deps.audit });
        const run = await this.dispatchWithRetry(
          opts.userId,
          LOCAL_AGENT_ID,
          generation,
          getAgent,
          prompt,
          tools,
        );
        const result = await this.consumeRun(
          opts.userId,
          LOCAL_AGENT_ID,
          opts.text,
          run,
          view,
          opts.onUpdate,
          generation,
        );
        return interruptedPrevious ? { ...result, interruptedPrevious } : result;
      } finally {
        this.inflight.delete(opts.userId);
      }
    });
  }

  private async dispatchWithRetry(
    userId: number,
    scope: string,
    generation: number,
    getAgent: (forceFresh?: boolean) => Promise<SDKAgent>,
    prompt: string,
    tools: Record<string, SDKCustomTool>,
  ): Promise<Run> {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.isStale(userId, generation)) {
        throw new SupersededError();
      }
      const forceFresh = attempt > 0;
      if (forceFresh) {
        this.resetAgentSession(userId, scope);
        await sleep(INTERRUPT_SETTLE_MS + attempt * 200);
      }
      const agent = await getAgent(forceFresh);
      try {
        return await agent.send(prompt, { local: { customTools: tools } });
      } catch (err) {
        if (attempt < maxAttempts - 1 && isAgentBusyError(err)) {
          console.warn(
            `agent busy (attempt ${attempt + 1}), recreate user=${userId} scope=${scope}`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        throw mapAgentError(err);
      }
    }
    throw new Error("Cursor Agent 繁忙，请稍后再试");
  }

  private async consumeRun(
    userId: number,
    scope: string,
    detail: string,
    run: Run,
    view: StreamView,
    onUpdate: (view: StreamView) => Promise<void>,
    generation: number,
  ): Promise<AgentResult> {
    if (this.isStale(userId, generation)) return this.emptySuperseded();

    this.active.set(userId, {
      run,
      vpsId: scope,
      generation,
      startedAt: Date.now(),
      prompt: detail.slice(0, 120),
      view,
      onUpdate,
    });
    this.armHeartbeat(userId, generation);
    this.deps.audit.write({
      userId,
      vpsId: scope,
      action: "agent.send",
      detail: detail.slice(0, 200),
      ok: true,
    });
    try {
      for await (const event of run.stream()) {
        if (this.isStale(userId, generation)) {
          if (run.supports("cancel")) await run.cancel().catch(() => undefined);
          return { ...this.emptySuperseded(), text: view.text, tools: view.tools };
        }
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") view.text += block.text;
          }
          await onUpdate(view);
        } else if (event.type === "tool_call") {
          const label = event.status === "running" ? event.name : `${event.name}:${event.status}`;
          if (event.status === "running") {
            view.tools.push(event.name);
          } else {
            const last = view.tools.length - 1;
            if (last >= 0) view.tools[last] = label;
            else view.tools.push(label);
          }
          if (event.status === "error") {
            view.error = `${event.name} 工具失败`;
          }
          await onUpdate(view);
        } else if (event.type === "thinking") {
          view.thinking = true;
          await onUpdate(view);
        } else if (event.type === "status") {
          if (event.status === "ERROR" || event.status === "EXPIRED") {
            view.error = event.message?.trim() || event.status;
            await onUpdate(view);
          }
        }
      }
      if (this.isStale(userId, generation)) {
        return { ...this.emptySuperseded(), text: view.text, tools: view.tools };
      }
      const result = await run.wait();
      const error =
        result.error?.message?.trim() ||
        view.error ||
        (result.status !== "finished" && result.status !== "cancelled"
          ? `任务 ${result.status}`
          : undefined);
      if (result.status !== "finished") {
        console.error(
          `agent run ${result.status} user=${userId} scope=${scope}`,
          result.error ?? error,
        );
        this.deps.audit.write({
          userId,
          vpsId: scope,
          action: "agent.error",
          detail: detail.slice(0, 200),
          ok: false,
          error: error ?? result.status,
        });
        if (result.status === "error") {
          this.resetAgentSession(userId, scope);
        }
      }
      return { status: result.status, text: view.text, tools: view.tools, error };
    } catch (err) {
      if (err instanceof SupersededError) {
        return this.emptySuperseded();
      }
      console.error(`agent run failed user=${userId} scope=${scope}`, err);
      this.deps.audit.write({
        userId,
        vpsId: scope,
        action: "agent.error",
        detail: detail.slice(0, 200),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw mapAgentError(err);
    } finally {
      const active = this.active.get(userId);
      if (active?.generation === generation) {
        this.active.delete(userId);
      }
      this.disarmHeartbeat(userId);
    }
  }

  async closeAll(): Promise<void> {
    for (const userId of [...this.heartbeats.keys()]) this.disarmHeartbeat(userId);
    for (const agent of this.handles.values()) {
      try {
        agent.close();
      } catch {
        /* ignore */
      }
    }
    this.handles.clear();
  }

  private onConfirmEvent(ev: ConfirmEvent): void {
    const active = this.active.get(ev.userId);
    if (!active) return;
    if (ev.phase === "waiting") {
      active.view.phase = "waiting_confirm";
      active.view.waitingConfirm = ev.summary;
      active.view.remainSec = ev.remainSec;
    } else if (ev.phase === "confirmed") {
      active.view.phase = "executing";
      active.view.waitingConfirm = undefined;
      active.view.remainSec = 0;
    } else {
      active.view.phase = undefined;
      active.view.waitingConfirm = undefined;
      active.view.remainSec = 0;
    }
    void active.onUpdate(active.view);
  }

  private armHeartbeat(userId: number, generation: number): void {
    this.disarmHeartbeat(userId);
    this.heartbeats.set(
      userId,
      setInterval(() => {
        if (this.isStale(userId, generation)) {
          this.disarmHeartbeat(userId);
          return;
        }
        const active = this.active.get(userId);
        if (!active) {
          this.disarmHeartbeat(userId);
          return;
        }
        if (active.view.phase === "waiting_confirm") {
          active.view.remainSec = this.deps.confirm.remainSec(userId);
        }
        void active.onUpdate(active.view);
      }, 2500),
    );
  }

  private disarmHeartbeat(userId: number): void {
    const timer = this.heartbeats.get(userId);
    if (!timer) return;
    clearInterval(timer);
    this.heartbeats.delete(userId);
  }

  private key(userId: number, vpsId: string): string {
    return `${userId}:${vpsId}`;
  }

  /** error 后丢弃缓存的 Agent，下次对话重新 create/resume */
  private resetAgentSession(userId: number, scope: string): void {
    const key = this.key(userId, scope);
    const cached = this.handles.get(key);
    if (cached) {
      try {
        cached.close();
      } catch {
        /* ignore */
      }
      this.handles.delete(key);
    }
    this.deps.sessions.clearAgent(userId, scope);
  }

  private async getAgent(
    opts: {
      userId: number;
      chatId: number;
      vps: VpsHost;
    },
    forceFresh = false,
  ): Promise<SDKAgent> {
    const key = this.key(opts.userId, opts.vps.id);
    if (forceFresh) {
      this.resetAgentSession(opts.userId, opts.vps.id);
    } else {
      const cached = this.handles.get(key);
      if (cached) return cached;
    }

    const cwd = ensureWorkspace(opts.vps);
    const tools = buildVpsTools({
      vps: opts.vps,
      userId: opts.userId,
      chatId: opts.chatId,
      ssh: this.deps.ssh,
      confirm: this.deps.confirm,
      audit: this.deps.audit,
    });
    const local = {
      cwd,
      customTools: tools,
    };
    const common = {
      apiKey: config.cursorApiKey,
      model: { id: config.cursorModel },
      disallowedTools: [...DISALLOWED],
      local,
    };

    const savedId = forceFresh ? undefined : this.deps.sessions.get(opts.userId).agents[opts.vps.id];
    let agent: SDKAgent;
    if (savedId) {
      try {
        agent = await Agent.resume(savedId, common);
      } catch (err) {
        console.warn(`resume ${savedId} 失败，将新建`, err);
        this.deps.sessions.clearAgent(opts.userId, opts.vps.id);
        agent = await Agent.create(common);
      }
    } else {
      agent = await Agent.create(common);
    }

    this.handles.set(key, agent);
    this.deps.sessions.setAgent(opts.userId, opts.vps.id, agent.agentId);
    return agent;
  }

  private async getLocalAgent(userId: number, forceFresh = false): Promise<SDKAgent> {
    const key = this.key(userId, LOCAL_AGENT_ID);
    if (forceFresh) {
      this.resetAgentSession(userId, LOCAL_AGENT_ID);
    } else {
      const cached = this.handles.get(key);
      if (cached) return cached;
    }

    const cwd = ensureLocalWorkspace();
    const tools = buildLocalTools({ userId, audit: this.deps.audit });
    const common = {
      apiKey: config.cursorApiKey,
      model: { id: config.cursorModel },
      disallowedTools: [...DISALLOWED],
      local: { cwd, customTools: tools },
    };
    const savedId = forceFresh ? undefined : this.deps.sessions.get(userId).agents[LOCAL_AGENT_ID];
    let agent: SDKAgent;
    if (savedId) {
      try {
        agent = await Agent.resume(savedId, common);
      } catch (err) {
        console.warn(`resume local ${savedId} 失败，将新建`, err);
        this.deps.sessions.clearAgent(userId, LOCAL_AGENT_ID);
        agent = await Agent.create(common);
      }
    } else {
      agent = await Agent.create(common);
    }
    this.handles.set(key, agent);
    this.deps.sessions.setAgent(userId, LOCAL_AGENT_ID, agent.agentId);
    return agent;
  }
}

export class BusyError extends Error {}

class SupersededError extends Error {
  constructor() {
    super("已被新消息取代");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentBusyError(err: unknown): boolean {
  if (err instanceof AgentBusyError) return true;
  if (err instanceof CursorAgentError && err.code === "agent_busy") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /already has active run/i.test(msg);
}

function mapAgentError(err: unknown): Error {
  if (err instanceof SupersededError || err instanceof BusyError) return err;
  if (isAgentBusyError(err)) {
    return new BusyError("Cursor Agent 正忙，请稍后再试");
  }
  if (err instanceof CursorAgentError) {
    return new Error(`Cursor Agent 失败: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export interface StreamView {
  tools: string[];
  text: string;
  thinking: boolean;
  error?: string;
  phase?: "waiting_confirm" | "executing";
  waitingConfirm?: string;
  remainSec?: number;
}

export interface AgentResult {
  status: string;
  text: string;
  tools: string[];
  error?: string;
  superseded?: boolean;
  interruptedPrevious?: boolean;
}

function wrapPrompt(vps: VpsHost, text: string, repo?: CodeRepo): string {
  return [
    `You are operating remote VPS "${vps.name}" (id=${vps.id}) at ${vps.user}@${vps.host}:${vps.port}.`,
    "The local workspace only contains notes/runbooks. It is NOT the server filesystem.",
    "Application code is written on a local client, then pushed to GitHub (R2 is backup). Do not rewrite app source on this VPS.",
    "R2 name must align with the 便签: one 便签 = one GitHub repo = projects/{便签}/latest.tar.gz. Never invent another R2 key.",
    "Use custom tools only: exec, read_file, write_file, list_dir, service, logs, metrics, verify_repo, deploy_code, backup_to_r2.",
    `Writable: ${vps.writable ? "yes" : "NO, read-only machine"}.`,
    vps.allowedServices ? `Allowed systemd services: ${vps.allowedServices.join(", ")}.` : "",
    vps.notes ? `Notes: ${vps.notes}` : "",
    repo
      ? `The only allowed repo is "${repo.name}" id=${repo.id} url=${repo.githubRepo}. First verify_repo, then deploy_code. Never pull a different repo.`
      : "If asked to deploy, the user must pick an added repo. Call verify_repo then deploy_code with that repoId.",
    "",
    "【对话场景】",
    "- 用户说检查/看看/排查/为什么/网络异常：只读。只用 metrics、logs、read_file、list_dir，以及只读 exec（ps/curl/grep/systemctl status/nginx -t）。禁止 write_file、禁止改 nginx/php、禁止 restart/reload、禁止删除配置。先把结论发给用户，等他们明确说「修复」。",
    "- 用户说修复/改/重启/部署：可以改。危险命令会弹出 Telegram「同意执行」。必须等用户点同意后再执行；点了之后立刻干活并汇报，不要沉默。",
    "- 禁止用 python/heredoc/base64/cat>/tee 绕过 Telegram 确认。改文件用 write_file，改服务用 service。",
    "- 用户点了拒绝：停止该改法，用中文总结并等待，不要立刻换一种等价写入。",
    "- 回复用用户的语言。简洁。命令输出只给摘要。",
    "",
    "User request:",
    text,
  ]
    .filter(Boolean)
    .join("\n");
}

function wrapLocalPrompt(text: string): string {
  return [
    "You are the Telegram ops assistant on the bot host. The user is NOT inside a VPS session.",
    "Talk normally. Help with repos, R2 backup, GitHub, and how to use this bot.",
    "Custom tools: list_vps, list_repos, hub_status, verify_repo, backup_to_r2.",
    "Do not SSH or change remote servers. If they need a machine, tell them to tap 进入VPS.",
    "Application code is edited locally and pushed to GitHub. R2 backup name must align: projects/{便签}/latest.tar.gz. One 便签 = one GitHub repo = one R2 object. Do not invent another name.",
    "Reply in the user's language. Be concise.",
    "",
    "User request:",
    text,
  ].join("\n");
}

function ensureLocalWorkspace(): string {
  const dir = path.join(config.workspacesDir, LOCAL_AGENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      "# 本机对话\n\n未进入 VPS 时，Telegram 消息会走到这里。\n",
    );
  }
  return dir;
}

function ensureWorkspace(vps: VpsHost): string {
  const dir = path.join(config.workspacesDir, vps.id);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "README.md");
  const body = [
    `# ${vps.name} (${vps.id})`,
    "",
    `- Host: \`${vps.user}@${vps.host}:${vps.port}\``,
    `- Writable: ${vps.writable}`,
    vps.tags.length ? `- Tags: ${vps.tags.join(", ")}` : "",
    vps.notes ? `- Notes: ${vps.notes}` : "",
    "",
    "This folder is a local runbook. Remote files live on the VPS; use SSH tools.",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  fs.writeFileSync(readme, body);
  return dir;
}
