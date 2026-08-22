import fs from "node:fs";
import yaml from "js-yaml";
import { parseRepoSlug } from "./codehub.ts";
import { config } from "./config.ts";
import { ID_RE } from "./inventory.ts";
import type { CodeRepo } from "./types.ts";

interface RawFile {
  repos?: RawRepo[];
}

interface RawRepo {
  id?: unknown;
  name?: unknown;
  githubRepo?: unknown;
  branch?: unknown;
  deployPath?: unknown;
  deployCmd?: unknown;
  notes?: unknown;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`仓库字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function parseRepo(raw: RawRepo, index: number): CodeRepo {
  const id = asString(raw.id, `repos[${index}].id`);
  if (!ID_RE.test(id)) {
    throw new Error(`repos[${index}].id="${id}" 非法，仅允许字母数字和 ._- ，最长 32`);
  }
  const githubRepo = asString(raw.githubRepo, `repos[${index}].githubRepo`);
  parseRepoSlug(githubRepo);
  const deployPath =
    typeof raw.deployPath === "string" && raw.deployPath.trim()
      ? raw.deployPath.trim()
      : "/var/www/app";
  if (!deployPath.startsWith("/") || deployPath === "/") {
    throw new Error(`${id} 的 deployPath 必须是绝对路径，且不能是 /`);
  }
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    githubRepo,
    branch: typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : "main",
    deployPath,
    deployCmd: typeof raw.deployCmd === "string" ? raw.deployCmd.trim() : "",
    notes: typeof raw.notes === "string" ? raw.notes.trim() : "",
  };
}

export function loadRepos(): CodeRepo[] {
  if (!fs.existsSync(config.reposPath)) return [];
  const parsed = yaml.load(fs.readFileSync(config.reposPath, "utf8")) as RawFile | undefined;
  const repos = (parsed?.repos ?? []).map(parseRepo);
  const seen = new Set<string>();
  for (const r of repos) {
    if (seen.has(r.id)) throw new Error(`仓库 id 重复: ${r.id}`);
    seen.add(r.id);
  }
  return repos;
}

export function findRepo(idOrName: string): CodeRepo | undefined {
  const key = idOrName.trim();
  return loadRepos().find((r) => r.id === key || r.name === key);
}

export function upsertRepo(repo: CodeRepo): { created: boolean } {
  const repos = loadRepos();
  const i = repos.findIndex((r) => r.id === repo.id);
  if (i >= 0) {
    repos[i] = repo;
    saveRepos(repos);
    return { created: false };
  }
  repos.push(repo);
  saveRepos(repos);
  return { created: true };
}

export function removeRepo(id: string): CodeRepo | undefined {
  const repos = loadRepos();
  const i = repos.findIndex((r) => r.id === id);
  if (i < 0) return undefined;
  const [removed] = repos.splice(i, 1);
  saveRepos(repos);
  return removed;
}

export function saveRepos(repos: CodeRepo[]): void {
  const body = yaml.dump(
    {
      repos: repos.map((r) => ({
        id: r.id,
        name: r.name,
        githubRepo: r.githubRepo,
        branch: r.branch,
        deployPath: r.deployPath,
        ...(r.deployCmd ? { deployCmd: r.deployCmd } : {}),
        ...(r.notes ? { notes: r.notes } : {}),
      })),
    },
    { lineWidth: 120, noRefs: true, sortKeys: false },
  );
  fs.mkdirSync(config.reposPath.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(config.reposPath, `# 代码仓库台账。成品先推 GitHub，R2 做备份。\n\n${body}`);
}

export function repoLine(r: CodeRepo): string {
  return `${r.name} (${r.id})  ${r.githubRepo}@${r.branch}  → ${r.deployPath}`;
}
