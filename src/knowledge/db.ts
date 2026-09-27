import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vps_facts (
  vps_id TEXT NOT NULL,
  section TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vps_id, section)
);

CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  vps_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  problem TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (vps_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_playbooks_vps ON playbooks(vps_id);

CREATE TABLE IF NOT EXISTS playbook_embeddings (
  playbook_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vps_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  tools_json TEXT NOT NULL DEFAULT '[]',
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_turns_vps_ts ON turns(vps_id, ts);
`;

let knowledgeDb: DatabaseSync | undefined;

export function getKnowledgeDb(): DatabaseSync {
  if (knowledgeDb) return knowledgeDb;
  fs.mkdirSync(config.knowledgeDbPath.replace(/\/[^/]+$/, ""), { recursive: true });
  knowledgeDb = new DatabaseSync(config.knowledgeDbPath);
  knowledgeDb.exec("PRAGMA journal_mode = WAL");
  knowledgeDb.exec("PRAGMA foreign_keys = ON");
  knowledgeDb.exec(SCHEMA);
  ensureFts(knowledgeDb);
  setMeta("schema_version", "1");
  return knowledgeDb;
}

export function closeKnowledgeDb(): void {
  if (!knowledgeDb) return;
  try {
    knowledgeDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore */
  }
  knowledgeDb.close();
  knowledgeDb = undefined;
}

function ensureFts(database: DatabaseSync): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS playbooks_fts USING fts5(
      id UNINDEXED,
      vps_id UNINDEXED,
      title,
      problem,
      steps,
      tags
    );
  `);
}

export function setMeta(key: string, value: string): void {
  getKnowledgeDb()
    .prepare(
      `INSERT INTO meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(key, value);
}

export function getMeta(key: string): string | null {
  const row = getKnowledgeDb()
    .prepare(`SELECT value FROM meta WHERE key=?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** 导出前落盘 WAL，保证单文件可拷贝 */
export function checkpointKnowledgeDb(): void {
  const db = getKnowledgeDb();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
