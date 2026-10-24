#!/bin/bash
# 给 index.html / large.html 里的 style.css 与 src/*.js 打上版本戳（?v=时间戳）。
#
# 为什么需要：CDN 按 **URL** 缓存。资源 URL 不变，部署后就会拿到旧文件 ——
# 2026-10-24 真的踩过：HTML 更新了、style.css 还是旧的，页面以「没样式」的样子上线。
#
# 发版流程：改代码 → bash scripts/bump.sh → 跑回归 → commit → 发布仓库根目录。
# 只改资源 URL 的查询串，不动文件内容，也不影响 file:// 下的本地调试。
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP="$(date +%Y%m%d%H%M)"

python3 - "$STAMP" <<'PY'
import re, sys, pathlib

stamp = sys.argv[1]
pat = re.compile(r'((?:href|src)=")((?:style\.css|js/[a-z0-9\-]+\.js))(\?v=\d+)?(")')

for name in ("dist/index.html", "dist/large.html"):
    p = pathlib.Path(name)
    s = p.read_text(encoding="utf-8")
    s2, n = pat.subn(lambda m: m.group(1) + m.group(2) + "?v=" + stamp + m.group(4), s)
    if s2 != s:
        p.write_text(s2, encoding="utf-8")
    print(f"{name}: {n} 处资源已打版本戳")
PY

echo "版本戳：$STAMP"
