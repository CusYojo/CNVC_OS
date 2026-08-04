# Project Discovery Radar

项目发现雷达是中台的本地多信源聚合服务，提供公众号、创投新闻、微信群聊和
arXiv 候选项目的统一查询接口。

## 本地启动

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
./start.sh
```

默认只监听 `127.0.0.1:8121`。主项目通过
`RADAR_BASE_URL=http://127.0.0.1:8121` 调用。

常用检查：

```bash
curl http://127.0.0.1:8121/api/health
curl http://127.0.0.1:8121/api/summary
```

`/api/health` 默认执行带 5 分钟缓存的 GSData 最小鉴权探测；只检查本地配置时可用：

```bash
curl 'http://127.0.0.1:8121/api/health?deep=false'
```

候选记录默认保持原有的评分排序。主系统增量同步使用采集时间排序和游标分页：

```bash
curl 'http://127.0.0.1:8121/api/candidates?sort=collected&limit=100'
# 将响应中的 next_cursor 作为下一页 cursor 参数
```

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
| `PORT` | `8121` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |

生产部署会安装 `cybernaut-radar-sync.timer`，每 30 分钟把 Radar JSONL
中的最新候选同步到主数据库，同时通过数据库游标逐轮完成历史数据回填。

公众号采集每天 08:30 执行全量窗口扫描；机构公众号会优先处理并独立定时
刷新。网络失败的账号进入补采队列，每 30 分钟重试。以下接口用于区分
“最后检查时间”“最后发文时间”和“最后有效线索时间”：

```bash
curl 'http://127.0.0.1:8121/api/wechat-api/daily-status'
curl 'http://127.0.0.1:8121/api/wechat-api/source-status?group=机构'
```
