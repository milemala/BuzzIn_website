#!/bin/bash
# 在阿里云 Ubuntu 上执行一次。把已经解压好的审核台装成开机自启的服务。
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：sudo bash deploy/install-on-cloud.sh"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_VER="${NODE_VER:-v22.20.0}"
NODE_BIN="/usr/local/bin/node"

if ! "$NODE_BIN" -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "正在安装 Node ${NODE_VER}（走国内镜像）…"
  curl -fsSL "https://npmmirror.com/mirrors/node/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi

if ! "$NODE_BIN" -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "这台机器的 Node 还不能打开本地数据库。请换 NODE_VER 为 22 或更新的版本后再执行。"
  exit 1
fi

if [[ ! -s "$APP_DIR/data/review-password" ]] && [[ -z "${REVIEW_PASSWORD:-}" ]]; then
  echo "缺少登录密码。请先在 data/review-password 里写一行密码，再执行安装。"
  exit 1
fi

cd "$APP_DIR"
npm install --omit=dev --registry=https://registry.npmmirror.com

install -d /etc/systemd/system
sed "s#__APP_DIR__#${APP_DIR}#g; s#__NODE_BIN__#${NODE_BIN}#g" \
  "$APP_DIR/deploy/zup-review.service" > /etc/systemd/system/zup-review.service

systemctl daemon-reload
systemctl enable zup-review
systemctl restart zup-review

echo "审核台已在这台云服务器上启动，并设置为开机自启。"
echo "本机查看：systemctl status zup-review"
