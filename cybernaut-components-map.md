# 系统组件分布：信源 / Agent / 评分

> 项目：浙江赛智伯乐投资中台 MVP（cybernaut-mvp）
> 服务器：101.126.131.28 · 整理日期：2026-07-22
>
> 本文记录服务器部署快照；当前本地一体化开发环境统一使用
> `http://127.0.0.1:3584`，以根目录 `.env` 和源码配置为准。

---

## 一、信源（线索数据来源）

| 信源 | 位置 / 地址 | 说明 |
|---|---|---|
| **项目发现雷达**（多信源聚合服务） | `http://101.126.93.130:8121/api/candidates` | 机构公众号 / 高校公众号 / 创投新闻 / 微信群聊 / 论文(arxiv) 的统一上游。中台通过 `POST /api/leads/sync-radar` 拉取，按返回数据的 `source_group` 字段映射成渠道（`radar_profile->>'channel'`）。`?source=` 参数只认 `arxiv`。 |
| **36氪储备池** | 本机 PostgreSQL `lead_reserve` 表（约 1 万条） | 每日 8 点 cron `run_daily_intake.sh` → `daily_intake.mjs` 按序取 50 条入池（渠道='36氪'）。 |

### 信源代码位置（在 `/data/cybernaut-mvp` 主项目）

| 信源 | 代码文件 | 关键位置 |
|---|---|---|
| **雷达多信源**（机构/高校/创投/微信/论文） | `server/src/routes/meta.ts` | L143 `RADAR_BASE = http://101.126.93.130:8121`；L144 `POST /leads/sync-radar` handler：fetch `/api/candidates`(L149) → 去重 → 噪音闸 → INSERT leads |
| **36氪每日入池** | `daily_intake.mjs`（项目根目录） | 从 `lead_reserve` 按 seq 取 50 条未入池 → INSERT leads → 标记 imported；cron `run_daily_intake.sh` 每日 8 点触发 |
| **36氪储备库建表/导入** | `import_reserve.mjs`（项目根目录） | 一次性脚本：建 `lead_reserve` 表 + 导入 1 万条 36氪 CSV |

> ⚠️ 雷达服务本体（101.126.93.130:8121 的抓取端代码）**在另一台机器上**，本服务器只有消费它的客户端代码（meta.ts 的 sync-radar）。渠道数据偏斜（高校多、创投/微信少）是雷达上游现状，需在该服务侧扩量。

**信源入库链路**：雷达/36氪 → `leads` 表 → AI 分析（评分 workflow）→ `scoring.dimensions` 落库 → 前端展示（未分析不显示）。

---

## 二、Agent（AI 智能助手）

| 项 | 值 |
|---|---|
| Agent 名 | **`assistant`** |
| 代码位置 | **`/data/cybernaut-assistant/src/agents/assistant.ts`** |
| 运行服务 | Flue 服务 `node --env-file=.env dist/server/server.mjs`，监听 **127.0.0.1:8791** |
| 模型 | `FLUE_MODEL=zeelin-oai/gpt-5.5` |
| 调用入口 | 前端 AI 助手页（AIAssistantPage）直连 8791，`POST /agents/assistant/...` |
| 挂载工具 | searchProjectDocs / collectIntel / publishFile / readPptx |

---

## 三、评分（AI 分析 workflow）

| 项 | 值 |
|---|---|
| 代码位置 | **`/data/cybernaut-assistant/src/workflows/`**（与 assistant 同属 Flue 服务 :8791） |
| ├ 公司项目评分 | `score-project.ts` → `POST /workflows/score-project`，**7 维**（交易可参与性等） |
| └ 论文评分 | `score-paper.ts` → `POST /workflows/score-paper`，**5 维**（技术实力30/落地28/市场20/学术12/商业化10） |
| 评分模型 | `SCORE_MODEL=zeelin/DeepSeek-V4-Pro` |
| 触发路由 | 主项目 `/data/cybernaut-mvp/server/src/routes/meta.ts` 的 `doScore`：按 `radar_profile->>'channel' === '论文'` 路由到 score-paper，否则 score-project |
| 调用方式 | 主项目后端 `FLUE_BASE_URL=http://127.0.0.1:8791` 异步调用，单条约 2–3 分钟，后端 3 并发队列 |

---

## 四、组件关系总览

```
┌─ 信源 ─────────────────────────────────┐
│ 雷达 101.126.93.130:8121 (机构/高校/创投/微信/论文)
│ 36氪 lead_reserve 表 (每日 cron 50条)
└──────────────┬─────────────────────────┘
               ▼ 入池 leads 表
┌─ 主项目 /data/cybernaut-mvp ───────────┐
│ 前端 Vite+React → nginx :5180          │
│ 后端 Express+Drizzle+PG :3100 (systemd)│
│ doScore 路由: 论文→score-paper         │
│               其他→score-project       │
└──────────────┬─────────────────────────┘
               ▼ FLUE_BASE_URL=:8791
┌─ Flue 服务 /data/cybernaut-assistant ──┐
│ agent:     assistant    (gpt-5.5)      │ ← AI 助手页直连
│ workflow:  score-project (DeepSeek-V4-Pro) ← 评分
│            score-paper   (DeepSeek-V4-Pro) ← 评分
└────────────────────────────────────────┘
```

**一句话**：信源在外部雷达服务（101.126.93.130:8121）+ 本机 36氪储备表；agent 和评分都在 `/data/cybernaut-assistant`（Flue 服务，:8791）——agent 是 `assistant`（gpt-5.5），评分是 `score-project` / `score-paper` 两个 workflow（DeepSeek-V4-Pro）。
