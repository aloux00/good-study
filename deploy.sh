#!/usr/bin/env bash
# 课栈（kezhan）从 GitHub 部署 —— 目标 Debian 12 / Armbian
# 用法：sudo bash deploy.sh
# 首次执行克隆，之后重复执行等同于更新（fetch + 重启）
# 学习进度保存在 /var/lib/kezhan，更新代码不会丢

set -euo pipefail

REPO="${REPO:-https://github.com/aloux00/good-study.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/kezhan
DATA_DIR=/var/lib/kezhan
PORT=8080
RUN_USER=kezhan

case "$APP_DIR" in
  /opt/kezhan) ;;
  *) echo "错误：APP_DIR 异常（$APP_DIR），终止"; exit 1 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "错误：请用 sudo 执行"; exit 1; }

echo "==> 1/5 检查依赖"
command -v git  >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y git; }
command -v node >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y nodejs; }
NODE_BIN=$(command -v node)
NODE_MAJOR=$("$NODE_BIN" -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || { echo "错误：Node $(node -v) 低于 18"; exit 1; }
echo "git $(git --version | awk '{print $3}') / node $(node -v)"

echo "==> 2/5 准备用户与目录"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$RUN_USER"
mkdir -p "$DATA_DIR"
systemctl stop kezhan >/dev/null 2>&1 || true

echo "==> 3/5 拉取代码"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ -d "$APP_DIR/.git" ]; then
  echo "已有仓库，执行更新"
  git -C "$APP_DIR" remote set-url origin "$REPO"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  echo "首次克隆"
  rm -rf "$APP_DIR"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
echo "当前提交：$(git -C "$APP_DIR" rev-parse --short HEAD)"

echo "==> 4/5 权限与 systemd"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"

cat > /etc/systemd/system/kezhan.service <<EOF
[Unit]
Description=Kezhan course learning site
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Environment=DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable kezhan >/dev/null 2>&1 || true
systemctl restart kezhan

echo "==> 5/5 健康检查"
READY=0
for _ in $(seq 1 20); do
  if "$NODE_BIN" -e 'require("http").get("http://127.0.0.1:'"$PORT"'/api/health",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))' 2>/dev/null; then
    READY=1; break
  fi
  sleep 1
done

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 && echo "已放行 ufw $PORT/tcp"
fi

echo ""
if [ "$READY" -eq 1 ]; then
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "启动成功"
  echo "内网访问：http://${HOST_IP:-<本机IP>}:$PORT"
else
  echo "启动失败，排查：journalctl -u kezhan -n 50 --no-pager"
  exit 1
fi

echo ""
echo "以后再更新，只需重跑本脚本："
echo "  sudo bash $0"
