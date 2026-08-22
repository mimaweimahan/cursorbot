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
import { buildVpsTools } from "./tools.ts";

const DISALLOWED = ["shell", "task", "edit", "write", "delete", "applyAgentDiff"] as const;

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
    this.active.set(opts.userId, { run, vpsId: opts.vps.id });
    this.deps.audit.write({
      userId: opts.userId,
      vpsId: opts.vps.id,
      action: "agent.send",
      detail: opts.text.slice(0, 200),
      ok: true,
    });

    try {
      for await (const event of run.stream()) {
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") view.text += block.text;
          }
          await opts.onUpdate(view);
        } else if (event.type === "tool_call") {
          const label = event.status === "running" ? event.name : `${event.name}:${event.status}`;
          if (event.status === "running") {
            view.tools.push(event.name);
          } else {
            const last = view.tools.length - 1;
            if (last >= 0) view.tools[last] = label;
            else view.tools.push(label);
          }
          await opts.onUpdate(view);
        } else if (event.type === "thinking") {
          view.thinking = true;
          await opts.onUpdate(view);
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
      this.active.delete(opts.userId);
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
    "Use custom tools only: exec, read_file, write_file, list_dir, service, logs, metrics, deploy_code, backup_to_r2.",
    `Writable: ${vps.writable ? "yes" : "NO, read-only machine"}.`,
    vps.allowedServices ? `Allowed systemd services: ${vps.allowedServices.join(", ")}.` : "",
    vps.notes ? `Notes: ${vps.notes}` : "",
    repo
      ? `Selected repo: ${repo.name} (${repo.id}) ${repo.githubRepo}@${repo.branch} → ${repo.deployPath} cmd=${repo.deployCmd || "(none)"}. deploy_code must use repoId=${repo.id}.`
      : "If asked to deploy, the user must have added a repo first. Call deploy_code with that repoId.",
    "Reply in the same language as the user. Be concise. Show command output summaries, not huge dumps.",
    "",
    "User request:",
    text,
  ]
    .filter(Boolean)
    .join("\n");
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
