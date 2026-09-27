/**
 * 运维记忆门面：对外保持原 API，底层改为 knowledge.sqlite + 向量检索。
 * 磁盘 markdown 仅为可读镜像；迁移请带走 data/knowledge.sqlite（+ embedding-cache）。
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import type { VpsHost } from "../types.ts";
import { embedMetaSummary } from "../knowledge/embed.ts";
import {
  appendTurn,
  formatPlaybookMarkdown,
  getFact,
  getPlaybookBySlug,
  listPlaybooks,
  savePlaybookRecord,
  searchHybrid,
  setFact,
} from "../knowledge/store.ts";

const MAX_INDEX_CHARS = 1_200;
const MAX_RETRIEVED_BODY = 2_200;
const RETRIEVE_MIN_SCORE = 0.28;

export function vpsWorkspaceDir(vpsId: string): string {
  return path.join(config.workspacesDir, vpsId);
}

export function ensureVpsMemory(vps: VpsHost): string {
  const dir = vpsWorkspaceDir(vps.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "playbooks"), { recursive: true });

  fs.writeFileSync(
    path.join(dir, "README.md"),
    [
      `# ${vps.name} (${vps.id})`,
      "",
      `- Host: \`${vps.user}@${vps.host}:${vps.port}\``,
      `- Writable: ${vps.writable}`,
      "",
      "权威数据在 `data/knowledge.sqlite`（向量+全文）。",
      "本目录 markdown 是可读镜像；换机请用 `npm run knowledge:export`。",
      "",
    ].join("\n"),
  );

  if (!getFact(vps.id, "环境速查")) {
    setFact(
      vps.id,
      "环境速查",
      [
        "- 系统 / 面板：（待补充）",
        "- Web / Nginx：（待补充）",
        "- PHP / 站点根目录：（待补充）",
        "- 数据库：（待补充，勿写密码）",
        "- 业务要点：（待补充）",
      ].join("\n"),
    );
  }

  // 可读 MEMORY 镜像
  const facts = getFact(vps.id, "环境速查");
  fs.writeFileSync(
    path.join(dir, "MEMORY.md"),
    [`# ${vps.name} (${vps.id}) 运维记忆`, "", "## 环境速查", "", facts, ""].join("\n"),
  );
  return dir;
}

export function listPlaybookFiles(vpsId: string): { name: string; title: string }[] {
  return listPlaybooks(vpsId).map((p) => ({
    name: `${p.slug}.md`,
    title: p.title,
  }));
}

export function memoryIndex(vpsId: string, maxChars = MAX_INDEX_CHARS): string {
  const parts: string[] = [];
  const facts = getFact(vpsId, "环境速查");
  if (facts) {
    parts.push("### 环境速查（稳定事实）");
    parts.push(clip(facts, 600));
  }
  const books = listPlaybooks(vpsId);
  parts.push(
    `### playbook 目录（共 ${books.length}，库=${path.basename(config.knowledgeDbPath)}；${embedMetaSummary()}）`,
  );
  if (!books.length) parts.push("（空）");
  else {
    for (const b of books.slice(0, 12)) {
      const tag = b.tags.length ? ` [${b.tags.slice(0, 3).join(",")}]` : "";
      parts.push(`- ${b.slug}.md${tag}`);
    }
    if (books.length > 12) parts.push(`- …另有 ${books.length - 12} 条，请 memory_search`);
  }
  return clip(parts.join("\n"), maxChars);
}

export function memoryBrief(vpsId: string, maxChars = MAX_INDEX_CHARS): string {
  return memoryIndex(vpsId, maxChars);
}

export async function retrieveForPrompt(vpsId: string, userQuestion: string): Promise<string> {
  const hits = await searchHybrid(vpsId, userQuestion, 3);
  const top = hits[0];
  if (!top || top.score < RETRIEVE_MIN_SCORE) {
    return [
      "### 本轮检索（向量+FTS）",
      "未自动附带流程正文。可先 memory_search 主题词。",
      `参数提示: ${describeParamHints(userQuestion)}`,
    ].join("\n");
  }
  const body = clip(formatPlaybookMarkdown(top.playbook), MAX_RETRIEVED_BODY);
  return [
    "### 本轮检索（向量+FTS Top1）",
    `命中: ${top.playbook.slug}.md（综合 ${top.score.toFixed(3)} / 向量 ${top.vectorScore.toFixed(3)} / FTS ${top.ftsScore.toFixed(3)}）`,
    `参数提示: ${describeParamHints(userQuestion)}`,
    "不够用再 memory_search / memory_read；禁止通读知识库。",
    "",
    body,
  ].join("\n");
}

export async function searchPlaybooks(vpsId: string, query: string, limit = 5): Promise<string> {
  const hits = await searchHybrid(vpsId, query, limit);
  if (!hits.length) {
    return `未找到与「${query}」相关的 playbook。可用 memory_save_playbook 新建。`;
  }
  return hits
    .map(
      (h, i) =>
        `${i + 1}. ${h.playbook.slug}.md (${h.playbook.title}) [score=${h.score.toFixed(3)} vec=${h.vectorScore.toFixed(3)} fts=${h.ftsScore.toFixed(3)}]\n   ${h.snippet}`,
    )
    .join("\n\n");
}

export function readWorkspaceNote(vpsId: string, relPath: string): string {
  const n = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (n === "MEMORY.md") {
    return `## 环境速查\n\n${getFact(vpsId, "环境速查") || "（空）"}`;
  }
  if (n === "README.md") {
    const p = path.join(vpsWorkspaceDir(vpsId), "README.md");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "（无）";
  }
  const m = n.match(/^playbooks\/(.+)\.md$/);
  if (m) {
    const pb = getPlaybookBySlug(vpsId, m[1]);
    if (!pb) throw new Error(`不存在: ${n}`);
    return formatPlaybookMarkdown(pb);
  }
  throw new Error("只允许读 MEMORY.md / README.md / playbooks/<slug>.md");
}

export interface PlaybookInput {
  title: string;
  problem: string;
  steps: string;
  tags?: string[];
}

export async function savePlaybook(vpsId: string, input: PlaybookInput): Promise<string> {
  const rec = await savePlaybookRecord({
    vpsId,
    title: input.title,
    problem: input.problem,
    steps: input.steps,
    tags: input.tags,
    source: input.tags?.includes("auto") ? "auto" : "manual",
  });
  return `已保存到 knowledge.sqlite → ${rec.slug}.md（已更新向量）`;
}

export function recordTurn(opts: {
  vpsId: string;
  question: string;
  answer: string;
  tools: string[];
  ok: boolean;
}): void {
  appendTurn(opts);

  // 同步一份 history 镜像（可选）
  try {
    const p = path.join(vpsWorkspaceDir(opts.vpsId), "history.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(
      p,
      JSON.stringify({
        ts: new Date().toISOString(),
        question: opts.question.slice(0, 300),
        ok: opts.ok,
      }) + "\n",
    );
  } catch {
    /* ignore */
  }

  if (!opts.ok) return;
  if (opts.tools.includes("memory_save_playbook")) return;
  const meaningful = opts.tools.filter(
    (t) => !["memory_list", "memory_search", "memory_read", "metrics"].includes(t),
  );
  if (meaningful.length < 2) return;
  if (opts.answer.trim().length < 80) return;

  void savePlaybook(opts.vpsId, {
    title: opts.question.slice(0, 48),
    problem: opts.question,
    steps: ["（自动草稿）", "", `工具: ${opts.tools.join(", ")}`, "", opts.answer.slice(0, 3000)].join(
      "\n",
    ),
    tags: ["auto"],
  }).catch((err) => console.warn("auto playbook save failed", err));
}

function describeParamHints(question: string): string {
  const day =
    question.match(/最近\s*([0-9一二三四五六七八九十两]+)\s*天/)?.[1] ||
    question.match(/近\s*([0-9一二三四五六七八九十两]+)\s*天/)?.[1] ||
    question.match(/([0-9]+)\s*天/)?.[1];
  if (day) return `时间窗=${day}天（只改时间条件，勿重探库表）`;
  return "无特殊时间参数";
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
