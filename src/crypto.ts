import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.ts";

const PREFIX = "v1";

function key(): Buffer {
  const secret = config.vpsSecret;
  if (!secret) {
    throw new Error("缺少 VPS_SECRET，无法加解密密码");
  }
  return createHash("sha256").update(secret).digest();
}

/** AES-256-GCM. 返回 v1.iv.tag.ciphertext（base64url），yaml 里只存这个。 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, b64(iv), b64(tag), b64(enc)].join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("密码密文格式无效，请重新添加这台机器");
  }
  const iv = unb64(parts[1]!);
  const tag = unb64(parts[2]!);
  const enc = unb64(parts[3]!);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${PREFIX}.`) && value.split(".").length === 4;
}

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
