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

## 文献入库

TrustRAG 不直接读 PDF，而是用 `convert.py` 将 PDF 转换为带页码标记的 Markdown，供搜索引擎使用。

### 三目录体系

```
项目根目录/
├── source/      ← 放原始 PDF（你只需要关心这里）
├── KB/          ← 自动生成：Markdown + 抽取的图片（搜索引擎读这里）
└── MENU/        ← 自动生成：章节目录 TOC（浏览导航用）
```

- **你只需把 PDF 放进 `source/`**，然后运行入库命令，其余目录自动同步。
- `source/` 的子目录结构会被镜像到 `KB/` 和 `MENU/` 中，方便定位。
- 每个 PDF 在 `KB/` 中生成同名子文件夹（存放 `.md` 和 `images/`）。

```
source/
└── HotChips/2025/report.pdf
    ↓ python convert.py --ingest
KB/
└── HotChips/2025/report/
    ├── report.md          ← 可搜索的 Markdown
    └── images/             ← 抽取的图片
MENU/
└── HotChips/2025/report-toc.md  ← 章节目录
```

### 批量入库（推荐）

扫描 `source/` 下所有 PDF，增量同步到 `KB/` 和 `MENU/`：

```bash
python convert.py --ingest
```

增量检测基于 `KB/.manifest.json`（记录每个 PDF 的 size/mtime/sha256）：

| 场景 | 行为 |
|---|---|
| 新增 PDF | 自动转换 |
| PDF 内容修改 | 重算 SHA-256，内容变了才重转 |
| PDF 被删除 | 自动清理对应的 KB/MENU 产物和空目录 |
| 无变化 | 跳过（按 size+mtime 快速判断，不重算哈希）|

强制全量重转（忽略缓存）：

```bash
python convert.py --ingest --force
```

自定义目录：

```bash
python convert.py --ingest --source /path/to/pdfs --kb /path/to/KB --menu /path/to/MENU
```

### 单文件转换

转换单个 PDF 为 Markdown（不写入 manifest，不走增量流程）：

```bash
python convert.py input.pdf -o output.md
```

常用选项：

```bash
python convert.py input.pdf --dpi 300          # 提高图片分辨率
python convert.py input.pdf --no-images        # 不抽取图片
python convert.py input.pdf --no-page-markers  # 不插入页码标记
python convert.py input.pdf --table-strategy text  # 表格识别策略
```

### Markdown 页码标记

入库生成的每个 `.md` 文件内嵌页码标记，搜索引擎据此定位原文位置：

```html
<!-- page: 13 | book: FPGA数字IC知识手册 | chapter: 一、 FPGA/IC设计 > 11. 毛刺glitch -->
```

由 `convert.py` 自动生成，无需手动添加。

### 入库后启动搜索

入库完成后，`KB/` 目录即为知识库。确保 `.env` 或启动参数中 `MD_ROOT` 指向 `KB/`，然后重启服务即可搜索新文献。

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
trustrag/
├── convert.py              ← PDF → Markdown 转换 + 批量入库
├── rag_search.py           ← RAG 搜索引擎（CLI）
├── install.sh              ← 一键安装脚本
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
├── source/                 ← 放入原始 PDF
├── KB/                     ← 自动生成：Markdown + 图片（搜索引擎读这里）
│   └── .manifest.json      ← 增量入库指纹缓存
└── MENU/                   ← 自动生成：章节目录 TOC
```
