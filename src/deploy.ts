import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { githubDownloadTarball, githubDownloadTarballToFile, verifyListedRepo } from "./github.ts";
import { findRepo, loadRepos } from "./repos.ts";
import { r2GetTarball, r2PutTarball, r2PutTarballFile } from "./r2.ts";
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
  console.log(`[backup] verify github ${rec.name}`);
  const info = await verifyListedRepo(rec);
  const dest = path.join(config.workspacesDir, "tmp", `backup-${rec.id}.tar.gz`);
  console.log(`[backup] download ${info.fullName}@${info.defaultBranch} -> disk`);
  try {
    const bytes = await githubDownloadTarballToFile(rec.githubRepo, info.defaultBranch, dest);
    console.log(`[backup] tarball ${bytes} bytes, upload R2`);
    const key = await r2PutTarballFile(dest, rec);
    console.log(`[backup] uploaded ${key}`);
    return `已备份「${rec.name}」 ${info.fullName}@${info.defaultBranch}\n对齐路径 R2 ${key}（${bytes} 字节）\n名称已与便签对齐，没有另起 R2 项目名。`;
  } finally {
    fs.rmSync(dest, { force: true });
  }
}

export async function deployToVps(ssh: SshPool, vps: VpsHost, repoId?: string): Promise<string> {
  if (!vps.writable) throw new Error("只读机器不能部署");
  const rec = resolveCodeRepo(repoId);
  const info = await verifyListedRepo(rec);
  const repo = rec.githubRepo;
  const branch = info.defaultBranch;
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
      const key = await r2PutTarball(tar, rec);
      steps.push(`已同步备份到 R2 ${key}（便签 ${rec.name}）`);
    } catch (err) {
      steps.push(`R2 备份跳过: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push(`GitHub 失败: ${msg}，改走 R2 便签「${rec.name}」`);
    tar = await r2GetTarball(rec);
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
