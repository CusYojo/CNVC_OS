# intelligent-investment-platform 开发环境搭建指南

## 项目概览

**智能投资管理平台** — 覆盖项目全生命周期（线索→初筛→立项→尽调→上会→投决→投后→退出）的一站式工具。

## 整体架构

```
┌─────────────────────────────────────────────────────┐
│  前端 (Vite + React 18 + TailwindCSS + Zustand)      │
│  src/                                                 │
├─────────────────────────────────────────────────────┤
│  后端 API (Express 5 + Drizzle ORM)                   │
│  server/src/                                          │
│  HTTP :4100/api/* + WebSocket :4100/socket.io         │
├─────────────────────────────────────────────────────┤
│  JW Agent Runtime（内嵌 Express 进程）                 │
│  - Claude Agent SDK / RAG 检索 / 工具调用              │
│  - 会话、消息、工具结果持久化到 MySQL                  │
├─────────────────────────────────────────────────────┤
│  MySQL 8.x（表名前缀由 DB_FREFIX 配置）                │
├─────────────────────────────────────────────────────┤
│  Radar TypeScript 采集器（内嵌 Express 进程）          │
│  - 公众号 / arXiv / 微信聊天 Push / 多渠道采集          │
│  - 原始事件、候选、来源、状态与调度全部写入 MySQL       │
└─────────────────────────────────────────────────────┘
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite 6 + TailwindCSS 3 + Zustand |
| 后端 | Express 5 + TypeScript + Drizzle ORM |
| AI 编排 | Claude Agent SDK + 进程内 JW Runtime + Socket.io |
| 数据库 | MySQL 8.x + Drizzle 版本化迁移 |
| 路由 | React Router 7 |
| 线索发现 | TypeScript 进程内采集器 + MySQL Runtime Job |
| Skills | GordenImage2PPTX / GordenImagePPTGen / Financial Research Analyst |

## 目录结构

```
cybernaut-dist/
├── src/                          # 前端源码 (React)
│   ├── components/               # 通用组件
│   ├── layout/                   # 布局
│   ├── lib/                      # 工具（API 客户端、uid）
│   ├── pages/                    # 15 个页面
│   ├── store/                    # Zustand 状态管理
│   └── types/                    # TypeScript 类型
├── server/src/                   # 后端源码 (Express)
│   ├── controllers/              # 控制器
│   ├── db/                       # 数据库（schema / client / migrate）
│   ├── middleware/                # 中间件（鉴权、错误处理）
│   ├── routes/                   # 路由 (auth/projects/meetings/risks/...)
│   └── services/                 # 业务逻辑 + AI 服务
├── server/workspace/.agents/skills/ # 文档与 PPT Skills
├── server/drizzle/               # MySQL 版本化迁移
├── public/                       # 静态资源
├── docs/                         # 项目文档
└── 工具脚本                       # 数据批处理/修复脚本
```

## 快速开始

### 1. 环境准备

- **Node.js** ≥ 20
- **MySQL** ≥ 8.0（字符集 `utf8mb4`）
- **Python** ≥ 3.10（文档/PPT/PDF 受监督任务需要，Radar 不依赖）
- **npm** ≥ 10

### 2. 启动数据库

```bash
# 方式 A：Docker（推荐）
docker compose up -d

# 方式 B：使用已有 MySQL 8.x，并确保目标库字符集为 utf8mb4
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填入：
#   - DB_HOST / DB_PORT / DB_DATABASE
#   - DB_USERNAME / DB_PASSWORD / DB_FREFIX
#   - OPENAI_BASE_URL / OPENAI_API_KEY（需兼容 Claude Agent SDK；当前验收地址为 https://skill.zeelin.cn/api/v9）
#   - LLM_MODEL / JW_AGENT_MODEL / SCORE_MODEL（当前验收模型为 gpt-5.6-sol）
#   - JW_AGENT_MODEL / JW_AGENT_PERMISSION_MODE
#   - MODEL_CREDENTIAL_ENCRYPTION_KEY（32 字节 Base64 或 64 位 Hex）
#   - MODEL_PROVIDER_ALLOWED_HOSTS（逗号分隔的模型网关主机名）
```

### 4. 主平台：安装依赖 & 启动

```bash
npm install
npm run dev          # 同时启动前端(:5173) + 后端(:4100)
```

首次启动会执行版本化 Schema 迁移。演示用户默认不创建；仅本地测试可显式设置 `SEED_DEMO_USERS=1`。

模型 Provider、模型清单和七类任务路由由管理员在 `/system/ai/models` 配置。API Key
只在新增/替换时提交，MySQL 仅保存 AES-256-GCM 密文，页面只显示末四位掩码。
生产部署脚本会为全新环境生成独立加密主密钥；已有环境必须保留原主密钥，不能直接替换，
否则已有 Provider 凭据将无法解密。任何曾粘贴到聊天、工单或日志中的网关 Key 都应先在
供应商侧吊销并生成新值，再通过该页面写入。

### 5. Radar 运行时

Radar 随 API 主进程启动，不需要额外安装或启动服务。通过
`/api/health/components` 检查 `radar-typescript-collector` 和
`radar-mysql-source`；生产环境不得监听 8121。

### 6. 访问

| 地址 | 说明 |
|---|---|
| `http://localhost:5173` | 前端开发服务器 |
| `http://localhost:4100/api/health` | 后端健康检查 |
| `http://localhost:4100/socket.io` | JW Agent 实时事件（由客户端连接） |

