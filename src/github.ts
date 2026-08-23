import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { githubToken, loadCodehub, parseRepoSlug, slugsEqual } from "./codehub.ts";
import type { CodeRepo } from "./types.ts";

export interface GithubRepoInfo {
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  description: string;
  private: boolean;
}

function ghHeaders(): Record<string, string> {
  const token = githubToken(loadCodehub());
  return buildHeaders(token);
}

function buildHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "telegrambot",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function githubInspectRepo(repo: string): Promise<GithubRepoInfo> {
  const { owner, repo: name } = parseRepoSlug(repo);
  const token = githubToken(loadCodehub());
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: ghHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404 && !token) {
      throw new Error(
        `打不开 ${owner}/${name}（404）。仓库多半是私有的，先点「代码仓库 → 配置密钥」填 githubToken（要有这个仓的读取权限）。`,
      );
    }
    throw new Error(`GitHub 校验失败 ${res.status}: 打不开 ${owner}/${name}。${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    full_name?: string;
    html_url?: string;
    default_branch?: string;
    description?: string | null;
    private?: boolean;
  };
  return {
    fullName: data.full_name || `${owner}/${name}`,
    htmlUrl: data.html_url || `https://github.com/${owner}/${name}`,
    defaultBranch: data.default_branch || "main",
    description: data.description?.trim() || "",
    private: Boolean(data.private),
  };
}

export function formatRepoCheck(listed: CodeRepo, info: GithubRepoInfo): string {
  return [
    `台账名称: ${listed.name}`,
    `台账链接: ${listed.githubRepo}`,
    `GitHub: ${info.fullName}`,
    `真实链接: ${info.htmlUrl}`,
    `默认分支: ${info.defaultBranch}`,
    info.description ? `说明: ${info.description}` : "",
    `可见性: ${info.private ? "私有" : "公开"}`,
    "校验: 与台账链接一致",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function verifyListedRepo(listed: CodeRepo): Promise<GithubRepoInfo> {
  const info = await githubInspectRepo(listed.githubRepo);
  if (!slugsEqual(listed.githubRepo, info.fullName) && !slugsEqual(listed.githubRepo, info.htmlUrl)) {
    throw new Error(
      `不是要部署的仓库。台账是 ${listed.githubRepo}，GitHub 返回 ${info.fullName}（${info.htmlUrl}）`,
    );
  }
  return info;
}

export async function githubDownloadTarballToFile(
  repo: string,
  branch: string,
  dest: string,
): Promise<number> {
  const cfg = loadCodehub();
  const token = githubToken(cfg);
  if (!token) throw new Error("还没配置 GitHub token，先点「代码仓库 → 配置密钥」");
  const { owner, repo: name } = parseRepoSlug(repo);
  const url = `https://api.github.com/repos/${owner}/${name}/tarball/${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: ghHeaders(),
    redirect: "follow",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub 拉取失败 ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("GitHub 没有返回文件流");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  let received = 0;
  let lastLog = 0;
  nodeStream.on("data", (chunk: Buffer | string) => {
    received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (received - lastLog >= 8 * 1024 * 1024) {
      lastLog = received;
      console.log(`[backup] downloading ${Math.round(received / 1024 / 1024)}MB`);
    }
  });
  nodeStream.pipe(out);
  await finished(out);
  console.log(`[backup] downloaded ${received} bytes to disk`);
  return received;
}

export async function githubDownloadTarball(repo: string, branch: string): Promise<Buffer> {
  const dest = path.join(os.tmpdir(), `gh-${Date.now()}.tar.gz`);
  try {
    await githubDownloadTarballToFile(repo, branch, dest);
    return fs.readFileSync(dest);
  } finally {
    fs.rmSync(dest, { force: true });
  }
}
