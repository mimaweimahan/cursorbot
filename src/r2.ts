import fs from "node:fs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  loadCodehub,
  r2AccessKey,
  r2Ready,
  r2Secret,
  type CodehubConfig,
} from "./codehub.ts";
import type { CodeRepo } from "./types.ts";

function client(cfg: CodehubConfig): S3Client {
  const endpoint =
    cfg.r2Endpoint || `https://${cfg.r2AccountId}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: r2AccessKey(cfg),
      secretAccessKey: r2Secret(cfg),
    },
  });
}

export const R2_ALIGN_RULES = [
  "R2 备份名称对齐规则（必须遵守）：",
  "1. 一个便签 = 一个 GitHub 仓库 = 一份 R2 对象。便签全局唯一。",
  "2. R2 对象名只用便签，不用 GitHub 仓库名，也不另起项目名或桶名。",
  "3. 固定路径：projects/{便签}/latest.tar.gz",
  "4. 备份写入、部署读取，都只认这条路径。便签差一个字就是另一份备份。",
  "5. 改便签等于换路径，旧对象不会自动跟着走。",
].join("\n");

export function r2Key(repo: CodeRepo): string {
  const tag = repo.name.trim();
  if (!tag || /[\\/]/.test(tag)) {
    throw new Error("便签不能为空，也不能含 /");
  }
  return `projects/${tag}/latest.tar.gz`;
}

export function r2AlignLine(repo: CodeRepo): string {
  return `${repo.name} → ${r2Key(repo)}`;
}

export async function r2PutTarball(buf: Buffer, repo: CodeRepo): Promise<string> {
  const cfg = loadCodehub();
  if (!r2Ready(cfg)) throw new Error("还没配置 Cloudflare R2，先点「代码仓库」填写模板");
  const key = r2Key(repo);
  await client(cfg).send(
    new PutObjectCommand({
      Bucket: cfg.r2Bucket,
      Key: key,
      Body: buf,
      ContentType: "application/gzip",
    }),
  );
  return key;
}

export async function r2PutTarballFile(filePath: string, repo: CodeRepo): Promise<string> {
  const cfg = loadCodehub();
  if (!r2Ready(cfg)) throw new Error("还没配置 Cloudflare R2，先点「代码仓库」填写模板");
  const key = r2Key(repo);
  const size = fs.statSync(filePath).size;
  await client(cfg).send(
    new PutObjectCommand({
      Bucket: cfg.r2Bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: size,
      ContentType: "application/gzip",
    }),
  );
  return key;
}

export async function r2GetTarball(repo: CodeRepo): Promise<Buffer> {
  const cfg = loadCodehub();
  if (!r2Ready(cfg)) throw new Error("还没配置 Cloudflare R2");
  const key = r2Key(repo);
  const out = await client(cfg).send(
    new GetObjectCommand({ Bucket: cfg.r2Bucket, Key: key }),
  );
  const bytes = await out.Body?.transformToByteArray();
  if (!bytes) throw new Error(`R2 还没有「${repo.name}」的备份，先按 GitHub 列表备份一次`);
  return Buffer.from(bytes);
}