### 7. 本地演示账号

默认不会创建演示账号。仅在本地设置 `SEED_DEMO_USERS=1` 后，首次启动会按需创建：

| 角色 | 邮箱 | 密码 |
|---|---|---|
| 系统管理员 | admin@cybernaut.com | 123456 |
| 投资经理 | lin@cybernaut.com | 123456 |
| 投资总监 | chen@cybernaut.com | 123456 |

## 构建与生产部署

```bash
npm run build        # 编译前端+后端
npm run start:app    # 唯一项目启动入口（需先 build）
```

生产只安装 `cybernaut-app.service`，项目只监听 4100。MySQL 与 LLM Gateway
属于外部基础设施，不由该 systemd 单元启动。

## NPM Scripts

| 命令 | 说明 |
|---|---|
| `npm run dev` | 同时启动 API(:4100) + Web(:5173) |
| `npm run dev:web` | 仅前端 |
| `npm run dev:server` | 仅后端 |
| `npm run build` | 编译 TypeScript + Vite 打包 |
| `npm run check` | 类型检查 |
| `npm run migrate:radar` | 将 Radar JSONL/JSON/来源清单幂等导入 MySQL |
| `npm run accept:socket` | 验证 Socket 鉴权、隔离、推送、失效和重连（需先启动 API） |
| `npm run accept:auth` | 验证 HttpOnly 会话、CSRF/Origin、吊销和旧 Bearer 拒绝（需先启动 API） |
| `npm start` / `npm run start:app` | 生产统一启动入口 |

## Skills 说明

### Gorden PPT 技能链

| Skill | 功能 |
|---|---|
| `GordenImagePPTGen` | 从主题/内容 AI 生成图片型 PPT |
| `GordenImage2PPTX` | 图片 PPT → 可编辑 .pptx（四层还原）|
| `GordenSuperPPTSkill` | 一键全流程：生成 + 还原 |

每个 skill 含 `SKILL.md`（prompt）、`references/`（参考文档）、`scripts/`（Python 工具）。

### Financial Research Analyst

专业金融分析 skill，覆盖：
- 股权分析（DCF/倍数法/反向DCF/分部估值）
- 行业分析（消费/能源/金融/医药/工业/REITs/科技SaaS）
- 宏观分析（国家/行业/跨境）
- 特殊情景（并购套利/困境/做空/分拆）
- 模板（投资备忘录/快评/收益反应/私有公司 memo）

## 工具脚本

| 文件 | 用途 |
|---|---|
| `runtime_jobs` / `runtime_job_runs` | MySQL 持久化 Radar 与储备池摄入调度 |
| `rescore.mjs` / `rescore_all.mjs` | 评分重算 |
| `import_reserve.mjs` | 导入候选项目 |
| `patch_*.py` | 数据修复/迁移脚本 |
| `npm run backfill:paper-meta:preview` / `npm run backfill:paper-meta` | 从 MySQL Radar 当前投影预览/执行论文元数据幂等回填，不依赖 8121 HTTP 服务 |

## 数据库

由 Drizzle ORM 管理，`server/src/db/schema.ts` 定义 schema，`server/src/db/migrate.ts` 自动建表。

核心表：`users`, `projects`, `project_files`, `meetings`, `todos`, `risks`, `ai_summaries`, `leads`, `audit_logs`, `chat_conversations`, `knowledge_chunks`

## AI 服务架构

```
前端 AI 对话
  → POST /api/agent/conversations/:agentId
  → 进程内 JW Agent Runtime
    → Claude Agent SDK / LLM Gateway
    → search_project_docs 等进程内工具
  → MySQL agent_* 持久化
  → REST 短轮询返回流式快照与历史补偿
```

## 常见问题

**Q: 数据库连接失败**
A: 确认 MySQL 8.x 可用，`DB_HOST`、`DB_PORT`、`DB_DATABASE`、`DB_USERNAME`、
`DB_PASSWORD` 和 `DB_FREFIX` 正确。

**Q: AI 对话/摘要不工作**
A: 确认 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 指向可用的兼容网关，并检查
`JW_AGENT_MODEL`。本地默认网关未启动时，数据库功能正常但 AI 实答会失败。

**Q: 上传大文件超时**
A: 默认 body 限制 150MB，可在 `server/src/index.ts` 调整。

**Q: Radar 如何启动**
A: 只启动主服务；采集器和 MySQL 调度器会在同一 Node 进程内恢复。
