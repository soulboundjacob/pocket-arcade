#!/bin/bash
# Deploy to GitHub Pages: stamp a new version (busts phone caches and lights up the
# in-app "update ready" banner), commit everything, push main.
#   tools/deploy.sh "What changed"
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s/\.js\?v=[0-9]+/.js?v=$V/g; s/ARCADE_VERSION = \"[0-9]+\"/ARCADE_VERSION = \"$V\"/" index.html
printf '{"v":"%s"}\n' "$V" > version.json
git add -A
git commit -qm "${1:-Update}"
git push -q origin main
echo "deployed $V"
