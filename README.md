# 无幻（TrustRAG）— 无幻觉 RAG 搜索引擎

> 纯大模型驱动、无 Embedding、无幻觉的 Agentic RAG 系统。所有输出内容 100% 源自 Markdown 原文摘抄。

## 功能

- 🔍 **多轮智能搜索**：LLM 自动拆解关键词、迭代搜索、筛选无关结果
- 📄 **原文摘抄输出**：零幻觉，所有内容逐字源自知识库
- 📊 **相关性打分**：精确命中优先 + LLM 语义打分排序
- 🤖 **AI 整理总结**：结构化总结报告，引用列表 + 观点对照表
- 📕 **PDF 预览**：点击链接直接在新标签页预览原始 PDF
- 🌐 **Web 界面**：标签页式浏览，搜索状态实时显示
- 📥 **导出 Word**：一键导出搜索报告

## 快速安装

```bash
# 一键安装（root 用户，自动配置 systemd + nginx）
bash install.sh /path/to/your/knowledge_base /trustrag

# 非 root 用户（手动启动服务 + 提示安装 nginx 配置）
bash install.sh /path/to/your/knowledge_base
```

### 参数说明

| 参数 | 说明 | 默认值 |
|---|---|---|
| 第1参数 | 知识库目录（放 .md 文件和 images/ 的根目录） | `./KB` |
| 第2参数 | Nginx 部署路径 | `/trustrag` |
| `PORT` 环境变量 | 后端端口 | `3010` |

### 环境要求

- **Node.js** >= 18
- **Python** >= 3.10
- **pip** (Python 包管理器)
- **Nginx**（域名部署需要）

### Python 依赖

安装脚本会自动安装，也可手动安装：

```bash
pip install pymupdf4llm jieba openai
```

- `pymupdf4llm`：PDF 转 Markdown 工具
- `jieba`：中文分词（搜索时拆解中文查询词）
- `openai`：调用智谱 GLM API

## 手动安装

如果不使用一键脚本，按以下步骤：

### 1. 安装依赖

```bash
cd rag-web
npm install
pip install pymupdf4llm jieba openai
```

### 2. 构建前端

```bash
npm run build
```

### 3. 配置环境

创建 `rag-web/.env`：

```bash
PORT=3010
MD_ROOT=/path/to/your/knowledge_base
ZHIPU_API_KEY=你的智谱API密钥
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
RAG_MODEL=glm-4-flash
```

### 4. 启动服务

```bash
# 直接启动
cd rag-web && node server.js

# 或用 pm2 守护
pm2 start server.js --name trustrag

# 或用 systemd（root）
cp /etc/systemd/system/trustrag.service << 'EOF'
[Unit]
Description=TrustRAG
After=network.target
[Service]
Type=simple
WorkingDirectory=/path/to/rag-web
EnvironmentFile=/path/to/rag-web/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
systemctl enable --now trustrag
```

### 5. 配置 Nginx（域名部署）

```bash
sudo tee /etc/nginx/snippets/trustrag.conf << 'EOF'
location /trustrag/ {
    proxy_pass http://127.0.0.1:3010/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 50M;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
    proxy_cache off;
}
location = /trustrag {
    return 301 /trustrag/;
}
EOF

# 在 sites-enabled/default 中添加 include
sudo sed -i '/transocr.conf/a\\tinclude snippets/trustrag.conf;' /etc/nginx/sites-enabled/default
sudo nginx -t && sudo nginx -s reload
```

## 知识库格式要求

### 目录结构

```
knowledge_base/             ← MD_ROOT 指向这里
├── doc1.md                 ← Markdown 文档
├── doc2.md
├── images/                 ← 图片目录（与 .md 同级或子目录）
│   ├── doc1-fig1.png
│   └── doc2-fig1.png
├── 子目录/
│   ├── doc3.md
│   └── images/
│       └── doc3-fig1.png
└── source/                 ← PDF 原件目录（可选）
    ├── doc1.pdf
    └── doc2.pdf
```

### Markdown 内嵌标记

每个 `.md` 文件需要在内容中包含页码标记（由 `convert.py` 自动生成）：

```html
<!-- page: 13 | book: FPGA数字IC知识手册 | chapter: 一、 FPGA/IC设计 > 11. 毛刺glitch -->
```

用 PDF 转换工具生成带标记的 Markdown：

```bash
python convert.py input.pdf
```

## 服务管理

```bash
# 查看状态
systemctl status trustrag

# 重启
systemctl restart trustrag

# 查看日志
journalctl -u trustrag -f

# 更新代码后重新构建
cd rag-web && npm run build && systemctl restart trustrag
```

## 项目结构

```
pymupdftest/
├── install.sh              ← 一键安装脚本
├── convert.py              ← PDF → Markdown 转换工具
├── rag_search.py           ← RAG 搜索引擎（CLI）
├── rag-web/                ← Web 应用
│   ├── server.js           ← 后端（Express + SSE）
│   ├── src/
│   │   ├── App.jsx         ← 前端主组件
│   │   ├── App.css         ← 样式
│   │   └── utils/
│   │       ├── markdownRenderer.js  ← Markdown 渲染
│   │       └── exportUtils.js       ← Word 导出
│   ├── vite.config.js      ← Vite 配置（base 路径）
│   └── package.json
├── KB/                     ← 知识库（Markdown 文档）
│   ├── *.md
│   └── images/
└── source/                 ← PDF 原件
    └── *.pdf
```
