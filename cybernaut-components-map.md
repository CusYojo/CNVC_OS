# 系统组件分布：信源 / Agent / 评分

> 项目：浙江赛智伯乐投资中台 MVP（cybernaut-mvp）
> 服务器：101.126.131.28 · 整理日期：2026-07-22
>
> 本文原始内容记录服务器部署快照；当前一体化版本已将 Agent Runtime
> 和项目发现雷达都收进主项目，以根目录 `.env` 和 `deploy.sh` 为准。

---

## 一、信源（线索数据来源）

| 信源 | 位置 / 地址 | 说明 |
|---|---|---|
| **项目发现雷达**（多信源聚合服务） | 源码 `project-discovery/`；本机 `http://127.0.0.1:8121/api/candidates` | 机构公众号 / 高校公众号 / 创投新闻 / 微信群聊 / 论文(arxiv) 的统一上游。中台通过 `POST /api/leads/sync-radar` 拉取，按返回数据的 `source_group` 字段映射成渠道（`radar_profile->>'channel'`）。旧服务 `101.126.93.130:8121` 仅作为首次数据迁移源。 |
| **36氪储备池** | 本机 PostgreSQL `lead_reserve` 表（约 1 万条） | 每日 8 点 cron `run_daily_intake.sh` → `daily_intake.mjs` 按序取 50 条入池（渠道='36氪'）。 |

### 信源代码位置（在 `/data/cybernaut-mvp` 主项目）

| 信源 | 代码文件 | 关键位置 |
|---|---|---|
| **雷达服务本体** | `project-discovery/app.py` | FastAPI 多信源聚合、采集任务与 `/api/candidates` 接口；运行数据位于 `project-discovery/data/`，生产环境持久化到 `/var/lib/cybernaut-radar/` |
| **雷达消费端** | `server/src/routes/meta.ts` | 读取 `RADAR_BASE_URL`；`POST /leads/sync-radar` → fetch `/api/candidates` → 去重 → 噪音闸 → INSERT leads |
| **36氪每日入池** | `daily_intake.mjs`（项目根目录） | 从 `lead_reserve` 按 seq 取 50 条未入池 → INSERT leads → 标记 imported；cron `run_daily_intake.sh` 每日 8 点触发 |
| **36氪储备库建表/导入** | `import_reserve.mjs`（项目根目录） | 一次性脚本：建 `lead_reserve` 表 + 导入 1 万条 36氪 CSV |

> 雷达历史运行数据和公众号 Excel 不进入 Git。`deploy.sh` 会将它们保存在
> `/var/lib/cybernaut-radar`，首次缺失时可通过旧服务只读恢复。GSData 密钥
> 只能通过受限权限的 `.env` 或 `gsdata_credentials.json` 单独迁移。

**信源入库链路**：雷达/36氪 → `leads` 表 → AI 分析（评分 workflow）→ `scoring.dimensions` 落库 → 前端展示（未分析不显示）。

---

## 二、Agent（AI 智能助手）

| 项 | 值 |
|---|---|
| Agent 名 | **`assistant`** |
| 代码位置 | **`cybernaut-assistant/src/agents/assistant.ts`** |
| 运行服务 | 仓库内 Flue Runtime 的生产构建产物，监听 **127.0.0.1:3584** |
| 模型 | `FLUE_MODEL=zeelin-oai/gpt-5.5` |
| 调用入口 | 前端 AI 助手页通过 Nginx `/ai/api/` 访问 Runtime |
| 挂载工具 | searchProjectDocs / collectIntel / publishFile / readPptx |

---

## 三、评分（AI 分析 workflow）

| 项 | 值 |
|---|---|
| 代码位置 | **`cybernaut-assistant/src/workflows/`**（与 assistant 同属 Flue 服务 :3584） |
| ├ 公司项目评分 | `score-project.ts` → `POST /workflows/score-project`，**7 维**（交易可参与性等） |
| └ 论文评分 | `score-paper.ts` → `POST /workflows/score-paper`，**5 维**（技术实力30/落地28/市场20/学术12/商业化10） |
| 评分模型 | 默认 `SCORE_MODEL=zeelin/DeepSeek-V4-Flash`，可由 `.env` 覆盖 |
| 触发路由 | `server/src/routes/meta.ts` 的 `doScore`：按 `radar_profile->>'channel' === '论文'` 路由到 score-paper，否则 score-project |
| 调用方式 | 主项目后端通过 `FLUE_BASE_URL=http://127.0.0.1:3584` 异步调用，后端默认 3 并发队列 |

---

## 四、组件关系总览

```
┌─ 信源 ─────────────────────────────────┐
│ 本地雷达 project-discovery :8121 (机构/高校/创投/微信/论文)
│ 36氪 lead_reserve 表 (每日 cron 50条)
└──────────────┬─────────────────────────┘
               ▼ 入池 leads 表
┌─ 主项目 /www/sbl ──────────────────────┐
│ 前端 Vite+React → nginx :5180          │
│ 后端 Express+Drizzle+PG :3100 (systemd)│
│ doScore 路由: 论文→score-paper         │
│               其他→score-project       │
└──────────────┬─────────────────────────┘
               ▼ FLUE_BASE_URL=:3584
┌─ Flue 服务 /www/sbl/cybernaut-assistant ┐
│ agent:     assistant    (gpt-5.5)      │ ← AI 助手页直连
│ workflow:  score-project (DeepSeek-V4-Flash) ← 评分
│            score-paper   (DeepSeek-V4-Flash) ← 评分
└────────────────────────────────────────┘
```

**一句话**：项目现在包含本地雷达服务 `project-discovery/` 和本地 Agent Runtime
`cybernaut-assistant/`；生产部署分别由 `cybernaut-radar`、`cybernaut-api`
和 `cybernaut-flue` 三个 systemd 服务托管，运行状态保存在 `/var/lib`，不随
Git 更新被覆盖。
