import { encryptSecret, isEncryptedSecret } from "./crypto.ts";
import { getDb } from "./db.ts";
import type { VpsHost } from "./types.ts";

export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;

interface VpsRow {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  identity_file: string;
  password_enc: string;
  tags_json: string;
  notes: string;
  writable: number;
  allowed_services_json: string | null;
  repo: string;
  branch: string;
  deploy_path: string;
  deploy_cmd: string;
}

function rowToHost(row: VpsRow): VpsHost {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: Number(row.port),
    user: row.user,
    identityFile: row.identity_file,
    passwordEnc: row.password_enc,
    tags: JSON.parse(row.tags_json || "[]") as string[],
    notes: row.notes,
    writable: row.writable !== 0,
    allowedServices: row.allowed_services_json
      ? (JSON.parse(row.allowed_services_json) as string[])
      : null,
    repo: row.repo,
    branch: row.branch,
    deployPath: row.deploy_path,
    deployCmd: row.deploy_cmd,
  };
}

function normalizeHost(host: VpsHost): VpsHost {
  let passwordEnc = host.passwordEnc;
  if (passwordEnc && !isEncryptedSecret(passwordEnc)) {
    passwordEnc = encryptSecret(passwordEnc);
  }
  return { ...host, passwordEnc };
}

export function loadInventory(): VpsHost[] {
  const rows = getDb().prepare("SELECT * FROM vps ORDER BY id").all() as unknown as VpsRow[];
  return rows.map(rowToHost);
}

export function findHost(idOrName: string): VpsHost | undefined {
  const key = idOrName.trim();
  const hosts = loadInventory();
  return (
    hosts.find((h) => h.id === key) ??
    hosts.find((h) => h.name === key) ??
    hosts.find((h) => h.id.toLowerCase() === key.toLowerCase())
  );
}

export function filterHosts(query?: string): VpsHost[] {
  const hosts = loadInventory();
  if (!query) return hosts;
  const q = query.toLowerCase();
  return hosts.filter(
    (h) =>
      h.id.toLowerCase().includes(q) ||
      h.name.toLowerCase().includes(q) ||
      h.tags.some((t) => t.toLowerCase().includes(q)) ||
      h.host.includes(q),
  );
}

export function validateId(id: string): string | undefined {
  const trimmed = id.trim();
  if (!ID_RE.test(trimmed)) {
    return "id 仅允许字母数字和 ._- ，最长 32，需以字母或数字开头";
  }
  return undefined;
}

export function upsertHost(host: VpsHost): { created: boolean } {
  const h = normalizeHost(host);
  const db = getDb();
  const existing = db.prepare("SELECT id FROM vps WHERE id = ?").get(h.id);
  db.prepare(
    `INSERT INTO vps (id,name,host,port,user,identity_file,password_enc,tags_json,notes,writable,allowed_services_json,repo,branch,deploy_path,deploy_cmd)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, host=excluded.host, port=excluded.port, user=excluded.user,
       identity_file=excluded.identity_file, password_enc=excluded.password_enc,
       tags_json=excluded.tags_json, notes=excluded.notes, writable=excluded.writable,
       allowed_services_json=excluded.allowed_services_json, repo=excluded.repo,
       branch=excluded.branch, deploy_path=excluded.deploy_path, deploy_cmd=excluded.deploy_cmd`,
  ).run(
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
  return { created: !existing };
}

export function removeHost(id: string): VpsHost | undefined {
  const host = loadInventory().find((h) => h.id === id);
  if (!host) return undefined;
  getDb().prepare("DELETE FROM vps WHERE id = ?").run(id);
  return host;
}

export function saveInventory(hosts: VpsHost[]): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM vps").run();
    for (const host of hosts) upsertHost(host);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
