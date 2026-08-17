# cybernaut-assistant（旧 Flue 迁移参考）

该目录已退出当前构建、启动和生产部署链，仅保留用于旧 Flue 会话迁移、行为对照和恢复审计。

当前 AI 会话由主服务内的 JW Runtime 承载。请从仓库根目录构建并启动：

```bash
npm run build
npm run start:all
```

`start:all` 等价于 `start:app`，只启动监听 `127.0.0.1:3100` 的一个 Node 业务服务。3584 端口、`dev:agent`、Flue/Hono Runtime 和 `/ai/api` 均不再使用。

本目录不再接受端口、数据库路径、主服务回调地址、模型或共享密钥等运行配置；全部 build/start/health 命令固定退出 78，旧数据库与工具模块被重新导入时也会失败关闭。生产 `flue.db` 完成迁移、核对和归档保留期之前，不要删除本目录中的参考代码或迁移脚本；旧数据只允许由仓库根目录批准的离线迁移命令读取，禁止把本目录安装为独立服务。
