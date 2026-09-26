#!/bin/bash
# 把审核台打成一个包，方便拷到阿里云。
# 已结束的活动及其封面不放进去。商户、还没结束的活动、登录密码会留下。
# 不含本机依赖和抓取缓存。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/data/zup-review-cloud.tar.gz}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage"
tar -C "$root" -cf - \
  --exclude node_modules \
  --exclude .git \
  --exclude data \
  --exclude '*.log' \
  . | tar -C "$stage" -xf -

node "$root/scripts/export-unexpired-cloud-data.js" "$stage/data"

rm -f "$out"
tar -czf "$out" -C "$stage" .
echo "打包完成：$out"
du -sh "$out"
