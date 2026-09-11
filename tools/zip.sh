#!/usr/bin/env bash
# 打包成 Chrome 应用商店要的 zip（纯文件，不含私钥、不含开发文件）。
#
# 用法：bash tools/zip.sh
# 产出：release/ytb2text-<version>.zip
#
# Windows 没有 zip 命令，所以用 python 的 zipfile 内联脚本兜底。
set -euo pipefail

cd "$(dirname "$0")/.."
unset PWD

VERSION=$(node -p "require('./manifest.json').version")
OUT="release/ytb2text-$VERSION.zip"
mkdir -p release

PY=$(command -v python3 || command -v python || true)
if [ -z "$PY" ]; then
  echo "没找到 python，无法打 zip" >&2
  exit 1
fi

"$PY" - "$OUT" <<'PYEOF'
import os, sys, zipfile

out = sys.argv[1]
include = [
    'manifest.json', 'background.js', 'content.js', 'content.css',
    'offscreen.html', 'offscreen.js',
    'popup.html', 'popup.css', 'popup.js',
    'icons', 'lib',
]
# 商店不接受的杂物，双保险再排一次
skip_dirs = {'node_modules', 'tools', '.git', 'release', '.staging', 'docs'}
skip_files = {'package.json', 'package-lock.json', '.gitignore', 'README.md'}

n = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in include:
        if not os.path.exists(item):
            raise SystemExit('缺少 ' + item)
        if os.path.isfile(item):
            z.write(item, item)
            n += 1
            continue
        for root, dirs, files in os.walk(item):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for f in files:
                if f in skip_files:
                    continue
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, '.').replace('\\', '/'))
                n += 1
print('已写入 %d 个文件 -> %s' % (n, out))
PYEOF
