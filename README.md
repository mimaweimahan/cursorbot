# Telegram VPS 运维 Bot

对话进入指定 VPS，之后把自然语言交给本机 Cursor Agent。Agent **不能**用 Bot 服务器的 shell，只通过 SSH 工具操作目标机。

## 准备

1. Node.js **22.13+**（当前机器若没有，用官方二进制即可）
2. [@BotFather](https://t.me/BotFather) 的 `TELEGRAM_BOT_TOKEN`
3. [Cursor Dashboard](https://cursor.com/dashboard/integrations) 的 `CURSOR_API_KEY`
4. Bot 所在机能 SSH 密钥登录所有目标 VPS（非交互、无私钥口令）

## 配置

```bash
cd telegrambot
cp .env.example .env
cp data/vps.yaml.example data/vps.yaml
```

编辑 `.env`：填 token、API key、你的 Telegram 数字 id（给 bot 发 `/start` 可看到）。

编辑 `data/vps.yaml`：每台机的 `id` / `host` / `user` / `identityFile`。`writable: false` 的机器只能查不能改。

```bash
npm install
npm start
```

## 用法

- `/vps` 列表，按钮进入
- `/enter web-1` 或发「进入 web-1」
- 进入后直接说：「磁盘为什么满了」「重启 nginx」「看 error log」
- `/status` 不走 Agent，直接 SSH 探测
- `/exit` 离开；`/cancel` 取消进行中的任务
- 重启、`rm -rf`、改 `sshd` 等会要求 Telegram 按钮确认

## 可迁移知识库（向量检索）

运维流程存在 `data/knowledge.sqlite`（全文 + 向量），换机带走即可。详见 [docs/KNOWLEDGE.md](./docs/KNOWLEDGE.md)。

```bash
npm run knowledge:export
npm run knowledge:import -- ./data/exports/knowledge-pack-xxx.tar.gz
```

## 安全

这是高权限 Bot。务必收紧 `TELEGRAM_ALLOWED_IDS`，私钥只放 Bot 机且权限 `600`。操作会追加到 `data/audit.jsonl`。
