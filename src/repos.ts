import { parseRepoSlug, slugsEqual } from "./codehub.ts";
import { getDb } from "./db.ts";
import { ID_RE } from "./inventory.ts";
import type { CodeRepo } from "./types.ts";

interface RepoRow {
  id: string;
  name: string;
  github_repo: string;
  branch: string;
  deploy_path: string;
  deploy_cmd: string;
  notes: string;
  intro: string;
}

function rowToRepo(row: RepoRow): CodeRepo {
  return {
    id: row.id,
    name: row.name,
    githubRepo: row.github_repo,
    branch: row.branch,
    deployPath: row.deploy_path,
    deployCmd: row.deploy_cmd,
    notes: row.notes,
    intro: row.intro,
  };
}

export function loadRepos(): CodeRepo[] {
  const rows = getDb().prepare("SELECT * FROM repos ORDER BY name").all() as unknown as RepoRow[];
  return rows.map(rowToRepo);
}

export function findRepo(idOrName: string): CodeRepo | undefined {
  const key = idOrName.trim();
  return loadRepos().find((r) => {
    if (r.id === key || r.name === key) return true;
    try {
      return slugsEqual(r.githubRepo, key);
    } catch {
      return false;
    }
  });
}

export function slugToRepoId(githubRepo: string, used: Set<string>, keep?: string): string {
  if (keep && !used.has(keep)) return keep;
  const { owner, repo } = parseRepoSlug(githubRepo);
  const candidates = [repo, `${owner}-${repo}`, `r-${repo}`].map((s) =>
    s.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+/, "").slice(0, 32),
  );
  for (const c of candidates) {
    if (c && ID_RE.test(c) && !used.has(c)) return c;
  }
  let n = 2;
  while (n < 1000) {
    const c = `repo-${n}`.slice(0, 32);
    if (!used.has(c)) return c;
    n++;
  }
  throw new Error("无法生成仓库 id");
}

export function upsertRepo(repo: CodeRepo): { created: boolean } {
  const db = getDb();
  const clash = db.prepare("SELECT id FROM repos WHERE name = ? AND id != ?").get(repo.name, repo.id);
  if (clash) throw new Error(`便签「${repo.name}」已经有了，每个项目便签必须唯一`);
  const existing = db.prepare("SELECT id FROM repos WHERE id = ?").get(repo.id);
  db.prepare(
    `INSERT INTO repos (id,name,github_repo,branch,deploy_path,deploy_cmd,notes,intro)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, github_repo=excluded.github_repo, branch=excluded.branch,
       deploy_path=excluded.deploy_path, deploy_cmd=excluded.deploy_cmd,
       notes=excluded.notes, intro=excluded.intro`,
  ).run(
    repo.id,
    repo.name,
    repo.githubRepo,
    repo.branch,
    repo.deployPath,
    repo.deployCmd,
    repo.notes,
    repo.intro,
  );
  return { created: !existing };
}

export function removeRepo(id: string): CodeRepo | undefined {
  const repo = loadRepos().find((r) => r.id === id);
  if (!repo) return undefined;
  getDb().prepare("DELETE FROM repos WHERE id = ?").run(id);
  return repo;
}

export function saveRepos(repos: CodeRepo[]): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM repos").run();
    for (const repo of repos) upsertRepo(repo);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function repoLine(r: CodeRepo): string {
  return r.name;
}
