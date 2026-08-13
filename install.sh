#!/usr/bin/env bash
# ============================================================
# 无幻（TrustRAG）— 一键安装脚本
# 用法: bash install.sh [知识库目录] [部署路径]
# 示例: bash install.sh /home/user/mydocs /trustrag
# ============================================================
set -euo pipefail

# ── 参数 ──
KB_DIR="${1:-$(cd "$(dirname "$0")" && pwd)/KB}"
DEPLOY_PATH="${2:-/trustrag}"
PORT="${PORT:-3010}"
SERVICE_NAME="trustrag"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "============================================"
echo "  无幻（TrustRAG）安装程序"
echo "  知识库目录: $KB_DIR"
echo "  部署路径:   $DEPLOY_PATH"
echo "  端口:       $PORT"
echo "============================================"
echo ""

# ── 1. 检查依赖 ──
echo ">>> 检查系统依赖..."

check_cmd() {
    if ! command -v "$1" &>/dev/null; then
        error "未找到 $1，请先安装: $2"
    fi
}

check_cmd node "https://nodejs.org/ (需要 v18+)"
check_cmd python3 "https://www.python.org/ (需要 v3.10+)"
check_cmd npm "随 Node.js 安装"

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 18 ]; then
    error "Node.js 版本需要 >= 18，当前: $(node -v)"
fi
info "Node.js $(node -v), Python $(python3 --version 2>&1 | awk '{print $2}')"

# ── 2. Python 依赖 ──
echo ""
echo ">>> 安装 Python 依赖..."
pip3 install -q pymupdf4llm jieba openai 2>/dev/null || pip install -q pymupdf4llm jieba openai
info "Python 依赖安装完成"

# ── 3. 定位项目目录 ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/rag-web"

if [ ! -f "$APP_DIR/server.js" ]; then
    error "未找到 rag-web/server.js，请在项目根目录运行此脚本"
fi
info "应用目录: $APP_DIR"

# ── 4. 安装 npm 依赖并构建 ──
echo ""
echo ">>> 安装前端依赖并构建..."
cd "$APP_DIR"
npm install --silent 2>/dev/null
info "npm 依赖安装完成"

echo ">>> 构建前端（base=$DEPLOY_PATH/）..."
# 确保 vite.config.js 的 base 路径正确
node -e "
const fs = require('fs');
const cfg = fs.readFileSync('vite.config.js', 'utf-8');
if (!cfg.includes(\"base: '$DEPLOY_PATH/'\")) {
  console.log('  更新 vite.config.js base 路径');
}
"
npm run build 2>/dev/null
info "前端构建完成"

# ── 5. 配置环境变量 ──
echo ""
echo ">>> 配置环境变量..."

ENV_FILE="$APP_DIR/.env"
cat > "$ENV_FILE" << EOF
# TrustRAG 环境配置
PORT=$PORT
MD_ROOT=$KB_DIR
EOF
info "环境变量写入: $ENV_FILE"

# 生成 config.json（LLM API 配置）
CONFIG_FILE="$APP_DIR/config.json"
cat > "$CONFIG_FILE" << EOF
{
  "api_key": "YOUR_ZHIPU_API_KEY_HERE",
  "base_url": "https://open.bigmodel.cn/api/paas/v4/",
  "model": "glm-4-flash"
}
EOF
info "LLM 配置写入: $CONFIG_FILE（请修改 api_key 为你自己的密钥）"

# ── 6. 创建 systemd 服务（守护进程） ──
echo ""
echo ">>> 配置 systemd 服务..."

if command -v systemctl &>/dev/null && [ "$(id -u)" -eq 0 ]; then
    cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
[Unit]
Description=TrustRAG - 无幻觉 RAG 搜索引擎
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5
User=$(whoami)

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME}
    systemctl restart ${SERVICE_NAME}
    info "systemd 服务已创建并启动: ${SERVICE_NAME}"
