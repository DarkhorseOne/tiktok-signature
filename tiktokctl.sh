#!/usr/bin/env bash
# TikTok 签名服务（多账号登录态版）进程管理。附加脚本，不触碰上游文件。
# 服务: start [name] | stop | restart [name] | status | log
# 账号: profile <list|chrome|add|refresh|rename|delete|backup|import|restore> ...
set -uo pipefail

cd "$(dirname "$0")"

ENTRY="auth-server.mjs"
CLI="tiktok-auth/profile-cli.mjs"
PID_FILE="tiktok-auth/auth-server.pid"
LOG_FILE="tiktok-auth/auth-server.log"

PORT=8080
if [ -f .env ]; then
  envport="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | tr -d '[:space:]' || true)"
  [ -n "${envport:-}" ] && PORT="$envport"
fi

env_value() { # $1=KEY -> value from .env (no inline comment)
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | cut -d'#' -f1 | tr -d '[:space:]' || true
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

running_profile() { # echo current --profile from live pid (empty if none)
  is_running || return 0
  local pid cmd
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  node "$CLI" ps-profile "$cmd" 2>/dev/null || true
}

launch() { # $1=profile (may be empty -> legacy CHROME_PROFILE path)
  local prof="$1"
  if [ -n "${TIKTOKCTL_DRY_RUN:-}" ]; then
    if [ -n "$prof" ]; then
      echo "DRY: nohup node --env-file-if-exists=.env $ENTRY --profile \"$prof\""
    else
      echo "DRY: nohup node --env-file-if-exists=.env $ENTRY"
    fi
    return 0
  fi
  mkdir -p "$(dirname "$PID_FILE")"
  if [ -n "$prof" ]; then
    nohup node --env-file-if-exists=.env "$ENTRY" --profile "$prof" >> "$LOG_FILE" 2>&1 &
  else
    nohup node --env-file-if-exists=.env "$ENTRY" >> "$LOG_FILE" 2>&1 &
  fi
  echo "$!" > "$PID_FILE"
  sleep 1
  if is_running; then
    echo "started (pid $(cat "$PID_FILE"))${prof:+ as $prof}, logs -> $LOG_FILE"
  else
    echo "failed to start; see $LOG_FILE"
    return 1
  fi
}

resolve_start_profile() { # echo chosen profile name, or empty for legacy; nonzero on hard error
  local arg="${1:-}"
  if [ -n "$arg" ]; then
    if node "$CLI" exists "$arg" >/dev/null 2>&1; then echo "$arg"; return 0; fi
    echo "" ; return 9
  fi
  if [ -t 0 ]; then
    local picked
    picked="$(node "$CLI" pick-start)" || return $?
    [ -n "$picked" ] || return 9
    echo "$picked"; return 0
  fi
  # 非交互回退
  local p
  p="$(env_value TIKTOK_PROFILE)"; [ -n "$p" ] && { echo "$p"; return 0; }
  p="$(env_value CHROME_PROFILE)"; [ -n "$p" ] && { echo ""; return 0; }  # legacy live, 不传 --profile
  return 9
}

start() {
  local arg="${1:-}"
  if is_running; then
    local cur; cur="$(running_profile)"
    if [ -n "$arg" ] && [ "$arg" != "$cur" ]; then
      echo "already running as ${cur:-?} (pid $(cat "$PID_FILE")); use 'restart $arg' to switch"
      return 4
    fi
    echo "already running${cur:+ as $cur} (pid $(cat "$PID_FILE"))"
    return 0
  fi
  local prof rc
  prof="$(resolve_start_profile "$arg")"; rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -n "$arg" ]; then echo "profile not found: $arg"; node "$CLI" list || true
    else echo "no profile selected; run './tiktokctl.sh profile add' first"; fi
    return 2
  fi
  launch "$prof"
}

stop() {
  if ! is_running; then echo "not running"; rm -f "$PID_FILE"; return 0; fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then rm -f "$PID_FILE"; echo "not running"; return 0; fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$pid" 2>/dev/null; then echo "graceful stop timed out, sending SIGKILL"; kill -9 "$pid" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
  echo "stopped"
}

restart() {
  local arg="${1:-}" target
  if [ -n "$arg" ]; then
    if ! node "$CLI" exists "$arg" >/dev/null 2>&1; then
      echo "restart: profile not found: $arg"; node "$CLI" list || true; return 2
    fi
    target="$arg"
  elif is_running; then
    target="$(running_profile)"
    [ -n "$target" ] || target="$(env_value TIKTOK_PROFILE)"
    [ -n "$target" ] || { if [ -n "$(env_value CHROME_PROFILE)" ]; then target="__legacy__"; fi; }
  else
    target="$(env_value TIKTOK_PROFILE)"
  fi
  if [ -z "$target" ]; then
    echo "restart: cannot resolve which profile to restart; not stopping. Pass a name."
    return 2
  fi
  stop
  if [ "$target" = "__legacy__" ]; then start; else start "$target"; fi
}

status() {
  if is_running; then
    local cur; cur="$(running_profile)"
    [ -n "$cur" ] || cur="$(env_value TIKTOK_PROFILE)"
    [ -n "$cur" ] || cur="$(env_value CHROME_PROFILE)"
    echo "running (pid $(cat "$PID_FILE")) on port $PORT${cur:+ — account: $cur}"
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
  start) shift; start "${1:-}" ;;
  stop) stop ;;
  restart) shift; restart "${1:-}" ;;
  status) status ;;
  log | logs) log ;;
  profile) shift; exec node "$CLI" "$@" ;;
  *) echo "usage: $0 {start [name]|stop|restart [name]|status|log|profile <sub> ...}"; exit 2 ;;
esac
