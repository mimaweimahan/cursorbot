import fs from "node:fs";
import path from "node:path";
import { Agent, CursorAgentError, type Run, type SDKAgent } from "@cursor/sdk";
import { config } from "../config.ts";
import type { AuditLog } from "../audit.ts";
import { findRepo } from "../repos.ts";
import type { CodeRepo, VpsHost } from "../types.ts";
import type { ConfirmBroker } from "../telegram/confirm.ts";
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
}

export class AgentManager {
  private handles = new Map<string, SDKAgent>();
  private active = new Map<number, Active>();

  constructor(private deps: AgentDeps) {}

  isBusy(userId: number): boolean {
    return this.active.has(userId);
  }

  async cancel(userId: number): Promise<boolean> {
    const active = this.active.get(userId);
    if (!active) return false;
    if (active.run.supports("cancel")) {
      await active.run.cancel();
    }
    this.active.delete(userId);
    return true;
  }

  async stop(userId: number): Promise<{ cancelled: boolean }> {
    const cancelled = await this.cancel(userId);
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
  }): Promise<{ status: string; text: string; tools: string[] }> {
    if (this.isBusy(opts.userId)) {
      throw new BusyError("已有任务在跑，先 /cancel 或等它结束");
    }
    if (!config.cursorApiKey) {
      throw new Error("还没配置 CURSOR_API_KEY，列表和添加机器可用，对话运维需要先填这个 key");
    }

    const agent = await this.getAgent(opts);
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

    const run = await agent.send(prompt, {
      local: { customTools: tools },
    });
    return this.consumeRun(opts.userId, opts.vps.id, opts.text, run, view, opts.onUpdate);
  }

  async sendLocal(opts: {
    userId: number;
    chatId: number;
    text: string;
    onUpdate: (view: StreamView) => Promise<void>;
  }): Promise<{ status: string; text: string; tools: string[] }> {
    if (this.isBusy(opts.userId)) {
      throw new BusyError("已有任务在跑，先 /cancel 或等它结束");
    }
    if (!config.cursorApiKey) {
      throw new Error("还没配置 CURSOR_API_KEY");
    }
    const agent = await this.getLocalAgent(opts.userId);
    const view: StreamView = { tools: [], text: "", thinking: false };
    const prompt = wrapLocalPrompt(opts.text);
    const tools = buildLocalTools({ userId: opts.userId, audit: this.deps.audit });
    const run = await agent.send(prompt, { local: { customTools: tools } });
    return this.consumeRun(opts.userId, LOCAL_AGENT_ID, opts.text, run, view, opts.onUpdate);
  }

  private async consumeRun(
    userId: number,
    scope: string,
    detail: string,
    run: Run,
    view: StreamView,
    onUpdate: (view: StreamView) => Promise<void>,
  ): Promise<{ status: string; text: string; tools: string[] }> {
    this.active.set(userId, { run, vpsId: scope });
    this.deps.audit.write({
      userId,
      vpsId: scope,
      action: "agent.send",
      detail: detail.slice(0, 200),
      ok: true,
    });
    try {
      for await (const event of run.stream()) {
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
          await onUpdate(view);
        } else if (event.type === "thinking") {
          view.thinking = true;
          await onUpdate(view);
        }
      }
      const result = await run.wait();
      return { status: result.status, text: view.text, tools: view.tools };
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(`Cursor Agent 启动失败: ${err.message}`);
      }
      throw err;
    } finally {
      this.active.delete(userId);
    }
  }

  async closeAll(): Promise<void> {
    for (const agent of this.handles.values()) {
      try {
        agent.close();
      } catch {
        /* ignore */
      }
    }
    this.handles.clear();
  }

  private key(userId: number, vpsId: string): string {
    return `${userId}:${vpsId}`;
  }

  private async getAgent(opts: {
    userId: number;
    chatId: number;
    vps: VpsHost;
  }): Promise<SDKAgent> {
    const key = this.key(opts.userId, opts.vps.id);
    const cached = this.handles.get(key);
    if (cached) return cached;

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

    const savedId = this.deps.sessions.get(opts.userId).agents[opts.vps.id];
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

  private async getLocalAgent(userId: number): Promise<SDKAgent> {
    const key = this.key(userId, LOCAL_AGENT_ID);
    const cached = this.handles.get(key);
    if (cached) return cached;

    const cwd = ensureLocalWorkspace();
    const tools = buildLocalTools({ userId, audit: this.deps.audit });
    const common = {
      apiKey: config.cursorApiKey,
      model: { id: config.cursorModel },
      disallowedTools: [...DISALLOWED],
      local: { cwd, customTools: tools },
    };
    const savedId = this.deps.sessions.get(userId).agents[LOCAL_AGENT_ID];
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

export interface StreamView {
  tools: string[];
  text: string;
  thinking: boolean;
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
    "Reply in the same language as the user. Be concise. Show command output summaries, not huge dumps.",
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