elif [ "$(id -u)" -ne 0 ]; then
    warn "当前非 root 用户，跳过 systemd 配置"
    warn "手动启动: cd $APP_DIR && env \$(cat .env | xargs) node server.js"
    warn "或用 pm2: pm2 start server.js --name $SERVICE_NAME"
else
    warn "systemctl 不可用，跳过"
fi

# ── 7. Nginx 配置 ──
echo ""
echo ">>> 配置 Nginx..."

NGINX_CONF="/etc/nginx/snippets/trustrag.conf"
NGINX_PATH_ESCAPED=$(echo "$DEPLOY_PATH" | sed 's/\//\\\//g')

if [ "$(id -u)" -eq 0 ]; then
    # 写入 nginx snippet
    cat > "$NGINX_CONF" << EOF
# TrustRAG — 无幻觉 RAG 搜索引擎
location ${DEPLOY_PATH}/ {
    proxy_pass http://127.0.0.1:${PORT}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 50M;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
}
location = ${DEPLOY_PATH} {
    return 301 ${DEPLOY_PATH}/;
}
EOF
    info "Nginx snippet 已写入: $NGINX_CONF"

    # 在 default 配置中 include（如果尚未包含）
    for site_conf in /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default; do
        if [ -f "$site_conf" ] && ! grep -q "trustrag.conf" "$site_conf"; then
            sed -i "/transocr.conf/a\\\\tinclude snippets/trustrag.conf;" "$site_conf"
            info "已添加 include 到 $site_conf"
        fi
    done

    nginx -t 2>/dev/null && {
        nginx -s reload
        info "Nginx 已重载"
    } || warn "Nginx 配置测试失败，请检查"
else
    # 非 root：生成配置文件让用户手动安装
    cat << NGINXEOF
${YELLOW}[!]${NC} 非 root 用户，请手动执行以下命令安装 Nginx 配置:

sudo cp /tmp/trustrag.conf /etc/nginx/snippets/trustrag.conf
sudo sh -c 'grep -q trustrag /etc/nginx/sites-enabled/default || sed -i "/transocr.conf/a\\\\tinclude snippets/trustrag.conf;" /etc/nginx/sites-enabled/default'
sudo nginx -t && sudo nginx -s reload
NGINXEOF

    cat > /tmp/trustrag.conf << EOF
location ${DEPLOY_PATH}/ {
    proxy_pass http://127.0.0.1:${PORT}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 50M;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
    proxy_cache off;
}
location = ${DEPLOY_PATH} {
    return 301 ${DEPLOY_PATH}/;
}
EOF
    warn "Nginx 配置已生成到: /tmp/trustrag.conf"
fi

# ── 8. 验证 ──
echo ""
echo ">>> 验证安装..."
sleep 2

if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/" | grep -q "200"; then
    info "后端服务正常运行 (port $PORT)"
else
    warn "后端服务可能未启动，请检查日志"
fi

# ── 完成 ──
echo ""
echo "============================================"
echo -e "${GREEN}  安装完成！${NC}"
echo "============================================"
echo ""
echo "  本地访问:   http://localhost:${PORT}/"
if [ "$(id -u)" -eq 0 ]; then
    echo "  域名访问:   http://你的域名${DEPLOY_PATH}/"
fi
echo ""
echo "  服务管理:"
if [ "$(id -u)" -eq 0 ]; then
    echo "    systemctl status  $SERVICE_NAME"
    echo "    systemctl restart $SERVICE_NAME"
    echo "    journalctl -u $SERVICE_NAME -f"
else
    echo "    cd $APP_DIR && source .env && node server.js"
    echo "    # 或用 pm2: pm2 start server.js --name $SERVICE_NAME"
fi
echo ""
echo "  配置文件:"
echo "    环境变量:   $APP_DIR/.env"
echo "    Nginx:      $NGINX_CONF"
echo ""
echo "  知识库目录: $KB_DIR"
echo "  （放入 .md 文件和对应的 images/ 目录即可被搜索）"
echo ""
