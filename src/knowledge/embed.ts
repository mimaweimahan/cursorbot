import fs from "node:fs";
import { config } from "../config.ts";
import { getMeta, setMeta } from "./db.ts";

export interface Embedder {
  readonly provider: string;
  readonly modelId: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

let cached: Embedder | null = null;
let initPromise: Promise<Embedder> | null = null;

export async function getEmbedder(): Promise<Embedder> {
  if (cached) return cached;
  if (!initPromise) initPromise = createEmbedder();
  cached = await initPromise;
  return cached;
}

async function createEmbedder(): Promise<Embedder> {
  const mode = config.embeddingProvider;
  if (mode === "none") {
    const e = new HashEmbedder();
    persistEmbedMeta(e);
    return e;
  }
  if (mode === "openai" || (mode === "auto" && config.embeddingApiKey)) {
    const e = new OpenAIEmbedder();
    persistEmbedMeta(e);
    return e;
  }
  try {
    const e = await LocalTransformersEmbedder.create();
    persistEmbedMeta(e);
    return e;
  } catch (err) {
    console.warn("本地向量模型加载失败，回退 HashEmbedder:", err);
    const e = new HashEmbedder();
    persistEmbedMeta(e);
    return e;
  }
}

function persistEmbedMeta(e: Embedder): void {
  setMeta("embedding_provider", e.provider);
  setMeta("embedding_model", e.modelId);
  setMeta("embedding_dims", String(e.dims));
}

/** OpenAI 兼容 /v1/embeddings */
class OpenAIEmbedder implements Embedder {
  readonly provider = "openai";
  readonly modelId = config.embeddingModel.includes("Xenova")
    ? "text-embedding-3-small"
    : config.embeddingModel;
  dims = 1536;

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!config.embeddingApiKey) throw new Error("缺少 EMBEDDING_API_KEY");
    const url = `${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.embeddingApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.modelId, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`embedding API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    if (sorted[0]?.embedding?.length) this.dims = sorted[0].embedding.length;
    return sorted.map((d) => Float32Array.from(d.embedding));
  }
}

/** 本地 MiniLM（@xenova/transformers），模型缓存可随 data/embedding-cache 一起带走 */
class LocalTransformersEmbedder implements Embedder {
  readonly provider = "local";
  readonly modelId: string;
  dims = 384;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe: any;

  private constructor(modelId: string, pipe: unknown) {
    this.modelId = modelId;
    this.pipe = pipe;
  }

  static async create(): Promise<LocalTransformersEmbedder> {
    fs.mkdirSync(config.embeddingCacheDir, { recursive: true });
    process.env.TRANSFORMERS_CACHE = config.embeddingCacheDir;
    process.env.HF_HOME = config.embeddingCacheDir;
    const mod = await import("@xenova/transformers");
    if (mod.env) {
      mod.env.cacheDir = config.embeddingCacheDir;
      mod.env.allowLocalModels = true;
    }
    const resolved =
      config.embeddingModel.startsWith("Xenova/")
        ? config.embeddingModel
        : "Xenova/all-MiniLM-L6-v2";
    console.log(`加载本地 embedding 模型: ${resolved}（缓存 ${config.embeddingCacheDir}）`);
    const pipe = await mod.pipeline("feature-extraction", resolved, {
      quantized: true,
    });
    return new LocalTransformersEmbedder(resolved, pipe);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) {
      const result = await this.pipe(text.slice(0, 8000), {
        pooling: "mean",
        normalize: true,
      });
      const arr = Float32Array.from(result.data as ArrayLike<number>);
      this.dims = arr.length;
      out.push(arr);
    }
    return out;
  }
}

/**
 * 无模型回退：字符 n-gram 哈希向量（可带走、无下载）。
 * 语义弱于 MiniLM，但仍支持余弦检索 + FTS 混合。
 */
class HashEmbedder implements Embedder {
  readonly provider = "hash";
  readonly modelId = "hash-ngram-384";
  readonly dims = 384;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => hashEmbed(t, this.dims));
  }
}

function hashEmbed(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  const normed = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normed) return v;
  const tokens = new Set<string>();
  for (const w of normed.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 2) tokens.add(w);
  }
  for (let i = 0; i < normed.length - 1; i++) {
    tokens.add(normed.slice(i, i + 2));
  }
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    v[idx] += 1;
  }
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += v[i] * v[i];
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < dims; i++) v[i] /= n;
  return v;
}

export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVector(buf: Buffer | Uint8Array): Float32Array {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

export function embedMetaSummary(): string {
  return [
    `provider=${getMeta("embedding_provider") || "?"}`,
    `model=${getMeta("embedding_model") || "?"}`,
    `dims=${getMeta("embedding_dims") || "?"}`,
  ].join(" ");
}
