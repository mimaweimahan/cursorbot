import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { getKnowledgeDb, getMeta } from "./db.ts";
import { embedMetaSummary, getEmbedder } from "./embed.ts";
import {
  getFact,
  listPlaybooks,
  reembedAll,
  savePlaybookRecord,
  setFact,
} from "./store.ts";

/** 启动时：打开库、导入遗留 markdown、补齐向量 */
export async function bootstrapKnowledge(): Promise<void> {
  getKnowledgeDb();
  const embedder = await getEmbedder();
  console.log(`知识库已就绪: ${config.knowledgeDbPath}（${embedMetaSummary()}）`);

  const imported = await importLegacyWorkspaces();
  if (imported > 0) {
    console.log(`已从 workspaces 导入 ${imported} 条 playbook 到 knowledge.sqlite`);
  }

  const missing = countMissingEmbeddings();
  if (missing > 0) {
    console.log(`补齐 ${missing} 条向量（model=${embedder.modelId}）…`);
    await reembedAll();
  }
}

function countMissingEmbeddings(): number {
  const row = getKnowledgeDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM playbooks p
       LEFT JOIN playbook_embeddings e ON e.playbook_id=p.id
       WHERE e.playbook_id IS NULL OR e.model != ?`,
    )
    .get(getMeta("embedding_model") || "") as { n: number };
  return Number(row.n);
}

async function importLegacyWorkspaces(): Promise<number> {
  const root = config.workspacesDir;
  if (!fs.existsSync(root)) return 0;
  let imported = 0;
  for (const name of fs.readdirSync(root)) {
    const vpsDir = path.join(root, name);
    if (!fs.statSync(vpsDir).isDirectory()) continue;
    if (name === "local" || name === "tmp") continue;

    const memFile = path.join(vpsDir, "MEMORY.md");
    if (fs.existsSync(memFile) && !getFact(name, "环境速查")) {
      const facts = extractSection(fs.readFileSync(memFile, "utf8"), "环境速查");
      if (facts) setFact(name, "环境速查", facts);
    }

    const pbDir = path.join(vpsDir, "playbooks");
    if (!fs.existsSync(pbDir)) continue;
    const existing = new Set(listPlaybooks(name).map((p) => p.slug));
    for (const file of fs.readdirSync(pbDir).filter((f) => f.endsWith(".md"))) {
      const slug = file.replace(/\.md$/, "");
      if (existing.has(slug)) continue;
      const raw = fs.readFileSync(path.join(pbDir, file), "utf8");
      const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug;
      const tagsLine = raw.match(/^tags:\s*(.+)$/im)?.[1] || "";
      const tags = tagsLine
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const problem =
        raw.match(/##\s*问题\s*\n+([\s\S]*?)(?=\n##\s|$)/)?.[1]?.trim() || title;
      const steps =
        raw.match(/##\s*已验证步骤\s*\n+([\s\S]*?)(?=\n##\s|$)/)?.[1]?.trim() ||
        raw;
      await savePlaybookRecord({
        vpsId: name,
        title,
        problem,
        steps,
        tags,
        source: tags.includes("auto") ? "auto" : "import",
      });
      imported++;
    }
  }
  return imported;
}

function extractSection(md: string, heading: string): string {
  const re = new RegExp(
    `##\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
  );
  return (md.match(re)?.[1] || "").trim();
}
