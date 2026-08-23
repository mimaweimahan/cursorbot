import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import yaml from "js-yaml";
import { config } from "./config.ts";
import type { CodeRepo, UserSession, VpsHost } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  user TEXT NOT NULL,
  identity_file TEXT NOT NULL DEFAULT '',
  password_enc TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  writable INTEGER NOT NULL DEFAULT 1,
  allowed_services_json TEXT,
  repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  deploy_path TEXT NOT NULL DEFAULT '',
  deploy_cmd TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  github_repo TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  deploy_path TEXT NOT NULL DEFAULT '/var/www/app',
  deploy_cmd TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER PRIMARY KEY,
  current_vps_id TEXT,
  last_repo_id TEXT,
  chat_on INTEGER NOT NULL DEFAULT 1,
  agents_json TEXT NOT NULL DEFAULT '{}'
);
`;

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(config.dbPath.replace(/\/[^/]+$/, ""), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrateFromLegacy(db);
  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore */
  }
  db.close();
  db = undefined;
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return Number(row.n);
}

function migrateFromLegacy(database: DatabaseSync): void {
  if (count(database, "vps") === 0 && fs.existsSync(config.inventoryPath)) {
    const hosts = readLegacyHosts();
    const ins = database.prepare(
      `INSERT INTO vps (id,name,host,port,user,identity_file,password_enc,tags_json,notes,writable,allowed_services_json,repo,branch,deploy_path,deploy_cmd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const h of hosts) {
      ins.run(
        h.id,
        h.name,
        h.host,
        h.port,
        h.user,
        h.identityFile,
        h.passwordEnc,
        JSON.stringify(h.tags),
        h.notes,
        h.writable ? 1 : 0,
        h.allowedServices ? JSON.stringify(h.allowedServices) : null,
        h.repo,
        h.branch,
        h.deployPath,
        h.deployCmd,
      );
    }
    if (hosts.length) console.log(`已把 ${hosts.length} 台 VPS 从 yaml 迁入 SQLite`);
  }

  if (count(database, "repos") === 0 && fs.existsSync(config.reposPath)) {
    const repos = readLegacyRepos();
    const ins = database.prepare(
      `INSERT INTO repos (id,name,github_repo,branch,deploy_path,deploy_cmd,notes,intro)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    for (const r of repos) {
      ins.run(r.id, r.name, r.githubRepo, r.branch, r.deployPath, r.deployCmd, r.notes, r.intro);
    }
    if (repos.length) console.log(`已把 ${repos.length} 个仓库从 yaml 迁入 SQLite`);
  }

  const setting = database.prepare("SELECT value FROM settings WHERE key = ?").get("codehub");
  if (!setting && fs.existsSync(config.codehubPath)) {
    const raw = yaml.load(fs.readFileSync(config.codehubPath, "utf8")) as Record<string, unknown> | undefined;
    if (raw && typeof raw === "object") {
      database
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run("codehub", JSON.stringify(raw));
      console.log("已把密钥配置从 yaml 迁入 SQLite");
    }
  }

  if (count(database, "sessions") === 0 && fs.existsSync(config.sessionsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(config.sessionsPath, "utf8")) as Record<string, UserSession>;
      const ins = database.prepare(
        `INSERT INTO sessions (user_id, current_vps_id, last_repo_id, chat_on, agents_json)
         VALUES (?,?,?,?,?)`,
      );
      for (const [id, session] of Object.entries(raw)) {
        ins.run(
          Number(id),
          session.currentVpsId,
          session.lastRepoId,
          session.chatOn === false ? 0 : 1,
          JSON.stringify(session.agents ?? {}),
        );
      }
      console.log("已把会话从 json 迁入 SQLite");
    } catch (err) {
      console.error("迁移 sessions.json 失败，跳过", err);
    }
  }
}

function readLegacyHosts(): VpsHost[] {
  const parsed = yaml.load(fs.readFileSync(config.inventoryPath, "utf8")) as { hosts?: Record<string, unknown>[] } | undefined;
  const rows = parsed?.hosts ?? [];
  return rows.map((raw, index) => {
    const str = (k: string, fallback = ""): string =>
      typeof raw[k] === "string" ? String(raw[k]).trim() : fallback;
    const id = str("id");
    if (!id) throw new Error(`hosts[${index}].id 为空，无法迁移`);
    const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [];
    const allowed = Array.isArray(raw.allowedServices)
      ? raw.allowedServices.map((s) => String(s))
      : null;
    return {
      id,
      name: str("name", id),
      host: str("host"),
      port: raw.port === undefined ? 22 : Number(raw.port),
      user: str("user"),
      identityFile: str("identityFile"),
      passwordEnc: str("passwordEnc"),
      tags,
      notes: str("notes"),
      writable: raw.writable !== false,
      allowedServices: allowed,
      repo: str("repo"),
      branch: str("branch"),
      deployPath: str("deployPath"),
      deployCmd: str("deployCmd"),
    };
  });
}

function readLegacyRepos(): CodeRepo[] {
  const parsed = yaml.load(fs.readFileSync(config.reposPath, "utf8")) as { repos?: Record<string, unknown>[] } | undefined;
  const rows = parsed?.repos ?? [];
  return rows.map((raw, index) => {
    const str = (k: string, fallback = ""): string =>
      typeof raw[k] === "string" ? String(raw[k]).trim() : fallback;
    const id = str("id");
    if (!id) throw new Error(`repos[${index}].id 为空，无法迁移`);
    return {
      id,
      name: str("name", id),
      githubRepo: str("githubRepo"),
      branch: str("branch", "main"),
      deployPath: str("deployPath", "/var/www/app"),
      deployCmd: str("deployCmd"),
      notes: str("notes"),
      intro: str("intro") || str("notes"),
    };
  });
}
