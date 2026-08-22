import { config } from "./config.ts";
import { githubDownloadTarball } from "./github.ts";
import { findRepo, loadRepos } from "./repos.ts";
import { r2GetTarball, r2PutTarball } from "./r2.ts";
import { formatExec, type SshPool } from "./ssh/client.ts";
import type { CodeRepo, VpsHost } from "./types.ts";

export function resolveCodeRepo(repoId?: string): CodeRepo {
  if (repoId) {
    const found = findRepo(repoId);
    if (!found) throw new Error(`没有仓库 ${repoId}，请先「添加仓库」`);
    return found;
  }
  const all = loadRepos();
  if (all.length === 1) return all[0]!;
  if (all.length === 0) throw new Error("还没有代码仓库。请先点「添加仓库」");
  throw new Error("有多个仓库，请指定 repoId");
}

export async function backupRepoToR2(repoId?: string): Promise<string> {
  const rec = resolveCodeRepo(repoId);
  const tar = await githubDownloadTarball(rec.githubRepo, rec.branch);
  const key = await r2PutTarball(tar, rec.githubRepo, rec.branch);
  return `已备份 ${rec.name} ${rec.githubRepo}@${rec.branch} → R2 ${key}（${tar.length} 字节）`;
}

export async function deployToVps(ssh: SshPool, vps: VpsHost, repoId?: string): Promise<string> {
  if (!vps.writable) throw new Error("只读机器不能部署");
  const rec = resolveCodeRepo(repoId);
  const repo = rec.githubRepo;
  const branch = rec.branch;
  const deployPath = rec.deployPath || "/var/www/app";
  if (!deployPath.startsWith("/") || deployPath === "/") {
    throw new Error("deployPath 必须是绝对路径，且不能是 /");
  }
  const steps: string[] = [];
  let tar: Buffer | undefined;
  let source = "github";
  try {
    tar = await githubDownloadTarball(repo, branch);
    steps.push(`GitHub 已下载 ${tar.length} 字节`);
    try {
      const key = await r2PutTarball(tar, repo, branch);
      steps.push(`已同步备份到 R2 ${key}`);
    } catch (err) {
      steps.push(`R2 备份跳过: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push(`GitHub 失败: ${msg}，改走 R2`);
    tar = await r2GetTarball(repo, branch);
    source = "r2";
    steps.push(`R2 已下载 ${tar.length} 字节`);
  }

  const remoteTar = `/tmp/code-${vps.id}.tar.gz`;
  await ssh.writeBuffer(vps, remoteTar, tar);
  const extract = [
    `set -e`,
    `mkdir -p ${shellQuote(deployPath)}`,
    `tar -xzf ${shellQuote(remoteTar)} -C ${shellQuote(deployPath)} --strip-components=1`,
    `rm -f ${shellQuote(remoteTar)}`,
    `echo DEPLOY_OK source=${source} path=${deployPath}`,
  ].join("\n");
  const unpacked = await ssh.exec(vps, extract, config.deployTimeoutMs);
  steps.push(formatExec(unpacked));
  if (unpacked.code !== 0) {
    throw new Error(`解压失败\n${steps.join("\n")}`);
  }

  if (rec.deployCmd) {
    const run = await ssh.exec(
      vps,
      `cd ${shellQuote(deployPath)} && ${rec.deployCmd}`,
      config.deployTimeoutMs,
    );
    steps.push("deployCmd:\n" + formatExec(run));
    if (run.code !== 0) throw new Error(`部署命令失败\n${steps.join("\n")}`);
  }
  return steps.join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
