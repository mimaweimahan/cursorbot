import fs from "node:fs";
import yaml from "js-yaml";
import { config } from "./config.ts";
import { encryptSecret, isEncryptedSecret } from "./crypto.ts";
import type { VpsHost } from "./types.ts";

interface RawFile {
  hosts?: RawHost[];
}

interface RawHost {
  id?: unknown;
  name?: unknown;
  host?: unknown;
  port?: unknown;
  user?: unknown;
  identityFile?: unknown;
  passwordEnc?: unknown;
  password?: unknown;
  tags?: unknown;
  notes?: unknown;
  writable?: unknown;
  allowedServices?: unknown;
  repo?: unknown;
  branch?: unknown;
  deployPath?: unknown;
  deployCmd?: unknown;
}

export const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`VPS 台账字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function parseHost(raw: RawHost, index: number): { host: VpsHost; migrated: boolean } {
  const id = asString(raw.id, `hosts[${index}].id`);
  if (!ID_RE.test(id)) {
    throw new Error(
      `hosts[${index}].id="${id}" 非法，仅允许字母数字和 ._- ，最长 32`,
    );
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t, i) => asString(t, `hosts[${index}].tags[${i}]`))
    : [];
  const allowedServices = Array.isArray(raw.allowedServices)
    ? raw.allowedServices.map((s, i) =>
        asString(s, `hosts[${index}].allowedServices[${i}]`),
      )
    : null;
  const identityFile =
    typeof raw.identityFile === "string" ? raw.identityFile.trim() : "";
  let passwordEnc =
    typeof raw.passwordEnc === "string" ? raw.passwordEnc.trim() : "";
  let migrated = false;
  if (typeof raw.password === "string" && raw.password) {
    passwordEnc = encryptSecret(raw.password);
    migrated = true;
  }
  if (passwordEnc && !isEncryptedSecret(passwordEnc)) {
    passwordEnc = encryptSecret(passwordEnc);
    migrated = true;
  }
  if (!identityFile && !passwordEnc) {
    throw new Error(`${id} 需要 password / passwordEnc 或 identityFile`);
  }
  return {
    host: {
      id,
      name: asString(raw.name ?? raw.id, `hosts[${index}].name`),
      host: asString(raw.host, `hosts[${index}].host`),
      port: raw.port === undefined ? 22 : Number(raw.port),
      user: asString(raw.user, `hosts[${index}].user`),
      identityFile,
      passwordEnc,
      tags,
      notes: typeof raw.notes === "string" ? raw.notes.trim() : "",
      writable: raw.writable !== false,
      allowedServices,
      repo: typeof raw.repo === "string" ? raw.repo.trim() : "",
      branch: typeof raw.branch === "string" ? raw.branch.trim() : "",
      deployPath: typeof raw.deployPath === "string" ? raw.deployPath.trim() : "",
      deployCmd: typeof raw.deployCmd === "string" ? raw.deployCmd.trim() : "",
    },
    migrated,
  };
}

export function loadInventory(): VpsHost[] {
  if (!fs.existsSync(config.inventoryPath)) {
    return [];
  }
  const text = fs.readFileSync(config.inventoryPath, "utf8");
  const parsed = yaml.load(text) as RawFile | undefined;
  const parsedHosts = (parsed?.hosts ?? []).map(parseHost);
  const hosts = parsedHosts.map((p) => p.host);
  const seen = new Set<string>();
  for (const h of hosts) {
    if (seen.has(h.id)) {
      throw new Error(`VPS id 重复: ${h.id}`);
    }
    seen.add(h.id);
    if (!Number.isInteger(h.port) || h.port < 1 || h.port > 65535) {
      throw new Error(`${h.id} 的 port 非法`);
    }
  }
  if (parsedHosts.some((p) => p.migrated)) {
    saveInventory(hosts);
  }
  return hosts;
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
  const hosts = loadInventory();
  const idx = hosts.findIndex((h) => h.id === host.id);
  const created = idx < 0;
  if (idx >= 0) hosts[idx] = host;
  else hosts.push(host);
  saveInventory(hosts);
  return { created };
}

export function removeHost(id: string): VpsHost | undefined {
  const hosts = loadInventory();
  const idx = hosts.findIndex((h) => h.id === id);
  if (idx < 0) return undefined;
  const [removed] = hosts.splice(idx, 1);
  saveInventory(hosts);
  return removed;
}

export function saveInventory(hosts: VpsHost[]): void {
  const doc = {
    hosts: hosts.map((h) => {
      const row: Record<string, unknown> = {
        id: h.id,
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        writable: h.writable,
      };
      if (h.passwordEnc) row.passwordEnc = h.passwordEnc;
      if (h.identityFile) row.identityFile = h.identityFile;
      if (h.tags.length) row.tags = h.tags;
      if (h.notes) row.notes = h.notes;
      if (h.allowedServices?.length) row.allowedServices = h.allowedServices;
      if (h.repo) row.repo = h.repo;
      if (h.branch) row.branch = h.branch;
      if (h.deployPath) row.deployPath = h.deployPath;
      if (h.deployCmd) row.deployCmd = h.deployCmd;
      return row;
    }),
  };
  const body = yaml.dump(doc, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  fs.mkdirSync(config.inventoryPath.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(
    config.inventoryPath,
    `# 由 Bot 菜单维护，也可手工编辑后保存。\n\n${body}`,
  );
}
