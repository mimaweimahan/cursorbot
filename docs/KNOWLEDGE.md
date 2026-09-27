# 可迁移运维知识库（Knowledge Pack）

权威存储：`data/knowledge.sqlite`（playbook 全文 + 向量 + 环境速查 + 对话摘要）。

上下文策略：每次对话只注入短索引 + 向量/FTS Top1，不把整库塞进 prompt。

## 文件清单（换机带走）

| 路径 | 必须 | 说明 |
|------|------|------|
| `data/knowledge.sqlite` | ✅ | 知识库本体 |
| `data/embedding-cache/` | 本地向量时建议 | MiniLM 模型缓存，避免重下 |
| `data/bot.sqlite` | 台账/会话 | 与知识库分离；含加密字段时还需 `VPS_SECRET` |
| `workspaces/*/playbooks/*.md` | 可选 | 可读镜像，非权威 |

## Embedding

默认 `EMBEDDING_PROVIDER=auto`：

1. 若配置了 `EMBEDDING_API_KEY` → OpenAI 兼容 `/v1/embeddings`
2. 否则本地 `@xenova/transformers` → `Xenova/all-MiniLM-L6-v2`
3. 本地失败 → Hash 回退（仍可检索，语义较弱）

```bash
# .env 可选
EMBEDDING_PROVIDER=auto          # auto | local | openai | none
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
# EMBEDDING_API_KEY=
# EMBEDDING_BASE_URL=https://api.openai.com/v1
# KNOWLEDGE_DB=./data/knowledge.sqlite
# EMBEDDING_CACHE_DIR=./data/embedding-cache
```

## 命令

```bash
npm run knowledge:export              # 打出 tar.gz 知识包
npm run knowledge:import -- ./xxx.tar.gz
npm run knowledge:reembed             # 换模型后重建向量
```

## 检索

混合打分：`0.65 * cosine(向量) + 0.30 * FTS + 主题加成`，只把 Top1 注入 Agent prompt。
