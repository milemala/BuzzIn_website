#!/bin/bash
# 把审核台打成一个包，方便拷到阿里云。不含本机依赖和抓取缓存。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/data/zup-review-cloud.tar.gz}"

cd "$root"
tar -czf "$out" \
  --exclude node_modules \
  --exclude .git \
  --exclude data/scrape-cache \
  --exclude data/image-cache \
  --exclude data/image-composed-preview \
  --exclude data/poi-agent-workbench \
  --exclude data/chrome-cdp-profile \
  --exclude data/zup-review-cloud.tar.gz \
  --exclude data/batch-scrape \
  --exclude '*.log' \
  .

echo "打包完成：$out"
du -sh "$out"
