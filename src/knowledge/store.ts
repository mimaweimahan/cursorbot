import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { getKnowledgeDb } from "./db.ts";
import {
  blobToVector,
  cosine,
  getEmbedder,
  vectorToBlob,
  type Embedder,
} from "./embed.ts";

export interface PlaybookRecord {
  id: string;
  vpsId: string;
  slug: string;
  title: string;
  problem: string;
  steps: string;
  tags: string[];
  source: string;
  updatedAt: string;
}

export interface SearchHit {
  playbook: PlaybookRecord;
  score: number;
  vectorScore: number;
  ftsScore: number;
  snippet: string;
}

const TOPIC_WORDS = [
  "订单",
  "提现",
  "充值",
  "实名",
  "用户",
  "注册",
  "nginx",
  "ssl",
  "证书",
  "域名",
  "mysql",
  "数据库",
  "部署",
  "备份",
];

export function canonicalizePlaybookTitle(title: string): string {
  return title
    .replace(/最近\s*[0-9一二三四五六七八九十两]+\s*天/g, "近N天")
    .replace(/近\s*[0-9一二三四五六七八九十两]+\s*天/g, "近N天")
    .replace(/[0-9一二三四五六七八九十两]+\s*天/g, "N天")
    .replace(/last\s*\d+\s*days?/gi, "近N天")
    .trim();
}

