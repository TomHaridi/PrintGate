#!/usr/bin/env bash
# PrintGate 上线前全量功能回归执行器
# 用法：bash tools/run-all.sh [api|ui|static|<套件名>...]
#   PG_BASE       服务地址（默认 http://127.0.0.1:8098）
#   PG_PASS       管理员密码（默认 LocalTest2026）
#   PG_DATA_DIR   服务端数据目录（脚本要直连 SQLite 时用）
#   PG_LOG_DIR    日志输出目录（默认 <项目>/_logs）
#   NODE          node 可执行文件（默认 PATH 里的 node）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"
OUT="${PG_LOG_DIR:-$ROOT/_logs}"
mkdir -p "$OUT"

export PG_BASE="${PG_BASE:-http://127.0.0.1:8098}"
export PG_PASS="${PG_PASS:-LocalTest2026}"
export PG_DATA_DIR="${PG_DATA_DIR:-$ROOT/_data}"
export PG_DB="${PG_DB:-$PG_DATA_DIR/printgate.db}"
export PG_LOCAL_PORT="${PG_LOCAL_PORT:-8098}"
# Puppeteer 若装在项目外，可通过 NODE_PATH 指过去
# UI 套件依赖 puppeteer-core（不在 server 的运行依赖里）。若已安装到别处，用 NODE_PATH 指过去
export NODE_PATH="${NODE_PATH:-$ROOT/server/node_modules}"

API_SUITES=(
  final-hunt.js
  print-hunt.js
  file-task-hunt.js
  system-hunt.js
  user-manage-test.js
  session-hunt.js
  file-leak-hunt.js
  race-hunt.js
  scan-hunt.js
  mp-api-test.js
  qr-login-test.js
  cleanup-test.js
  wechat-config-test.js
  hunt11.js
  bug-hunt.js
  bug-hunt2.js
  bug-hunt3.js
  mp-wiring-check.js
  mp-merge-test.js
  mp-upload-test.js
)

UI_SUITES=(
  ui-print-test.js
  ui-users-test.js
  ui-page-patrol.js
  ui-admin-patrol.js
  ui-scan-driver.js
  setup-flow-test.js
)

STATIC_SUITES=(
  route-audit.js
  mp-contract-check.js
  mp-wiring-check.js
  check-wxml.js
  mp-page-test.js
  mp-prefs-test.js
  mp-static-check.js
  mp-field-check.js
)

run_one() {
  local s="$1"
  local log="$OUT/${s%.js}.log"
  local t0=$(date +%s)
  ( cd "$ROOT/tools" && timeout 600 "$NODE" "$s" > "$log" 2>&1 )
  local rc=$?
  local t1=$(date +%s)
  # 统计：优先取形如 "通过 x/y" 或 "PASS/FAIL" 的汇总
  local summary
  summary=$(grep -aoE "(通过|PASS|passed)[^0-9]{0,6}[0-9]+ */ *[0-9]+|[0-9]+ *(passed|通过)[^,)]{0,10}|失败[^0-9]{0,4}[0-9]+|FAIL[^0-9]{0,4}[0-9]+" "$log" | tail -3 | tr '\n' ' ')
  echo "RC=$rc TIME=$((t1-t0))s SUITE=$s SUM=${summary:-none}"
}

MODE="${1:-api}"
if [ "$MODE" = "ui" ] && ! "$NODE" -e "require('puppeteer-core')" >/dev/null 2>&1; then
  echo "⚠️  未找到 puppeteer-core（UI 套件需要它）"
  echo "   请安装：npm i -g puppeteer-core 或在有它的目录上设置 NODE_PATH"
  exit 2
fi
case "$MODE" in
  api) LIST=("${API_SUITES[@]}") ;;
  ui) LIST=("${UI_SUITES[@]}") ;;
  static) LIST=("${STATIC_SUITES[@]}") ;;
  *) LIST=("$@") ;;
esac

echo "### 开始 $MODE 组，共 ${#LIST[@]} 套 | base=$PG_BASE data=$PG_DATA_DIR"
i=0
for s in "${LIST[@]}"; do
  [ -f "$ROOT/tools/$s" ] || { echo "SKIP(缺失) $s"; continue; }
  # 登录限流是 20 次/分钟：每跑 5 套歇 62s，避免 429 造成假失败
  i=$((i+1))
  if [ $((i % 5)) -eq 1 ] && [ $i -ne 1 ]; then
    echo "--- 等待 62s 让登录限流窗口重置 ---"
    sleep 62
  fi
  run_one "$s"
done
echo "### 结束"
