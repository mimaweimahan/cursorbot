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
    `从已添加的代码仓库「${repo.name}」（id=${repo.id}）拉取成品并部署。`,
    `GitHub: ${repo.githubRepo}  branch=${repo.branch}`,
    `目标目录: ${repo.deployPath}`,
    repo.deployCmd ? `部署命令: ${repo.deployCmd}` : "没有 deployCmd，只落文件、不启动服务。",
    "必须调用工具 deploy_code，参数 repoId 填 " + repo.id + "。",
    "GitHub 为主，失败则用 Cloudflare R2 备份。",
    "不要在这台 VPS 上改业务代码；代码在本地客户端改完再推仓库。",
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
