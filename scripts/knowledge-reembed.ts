/** 全量重建向量：npm run knowledge:reembed */
import { ensureDataDirs } from "../src/config.ts";
import { bootstrapKnowledge } from "../src/knowledge/bootstrap.ts";
import { closeKnowledgeDb } from "../src/knowledge/db.ts";
import { getEmbedder, embedMetaSummary } from "../src/knowledge/embed.ts";
import { reembedAll } from "../src/knowledge/store.ts";

ensureDataDirs();
await bootstrapKnowledge();
await getEmbedder();
const n = await reembedAll();
console.log(`reembed ${n} playbooks — ${embedMetaSummary()}`);
closeKnowledgeDb();
