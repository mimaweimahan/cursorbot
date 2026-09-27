import { ensureDataDirs } from "../src/config.ts";
import { memoryIndex, retrieveForPrompt } from "../src/cursor/memory.ts";
import { bootstrapKnowledge } from "../src/knowledge/bootstrap.ts";
import { closeKnowledgeDb } from "../src/knowledge/db.ts";
import { listPlaybooks, searchHybrid } from "../src/knowledge/store.ts";

ensureDataDirs();
await bootstrapKnowledge();
console.log(
  "playbooks",
  listPlaybooks("vps-5").map((p) => p.slug),
);
const hits = await searchHybrid("vps-5", "检查最近七天的订单记录", 3);
console.log(
  "hits",
  hits.map((h) => ({
    slug: h.playbook.slug,
    score: h.score.toFixed(3),
    vec: h.vectorScore.toFixed(3),
    fts: h.ftsScore.toFixed(3),
  })),
);
console.log("INDEX_LEN", memoryIndex("vps-5").length);
console.log((await retrieveForPrompt("vps-5", "查7天订单")).slice(0, 320));
closeKnowledgeDb();
