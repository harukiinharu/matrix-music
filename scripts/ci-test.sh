#!/usr/bin/env bash
#
# 用无头 Chrome 跑页面级回归。CI 与本地共用同一份脚本。
#
#   scripts/ci-test.sh              # 自动寻找 Chrome
#   scripts/ci-test.sh /path/to/chrome
#
# 退出码：0 = 全部通过；1 = 有失败（CI 会因此中断，不部署）。
#
# 两个测试页都会把结论写进 <pre>，抓不到内容也算失败 —— 那说明页面卡住或报错了。

set -u

# ── 找 Chrome ────────────────────────────────────────────
CHROME="${1:-}"
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
    if [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
if [ -z "$CHROME" ]; then
  echo "找不到 Chrome，跳过页面级回归"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

# suite <文件名> <结果元素 id>
suite() {
  local file="$1" id="$2" tmp out summary
  tmp="$(mktemp -d)"
  out="$("$CHROME" --headless=new --disable-gpu --no-sandbox \
      --allow-file-access-from-files \
      --autoplay-policy=no-user-gesture-required \
      --virtual-time-budget=30000 \
      --user-data-dir="$tmp" \
      --dump-dom "file://$ROOT/test/$file" 2>/dev/null)"
  rm -rf "$tmp"

  summary="$(printf '%s' "$out" \
    | sed -n "/<pre id=\"$id\">/,/<\/pre>/p" \
    | sed "1s/.*<pre id=\"$id\">//" \
    | sed '$s/<\/pre>.*//')"

  if [ -z "$(printf '%s' "$summary" | tr -d '[:space:]')" ]; then
    echo "  ✗ $file —— 没有产出结果（页面卡住或抛异常）"
    FAILED=1
    return
  fi

  # 汇总行（第一行非空内容）
  printf '%s\n' "$summary" | grep -v '^[[:space:]]*$' | head -1 | sed 's/^/  /'

  # 失败明细
  local bad
  bad="$(printf '%s\n' "$summary" \
    | grep -E '^(FAIL|JS ERROR|PROMISE REJECT|WATCHDOG)' || true)"
  if [ -n "$bad" ]; then
    printf '%s\n' "$bad" | sed 's/^/      /'
    FAILED=1
  fi
}

echo "=== Matrix Music 页面级回归 ==="
suite selftest.html results
suite interaction.html out
suite large.html out

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "回归未通过，中止部署"
  exit 1
fi

echo
echo "回归全部通过"
