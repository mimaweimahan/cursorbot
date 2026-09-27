/**
 * 导出可迁移知识包：knowledge.sqlite + meta +（可选）embedding-cache
 * 用法: npx tsx scripts/knowledge-export.ts [outdir]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config, ensureDataDirs } from "../src/config.ts";
import { bootstrapKnowledge } from "../src/knowledge/bootstrap.ts";
import { checkpointKnowledgeDb, closeKnowledgeDb, getMeta } from "../src/knowledge/db.ts";
import { embedMetaSummary } from "../src/knowledge/embed.ts";

ensureDataDirs();
await bootstrapKnowledge();
checkpointKnowledgeDb();

const outDir = path.resolve(process.argv[2] || path.join(config.knowledgeDbPath, "..", "exports"));
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const packName = `knowledge-pack-${stamp}`;
const packDir = path.join(outDir, packName);
fs.mkdirSync(packDir, { recursive: true });

fs.copyFileSync(config.knowledgeDbPath, path.join(packDir, "knowledge.sqlite"));

const meta = {
  version: 1,
  exportedAt: new Date().toISOString(),
  embedding: {
    provider: getMeta("embedding_provider"),
    model: getMeta("embedding_model"),
    dims: getMeta("embedding_dims"),
  },
  summary: embedMetaSummary(),
  note: "换机：解压后执行 npm run knowledge:import -- <本目录>，并拷贝 embedding-cache（若用 local）",
};
fs.writeFileSync(path.join(packDir, "meta.json"), JSON.stringify(meta, null, 2));
fs.writeFileSync(
  path.join(packDir, "README.md"),
  [
    "# Knowledge Pack",
    "",
    `- exported: ${meta.exportedAt}`,
    `- ${meta.summary}`,
    "",
    "## 迁移步骤",
    "",
    "1. 把整个 pack 目录拷到新机器",
    "2. `cd telegrambot && npm install`",
    "3. `npm run knowledge:import -- /path/to/this-pack`",
    "4. 若 embedding.provider=local，同时拷贝 `data/embedding-cache/`（或让新机重新下载模型后 `npm run knowledge:reembed`）",
    "5. `systemctl restart telegrambot`",
    "",
  ].join("\n"),
);

// 可选打包 cache（可能较大）
const cache = config.embeddingCacheDir;
let cacheNote = "skipped";
if (fs.existsSync(cache) && fs.readdirSync(cache).length > 0) {
  const destCache = path.join(packDir, "embedding-cache");
  execFileSync("cp", ["-a", cache, destCache]);
  cacheNote = "included";
}

const tarPath = path.join(outDir, `${packName}.tar.gz`);
execFileSync("tar", ["-czf", tarPath, "-C", outDir, packName]);
closeKnowledgeDb();

console.log(`已导出: ${tarPath}`);
console.log(`embedding-cache: ${cacheNote}`);
console.log(meta.summary);
