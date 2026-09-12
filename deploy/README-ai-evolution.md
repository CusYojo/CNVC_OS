# AI 自进化发布进程

业务 API 只创建 `ai_evolution_release_jobs`；独立 publisher 负责领取、暂存、切换、健康核验和恢复。停止 `cybernaut-app.service` 不会中断 publisher。

启用前确认服务器迁移 journal 已完整执行到当前源码最新项 `0112_add_assistant_experience_memory`；其中自进化发布链要求 `0108`–`0110` 均已完成。配置 `AI_EVOLUTION_RELEASE_TARGETS_FILE`、`AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE` 和 `AI_EVOLUTION_ARTIFACT_ROOT` 的绝对路径。两份 JSON 应由 root 持有并设为 `0600`，格式见本目录 example 文件。

先执行：

```bash
npm run check:ai-evolution-release-publisher
```

该命令只读核对配置、目标目录以及 `0108` 的列和关键索引；输出必须包含 `databaseWrites: 0` 和 `processMutation: false`。通过后再根据服务器实际项目路径和 Node/npm 路径修改 systemd 示例 unit。

当前示例以 root 运行，因为 publisher 必须控制 `cybernaut-app.service`，并用 `ProtectSystem=strict` 限定写目录。若改用独立非 root 账号，应提供只允许控制该业务 unit 的 polkit 规则；不要向业务服务账号授予宽泛 sudo 权限。

启用后先使用隔离候选演练成功发布、健康失败回退和 publisher 中途退出。候选状态、release job、事件、审计、服务身份和页面资源哈希全部一致后，才能确认代码发布与回退验收通过。
