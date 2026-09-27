/**
 * 导入知识包到 data/knowledge.sqlite
 * 用法: npx tsx scripts/knowledge-import.ts <packDir|pack.tar.gz>
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config, ensureDataDirs } from "../src/config.ts";
import { closeKnowledgeDb } from "../src/knowledge/db.ts";
import { reembedAll } from "../src/knowledge/store.ts";
import { getEmbedder } from "../src/knowledge/embed.ts";

const srcArg = process.argv[2];
if (!srcArg) {
  console.error("用法: npm run knowledge:import -- <pack目录或.tar.gz>");
  process.exit(1);
}

ensureDataDirs();
const abs = path.resolve(srcArg);
let packDir = abs;
const tmp = path.join(config.knowledgeDbPath, "..", "exports", `_import_${Date.now()}`);

if (abs.endsWith(".tar.gz") || abs.endsWith(".tgz")) {
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync("tar", ["-xzf", abs, "-C", tmp]);
  const kids = fs.readdirSync(tmp).map((n) => path.join(tmp, n));
  const dir = kids.find((p) => fs.statSync(p).isDirectory());
  if (!dir) throw new Error("压缩包内没有目录");
  packDir = dir;
}

const srcDb = path.join(packDir, "knowledge.sqlite");
if (!fs.existsSync(srcDb)) throw new Error(`缺少 ${srcDb}`);

// 停库拷贝
closeKnowledgeDb();
fs.mkdirSync(path.dirname(config.knowledgeDbPath), { recursive: true });
for (const ext of ["", "-wal", "-shm"]) {
  const p = config.knowledgeDbPath + ext;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
fs.copyFileSync(srcDb, config.knowledgeDbPath);

const cacheSrc = path.join(packDir, "embedding-cache");
if (fs.existsSync(cacheSrc)) {
  fs.mkdirSync(config.embeddingCacheDir, { recursive: true });
  execFileSync("cp", ["-a", `${cacheSrc}/.`, config.embeddingCacheDir]);
  console.log(`已恢复 embedding-cache → ${config.embeddingCacheDir}`);
}

const metaPath = path.join(packDir, "meta.json");
if (fs.existsSync(metaPath)) {
  console.log("pack meta:", fs.readFileSync(metaPath, "utf8"));
}

const embedder = await getEmbedder();
console.log(`当前 embedder: ${embedder.provider} ${embedder.modelId}`);
const n = await reembedAll();
console.log(`已校验/重建 ${n} 条向量`);
closeKnowledgeDb();
console.log(`导入完成 → ${config.knowledgeDbPath}`);
