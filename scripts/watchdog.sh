#!/usr/bin/env bash
# cursorbot 看门狗：进程挂了或 Telegram API 连续不通 → 自动重启服务
set -euo pipefail

ROOT="/www/wwwroot/cursorbot"
STATE_FILE="$ROOT/data/watchdog.state"
LOG_FILE="$ROOT/data/watchdog.log"
ENV_FILE="$ROOT/data/runtime.env"
SERVICE="cursorbot"
FAIL_THRESHOLD="${WATCHDOG_FAIL_THRESHOLD:-2}"
CURL_TIMEOUT="${WATCHDOG_CURL_TIMEOUT:-12}"

mkdir -p "$ROOT/data"
touch "$STATE_FILE" "$LOG_FILE"
chmod 600 "$STATE_FILE" "$LOG_FILE" 2>/dev/null || true

log() {
  echo "$(date -Iseconds) $*" | tee -a "$LOG_FILE" >/dev/null
  logger -t cursorbot-watchdog "$*" 2>/dev/null || true
}

read_fails() {
  local n
  n=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  echo "$n"
}

write_fails() {
  echo "$1" >"$STATE_FILE"
}

load_token_and_root() {
  TOKEN=""
  API_ROOT="https://api.telegram.org"
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a
    # 只取需要的键，避免 source 整文件副作用
    TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
    ROOT_VAL=$(grep -E '^TELEGRAM_API_ROOT=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
    set +a
    if [[ -n "${ROOT_VAL:-}" ]]; then
      API_ROOT="${ROOT_VAL%/}"
    fi
  fi
}

restart_bot() {
  log "触发重启: $1"
  systemctl restart "$SERVICE" || true
  write_fails 0
  sleep 2
  if systemctl is-active --quiet "$SERVICE"; then
    log "重启成功，服务 active"
  else
    log "重启后仍非 active，请人工检查"
  fi
}

# --- 1) 进程 ---
if ! systemctl is-active --quiet "$SERVICE"; then
  restart_bot "systemd 状态非 active"
  exit 0
fi

# --- 2) Telegram getMe ---
load_token_and_root
if [[ -z "$TOKEN" ]]; then
  log "跳过 API 探测：缺少 TELEGRAM_BOT_TOKEN"
  exit 0
fi

URL="${API_ROOT}/bot${TOKEN}/getMe"
HTTP_CODE=0
BODY=""
set +e
BODY=$(curl -4 -sS --connect-timeout "$CURL_TIMEOUT" --max-time "$CURL_TIMEOUT" "$URL" 2>/tmp/cursorbot-watchdog-curl.err)
CURL_RC=$?
set -e
if [[ $CURL_RC -eq 0 ]]; then
  HTTP_CODE=$(printf '%s' "$BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(200 if d.get("ok") else 0)' 2>/dev/null || echo 0)
fi

if [[ "$HTTP_CODE" == "200" ]]; then
  if [[ "$(read_fails)" != "0" ]]; then
    log "Telegram API 恢复 (apiRoot=$API_ROOT)"
  fi
  write_fails 0
  exit 0
fi

FAILS=$(($(read_fails) + 1))
write_fails "$FAILS"
ERR=$(head -c 200 /tmp/cursorbot-watchdog-curl.err 2>/dev/null || true)
log "Telegram API 探测失败 #$FAILS/$FAIL_THRESHOLD (curl=$CURL_RC) ${ERR}"

if [[ "$FAILS" -ge "$FAIL_THRESHOLD" ]]; then
  restart_bot "Telegram getMe 连续失败 ${FAILS} 次"
fi
