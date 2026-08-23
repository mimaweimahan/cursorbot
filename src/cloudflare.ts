import { createHash } from "node:crypto";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const CF = "https://api.cloudflare.com/client/v4";
const DEFAULT_BUCKET = "cursorbot";

export interface R2Provision {
  r2AccountId: string;
  r2AccountName: string;
  r2AccessKey: string;
  r2Secret: string;
  r2Bucket: string;
  r2Endpoint: string;
  createdBucket: boolean;
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
}

async function cf<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CF}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as CfEnvelope<T>;
  if (!res.ok || !body.success || body.result === undefined) {
    const msg = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || res.statusText;
    throw new Error(`Cloudflare API ${path} 失败: ${msg}`);
  }
  return body.result;
}

export async function provisionR2FromApiToken(
  apiToken: string,
  preferBucket?: string,
): Promise<R2Provision> {
  const token = apiToken.trim();
  if (!token || token === "*") throw new Error("请填写 Cloudflare API Token");

  const verified = await cf<{ id: string; status: string }>(token, "/user/tokens/verify");
  if (verified.status && verified.status !== "active") {
    throw new Error(`这个 Token 状态是 ${verified.status}，不能用`);
  }
  const accessKey = verified.id;
  if (!accessKey) throw new Error("Token 校验成功但没有 id，无法生成 R2 Access Key");

  const accounts = await cf<Array<{ id: string; name: string }>>(token, "/accounts");
  if (!accounts.length) throw new Error("这个 Token 看不到任何账号");
  const account = accounts[0]!;
  const accountId = account.id;

  const listed = await cf<{ buckets?: Array<{ name?: string }> } | Array<{ name?: string }>>(
    token,
    `/accounts/${accountId}/r2/buckets`,
  );
  const rawBuckets = Array.isArray(listed) ? listed : listed.buckets ?? [];
  const names = rawBuckets.map((b) => b.name).filter((n): n is string => Boolean(n));
  const wanted = (preferBucket || "").trim() || names[0] || DEFAULT_BUCKET;
  let createdBucket = false;
  if (!names.includes(wanted)) {
    await cf(token, `/accounts/${accountId}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name: wanted }),
    });
    createdBucket = true;
  }

  const secret = createHash("sha256").update(token).digest("hex");
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: wanted }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `R2 桶已就绪，但 S3 访问校验失败: ${message}。请给 Token 加上 Account → Workers R2 Storage → Edit。`,
    );
  }

  return {
    r2AccountId: accountId,
    r2AccountName: account.name,
    r2AccessKey: accessKey,
    r2Secret: secret,
    r2Bucket: wanted,
    r2Endpoint: endpoint,
    createdBucket,
  };
}
