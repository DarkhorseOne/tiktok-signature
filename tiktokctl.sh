#!/usr/bin/env bash
# TikTok 签名服务（登录态版）进程管理。附加脚本，不触碰上游文件。
# 子命令: start stop restart status log
set -uo pipefail

cd "$(dirname "$0")"

ENTRY="auth-server.mjs"
PID_FILE="tiktok-auth/auth-server.pid"
LOG_FILE="tiktok-auth/auth-server.log"

PORT=8080
if [ -f .env ]; then
  envport="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | tr -d '[:space:]' || true)"
  [ -n "${envport:-}" ] && PORT="$envport"
fi

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  mkdir -p "$(dirname "$PID_FILE")"
  nohup node --env-file-if-exists=.env "$ENTRY" >> "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  sleep 1
  if is_running; then
    echo "started (pid $(cat "$PID_FILE")), logs -> $LOG_FILE"
  else
    echo "failed to start; see $LOG_FILE"
    return 1
  fi
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE"
    echo "not running"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "graceful stop timed out, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "stopped"
}

status() {
  if is_running; then
    echo "running (pid $(cat "$PID_FILE")) on port $PORT"
    curl -s "http://localhost:$PORT/health" 2>/dev/null || echo "(health 未响应)"
    echo
    return 0
  fi
  echo "not running"
  return 3
}

log() {
  [ -f "$LOG_FILE" ] || { echo "暂无日志: $LOG_FILE"; return 0; }
  tail -n 100 -f "$LOG_FILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  log | logs) log ;;
  *) echo "usage: $0 {start|stop|restart|status|log}"; exit 2 ;;
esac
