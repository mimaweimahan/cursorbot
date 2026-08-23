import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AuditLog } from "../audit.ts";
import { normalizeGithubUrl, slugsEqual } from "../codehub.ts";
import { findRepo, loadRepos, removeRepo, repoLine, slugToRepoId, upsertRepo } from "../repos.ts";
import type { CodeRepo } from "../types.ts";
import { R2_ALIGN_RULES, r2AlignLine } from "../r2.ts";
import { showRepoIntro } from "./codehub.ts";
import { menuReply } from "./menu.ts";

export const REPO_TEMPLATE = ["name: 唯一便签", "url: https://github.com/owner/repo"].join("\n");

export function looksLikeRepoTemplate(text: string): boolean {
  const fields = extract(stripFence(text));
  const url = fields.url || fields.githubRepo || fields.link;
  return Boolean((fields.name || fields.名称) && url && !fields.host);
}

export class RepoWizard {
  private waiting = new Set<number>();
  private editingId = new Map<number, string>();
  private introFor = new Map<number, string>();

  constructor(private audit: AuditLog) {}

  isActive(userId: number): boolean {
    return this.waiting.has(userId) || this.introFor.has(userId);
  }

  cancel(userId: number): boolean {
    const a = this.waiting.delete(userId);
    const b = this.editingId.delete(userId);
    const c = this.introFor.delete(userId);
    return a || b || c;
  }

  async start(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    this.waiting.add(ctx.from.id);
    await ctx.reply(
      [
        "添加项目：<strong>便签必须唯一</strong>，再填 GitHub 链接。",
        `R2 会写成 <code>projects/{便签}/latest.tar.gz</code>，名称必须和便签对齐。`,
        "复制模板改完整段发回。取消发 /cancel。",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "rw:cancel"),
      },
    );
    await ctx.reply(`<pre>${escapeHtml(REPO_TEMPLATE)}</pre>`, { parse_mode: "HTML" });
    await ctx.reply(R2_ALIGN_RULES);
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
      `编辑 <strong>${escapeHtml(repo.name)}</strong>。复制下面改完整段发回。\n改便签等于换 R2 路径，旧备份不会自动跟着走。`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "rw:cancel"),
      },
    );
    await ctx.reply(`<pre>${escapeHtml(editTemplate(repo))}</pre>`, { parse_mode: "HTML" });
  }

  async startIntro(ctx: Context, id: string): Promise<void> {
    if (!ctx.from) return;
    const repo = findRepo(id);
    if (!repo) {
      await ctx.reply(`没有仓库 ${id}。`, menuReply());
      return;
    }
    this.waiting.delete(ctx.from.id);
    this.editingId.delete(ctx.from.id);
    this.introFor.set(ctx.from.id, repo.id);
    await ctx.reply(
      [
        `给 <strong>${escapeHtml(repo.name)}</strong> 写简介。直接发一段文字即可。`,
        repo.intro ? "发来的内容会覆盖原来的简介。" : "",
        "取消发 /cancel。",
      ]
        .filter(Boolean)
        .join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "rw:cancel"),
      },
    );
  }

  async handleText(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    if (text === "/cancel" || text === "取消") {
      this.cancel(ctx.from.id);
      await ctx.reply("已取消。", menuReply());
      return true;
    }
    const introId = this.introFor.get(ctx.from.id);
    if (introId) {
      const repo = findRepo(introId);
      if (!repo) {
        this.introFor.delete(ctx.from.id);
        await ctx.reply("仓库已经不在了。", menuReply());
        return true;
      }
      upsertRepo({ ...repo, intro: text.trim() });
      this.introFor.delete(ctx.from.id);
      this.audit.write({
        userId: ctx.from.id,
        vpsId: "-",
        action: "repo.intro",
        detail: repo.name,
        ok: true,
      });
      await showRepoIntro(ctx, repo.id);
      return true;
    }
    if (!this.waiting.has(ctx.from.id) && !looksLikeRepoTemplate(text)) {
      return false;
    }
    if (this.waiting.has(ctx.from.id) && !looksLikeRepoTemplate(text)) {
      await ctx.reply("请发仓库模板（只要 name 和 url），或 /cancel。");
      return true;
    }
    try {
      const parsed = parseRepoTemplate(text);
      const editId = this.editingId.get(ctx.from.id);
      const all = loadRepos();
      if (/[\\/]/.test(parsed.name)) throw new Error("便签不能包含 /，R2 路径是 projects/{便签}/latest.tar.gz");
      const nameClash = all.find((r) => r.name === parsed.name && r.id !== editId);
      if (nameClash) throw new Error(`便签「${parsed.name}」已经有了，每个项目便签必须唯一`);
      const clash = all.find((r) => slugsEqual(r.githubRepo, parsed.githubRepo) && r.id !== editId);
      if (clash) throw new Error(`这个 GitHub 链接已经加过了：${clash.name}`);
      const used = new Set(all.filter((r) => r.id !== editId).map((r) => r.id));
      const prev = editId ? findRepo(editId) : undefined;
      const repo: CodeRepo = {
        id: slugToRepoId(parsed.githubRepo, used, editId),
        name: parsed.name,
        githubRepo: parsed.githubRepo,
        branch: prev?.branch ?? "",
        deployPath: prev?.deployPath || "/var/www/app",
        deployCmd: prev?.deployCmd ?? "",
        notes: prev?.notes ?? "",
        intro: prev?.intro ?? "",
      };
      if (editId && repo.id !== editId) removeRepo(editId);
      const { created } = upsertRepo(repo);
      this.cancel(ctx.from.id);
      this.audit.write({
        userId: ctx.from.id,
        vpsId: "-",
        action: created && !editId ? "repo.add" : "repo.update",
        detail: repo.githubRepo,
        ok: true,
      });
      await ctx.reply(
        `${created && !editId ? "已加入" : "已更新"} ${repoLine(repo)}\n对齐路径: ${r2AlignLine(repo)}\n\n当前共 ${loadRepos().length} 个仓库。部署时会校验链接。`,
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

function parseRepoTemplate(raw: string): { name: string; githubRepo: string } {
  const fields = extract(stripFence(raw));
  const name = (fields.name || fields.名称 || "").trim();
  const url = (fields.url || fields.链接 || fields.githubRepo || fields.link || "").trim();
  if (!name) throw new Error("请填 name（仓库名字）");
  if (!url) throw new Error("请填 url（GitHub 链接）");
  return { name, githubRepo: normalizeGithubUrl(url) };
}

function editTemplate(r: CodeRepo): string {
  return [`name: ${r.name}`, `url: ${r.githubRepo}`].join("\n");
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
