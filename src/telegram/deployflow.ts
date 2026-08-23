import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { githubReady, loadCodehub, r2Ready } from "../codehub.ts";
import { findHost } from "../inventory.ts";
import { findRepo, loadRepos, repoLine } from "../repos.ts";
import type { SessionStore } from "../session.ts";
import type { CodeRepo, VpsHost } from "../types.ts";
import { menuReply } from "./menu.ts";

const pendingVps = new Map<number, string>();

export function deployPrompt(repo: CodeRepo): string {
  return [
    `用户要部署台账里的仓库「${repo.name}」。`,
    `台账链接: ${repo.githubRepo}`,
    `repoId: ${repo.id}`,
    "先调用 verify_repo（repoId 必须是上面这个）向 GitHub 校验：名字/链接是否就是这个仓库。",
    "对不上就停止，不要拉别的仓库。",
    "校验通过后再调用 deploy_code，repoId 同样必须是 " + repo.id + "。",
    "GitHub 为主，失败用 R2。不要在 VPS 上改业务代码。",
  ].join("\n");
}

export async function startDeployPick(
  ctx: Context,
  vpsId: string,
): Promise<void> {
  if (!ctx.from) return;
  const host = findHost(vpsId);
  if (!host) {
    await ctx.reply(`找不到机器 ${vpsId}。`, menuReply());
    return;
  }
  const repos = loadRepos();
  if (repos.length === 0) {
    await ctx.reply("还没有代码仓库。请先点「添加仓库」，把成品仓加进来，再部署。", menuReply());
    return;
  }
  const cred = loadCodehub();
  if (!githubReady(cred) && !r2Ready(cred)) {
    await ctx.reply("还没配 GitHub token / R2。先点「代码仓库 → 配置密钥」。", menuReply());
    return;
  }
  pendingVps.set(ctx.from.id, host.id);
  const kb = new InlineKeyboard();
  for (const r of repos.slice(0, 20)) {
    kb.text(r.name.slice(0, 28), `pk:${r.id}`).row();
  }
  await ctx.reply(
    [
      `给 ${host.name}（${host.id}）部署。选一个已添加的仓库：`,
      "",
      ...repos.map((r) => `• ${repoLine(r)}`),
      "",
      "选完后由 Cursor 拉代码部署（GitHub 为主，R2 备用）。",
    ].join("\n"),
    { reply_markup: kb },
  );
}

export function takePendingVps(userId: number): string | undefined {
  const id = pendingVps.get(userId);
  pendingVps.delete(userId);
  return id;
}

export function bindDeploy(
  sessions: SessionStore,
  userId: number,
  vpsId: string,
  repoId: string,
): { host: VpsHost; repo: CodeRepo; prompt: string } | null {
  const host = findHost(vpsId);
  const repo = findRepo(repoId);
  if (!host || !repo) return null;
  sessions.setCurrent(userId, host.id);
  sessions.setLastRepo(userId, repo.id);
  return { host, repo, prompt: deployPrompt(repo) };
}
