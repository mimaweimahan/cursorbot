import { githubToken, loadCodehub, parseRepoSlug } from "./codehub.ts";

export async function githubDownloadTarball(repo: string, branch: string): Promise<Buffer> {
  const cfg = loadCodehub();
  const token = githubToken(cfg);
  if (!token) throw new Error("还没配置 GitHub token，先点「代码仓库」");
  const { owner, repo: name } = parseRepoSlug(repo);
  const url = `https://api.github.com/repos/${owner}/${name}/tarball/${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "telegrambot",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub 拉取失败 ${res.status}: ${body.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
