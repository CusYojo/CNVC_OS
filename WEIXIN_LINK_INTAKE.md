# 微信链接收录

用户向已授权绑定的微信机器人发送公众号链接后，选择创建项目线索、存入团队知识库或两者。项目线索复用 Radar 清洗和入库判断；转人工复核不等于已入池。入口为 `/projects?view=reviews`，可查看来源、正文和审核原因，填写证据后接受或拒绝。

## 运行条件

- 使用已有微信机器人配置及平台账号授权绑定。
- 配置 `WEIXIN_INTAKE_PLATFORM_URL` 为用户可访问的平台地址，用于回执链接。
- 浏览器正文提取需要 Chrome，以及安装了 `server/scripts/weixin-browser-requirements.txt` 的 Python；将 Python 可执行文件路径写入 `WEIXIN_ARTICLE_PYTHON`。
- 不配置 Python 时使用已有 HTTP 正文提取器。验证页或读取失败不能入库，可重试或取消。
- 新表定义在 `server/drizzle/0102_add_weixin_link_intakes.sql`，模型和迁移清单一并提供。不需要 AI 自进化的 0098—0101 迁移文件。
- 已手工创建该表的环境应先核对结构与迁移记录，不能盲目重复执行 CREATE TABLE。应用启动不自动建表。本次 Git 同步不执行数据库迁移，也不部署或重启服务器。

## 验证

合入基于远端 `548815d`。保留远端新增的论文来源测试，仅添加微信相关改动。

Node 测试：`weixinLinkIntake.test.ts`、`weixinBrowserArticle.test.ts`、`leadSourceDocument.test.ts`、`leadWorkflowJsonEvidence.test.ts`、`sourceTextMatch.test.ts`。Python 测试：`server/tests/weixin_browser_article_test.py`。

浏览器子进程仅继承运行所需环境变量，不传数据库或 API 凭据。正文保留 Markdown 和纯文本，知识库访问沿用原有权限，重复消息和重试沿用幂等流程。
