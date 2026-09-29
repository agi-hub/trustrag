# 无幻（TrustRAG）— 富格式无幻觉知识库搜索引擎

> **富格式、零幻觉的知识库全文搜索引擎：纯 CPU 即可运行，大模型可选可不用，无需嵌入向量、无向量数据库 —— 适用于无 LLM 的私有化离线部署场景。**

## 功能特性

- 🚫 **大模型是可选项**：LLM 仅用于查询关键词扩展，可开可关——`config.json` 设 `use_llm: false` 或 CLI 加 `--no-llm` 即自动降级为 jieba 本地分词，离线功能完整可用
- 💻 **纯 CPU 即可运行**：检索、排序、报告全程零 GPU、零模型推理，无需购置任何额外设备
- 🔬 **知识库全文深入检索**：ripgrep 全文并集扫描 + 多轮迭代深挖；支持分号分隔多关键词，逐词汇报命中与扩展情况
- 🧩 **无需嵌入向量与嵌入模型**：不保存 embedding、不建向量库；reranker 亦为可选项——本地词法打分开箱即用，精度按需升级
- 📝 **检索报告（可导出 Word）**：程序化生成「检索综述 + 原文摘抄 + 搜索路径日志」，引述逐字可溯源，零幻觉；一键导出 .docx 报告
- ⚡ **快速多轮次检索**：多遍全文扫描单进程完成，千级文档库 3 秒内出结果
- 📚 **多格式全文检索**：PDF / Word / PPT / Excel / Markdown 统一转换为 Markdown 入库，正文、表格、插图全部可搜
- 🖼️ **图像索引与召回**：入库时自动抽取文档插图，检索报告按命中片段汇总「检索图示」，可回看原文对应页
- 📕 **PDF 原文预览**：点击资料链接直接在新标签页预览原始 PDF 对应位置
- 🌐 **Web 界面**：标签页式浏览，搜索状态实时显示

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
pip install pdf-inspector pymupdf4llm jieba openai python-docx python-pptx openpyxl
```

- `pdf-inspector`：PDF 转 Markdown 工具（**默认**，快速准确）
- `pymupdf4llm`：PDF 转 Markdown 工具（备选，兼容性好）
- `jieba`：中文分词（搜索时拆解中文查询词）
- `openai`：调用智谱 GLM API（可选，不用大模型时可卸载）
- `python-docx` / `python-pptx` / `openpyxl`：Word / PPT / Excel 转 Markdown 入库（纯本地解析）

## 手动安装

如果不使用一键脚本，按以下步骤：

### 1. 安装依赖

```bash
cd rag-web
npm install
pip install pdf-inspector pymupdf4llm jieba openai python-docx python-pptx openpyxl
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

扫描 `source/` 下所有 PDF / Word / PPT / Excel 文档，增量同步到 `KB/` 和 `MENU/`：

```bash
python convert.py --ingest
```

Office 文档（`.docx` / `.pptx` / `.xlsx`）由 python-docx / python-pptx / openpyxl 纯本地解析为 Markdown，正文、表格、插图一并入库；同名不同扩展的文件会自动以扩展名消歧。

增量检测基于 `KB/.manifest.json`（记录每个文档的 size/mtime/sha256）：

| 场景 | 行为 |
|---|---|
| 新增文档 | 自动转换 |
| 文档内容修改 | 重算 SHA-256，内容变了才重转 |
| 文档被删除 | 自动清理对应的 KB/MENU 产物和空目录 |
| 无变化 | 跳过（按 size+mtime 快速判断，不重算哈希）|

强制全量重转（忽略缓存）：

```bash
python convert.py --ingest --force
```

**PDF 解析器选择**：

```bash
# 默认使用 pdf-inspector（快速准确）
python convert.py input.pdf

# 强制使用 pymupdf4llm
python convert.py input.pdf --force-pymupdf

# 批量入库时强制使用 pymupdf4llm
python convert.py --ingest --force-pymupdf
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

## 搜索使用

### 多关键词查询

Web 搜索框或 CLI 均支持分号分隔的多个关键词（中英文分号皆可），每个关键词独立判定「是否直接命中 → 是否需要扩展」，结果合并去重后生成一份报告，报告开头会逐个汇报命中情况：

```bash
python rag_search.py -q "HBM 带宽; chiplet 互连" -d KB -o report.md
```

### 关键词扩展方式

原始查询词在知识库中无直接命中时，系统会扩展关键词（同义词/子词）再检索，并在报告中提醒。扩展方式由 `rag-web/config.json` 的 `use_llm` 控制（首次使用请复制 `rag-web/config.example.json` 为 `config.json` 后修改，`config.json` 含密钥不入库）：

| 配置 | 扩展方式 | 说明 |
|---|---|---|
| `"use_llm": true`（默认） | LLM（任意 OpenAI 兼容端点） | 同义词质量高；在 `config.json` 配置 `api_key`/`base_url`/`model`，LLM 失败时自动回退 jieba |
| `"use_llm": false` 或 CLI `--no-llm` | jieba 本地分词 | 无 API 依赖、离线可用，中文复合词拆解（如「显存带宽」→ 显存 + 带宽） |

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
├── convert.py              ← PDF/Word/PPT/Excel → Markdown 转换 + 批量入库
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