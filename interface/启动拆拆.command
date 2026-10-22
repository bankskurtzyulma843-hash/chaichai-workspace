#!/bin/zsh
set -eu
ui_dir="$(cd "$(dirname "$0")" && pwd)"
node_bin="${CHAICHAI_NODE_BIN:-$HOME/.chaichai/node/bin/node}"
if [[ ! -x "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
fi
if [[ -z "$node_bin" ]]; then
  print '请先安装 Node.js 24.18.0，再启动拆拆。'
  read '?按回车退出…'
  exit 1
fi
if [[ ! -f "$ui_dir/../dist/mcp/main.js" ]]; then
  print '请先在拆拆项目根目录执行 npm ci 和 npm run build:cached。'
  read '?按回车退出…'
  exit 1
fi
cd "$ui_dir"
exec "$node_bin" server.mjs
