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
│  POST :3100/api/*                                     │
├─────────────────────────────────────────────────────┤
│  Flue Agent 编排层 (独立服务, :3584)                   │
│  - assistant agent: AI 对话 / RAG 检索 / PPT 生成     │
│  - 通过 FLUE_BASE_URL 与后端通信                      │
├─────────────────────────────────────────────────────┤
│  PostgreSQL 16 (cybernaut_mvp)                        │
├─────────────────────────────────────────────────────┤
│  线索发现服务 (Python Flask, project-discovery/)      │
│  - 公众号 / arXiv / 微信聊天 线索采集                  │
│  - Gorden PPT Skills (图片→可编辑PPTX)                 │
│  - Financial Research Analyst Skill                   │
└─────────────────────────────────────────────────────┘
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite 6 + TailwindCSS 3 + Zustand |
| 后端 | Express 5 + TypeScript + Drizzle ORM |
| AI 编排 | Flue SDK (beta.9) + Agent/Workflow |
| 数据库 | PostgreSQL 16 (自动建表) |
| 路由 | React Router 7 |
| 线索发现 | Python 3 + Flask |
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
├── project-discovery/            # 线索发现 + Skills
│   ├── app.py                    # Flask 线索发现主服务
│   ├── GordenSuperPPTSkills/     # PPT 生成/还原技能链
│   │   ├── GordenImage2PPTX/     #   图片→可编辑 PPTX
│   │   ├── GordenImagePPTGen/    #   AI 生成图片型 PPT
│   │   └── GordenSuperPPTSkill/  #   一键全流程编排
│   ├── skills-financial-research-analyst-main/
│   │   └── bigdata-financial-research-analyst/
│   │       ├── SKILL.md          #   金融研究分析 skill
│   │       ├── references/       #   分析框架（估值/行业/宏观/...）
│   │       └── scripts/          #   DCF/盈利质量/可比分析 Python 脚本
│   ├── data/                     # 线索数据 (JSONL)
│   └── static/                   # 线索发现前端页面
├── public/                       # 静态资源
├── docs/                         # 项目文档
└── 工具脚本                       # 数据批处理/修复脚本
```

## 快速开始

### 1. 环境准备

- **Node.js** ≥ 20
- **PostgreSQL** ≥ 16
- **Python** ≥ 3.10（如需运行线索发现服务）
- **npm** ≥ 10

### 2. 启动数据库

```bash
# 方式 A：Docker（推荐）
docker compose up -d

# 方式 B：已有 PostgreSQL
# CREATE USER cybernaut WITH PASSWORD 'cyb_mvp_2026';
# CREATE DATABASE cybernaut_mvp OWNER cybernaut;
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填入：
#   - DATABASE_URL（数据库连接串）
#   - LLM_API_KEY（LLM 网关密钥）
#   - FLUE_BASE_URL（Flue agent 地址，非必需）
```

### 4. 主平台：安装依赖 & 启动

```bash
npm install
npm run dev          # 同时启动前端(:5173) + 后端(:3100)
```

首次启动会自动建表（`ensureSchema()`）并写入演示用户。

### 5. 线索发现服务（可选）

```bash
cd project-discovery
pip install -r requirements.txt
bash start.sh        # 启动 Flask 线索采集服务
```

### 6. 访问

| 地址 | 说明 |
|---|---|
| `http://localhost:5173` | 前端开发服务器 |
| `http://localhost:3100/api/health` | 后端健康检查 |

### 7. 演示账号

首次运行后自动创建：

| 角色 | 邮箱 | 密码 |
|---|---|---|
| 系统管理员 | admin@cybernaut.com | admin123 |
| 投资经理 | pm@cybernaut.com | pm123 |
| 投资总监 | director@cybernaut.com | director123 |

## 构建与生产部署

```bash
npm run build        # 编译前端+后端
npm start            # 生产启动（需先 build）
```

生产环境推荐使用 `start.sh` 作为入口脚本。

## NPM Scripts

| 命令 | 说明 |
|---|---|
| `npm run dev` | 同时启动 API(:3100) + Web(:5173) |
| `npm run dev:web` | 仅前端 |
| `npm run dev:server` | 仅后端 |
| `npm run build` | 编译 TypeScript + Vite 打包 |
| `npm run check` | 类型检查 |
| `npm start` | 生产启动 |

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
| `daily_intake.mjs` | 每日情报摄入 |
| `batch_analyze.mjs` | 批量 AI 分析 |
| `rescore.mjs` / `rescore_all.mjs` | 评分重算 |
| `import_reserve.mjs` | 导入候选项目 |
| `patch_*.py` | 数据修复/迁移脚本 |
| `backfill_papermeta.*` | 论文元数据回填 |

## 数据库

由 Drizzle ORM 管理，`server/src/db/schema.ts` 定义 schema，`server/src/db/migrate.ts` 自动建表。

核心表：`users`, `projects`, `project_files`, `meetings`, `todos`, `risks`, `ai_summaries`, `leads`, `audit_logs`, `chat_conversations`, `knowledge_chunks`

## AI 服务架构

```
前端 AI 对话
  → POST /api/conversations/:id/messages
  → aiService.answerQuestion()
  → Flue Agent (FLUE_BASE_URL/agents/assistant/:sessionId)
    → search_project_docs (RAG, 走 /api/internal)
    → PPT 生成 / 其他工具
  → 流式返回结果
```

## 常见问题

**Q: 数据库连接失败**
A: 确认 PostgreSQL 运行中，`DATABASE_URL` 正确。

**Q: AI 对话/摘要不工作**
A: 确认 `LLM_BASE_URL` + `LLM_API_KEY`，以及 `FLUE_BASE_URL`（Flue 代理）。

**Q: 上传大文件超时**
A: 默认 body 限制 150MB，可在 `server/src/index.ts` 调整。

**Q: 线索发现服务的 Python 依赖**
A: `pip install -r project-discovery/requirements.txt`
