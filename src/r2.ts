import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  loadCodehub,
  parseRepoSlug,
  r2AccessKey,
  r2Ready,
  r2Secret,
  type CodehubConfig,
} from "./codehub.ts";

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

export function r2Key(repo: string, branch: string): string {
  const { owner, repo: name } = parseRepoSlug(repo);
  return `github/${owner}/${name}/${branch}/latest.tar.gz`;
}

export async function r2PutTarball(buf: Buffer, repo: string, branch: string): Promise<string> {
  const cfg = loadCodehub();
  if (!r2Ready(cfg)) throw new Error("还没配置 Cloudflare R2，先点「代码仓库」填写模板");
  const key = r2Key(repo, branch);
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

export async function r2GetTarball(repo: string, branch: string): Promise<Buffer> {
  const cfg = loadCodehub();
  if (!r2Ready(cfg)) throw new Error("还没配置 Cloudflare R2");
  const key = r2Key(repo, branch);
  const out = await client(cfg).send(
    new GetObjectCommand({ Bucket: cfg.r2Bucket, Key: key }),
  );
  const bytes = await out.Body?.transformToByteArray();
  if (!bytes) throw new Error(`R2 没有备份 ${key}`);
  return Buffer.from(bytes);
}
