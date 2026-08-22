import fs from "node:fs";
import yaml from "js-yaml";
import { config } from "./config.ts";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./crypto.ts";

export interface CodehubConfig {
  githubRepo: string;
  githubBranch: string;
  githubTokenEnc: string;
  r2AccountId: string;
  r2AccessKeyEnc: string;
  r2SecretEnc: string;
  r2Bucket: string;
  r2Endpoint: string;
}

export function emptyCodehub(): CodehubConfig {
  return {
    githubRepo: "",
    githubBranch: "main",
    githubTokenEnc: "",
    r2AccountId: "",
    r2AccessKeyEnc: "",
    r2SecretEnc: "",
    r2Bucket: "",
    r2Endpoint: "",
  };
}

function encMaybe(value: string, existingEnc: string): string {
  const t = value.trim();
  if (!t || t === "*" || t === "-" || t === "不改") return existingEnc;
  if (isEncryptedSecret(t)) return t;
  return encryptSecret(t);
}

export function loadCodehub(): CodehubConfig {
  const base = emptyCodehub();
  if (!fs.existsSync(config.codehubPath)) return base;
  const raw = yaml.load(fs.readFileSync(config.codehubPath, "utf8")) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return base;
  const str = (k: string) => (typeof raw[k] === "string" ? raw[k].trim() : "");
  let githubTokenEnc = str("githubTokenEnc");
  let r2AccessKeyEnc = str("r2AccessKeyEnc");
  let r2SecretEnc = str("r2SecretEnc");
  let migrated = false;
  if (str("githubToken")) {
    githubTokenEnc = encryptSecret(str("githubToken"));
    migrated = true;
  }
  if (str("r2AccessKey")) {
    r2AccessKeyEnc = encryptSecret(str("r2AccessKey"));
    migrated = true;
  }
  if (str("r2Secret")) {
    r2SecretEnc = encryptSecret(str("r2Secret"));
    migrated = true;
  }
  const cfg: CodehubConfig = {
    githubRepo: str("githubRepo"),
    githubBranch: str("githubBranch") || "main",
    githubTokenEnc,
    r2AccountId: str("r2AccountId"),
    r2AccessKeyEnc,
    r2SecretEnc,
    r2Bucket: str("r2Bucket"),
    r2Endpoint: str("r2Endpoint"),
  };
  if (migrated) saveCodehub(cfg);
  return cfg;
}

export function saveCodehub(cfg: CodehubConfig): void {
  const body = yaml.dump(
    {
      githubRepo: cfg.githubRepo,
      githubBranch: cfg.githubBranch || "main",
      githubTokenEnc: cfg.githubTokenEnc,
      r2AccountId: cfg.r2AccountId,
      r2AccessKeyEnc: cfg.r2AccessKeyEnc,
      r2SecretEnc: cfg.r2SecretEnc,
      r2Bucket: cfg.r2Bucket,
      r2Endpoint: cfg.r2Endpoint,
    },
    { lineWidth: 120, noRefs: true, sortKeys: false },
  );
  fs.mkdirSync(config.codehubPath.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(
    config.codehubPath,
    `# GitHub 主仓 + Cloudflare R2 备份。token/密钥已加密。\n\n${body}`,
  );
}

export function mergeCodehubPatch(fields: Record<string, string>): CodehubConfig {
  const cur = loadCodehub();
  return {
    githubRepo: fields.githubRepo?.trim() || cur.githubRepo,
    githubBranch: fields.githubBranch?.trim() || cur.githubBranch || "main",
    githubTokenEnc: encMaybe(fields.githubToken ?? "", cur.githubTokenEnc),
    r2AccountId: fields.r2AccountId?.trim() || cur.r2AccountId,
    r2AccessKeyEnc: encMaybe(fields.r2AccessKey ?? "", cur.r2AccessKeyEnc),
    r2SecretEnc: encMaybe(fields.r2Secret ?? "", cur.r2SecretEnc),
    r2Bucket: fields.r2Bucket?.trim() || cur.r2Bucket,
    r2Endpoint: fields.r2Endpoint?.trim() || cur.r2Endpoint,
  };
}

export function githubToken(cfg = loadCodehub()): string {
  return cfg.githubTokenEnc ? decryptSecret(cfg.githubTokenEnc) : "";
}

export function r2AccessKey(cfg = loadCodehub()): string {
  return cfg.r2AccessKeyEnc ? decryptSecret(cfg.r2AccessKeyEnc) : "";
}

export function r2Secret(cfg = loadCodehub()): string {
  return cfg.r2SecretEnc ? decryptSecret(cfg.r2SecretEnc) : "";
}

export function parseRepoSlug(input: string): { owner: string; repo: string } {
  const t = input.trim().replace(/\.git$/, "");
  const m =
    /github\.com[:/]([^/]+)\/([^/]+)$/i.exec(t) ||
    /^([^/]+)\/([^/]+)$/.exec(t);
  if (!m) throw new Error("仓库格式应为 owner/repo 或 GitHub URL");
  return { owner: m[1]!, repo: m[2]! };
}

export function r2Ready(cfg = loadCodehub()): boolean {
  return Boolean(cfg.r2Bucket && cfg.r2AccountId && cfg.r2AccessKeyEnc && cfg.r2SecretEnc);
}

export function githubReady(cfg = loadCodehub()): boolean {
  return Boolean(cfg.githubTokenEnc);
}

export function statusText(cfg = loadCodehub()): string {
  return [
    `GitHub token: ${cfg.githubTokenEnc ? "已加密" : "未配置"}`,
    `R2: ${cfg.r2Bucket || "未配置"}  account=${cfg.r2AccountId || "无"}  key=${cfg.r2SecretEnc ? "已加密" : "无"}`,
    cfg.r2Endpoint ? `endpoint: ${cfg.r2Endpoint}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
