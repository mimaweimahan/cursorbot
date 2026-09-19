import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { fromRoot, ROOT } from "./paths.ts";

const ENV_PATH = path.join(ROOT, ".env");
const RUNTIME_ENV_PATH = fromRoot("data", "runtime.env");
const VPS_SECRET_PATH = fromRoot("data", "vps.secret");

// 私密仓库可提交 data/runtime.env：新机 clone 后无需再手填。
// 本地 .env 优先覆盖（便于临时改 token / 模型）。
dotenv.config({ path: RUNTIME_ENV_PATH });
dotenv.config({ path: ENV_PATH, override: true });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}。请配置 data/runtime.env 或 .env（私密部署建议提交 runtime.env）`,
    );
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} 必须是正数`);
  }
  return n;
}

const allowedIds = (process.env.TELEGRAM_ALLOWED_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    if (!/^\d+$/.test(s)) {
      throw new Error(`TELEGRAM_ALLOWED_IDS 含非法 id: ${s}`);
    }
    return Number(s);
  });

if (allowedIds.length === 0) {
  console.warn("TELEGRAM_ALLOWED_IDS 为空：第一个发消息的人会自动写入白名单");
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  allowedIds,
  cursorApiKey: process.env.CURSOR_API_KEY?.trim() || "",
  cursorModel: process.env.CURSOR_MODEL?.trim() || "composer-2.5",
  vpsSecret: "",
  inventoryPath: process.env.VPS_INVENTORY
    ? path.resolve(ROOT, process.env.VPS_INVENTORY)
    : fromRoot("data", "vps.yaml"),
  sessionsPath: fromRoot("data", "sessions.json"),
  auditPath: fromRoot("data", "audit.jsonl"),
  workspacesDir: fromRoot("workspaces"),
  defaultIdentityFile:
    process.env.SSH_IDENTITY_FILE?.trim() || "/root/.ssh/id_ed25519",
  sshTimeoutMs: intEnv("SSH_TIMEOUT_MS", 20_000),
  cmdTimeoutMs: intEnv("CMD_TIMEOUT_MS", 30_000),
  cmdMaxOutput: intEnv("CMD_MAX_OUTPUT", 8_000),
  confirmTimeoutMs: intEnv("CONFIRM_TIMEOUT_MS", 180_000),
  readFileMaxBytes: intEnv("READ_FILE_MAX_BYTES", 200 * 1024),
  deployTimeoutMs: intEnv("DEPLOY_TIMEOUT_MS", 180_000),
  codehubPath: fromRoot("data", "codehub.yaml"),
  reposPath: fromRoot("data", "repos.yaml"),
  dbPath: fromRoot("data", "bot.sqlite"),
};

function upsertEnvFile(filePath: string, name: string, value: string): void {
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const line = `${name}=${value}`;
  if (new RegExp(`^${name}=`, "m").test(text)) {
    text = text.replace(new RegExp(`^${name}=.*$`, "m"), line);
  } else {
    text = text.replace(/\s*$/, "") + `\n${line}\n`;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, { mode: 0o600 });
}

function upsertEnv(name: string, value: string): void {
  upsertEnvFile(ENV_PATH, name, value);
}

function readSecretFile(filePath: string, name: string): string {
  if (!fs.existsSync(filePath)) return "";
  const text = fs.readFileSync(filePath, "utf8");
  const m = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m?.[1]?.trim() ?? text.trim();
}

function loadOrCreateVpsSecret(): string {
  const fromEnv = process.env.VPS_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16) {
    upsertEnvFile(VPS_SECRET_PATH, "VPS_SECRET", fromEnv);
    upsertEnvFile(RUNTIME_ENV_PATH, "VPS_SECRET", fromEnv);
    return fromEnv;
  }
  const fromFile =
    readSecretFile(VPS_SECRET_PATH, "VPS_SECRET") ||
    readSecretFile(RUNTIME_ENV_PATH, "VPS_SECRET");
  if (fromFile && fromFile.length >= 16) {
    process.env.VPS_SECRET = fromFile;
    upsertEnv("VPS_SECRET", fromFile);
    console.log("已从 data/vps.secret（或 runtime.env）恢复 VPS_SECRET");
    return fromFile;
  }
  const secret = randomBytes(32).toString("hex");
  process.env.VPS_SECRET = secret;
  upsertEnv("VPS_SECRET", secret);
  upsertEnvFile(VPS_SECRET_PATH, "VPS_SECRET", secret);
  upsertEnvFile(RUNTIME_ENV_PATH, "VPS_SECRET", secret);
  console.log("已生成 VPS_SECRET 并写入 .env / data/vps.secret / data/runtime.env");
  return secret;
}

config.vpsSecret = loadOrCreateVpsSecret();

export function enrollOwner(userId: number): boolean {
  if (config.allowedIds.length > 0) return false;
  config.allowedIds.push(userId);
  upsertEnv("TELEGRAM_ALLOWED_IDS", String(userId));
  console.log(`已将第一个用户 ${userId} 写入白名单`);
  return true;
}

export function ensureDataDirs(): void {
  fs.mkdirSync(fromRoot("data"), { recursive: true });
  fs.mkdirSync(config.workspacesDir, { recursive: true });
}
