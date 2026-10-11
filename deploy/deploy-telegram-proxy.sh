#!/usr/bin/env bash
# 用 Cloudflare API 部署 Telegram 反代 Worker（workers.dev，无需自有域名）
# 用法：
#   CF_API_TOKEN=xxx ./deploy/deploy-telegram-proxy.sh
# 可选：CF_ACCOUNT_ID=...  WORKER_NAME=cursorbot-tg-api
set -euo pipefail

TOKEN="${CF_API_TOKEN:-}"
ACCOUNT_ID="${CF_ACCOUNT_ID:-2fe0f37b124320e33c4c3b1868b4fcad}"
NAME="${WORKER_NAME:-cursorbot-tg-api}"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/telegram-api-proxy-worker.js"
RUNTIME_ENV="/www/wwwroot/cursorbot/data/runtime.env"

if [[ -z "$TOKEN" ]]; then
  echo "请设置 CF_API_TOKEN（需 Workers 编辑权限）"
  echo "例: CF_API_TOKEN=... $0"
  exit 1
fi

# 模块格式上传：Cloudflare 接受 module worker
# 使用 script 上传 API
BODY=$(python3 - <<PY
import json
from pathlib import Path
src = Path("$SCRIPT_PATH").read_text()
# 转为 service-worker 兼容：export default → addEventListener 更稳妥用 modules
meta = {
  "main_module": "worker.js",
  "compatibility_date": "2024-11-12",
}
print(json.dumps({"metadata": meta}))
PY
)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$SCRIPT_PATH" "$TMP/worker.js"
# metadata as file for multipart
python3 - <<PY >"$TMP/metadata.json"
import json
print(json.dumps({
  "main_module": "worker.js",
  "compatibility_date": "2024-11-12",
}))
PY

RESP=$(curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${NAME}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "metadata=@${TMP}/metadata.json;type=application/json" \
  -F "worker.js=@${TMP}/worker.js;type=application/javascript+module")

OK=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("success"))')
if [[ "$OK" != "True" && "$OK" != "true" ]]; then
  echo "部署失败:"
  echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
  exit 1
fi

# 开启 workers.dev 子域
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${NAME}/subdomain" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}' >/dev/null || true

SUB=$(curl -sS \
  "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -c 'import sys,json; r=json.load(sys.stdin); print((r.get("result") or {}).get("subdomain",""))')

if [[ -z "$SUB" ]]; then
  echo "Worker 已上传，但未读到 workers.dev 子域。请到 CF 控制台查看并设置 TELEGRAM_API_ROOT"
  exit 0
fi

ROOT="https://${NAME}.${SUB}.workers.dev"
echo "部署成功: $ROOT"

# 写入 runtime.env
if grep -q '^TELEGRAM_API_ROOT=' "$RUNTIME_ENV" 2>/dev/null; then
  sed -i "s|^TELEGRAM_API_ROOT=.*|TELEGRAM_API_ROOT=${ROOT}|" "$RUNTIME_ENV"
else
  printf '\nTELEGRAM_API_ROOT=%s\n' "$ROOT" >>"$RUNTIME_ENV"
fi
chmod 600 "$RUNTIME_ENV"
echo "已写入 data/runtime.env TELEGRAM_API_ROOT=$ROOT"
echo "请执行: systemctl restart cursorbot"
