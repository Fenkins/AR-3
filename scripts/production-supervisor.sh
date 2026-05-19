#!/usr/bin/env bash
set -euo pipefail

ROOT="${AR3_ROOT:-/opt/AR-3}"
PORT="${PORT:-3001}"
LOG_DIR="${AR3_LOG_DIR:-/tmp}"
PID_DIR="${AR3_PID_DIR:-/tmp/ar3-pids}"
mkdir -p "$PID_DIR" "$LOG_DIR"

cd "$ROOT"

load_env() {
  if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
}

is_running() {
  local pid_file="$1"
  [ -s "$pid_file" ] || return 1
  local pid
  pid=$(cat "$pid_file" 2>/dev/null || true)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

pid_for_pattern() {
  local pattern="$1"
  pgrep -f "$pattern" | head -1 || true
}

start_one() {
  local name="$1"
  local pattern="$2"
  local pid_file="$PID_DIR/$name.pid"
  local log_file="$LOG_DIR/ar3-$name.log"
  shift 2
  if is_running "$pid_file"; then
    echo "$name already running pid=$(cat "$pid_file")"
    return 0
  fi
  local existing_pid
  existing_pid=$(pid_for_pattern "$pattern")
  if [ -n "$existing_pid" ]; then
    echo "$name already running pid=$existing_pid (matched existing process)"
    echo "$existing_pid" >"$pid_file"
    return 0
  fi
  echo "starting $name"
  setsid "$@" </dev/null >>"$log_file" 2>&1 &
  echo $! >"$pid_file"
  sleep 1
  if ! is_running "$pid_file"; then
    echo "$name failed to stay running; tail of $log_file:" >&2
    tail -40 "$log_file" >&2 || true
    return 1
  fi
  echo "$name started pid=$(cat "$pid_file") log=$log_file"
}

stop_one() {
  local name="$1"
  local pattern="${2:-}"
  local pid_file="$PID_DIR/$name.pid"
  local pid=""
  if is_running "$pid_file"; then
    pid=$(cat "$pid_file")
  elif [ -n "$pattern" ]; then
    pid=$(pid_for_pattern "$pattern")
  fi
  if [ -n "$pid" ]; then
    echo "stopping $name pid=$pid"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$pid" 2>/dev/null || true
  else
    echo "$name not running"
  fi
  rm -f "$pid_file"
}

status_one() {
  local name="$1"
  local pattern="$2"
  local pid_file="$PID_DIR/$name.pid"
  if is_running "$pid_file"; then
    echo "$name: running pid=$(cat "$pid_file")"
    return 0
  fi
  local existing_pid
  existing_pid=$(pid_for_pattern "$pattern")
  if [ -n "$existing_pid" ]; then
    echo "$name: running pid=$existing_pid (matched existing process)"
    echo "$existing_pid" >"$pid_file"
    return 0
  fi
  echo "$name: stopped"
  return 1
}

start_all() {
  load_env
  start_one search_service "scripts/search_service.py|search_service.py" python3 "$ROOT/scripts/search_service.py"
  start_one gpu_worker "scripts/gpu_worker.py|gpu_worker.py" python3 "$ROOT/scripts/gpu_worker.py"
  start_one web "next-server|next start|next start -p $PORT" "$ROOT/node_modules/.bin/next" start -p "$PORT"
}

stop_all() {
  stop_one web "next-server|next start|next start -p $PORT" || true
  stop_one gpu_worker "scripts/gpu_worker.py|gpu_worker.py" || true
  stop_one search_service "scripts/search_service.py|search_service.py" || true
}

status_all() {
  local rc=0
  status_one search_service "scripts/search_service.py|search_service.py" || rc=1
  status_one gpu_worker "scripts/gpu_worker.py|gpu_worker.py" || rc=1
  status_one web "next-server|next start|next start -p $PORT" || rc=1
  exit "$rc"
}

case "${1:-start}" in
  start) start_all ;;
  stop) stop_all ;;
  restart) stop_all; start_all ;;
  status) status_all ;;
  *) echo "Usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