export function slugify(title: string): string {
  const base = canonicalizePlaybookTitle(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `playbook-${Date.now().toString(36)}`;
}

function hashContent(title: string, problem: string, steps: string, tags: string[]): string {
  return createHash("sha256")
    .update([title, problem, steps, tags.join(",")].join("\n"))
    .digest("hex")
    .slice(0, 32);
}

function rowToPlaybook(row: Record<string, unknown>): PlaybookRecord {
  let tags: string[] = [];
  try {
    tags = JSON.parse(String(row.tags_json || "[]")) as string[];
  } catch {
    tags = [];
  }
  return {
    id: String(row.id),
    vpsId: String(row.vps_id),
    slug: String(row.slug),
    title: String(row.title),
    problem: String(row.problem || ""),
    steps: String(row.steps || ""),
    tags,
    source: String(row.source || "manual"),
    updatedAt: String(row.updated_at || ""),
  };
}

export function listPlaybooks(vpsId: string): PlaybookRecord[] {
  const rows = getKnowledgeDb()
    .prepare(
      `SELECT * FROM playbooks WHERE vps_id=? ORDER BY updated_at DESC`,
    )
    .all(vpsId) as Record<string, unknown>[];
  return rows.map(rowToPlaybook);
}

export function getPlaybookBySlug(vpsId: string, slug: string): PlaybookRecord | null {
  const row = getKnowledgeDb()
    .prepare(`SELECT * FROM playbooks WHERE vps_id=? AND slug=?`)
    .get(vpsId, slug) as Record<string, unknown> | undefined;
  return row ? rowToPlaybook(row) : null;
}

export function getPlaybookById(id: string): PlaybookRecord | null {
  const row = getKnowledgeDb()
    .prepare(`SELECT * FROM playbooks WHERE id=?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToPlaybook(row) : null;
}

export function getFact(vpsId: string, section: string): string {
  const row = getKnowledgeDb()
    .prepare(`SELECT content FROM vps_facts WHERE vps_id=? AND section=?`)
    .get(vpsId, section) as { content: string } | undefined;
  return row?.content || "";
}

export function setFact(vpsId: string, section: string, content: string): void {
  const now = new Date().toISOString();
  getKnowledgeDb()
    .prepare(
      `INSERT INTO vps_facts(vps_id, section, content, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(vps_id, section) DO UPDATE SET
         content=excluded.content, updated_at=excluded.updated_at`,
    )
    .run(vpsId, section, content, now);
}

export async function savePlaybookRecord(input: {
  vpsId: string;
  title: string;
  problem: string;
  steps: string;
  tags?: string[];
  source?: string;
}): Promise<PlaybookRecord> {
  const title = canonicalizePlaybookTitle(input.title.trim() || "untitled");
  const problem = canonicalizePlaybookTitle(input.problem.trim() || title);
  const steps = input.steps.trim();
  const tags = [...(input.tags ?? [])];
  for (const topic of TOPIC_WORDS) {
    if ((problem + title + steps).includes(topic) && !tags.includes(topic)) {
      tags.push(topic);
    }
  }
  const slug = slugify(title);
  const now = new Date().toISOString();
  const contentHash = hashContent(title, problem, steps, tags);
  const db = getKnowledgeDb();
  const existing = db
    .prepare(`SELECT id, content_hash FROM playbooks WHERE vps_id=? AND slug=?`)
    .get(input.vpsId, slug) as { id: string; content_hash: string } | undefined;

  let id = existing?.id || randomUUID();
  if (existing) {
    db.prepare(
      `UPDATE playbooks SET title=?, problem=?, steps=?, tags_json=?, source=?,
       content_hash=?, updated_at=? WHERE id=?`,
    ).run(
      title,
      problem,
      steps,
      JSON.stringify(tags),
      input.source || "manual",
      contentHash,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO playbooks(id, vps_id, slug, title, problem, steps, tags_json, source, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.vpsId,
      slug,
      title,
      problem,
      steps,
      JSON.stringify(tags),
      input.source || "manual",
      contentHash,
      now,
      now,
    );
  }

  pruneAuto(input.vpsId);
  mirrorPlaybookMarkdown(input.vpsId, slug, title, problem, steps, tags);
  syncFts(id, input.vpsId, title, problem, steps, tags);

  const rec = getPlaybookById(id)!;
  if (!existing || existing.content_hash !== contentHash) {
    await embedPlaybook(rec);
  }
  return rec;
}

function syncFts(
  id: string,
  vpsId: string,
  title: string,
  problem: string,
  steps: string,
  tags: string[],
): void {
  const db = getKnowledgeDb();
  db.prepare(`DELETE FROM playbooks_fts WHERE id=?`).run(id);
  db.prepare(
    `INSERT INTO playbooks_fts(id, vps_id, title, problem, steps, tags) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, vpsId, title, problem, steps, tags.join(" "));
}

export async function embedPlaybook(rec: PlaybookRecord, embedder?: Embedder): Promise<void> {
  const e = embedder || (await getEmbedder());
  const text = [
    rec.title,
    rec.problem,
    rec.tags.join(" "),
    rec.steps.slice(0, 6000),
  ].join("\n");
  const [vec] = await e.embed([text]);
  const now = new Date().toISOString();
  getKnowledgeDb()
    .prepare(
      `INSERT INTO playbook_embeddings(playbook_id, model, dims, vector, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(playbook_id) DO UPDATE SET
         model=excluded.model, dims=excluded.dims, vector=excluded.vector, updated_at=excluded.updated_at`,
    )
    .run(rec.id, e.modelId, vec.length, vectorToBlob(vec), now);
}

export async function reembedAll(vpsId?: string): Promise<number> {
  const e = await getEmbedder();
  const rows = vpsId
    ? (getKnowledgeDb()
        .prepare(`SELECT * FROM playbooks WHERE vps_id=?`)
        .all(vpsId) as Record<string, unknown>[])
    : (getKnowledgeDb().prepare(`SELECT * FROM playbooks`).all() as Record<string, unknown>[]);
  let n = 0;
  for (const row of rows) {
    await embedPlaybook(rowToPlaybook(row), e);
    n++;
  }
  return n;
}

export async function searchHybrid(
  vpsId: string,
  query: string,
  limit = 5,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const embedder = await getEmbedder();
  const [qVec] = await embedder.embed([canonicalizePlaybookTitle(q)]);

  const all = listPlaybooks(vpsId);
  const embRows = getKnowledgeDb()
    .prepare(
      `SELECT e.playbook_id, e.vector, e.model FROM playbook_embeddings e
       JOIN playbooks p ON p.id=e.playbook_id WHERE p.vps_id=?`,
    )
    .all(vpsId) as { playbook_id: string; vector: Buffer; model: string }[];
  const embMap = new Map(embRows.map((r) => [r.playbook_id, r]));

  // FTS
  const ftsMap = new Map<string, number>();
  try {
    const ftsQuery = buildFtsQuery(q);
    if (ftsQuery) {
      const ftsRows = getKnowledgeDb()
        .prepare(
          `SELECT id, bm25(playbooks_fts) AS rank
           FROM playbooks_fts
           WHERE playbooks_fts MATCH ? AND vps_id=?
           ORDER BY rank
           LIMIT 20`,
        )
        .all(ftsQuery, vpsId) as { id: string; rank: number }[];
      // bm25 越小越好 → 转成 0..1
      for (const r of ftsRows) {
        const score = 1 / (1 + Math.max(0, Number(r.rank)));
        ftsMap.set(r.id, score);
      }
    }
  } catch {
    /* FTS 语法失败时忽略，纯向量 */
  }

  const hits: SearchHit[] = [];
  for (const pb of all) {
    let vectorScore = 0;
    const emb = embMap.get(pb.id);
    if (emb && emb.model === embedder.modelId) {
      vectorScore = cosine(qVec, blobToVector(emb.vector));
    } else if (emb) {
      // 模型不一致仍可比，但降权
      vectorScore = cosine(qVec, blobToVector(emb.vector)) * 0.5;
    }
    const ftsScore = ftsMap.get(pb.id) || 0;
    const hay = `${pb.slug}\n${pb.title}\n${pb.problem}\n${pb.tags.join(",")}`;
    let topicBoost = 0;
    let topicPenalty = 0;
    for (const t of TOPIC_WORDS) {
      const qHas = q.includes(t);
      const pHas = hay.includes(t);
      if (qHas && pHas) topicBoost += 0.18; // 主题对齐强加权（避免「注册」命中「订单」）
      if (qHas && !pHas) topicPenalty += 0.04;
    }
    // 标题/slug 直接包含查询核心词
    const canonQ = canonicalizePlaybookTitle(q);
    if (hay.includes("注册") && canonQ.includes("注册")) topicBoost += 0.12;
    if (hay.includes("订单") && canonQ.includes("订单")) topicBoost += 0.12;
    if (hay.includes("提现") && canonQ.includes("提现")) topicBoost += 0.12;
    // 错配：问注册却是订单标题
    if (canonQ.includes("注册") && hay.includes("订单") && !hay.includes("注册")) {
      topicPenalty += 0.25;
    }
    if (canonQ.includes("订单") && hay.includes("注册") && !hay.includes("订单")) {
      topicPenalty += 0.25;
    }
    const score = Math.max(
      0,
      vectorScore * 0.5 + ftsScore * 0.25 + topicBoost - topicPenalty,
    );
    if (score < 0.12 && ftsScore === 0 && vectorScore < 0.25 && topicBoost < 0.1) continue;
    hits.push({
      playbook: pb,
      score,
      vectorScore,
      ftsScore,
      snippet: clip(`${pb.title} — ${pb.steps}`.replace(/\s+/g, " "), 220),
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export function appendTurn(opts: {
  vpsId: string;
  question: string;
  answer: string;
  tools: string[];
  ok: boolean;
}): void {
  getKnowledgeDb()
    .prepare(
      `INSERT INTO turns(vps_id, ts, question, answer, tools_json, ok)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.vpsId,
      new Date().toISOString(),
      clip(opts.question, 300),
      clip(opts.answer, 1500),
      JSON.stringify(opts.tools.slice(0, 40)),
      opts.ok ? 1 : 0,
    );
  // 保留最近 200 条/机
  getKnowledgeDb()
    .prepare(
      `DELETE FROM turns WHERE vps_id=? AND id NOT IN (
         SELECT id FROM turns WHERE vps_id=? ORDER BY id DESC LIMIT 200
       )`,
    )
    .run(opts.vpsId, opts.vpsId);
}

export function formatPlaybookMarkdown(pb: PlaybookRecord): string {
  return [
    `# ${pb.title}`,
    "",
    `tags: ${pb.tags.join(", ") || "general"}`,
    `updated: ${pb.updatedAt}`,
    `id: ${pb.id}`,
    "",
    "## 问题",
    "",
    pb.problem,
    "",
    "## 参数说明",
    "",
    "- 时间窗（N天）、域名、ID 等是参数：同类只改参数，不重探路径。",
    "",
    "## 已验证步骤",
    "",
    pb.steps,
    "",
  ].join("\n");
}

function mirrorPlaybookMarkdown(
  vpsId: string,
  slug: string,
  title: string,
  problem: string,
  steps: string,
  tags: string[],
): void {
  try {
    const dir = path.join(config.workspacesDir, vpsId, "playbooks");
    fs.mkdirSync(dir, { recursive: true });
    const body = formatPlaybookMarkdown({
      id: "",
      vpsId,
      slug,
      title,
      problem,
      steps,
      tags,
      source: "manual",
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(dir, `${slug}.md`), body);
  } catch (err) {
    console.warn("mirror playbook md failed", err);
  }
}

function pruneAuto(vpsId: string): void {
  const autos = listPlaybooks(vpsId).filter((p) => p.tags.includes("auto") || p.source === "auto");
  if (autos.length <= 15) return;
  const db = getKnowledgeDb();
  for (const old of autos.slice(15)) {
    db.prepare(`DELETE FROM playbook_embeddings WHERE playbook_id=?`).run(old.id);
    db.prepare(`DELETE FROM playbooks_fts WHERE id=?`).run(old.id);
    db.prepare(`DELETE FROM playbooks WHERE id=?`).run(old.id);
  }
}

function buildFtsQuery(raw: string): string {
  const parts = canonicalizePlaybookTitle(raw)
    .split(/[^\p{L}\p{N}]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 8);
  if (!parts.length) return "";
  // 简单 AND：token*
  return parts.map((p) => `"${p.replace(/"/g, "")}"`).join(" OR ");
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
