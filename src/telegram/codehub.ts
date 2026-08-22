import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  loadCodehub,
  mergeCodehubPatch,
  saveCodehub,
  statusText,
} from "../codehub.ts";
import { backupRepoToR2 } from "../deploy.ts";
import { findRepo, loadRepos, repoLine } from "../repos.ts";
import { menuReply } from "./menu.ts";

export const CODEHUB_TEMPLATE = [
  "githubToken: 你的GitHub_PAT",
  "r2AccountId: Cloudflare账号ID",
  "r2AccessKey: R2_Access_Key",
  "r2Secret: R2_Secret_Key",
  "r2Bucket: 桶名",
  "r2Endpoint:",
].join("\n");

export function looksLikeCodehubTemplate(text: string): boolean {
  return /^(githubToken|r2Bucket|r2AccountId|r2Secret|r2AccessKey)\s*:/im.test(text);
}

export class CodehubWizard {
  private waiting = new Set<number>();

  isActive(userId: number): boolean {
    return this.waiting.has(userId);
  }

  cancel(userId: number): boolean {
    return this.waiting.delete(userId);
  }

  async start(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    this.waiting.add(ctx.from.id);
    const cur = loadCodehub();
    await ctx.reply(
      [
        "配置 <strong>拉取密钥</strong>（GitHub PAT + Cloudflare R2）。仓库本身请用「添加仓库」。",
        "复制模板改完整段发回。token 会加密。已有项填 <code>*</code> 表示不改。",
        "",
        escapeHtml(statusText(cur)),
        "",
        "取消发 /cancel。",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("取消", "ch:cancel"),
      },
    );
    const filled = [
      `githubToken: ${cur.githubTokenEnc ? "*" : "你的GitHub_PAT"}`,
      `r2AccountId: ${cur.r2AccountId || "Cloudflare账号ID"}`,
      `r2AccessKey: ${cur.r2AccessKeyEnc ? "*" : "R2_Access_Key"}`,
      `r2Secret: ${cur.r2SecretEnc ? "*" : "R2_Secret_Key"}`,
      `r2Bucket: ${cur.r2Bucket || "桶名"}`,
      `r2Endpoint: ${cur.r2Endpoint || ""}`,
    ].join("\n");
    await ctx.reply(`<pre>${escapeHtml(filled)}</pre>`, { parse_mode: "HTML" });
  }

  async handleText(ctx: Context, text: string): Promise<boolean> {
    if (!ctx.from) return false;
    if (text === "/cancel" || text === "取消") {
      this.cancel(ctx.from.id);
      await ctx.reply("已取消。", menuReply());
      return true;
    }
    if (!this.waiting.has(ctx.from.id) && !looksLikeCodehubTemplate(text)) {
      return false;
    }
    if (this.waiting.has(ctx.from.id) && !looksLikeCodehubTemplate(text)) {
      await ctx.reply("请发代码仓库模板（含 githubRepo / r2Bucket 等），或 /cancel。");
      return true;
    }
    try {
      const fields = extract(text);
      const cfg = mergeCodehubPatch(fields);
      saveCodehub(cfg);
      this.waiting.delete(ctx.from.id);
      await ctx.reply(`已保存代码仓库配置。\n${statusText(cfg)}`, menuReply());
      await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id).catch(() =>
        ctx.reply("请自己删掉带 token 的那条消息。"),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.waiting.add(ctx.from.id);
      await ctx.reply(`${message}\n\n<pre>${escapeHtml(CODEHUB_TEMPLATE)}</pre>`, {
        parse_mode: "HTML",
      });
    }
    return true;
  }

  async handleCallback(ctx: Context, data: string): Promise<boolean> {
    if (!ctx.from) return false;
    if (data === "ch:cancel") {
      this.cancel(ctx.from.id);
      await ctx.reply("已取消。", menuReply());
      return true;
    }
    return false;
  }
}

export async function showCodehubMenu(ctx: Context): Promise<void> {
  const repos = loadRepos();
  const kb = new InlineKeyboard()
    .text("添加仓库", "ch:add")
    .text("仓库列表", "ch:list")
    .row()
    .text("配置密钥", "ch:cfg")
    .text("备份到 R2", "ch:bak")
    .row()
    .text("密钥状态", "ch:st");
  await ctx.reply(
    [
      "流程：本地改代码 → 推 GitHub（R2 备份）→ 先「添加仓库」→ 加 VPS →「部署」选仓库 → Cursor 拉取部署。",
      "",
      `已添加仓库 ${repos.length} 个` + (repos.length ? `：\n${repos.map((r) => `• ${repoLine(r)}`).join("\n")}` : "。还没有，先添加。"),
      "",
      statusText(),
    ].join("\n"),
    { reply_markup: kb },
  );
}

export async function showRepoList(
  ctx: Context,
  mode: "edit" | "delete" | "backup" = "edit",
): Promise<void> {
  const repos = loadRepos();
  if (repos.length === 0) {
    await ctx.reply("还没有仓库。点「添加仓库」。", menuReply());
    return;
  }
  const kb = new InlineKeyboard();
  for (const r of repos.slice(0, 20)) {
    if (mode === "delete") kb.text(`删除 ${r.name}`, `rd:${r.id}`).row();
    else if (mode === "backup") kb.text(`备份 ${r.name}`, `rb:${r.id}`).row();
    else kb.text(`编辑 ${r.name}`, `re:${r.id}`).text("删除", `rd:${r.id}`).row();
  }
  await ctx.reply(
    ["仓库列表", "", ...repos.map((r) => `• ${repoLine(r)}`)].join("\n"),
    { reply_markup: kb },
  );
}

export async function runBackup(ctx: Context, repoId?: string): Promise<void> {
  if (!repoId) {
    const repos = loadRepos();
    if (repos.length === 0) {
      await ctx.reply("还没有仓库。先「添加仓库」。", menuReply());
      return;
    }
    if (repos.length > 1) {
      await showRepoList(ctx, "backup");
      return;
    }
    repoId = repos[0]!.id;
  }
  const repo = findRepo(repoId);
  if (!repo) {
    await ctx.reply(`没有仓库 ${repoId}。`, menuReply());
    return;
  }
  await ctx.reply(`正在备份 ${repo.name} 到 R2…`);
  try {
    const msg = await backupRepoToR2(repo.id);
    await ctx.reply(msg, menuReply());
  } catch (err) {
    await ctx.reply(`备份失败: ${err instanceof Error ? err.message : String(err)}`, menuReply());
  }
}

function extract(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const stripped = text.trim().replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
  for (const line of stripped.split(/\r?\n/)) {
    const m = /^([^\s:]+)\s*:\s*(.*)$/.exec(line.trim());
    if (m) fields[m[1]!] = m[2] ?? "";
  }
  return fields;
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
