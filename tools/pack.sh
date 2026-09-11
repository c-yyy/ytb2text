#!/usr/bin/env bash
# 打包成 .crx（本地私有 key 不进仓库）。
#
# 用法：bash tools/pack.sh
# 产出：release/ytb2text-<version>.crx
#
# 注意：crx3 会把目标目录下的**所有**文件打进包，所以先把要发布的文件
# 收集到 staging/ 再打包 —— 直接对项目根目录打包会把 node_modules 也塞进去。
set -euo pipefail

cd "$(dirname "$0")/.."
# git bash 会把 PWD 设成 POSIX 路径（/d/xxx），crx3 内部用 process.env.PWD
# 在 Windows 上会错解析成 D:\d\xxx 而 ENOENT。清掉最稳。
unset PWD

if [ ! -d node_modules ]; then
  echo "先跑 npm install（需要 crx3）" >&2
  exit 1
fi

VERSION=$(node -p "require('./manifest.json').version")
STAGING=".staging"
OUT_DIR="release"
OUT="$OUT_DIR/ytb2text-$VERSION.crx"
KEY="ytb2text.pem"

# 只发布扩展真正需要的文件，tools/ docs/ README 不进包
INCLUDE=(
  manifest.json
  background.js
  content.js
  content.css
  offscreen.html
  offscreen.js
  popup.html
  popup.css
  popup.js
  icons
  lib
)

rm -rf "$STAGING"
mkdir -p "$STAGING" "$OUT_DIR"
for item in "${INCLUDE[@]}"; do
  if [ ! -e "$item" ]; then
    echo "缺少 $item" >&2
    exit 1
  fi
  cp -r "$item" "$STAGING/"
done

if [ ! -f "$KEY" ]; then
  echo "未找到 $KEY，crx3 会自动生成一个 —— 请务必备份它，丢了扩展 ID 就变，已安装的用户要重装。"
fi

# 不能用 npx：npx 内部会重置 PWD，等于上面的 unset 白做
node node_modules/crx3/bin/crx3.js -p "$KEY" -o "$OUT" "$STAGING"

rm -rf "$STAGING"
echo "已生成 $OUT"
