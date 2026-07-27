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
| `PORT` | `8121` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
