import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { provisionR2FromApiToken } from "../cloudflare.ts";
import {
  applyR2Provision,
  githubReady,
  loadCodehub,
  mergeCodehubPatch,
  r2Ready,
  saveCodehub,
  statusText,
} from "../codehub.ts";
import { backupRepoToR2 } from "../deploy.ts";
import { R2_ALIGN_RULES, r2AlignLine, r2Key } from "../r2.ts";
import { findRepo, loadRepos, repoLine } from "../repos.ts";
import { clipTelegram } from "./format.ts";
import { menuReply } from "./menu.ts";

export const CODEHUB_TEMPLATE = [
  "githubToken: 你的GitHub_PAT",
  "cloudflareToken: 你的Cloudflare_API_Token",
].join("\n");

export function looksLikeCodehubTemplate(text: string): boolean {
  return /^(githubToken|cloudflareToken|cfToken|cloudapi|r2Bucket|r2AccountId|r2Secret|r2AccessKey)\s*:/im.test(
    text,
  );
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
        "配置拉取密钥。Cloudflare 只要一个 <strong>API Token</strong>，Bot 会自动查账号、建桶、生成 R2 密钥。",
        "复制模板改完整段发回。已有项填 <code>*</code> 表示不改。",
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
      `cloudflareToken: ${cur.r2SecretEnc ? "*" : "你的Cloudflare_API_Token"}`,
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
      await ctx.reply("请发密钥模板（githubToken / cloudflareToken），或 /cancel。");
      return true;
    }
    try {
      const fields = extract(text);
      let cfg = mergeCodehubPatch(fields);
      const cfToken = (fields.cloudflareToken || fields.cfToken || fields.cloudapi || "").trim();
      let extra = "";
      if (cfToken && cfToken !== "*") {
        await ctx.reply("正在用 Cloudflare Token 自动配置 R2…");
        const r2 = await provisionR2FromApiToken(cfToken, fields.r2Bucket);
        cfg = applyR2Provision(cfg, r2);
        extra = `\n账号 ${r2.r2AccountName}，桶 ${r2.r2Bucket}${r2.createdBucket ? "（新建）" : ""}`;
      }
      saveCodehub(cfg);
      this.waiting.delete(ctx.from.id);
      await ctx.reply(`已保存。${extra}\n${statusText(cfg)}`, menuReply());
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
    .text("选择备份", "ch:bak")
    .row()
    .text("密钥状态", "ch:st");
  await ctx.reply(
    [
      R2_ALIGN_RULES,
      "",
      "备份：从列表里选仓库。GitHub 有更新时，再点那个仓库，备份到对齐路径。",
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
    else {
      kb.text(r.name.slice(0, 20), `re:${r.id}`).text("简介", `ri:${r.id}`).row();
    }
  }
  const title =
    mode === "backup"
      ? [
          "选要备份的仓库。GitHub 有更新时点对应仓库。",
          "",
          R2_ALIGN_RULES,
        ].join("\n")
      : "仓库列表（点简介打开单独一页）";
  const lines =
    mode === "backup"
      ? repos.map((r) => `• ${r2AlignLine(r)}`)
      : repos.map((r) => `• ${repoLine(r)}`);
  await ctx.reply([title, "", ...lines].join("\n"), {
    reply_markup: kb,
  });
}

export async function showRepoIntro(ctx: Context, id: string): Promise<void> {
  const repo = findRepo(id);
  if (!repo) {
    await ctx.reply(`没有仓库 ${id}。`, menuReply());
    return;
  }
  const body = repo.intro.trim() || "还没有简介。点「写简介」发一段文字。";
  const kb = new InlineKeyboard()
    .text(repo.intro ? "改简介" : "写简介", `ie:${repo.id}`)
    .text("备份到R2", `rb:${repo.id}`)
    .row()
    .text("返回列表", "ch:list");
  await ctx.reply(
    clipTelegram(`简介 · ${repo.name}\n对齐路径: ${r2Key(repo)}\n\n${body}`),
    { reply_markup: kb },
  );
}

export async function runBackup(ctx: Context, repoId?: string): Promise<void> {
  console.log(`[backup] click repoId=${repoId ?? "(list only)"}`);
  if (!repoId) {
    await showRepoList(ctx, "backup");
    return;
  }
  const repo = findRepo(repoId);
  if (!repo) {
    console.log(`[backup] missing repo ${repoId}`);
    await ctx.reply(`没有仓库 ${repoId}。`, menuReply());
    return;
  }
  if (!githubReady() || !r2Ready()) {
    console.log("[backup] blocked: github/R2 keys not ready");
    await ctx.reply(
      "密钥还没配齐，备份走不了。先点「配置密钥」填 githubToken 和 cloudflareToken。\n" + statusText(),
      menuReply(),
    );
    return;
  }
  console.log(`[backup] start ${repo.name} (${repo.id})`);
  await ctx.reply(
    `正在备份「${repo.name}」→ ${r2Key(repo)}\n路径必须和便签一字不差，不会另起 R2 名称。`,
  );
  try {
    const text = await backupRepoToR2(repo.id);
    console.log(`[backup] ok ${text}`);
    await ctx.reply(text, menuReply());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[backup] fail ${repo.name}: ${message}`);
    await ctx.reply(`备份失败: ${message}`, menuReply());
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
