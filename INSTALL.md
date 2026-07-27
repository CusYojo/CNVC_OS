# intelligent-investment-platform 安装配置指南

> 适用版本：cybernaut-dist 2026-07  
> 目标读者：接手开发的工程师  
> 预计耗时：首次完整部署约 30 分钟

---

## 目录

1. [环境要求](#1-环境要求)
2. [快速开始（5 分钟）](#2-快速开始5-分钟)
3. [.env 逐项配置](#3-env-逐项配置)
4. [PostgreSQL 配置](#4-postgresql-配置)
5. [Nginx 反向代理（生产）](#5-nginx-反向代理生产)
6. [systemd 进程守护（生产）](#6-systemd-进程守护生产)
   - 6.1 [主 API 服务](#61-主-api-服务)
   - 6.2 [Flue Agent 服务](#62-flue-agent-服务ai-功能必须)
   - 6.3 [情报雷达服务（可选）](#63-情报雷达服务可选)
   - 6.4 [启用](#64-启用)
7. [Flue Agent 编排层](#7-flue-agent-编排层)
   - 7.1 [架构](#71-架构)
   - 7.2 [克隆 Flue 源码](#72-克隆-flue-源码)
   - 7.3 [安装依赖并构建核心包](#73-安装依赖并构建核心包)
   - 7.4 [创建 Cybernaut Flue 项目](#74-创建-cybernaut-flue-项目)
   - 7.5 [安装并验证](#75-安装并验证)
   - 7.6 [systemd 进程守护](#76-systemd-进程守护)
   - 7.7 [端点验证](#77-端点验证)
   - 7.8 [.env 配置](#78-env-配置)
   - 7.9 [Skill 工作区](#79-skill-工作区)
8. [情报雷达（project-discovery）](#8-情报雷达project-discovery)
9. [工具脚本运行](#9-工具脚本运行)
10. [故障排查](#10-故障排查)

---

## 1. 环境要求

```bash
# 一行检查所有前置条件
node -v    # ≥ 20
npm -v     # ≥ 10
psql --version 2>/dev/null || echo "需安装 PostgreSQL ≥ 16"
docker -v 2>/dev/null || echo "推荐安装 Docker"
python3 --version 2>/dev/null || echo "情报雷达需要 Python ≥ 3.10"
```

| 软件 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 20 | 前端 + 后端运行时 |
| pnpm | ≥ 11 | Flue Agent 构建（`npm install -g pnpm@11`） |
| PostgreSQL | ≥ 16 | 主数据库，端口 5432 |
| Docker | ≥ 24 | 快速启动 PG（推荐） |
| Python | ≥ 3.10 | 情报雷达（可选） |
| Nginx | 任意 | 生产反代（可选） |

---

## 2. 快速开始（5 分钟）

```bash
# 1. 解压
cd /path/to/cybernaut-dist

# 2. 配置环境
cp .env.example .env
# 编辑 .env：至少确认 DATABASE_URL 正确

# 3. 启动数据库
docker compose up -d          # 或手动建库

# 4. 导入生产数据（可选，跳过则自动建空库+种子数据）
PGPASSWORD=cyb_mvp_2026 psql -U cybernaut -h 127.0.0.1 cybernaut_mvp < cybernaut_mvp_dump.sql

# 5. 安装并启动
npm install
npm run dev                    # 前端 :5173 + 后端 :3100

# 6. 验证
curl http://localhost:3100/api/health
# → {"ok":true,"service":"intelligent-investment-platform-api",...}
```

浏览器打开 `http://localhost:5173`，用 `admin@cybernaut.com / 123456` 登录。

---

## 3. .env 逐项配置

### 3.1 必填项

```ini
# 数据库连接（唯一必填）
DATABASE_URL=postgres://cybernaut:cyb_mvp_2026@127.0.0.1:5432/cybernaut_mvp
```

只配置这一项，基础 CRUD 就能跑（项目管理、文件上传、会议记录）。

### 3.2 AI 功能（对话/摘要/RAG 需要）

```ini
# LLM 网关 — 所有 AI 能力的底座
LLM_BASE_URL=http://127.0.0.1:18081/v1
LLM_API_KEY=sk-xxxxxxxx
LLM_MODEL=claude-sonnet-4-6

# OpenAI 兼容网关 — RAG 文档解析 / OCR，通常和 LLM 同网关
OPENAI_BASE_URL=http://127.0.0.1:18081/v1
OPENAI_API_KEY=sk-xxxxxxxx
OCR_VISION_MODEL=gemini-3.1-pro-preview

# Flue Agent 编排 — AI 对话多步推理 / PPT 生成
FLUE_BASE_URL=http://127.0.0.1:3584

# 图片生成网关 — AI 封面 / PPT 出图
GATEWAY_IMAGE_BASE_URL=https://getways-jumu.zeelin.cn
GATEWAY_IMAGE_API_KEY=sk-xxxxxxxx
```

### 3.3 鉴权与安全

```ini
JWT_SECRET=cybernaut-dev-secret-change-me    # 生产务必换掉！
JWT_EXPIRES_IN=24h
INTERNAL_SECRET=cybernaut-internal-2026       # 内部服务间调用密钥，生产换掉
```

### 3.4 外部服务集成

```ini
# 情报雷达 — 本地多信源服务
RADAR_BASE_URL=http://127.0.0.1:8121

# Agent 工作空间 — PPT/文件产物存储目录
AGENT_WORKSPACE=/var/lib/cybernaut-assistant/workspace

# AI 业务 Skill — 默认读取 $AGENT_WORKSPACE/.agents/skills
# 若 Skill 以独立只读卷部署，可显式覆盖
AI_SKILL_ROOT=/var/lib/cybernaut-assistant/workspace/.agents/skills
```

### 3.5 性能调优

```ini
SCORE_QUEUE_CONCURRENCY=3     # 线索评分并发数
INGEST_MAX_ATTEMPTS=3         # RAG 文档摄入重试次数
```

### 3.6 完整 .env 模板

<details>
<summary>点击展开完整模板（可直接复制）</summary>

```ini
# ---- 运行模式 ----
NODE_ENV=development

# ---- 端口 ----
API_PORT=3100

# ---- 数据库 ----
DATABASE_URL=postgres://cybernaut:cyb_mvp_2026@127.0.0.1:5432/cybernaut_mvp

# ---- JWT ----
JWT_SECRET=cybernaut-dev-secret-change-me
JWT_EXPIRES_IN=24h

# ---- LLM 网关 ----
LLM_BASE_URL=http://127.0.0.1:18081/v1
LLM_MODEL=claude-sonnet-4-6
LLM_API_KEY=

# ---- OpenAI 兼容网关 ----
OPENAI_BASE_URL=http://127.0.0.1:18081/v1
OPENAI_API_KEY=
OCR_VISION_MODEL=gemini-3.1-pro-preview

# ---- 图片生成网关 ----
GATEWAY_IMAGE_BASE_URL=https://getways-jumu.zeelin.cn
GATEWAY_IMAGE_API_KEY=

# ---- Flue Agent ----
FLUE_BASE_URL=http://127.0.0.1:3584

# ---- 内部密钥 ----
INTERNAL_SECRET=cybernaut-internal-2026

# ---- 情报雷达 ----
RADAR_BASE_URL=http://127.0.0.1:8121

# ---- Agent 工作空间 ----
AGENT_WORKSPACE=/var/lib/cybernaut-assistant/workspace
AI_SKILL_ROOT=/var/lib/cybernaut-assistant/workspace/.agents/skills

# ---- 性能 ----
SCORE_QUEUE_CONCURRENCY=3
INGEST_MAX_ATTEMPTS=3
```
</details>

---

## 4. PostgreSQL 配置

### 4.1 Docker 方式（推荐）

```bash
docker compose up -d
```

检查状态：

```bash
docker compose ps
# NAME              STATUS              PORTS
# cybernaut-pg      running             0.0.0.0:5432->5432/tcp
```

### 4.2 手动安装 PostgreSQL

```bash
# CentOS/RHEL
dnf install -y postgresql16-server
postgresql-16-setup initdb
systemctl enable --now postgresql-16

# 创建用户和数据库
sudo -u postgres psql <<SQL
CREATE USER cybernaut WITH PASSWORD 'cyb_mvp_2026';
CREATE DATABASE cybernaut_mvp OWNER cybernaut;
GRANT ALL PRIVILEGES ON DATABASE cybernaut_mvp TO cybernaut;
SQL
```

### 4.3 修改 pg_hba.conf（如连不上）

```bash
# 找到 pg_hba.conf
sudo -u postgres psql -c "SHOW hba_file;"

# 确保有这一行（允许本地密码登录）
# local   all   all   md5
# host    all   all   127.0.0.1/32   md5

# 重载配置
sudo systemctl reload postgresql-16
```

### 4.4 导入生产数据

```bash
# 先确保空库已创建
PGPASSWORD=cyb_mvp_2026 psql -U cybernaut -h 127.0.0.1 cybernaut_mvp < cybernaut_mvp_dump.sql
```

> **注意**：如果先跑过 `npm run dev`（自动建了空表），导入会报唯一约束冲突。此时先 `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` 再导入。

---

## 5. Nginx 反向代理（生产）

### 5.1 配置

```nginx
# /etc/nginx/conf.d/cybernaut.conf
server {
    listen 80;
    server_name your-domain.com;       # 改成实际域名

    # 前端静态资源（Vite build 产物，带 hash 可长缓存）
    location /assets/ {
        root /path/to/cybernaut-dist/dist;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # 前端入口（禁止缓存）
    location / {
        root /path/to/cybernaut-dist/dist;
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # Flue Agent 编排层（长前缀优先于 /api/，必须放在 /api/ 前面）
    location /ai/api/ {
        proxy_pass http://127.0.0.1:3584/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;        # Agent 推理耗时较长
        proxy_connect_timeout 10s;
    }

    # 后端 API 反代
    location /api/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;        # AI 对话/PPT 生成较慢
        client_max_body_size 150m;      # 大文件上传
    }

    # 生成文件（PPT 产物等）
    location /generated/ {
        alias /path/to/cybernaut-dist/server/generated/;
        expires 1d;
    }
}
```

> **重要**：`/ai/api/` 必须放在 `/api/` **前面**，否则 nginx 会用 `/api/` 规则拦截 Flue 请求转发到 Express，导致前端 Flue SDK 解析 HTML 报错 `Cannot read properties of undefined (reading 'map')`。

### 5.2 生效

```bash
nginx -t && systemctl reload nginx
```

### 5.3 HTTPS（Let's Encrypt）

```bash
# certbot 自动获取证书
certbot --nginx -d your-domain.com
```

---

## 6. systemd 进程守护（生产）

### 6.1 主 API 服务

```ini
# /etc/systemd/system/cybernaut-api.service
[Unit]
Description=Cybernaut Investment Platform API
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/cybernaut-dist
EnvironmentFile=/path/to/cybernaut-dist/.env
ExecStart=/usr/bin/node --env-file=.env server-dist/index.js
Restart=on-failure
RestartSec=5

# 日志
StandardOutput=append:/path/to/cybernaut-dist/logs/server.log
StandardError=append:/path/to/cybernaut-dist/logs/server.log

[Install]
WantedBy=multi-user.target
```

### 6.2 Flue Agent 服务（AI 功能必须）

```ini
# /etc/systemd/system/cybernaut-flue.service
[Unit]
Description=Cybernaut Flue Agent Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/www/flue-cybernaut
Environment=ANTHROPIC_API_KEY=sk-xxxxxxxx
ExecStart=/usr/bin/npx vite dev --port 3584 --host 127.0.0.1
Restart=on-failure
RestartSec=5

StandardOutput=append:/path/to/cybernaut-dist/logs/flue.log
StandardError=append:/path/to/cybernaut-dist/logs/flue.log

[Install]
WantedBy=multi-user.target
```

### 6.3 情报雷达服务（可选）

```ini
# /etc/systemd/system/cybernaut-radar.service
[Unit]
Description=Cybernaut Project Discovery Radar
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/cybernaut-dist/project-discovery
ExecStart=/usr/bin/python3 -m uvicorn app:app --host 0.0.0.0 --port 9888
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 6.4 启用

```bash
# 先编译
cd /path/to/cybernaut-dist
npm run build

# 创建日志目录
mkdir -p logs server/generated

# 注册并启动
systemctl daemon-reload
systemctl enable --now cybernaut-api
systemctl enable --now cybernaut-flue     # AI 功能必须
systemctl enable --now cybernaut-radar   # 可选
```

---

## 7. Flue Agent 编排层

Flue 是独立的 Agent 编排框架，通过 HTTP 与主平台通信。AI 对话、RAG 检索、PPT 生成都依赖它。

### 7.1 架构

```
浏览器 → :80 nginx
           ├─ /          → dist/ (React SPA)
           ├─ /api/*     → :3100 Express 后端
           └─ /ai/api/*  → :3584 Flue Agent
                              ↓ tools 回调
                            :3100 /api/internal (RAG 检索等)
                              ↓ LLM 调用
                            Anthropic API (claude-sonnet-4-6)
```

### 7.2 克隆 Flue 源码

```bash
cd /www
git clone https://github.com/withastro/flue.git
cd flue
```

### 7.3 安装依赖并构建核心包

```bash
# 需要 pnpm ≥ 11
npm install -g pnpm@11

# 安装 Flue monorepo 依赖
pnpm install

# 构建核心包（runtime / vite / cli）
pnpm build
# 注：examples 下的 Cloudflare 等示例构建失败属正常，core 包构建成功即可
# 验证：ls packages/runtime/dist/ packages/vite/dist/ packages/cli/dist/
```

### 7.4 创建 Cybernaut Flue 项目

为 cybernaut 创建独立的 Flue assistant 项目：

```bash
mkdir -p /www/flue-cybernaut/src/agents
cd /www/flue-cybernaut
```

`package.json`：

```json
{
  "name": "cybernaut-assistant",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev --port 3584",
    "build": "vite build",
    "start": "node dist/server.mjs"
  },
  "dependencies": {
    "@flue/runtime": "file:/www/flue/packages/runtime",
    "hono": "^4.7.0",
    "just-bash": "^3.0.1"
  },
  "devDependencies": {
    "@flue/vite": "file:/www/flue/packages/vite",
    "vite": "^8.0.14"
  }
}
```

`vite.config.ts`：

```ts
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
  server: {
    allowedHosts: ['cybernaut.newmin.cn', 'localhost', '127.0.0.1'],
  },
});
```

`flue.config.ts`：

```ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
});
```

`src/app.ts` — 路由注册，挂载 assistant agent + health 端点：

```ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'cybernaut-flue', timestamp: new Date().toISOString() }),
);

app.route('/agents/assistant', createAgentRouter(Assistant));

export default app;
```

`src/agents/assistant.ts` — AI 投研助手 agent，包含 `search_project_docs` 和 `collect_intel` 两个工具回调：

```ts
'use agent';
import { bash, useModel, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(bash(() =>
    new Bash({ fs: new InMemoryFs(), network: { dangerouslyAllowFullInternetAccess: true } }),
  ));

  // 情报采集工具 → Express /api/internal/collect-intel
  useTool({
    name: 'collect_intel',
    description: '从外部源采集公司情报',
    async run({ data }) {
      const res = await fetch('http://127.0.0.1:3100/api/internal/collect-intel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET || 'cybernaut-internal-2026',
        },
        body: JSON.stringify(data),
      });
      return res.json();
    },
  });

  // 项目文档检索 → Express /api/internal/search-docs
  useTool({
    name: 'search_project_docs',
    description: '检索项目资料库中的文档',
    async run({ data }) {
      const res = await fetch('http://127.0.0.1:3100/api/internal/search-docs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET || 'cybernaut-internal-2026',
        },
        body: JSON.stringify(data),
      });
      return res.json();
    },
  });

  return '你是赛智伯乐（Cybernaut）投资中台的 AI 投研助手。使用中文回复，基于检索证据回答，区分事实与分析。';
}
```

### 7.5 安装并验证

```bash
cd /www/flue-cybernaut
npm install

# 设置 Anthropic API Key（Flue 调用 LLM 需要）
export ANTHROPIC_API_KEY=sk-xxxxxxxx

# 开发模式启动（前台验证）
npx vite dev --port 3584 --host 127.0.0.1

# 另开终端验证
curl http://127.0.0.1:3584/health
# → {"ok":true,"service":"cybernaut-flue",...}
```

### 7.6 systemd 进程守护

```ini
# /etc/systemd/system/cybernaut-flue.service
[Unit]
Description=Cybernaut Flue Agent Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/www/flue-cybernaut
Environment=ANTHROPIC_API_KEY=sk-xxxxxxxx
ExecStart=/usr/bin/npx vite dev --port 3584 --host 127.0.0.1
Restart=on-failure
RestartSec=5

StandardOutput=append:/path/to/cybernaut-dist/logs/flue.log
StandardError=append:/path/to/cybernaut-dist/logs/flue.log

[Install]
WantedBy=multi-user.target
```

启用：

```bash
systemctl daemon-reload
systemctl enable --now cybernaut-flue
systemctl status cybernaut-flue
```

### 7.7 端点验证

```bash
# Flue 本地
curl http://127.0.0.1:3584/health

# 通过 Nginx 反代
curl http://your-domain.com/ai/api/health
# 预期: {"ok":true,"service":"cybernaut-flue",...}

# Express 同样正常
curl http://127.0.0.1:3100/api/health
# 预期: {"ok":true,"service":"intelligent-investment-platform-api",...}
```

### 7.8 .env 配置

```ini
FLUE_BASE_URL=http://127.0.0.1:3584

# Flue 需要的 LLM API Key（在 .env 或 Flue systemd 的 Environment 中设置）
ANTHROPIC_API_KEY=sk-xxxxxxxx
```

### 7.9 Skill 工作区

合规性说明、投资提案、投资建议书、尽调报告和 Q&A 的 Agent Skill
位于 `server/workspace/.agents/skills/`。Flue assistant 通过 Express 的
`/api/internal/*` 回调间接使用这些 Skill——Skill 的执行逻辑在 Express 后端，
Flue agent 只负责编排调度。

如果暂时没有 Flue，基础 CRUD 功能不受影响，以下功能不可用：
- AI 智能问答
- 文档 RAG 检索
- AI 摘要生成
- PPT 自动生成
- 线索自动评分

---

## 8. 情报雷达（project-discovery）

### 8.1 本地启动

```bash
cd project-discovery
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
./start.sh     # 默认仅监听 127.0.0.1:8121
```

### 8.2 恢复旧雷达数据

本地数据为空时，可通过旧雷达的只读接口恢复候选记录和公众号清单：

```bash
.venv/bin/python scripts/bootstrap_from_remote.py \
  --remote-base http://101.126.93.130:8121
```

生产环境的 `deploy.sh` 会自动完成这一步，并将数据保存在
`/var/lib/cybernaut-radar`。GSData 凭据不能从旧接口导出，需在 `.env`
单独配置 `GSDATA_APP_KEY` 和 `GSDATA_APP_SECRET`。

### 8.3 Skills 说明

`project-discovery/` 包含的技能链（供 AI Agent 调用）：

| 目录 | 功能 | 入口 |
|---|---|---|
| `GordenImagePPTGen/` | 从主题 AI 出图生成 PPT | `SKILL.md` |
| `GordenImage2PPTX/` | 图片 PPT → 可编辑 PPTX | `SKILL.md` + `scripts/` |
| `GordenSuperPPTSkill/` | 一键全流程编排 | `SKILL.md` |
| `skills-financial-research-analyst-main/` | 金融研究分析（DCF/估值/行业） | `SKILL.md` + `scripts/` |

---

## 9. 工具脚本运行

### 9.1 准备工作

所有工具脚本依赖编译后的 `server-dist/`，先构建：

```bash
npm run build
```

### 9.2 脚本速查

```bash
# 每日情报摄入（从储备库取线索入池）
node daily_intake.mjs

# 批量分析线索
node batch_analyze.mjs                  # 补漏模式
SCOPE=all FORCE=1 node batch_analyze.mjs # 强制全量

# 评分重算
node rescore.mjs                        # 低分线索重评
node rescore_all.mjs                    # 全量重评

# 导入候选项目
node import_reserve.mjs
```

所有脚本已改为相对路径，无需 cd 到特定目录。

---

## 10. 故障排查

### 10.1 数据库

```bash
# 连不上
pg_isready -h 127.0.0.1 -U cybernaut -d cybernaut_mvp
# 检查 pg_hba.conf 和防火墙

# 启动报 "role cybernaut does not exist"
sudo -u postgres psql -c "CREATE USER cybernaut WITH PASSWORD 'cyb_mvp_2026';"

# 导入 dump 报唯一约束冲突
sudo -u postgres psql -d cybernaut_mvp -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
# 然后重新导入
```

### 10.2 端口占用

```bash
# 查看端口占用
ss -tlnp | grep -E '3100|5173|5432'

# 释放端口
kill -9 $(lsof -t -i:3100)

# 或修改 .env 中 API_PORT
```

### 10.3 npm 依赖

```bash
# 安装失败
rm -rf node_modules package-lock.json
npm cache clean --force
npm install

# 确认 Node 版本
node -v   # 必须 ≥ 20
```

### 10.4 AI 功能

```bash
# AI 对话无响应 → 检查网关连通性
curl http://127.0.0.1:18081/v1/models -H "Authorization: Bearer $LLM_API_KEY"

# Flue Agent 不可达
curl http://127.0.0.1:3584/health

# RAG 文档解析失败 → 检查 OCR 模型
curl http://127.0.0.1:18081/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model":"gemini-3.1-pro-preview","messages":[{"role":"user","content":"test"}]}'
```

### 10.5 前端白屏

```bash
# 检查构建产物
ls dist/index.html    # 应存在

# 检查 nginx 配置
nginx -t

# 检查 Vite 开发服务器
curl http://localhost:5173
```

---

## 附录：快速检查清单

部署完成后逐项验证：

```bash
# □ 1. PG 运行
pg_isready -h 127.0.0.1 -U cybernaut -d cybernaut_mvp

# □ 2. 后端健康
curl http://localhost:3100/api/health

# □ 3. 前端可访问
curl -o /dev/null -s -w '%{http_code}' http://localhost:5173
# → 200

# □ 4. 登录可用
curl -s http://localhost:3100/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cybernaut.com","password":"123456"}' | grep -o '"token":"[^"]*"'
# → 应返回 JWT token

# □ 5. LLM 网关（如配置了）
curl -s http://127.0.0.1:18081/v1/models | head -c 100

# □ 6. Flue Agent（如配置了）
curl -s http://127.0.0.1:3584/health

# □ 7. 情报雷达（如配置了）
curl -s http://127.0.0.1:8121/api/candidates?limit=1 | head -c 100
```
