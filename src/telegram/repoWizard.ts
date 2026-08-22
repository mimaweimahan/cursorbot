import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AuditLog } from "../audit.ts";
import { parseRepoSlug } from "../codehub.ts";
import { validateId } from "../inventory.ts";
import { findRepo, loadRepos, removeRepo, repoLine, upsertRepo } from "../repos.ts";
import type { CodeRepo } from "../types.ts";
import { menuReply } from "./menu.ts";

export const REPO_TEMPLATE = [
  "id: app-1",
  "name: 主站",
  "githubRepo: owner/repo",
  "branch: main",
  "deployPath: /var/www/app",
  "deployCmd:",
  "notes:",
].join("\n");

export function looksLikeRepoTemplate(text: string): boolean {
  const fields = extract(stripFence(text));
  return Boolean(fields.id && fields.githubRepo && !fields.host);
}

export class RepoWizard {
  private waiting = new Set<number>();
  private editingId = new Map<number, string>();

  constructor(private audit: AuditLog) {}

  isActive(userId: number): boolean {
    return this.waiting.has(userId);
  }

  cancel(userId: number): boolean {
    const a = this.waiting.delete(userId);
    const b = this.editingId.delete(userId);
    return a || b;
  }

  async start(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    this.waiting.add(ctx.from.id);
    const used = new Set(loadRepos().map((r) => r.id));
    let n = 1;
    while (used.has(`app-${n}`)) n++;
    const template = REPO_TEMPLATE.replace("id: app-1", `id: app-${n}`);
    await ctx.reply(
      [
        "添加 <strong>代码仓库</strong>。本地改完成品再推 GitHub（R2 备份）。",
        "复制模板改完整段发回。取消发 /cancel。",
        "GitHub token / R2 密钥在「代码仓库 → 配置密钥」里配一次即可。",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "rw:cancel"),
      },
    );
    await ctx.reply(`<pre>${escapeHtml(template)}</pre>`, { parse_mode: "HTML" });
  }

  async startEdit(ctx: Context, id: string): Promise<void> {
    if (!ctx.from) return;
    const repo = findRepo(id);
    if (!repo) {
      await ctx.reply(`没有仓库 ${id}。`, menuReply());
      return;
    }
    this.waiting.add(ctx.from.id);
    this.editingId.set(ctx.from.id, repo.id);
    await ctx.reply(
      `编辑 <strong>${escapeHtml(repo.id)}</strong>。复制下面改完整段发回。`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "rw:cancel"),
      },
    );
    await ctx.reply(`<pre>${escapeHtml(editTemplate(repo))}</pre>`, { parse_mode: "HTML" });
  }

  async handleText(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    if (text === "/cancel" || text === "取消") {
      this.cancel(ctx.from.id);
      await ctx.reply("已取消。", menuReply());
      return true;
    }
    if (!this.waiting.has(ctx.from.id) && !looksLikeRepoTemplate(text)) {
      return false;
    }
    if (this.waiting.has(ctx.from.id) && !looksLikeRepoTemplate(text)) {
      await ctx.reply("请发仓库模板（需要 id 和 githubRepo），或 /cancel。");
      return true;
    }
    try {
      const repo = parseRepoTemplate(text);
      const editId = this.editingId.get(ctx.from.id);
      const existing = findRepo(repo.id);
      if (existing && existing.id !== editId) {
        throw new Error(`id「${repo.id}」已存在。请换一个 id。`);
      }
      if (editId && repo.id !== editId) {
        removeRepo(editId);
      }
      const { created } = upsertRepo(repo);
      this.cancel(ctx.from.id);
      this.audit.write({
        userId: ctx.from.id,
        vpsId: "-",
        action: created && !editId ? "repo.add" : "repo.update",
        detail: `${repo.githubRepo}@${repo.branch}`,
        ok: true,
      });
      await ctx.reply(
        `${created && !editId ? "已加入" : "已更新"} ${repoLine(repo)}\n\n当前共 ${loadRepos().length} 个仓库。`,
        menuReply(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.waiting.add(ctx.from.id);
      await ctx.reply(`${message}\n\n<pre>${escapeHtml(REPO_TEMPLATE)}</pre>`, {
        parse_mode: "HTML",
      });
    }
    return true;
  }

  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    if (!ctx.from) return false;
    if (data === "rw:cancel") {
      this.cancel(ctx.from.id);
      await ctx.reply("已取消。", menuReply());
      return true;
    }
    return false;
  }
}

function parseRepoTemplate(raw: string): CodeRepo {
  const fields = extract(stripFence(raw));
  const id = fields.id?.trim() ?? "";
  const idErr = validateId(id);
  if (idErr) throw new Error(idErr);
  const githubRepo = fields.githubRepo?.trim() ?? "";
  if (!githubRepo) throw new Error("缺少 githubRepo（owner/repo）");
  parseRepoSlug(githubRepo);
  const deployPath = fields.deployPath?.trim() || "/var/www/app";
  if (!deployPath.startsWith("/") || deployPath === "/") {
    throw new Error("deployPath 必须是绝对路径，且不能是 /");
  }
  return {
    id,
    name: fields.name?.trim() || id,
    githubRepo,
    branch: fields.branch?.trim() || "main",
    deployPath,
    deployCmd: fields.deployCmd?.trim() ?? "",
    notes: fields.notes?.trim() ?? "",
  };
}

function editTemplate(r: CodeRepo): string {
  return [
    `id: ${r.id}`,
    `name: ${r.name}`,
    `githubRepo: ${r.githubRepo}`,
    `branch: ${r.branch}`,
    `deployPath: ${r.deployPath}`,
    `deployCmd: ${r.deployCmd}`,
    `notes: ${r.notes}`,
  ].join("\n");
}

function extract(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^\s:]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!m || line.trim().startsWith("#")) continue;
    fields[m[1]!] = m[2] ?? "";
  }
  return fields;
}

function stripFence(text: string): string {
  return text.trim().replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
