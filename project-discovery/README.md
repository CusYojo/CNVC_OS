# Project Discovery Radar

项目发现雷达是中台的多信源采集适配器，处理公众号、创投新闻、微信群聊和
arXiv 候选项目。生产运行采用单次 Job，由主项目按需启动，不再常驻监听端口。

## 本地运行

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -B job.py health
.venv/bin/python -B job.py candidates --limit 100
```

主项目通过 `npm run start:app` 统一调度这些 Job。`job.py` 每次执行一个动作，
在标准输出写入一行 JSON 后退出；不会触发 FastAPI 启动事件或常驻采集循环。

常用命令：

```bash
.venv/bin/python -B job.py health
.venv/bin/python -B job.py candidates --limit 100
.venv/bin/python -B job.py auto
.venv/bin/python -B job.py wechat-daily
.venv/bin/python -B job.py wechat-retry
.venv/bin/python -B job.py wechat-institution
```

`app.py` 中的 FastAPI 路由仅保留为旧部署的数据导出/回滚兼容面，不属于当前
生产启动链。不要再配置 `RADAR_BASE_URL`、`PORT=8121` 或独立 Radar systemd。

## 持久化数据

- 本地开发默认数据目录：`project-discovery/data/`
- 本地公众号清单：`project-discovery/公众号来源.xlsx`
- 生产部署数据目录：`/var/lib/cybernaut-radar/data/`
- 生产公众号清单：`/var/lib/cybernaut-radar/公众号来源.xlsx`

数据和含账号信息的 Excel 不进入 Git。首次部署若本机没有数据，
`deploy.sh` 会通过 `RADAR_BOOTSTRAP_URL` 从旧雷达的只读 API 恢复；
以后更新会保留 `/var/lib/cybernaut-radar`。

也可手工执行：

```bash
.venv/bin/python scripts/bootstrap_from_remote.py \
  --remote-base http://101.126.93.130:8121
```

## GSData 凭据

GSData 密钥不会由远程 API 导出，也不应提交到 Git。请写入项目根目录
`.env`：

```dotenv
GSDATA_APP_KEY=...
GSDATA_APP_SECRET=...
```

或者仅在兼容旧部署时，将权限设为 `0600` 的
`gsdata_credentials.json` 放入雷达数据目录。缺少凭据时，雷达仍可查询
已有数据，但公众号定时采集不会启动；`/api/health` 会返回
`gsdata_configured: false`。

生产服务器可通过交互式命令写入凭据，密钥不会出现在命令行历史中：

```bash
bash deploy.sh radar-configure
```

## 配置项

| 变量 | 默认值 | 用途 |
|---|---|---|
| `RADAR_DATA_DIR` | `project-discovery/data` | 候选记录与运行状态目录 |
| `RADAR_WECHAT_ACCOUNTS_XLSX` | `project-discovery/公众号来源.xlsx` | 公众号账号清单 |
| `RADAR_AUTO_CRAWL_ENABLED` | `true` | 创投等自动采集 |
| `RADAR_WECHAT_DAILY_ENABLED` | `true` | GSData 公众号每日采集 |
| `RADAR_WECHAT_MAX_WORKERS` | `4` | 公众号共享连接并发数 |
| `RADAR_WECHAT_REQUEST_ATTEMPTS` | `3` | DNS、超时、429/5xx 单请求最大尝试次数 |
| `RADAR_WECHAT_RETRY_INTERVAL_SECONDS` | `1800` | 失败账号补采间隔 |
| `RADAR_WECHAT_RETRY_BATCH_SIZE` | `100` | 每轮失败账号补采上限 |
| `RADAR_WECHAT_INSTITUTION_INTERVAL_SECONDS` | `7200` | 机构公众号独立刷新间隔 |
| `RADAR_SYNC_PAGE_SIZE` | `50` | 每页同步候选数 |
| `RADAR_SYNC_INCREMENTAL_PAGES` | `4` | 每轮优先扫描的最新数据页数 |
| `RADAR_SYNC_BACKFILL_PAGES` | `1` | 每轮继续回填的历史数据页数 |
生产只安装 `cybernaut-app.service`。API 进程内的 MySQL 持久化调度器每 30 分钟
串行运行采集和同步任务，同时通过数据库游标逐轮完成历史数据回填。任务领取、
续租、运行历史、重试和死信保存在 `runtime_jobs` / `runtime_job_runs`。

公众号采集每天 08:30 执行全量窗口扫描；机构公众号会优先处理并独立定时
刷新。网络失败的账号进入补采队列，每 30 分钟由单次 Job 重试。调度与运行记录
已经进入 MySQL Job/Lease；候选原始事件、当前投影、来源和采集状态也进入 MySQL。
每次 Python Job 前会从 MySQL 物化工作状态，结束后再幂等回写，因此数据目录不再是
主 API 的在线事实源，但仍需作为原始文件归档纳入备份。
