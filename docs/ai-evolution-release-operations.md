# AI 自进化发布进程运维说明

正式发布进程与 `cybernaut-app.service` 分离。业务 API 只创建 `ai_evolution_release_jobs` 记录；publisher 独立领取、暂存、切换、健康核验和恢复，因此停止业务服务不会中断发布者本身。

启用前必须确认服务器数据库迁移已按 journal 顺序执行到 `0110_add_ai_evolution_requested_rollback`。`0108` 才新增独立 publisher 使用的发布任务表，`0109` 新增结果反馈，`0110` 新增经批准的人工回退绑定；只看到部分表存在不能证明当前源码所需迁移完整。迁移仍使用项目现有的独立迁移账号和明确目标库流程，不能让 publisher 自动执行迁移。

需要配置以下绝对路径：

- `AI_EVOLUTION_RELEASE_TARGETS_FILE`：用户、仓库、Git 基线和目标目录授权，格式参考 `deploy/ai-evolution-release-targets.example.json`。
- `AI_EVOLUTION_PUBLISHER_LIFECYCLE_FILE`：固定的 systemd 停启参数和本机健康地址，格式参考 `deploy/ai-evolution-publisher-lifecycle.example.json`。
- `AI_EVOLUTION_ARTIFACT_ROOT`：业务服务与 publisher 均可读取、仅受信任执行器可写的内容寻址产物目录。

两个 JSON 文件应由 root 持有并设为 `0600`，不得放入候选工作区、上传目录或模型可写目录。publisher 只使用 JSON 中的固定可执行文件和参数，不解释 shell 文本。激活与回退只能调用目标仓库中的 `server/scripts/build-platform.mjs --activate/--rollback`。

当前生产架构使用 systemd。示例 unit 以 root 运行，是因为它必须控制 `cybernaut-app.service`；同时使用 `ProtectSystem=strict`，只开放构建指针和运行产物目录写权限。若服务器要求 publisher 使用独立非 root 账号，需要另行提供只允许该账号控制 `cybernaut-app.service` 的 polkit 规则，不能复用业务服务账号的宽泛 sudo 权限。

部署顺序：

1. 用迁移账号确认目标数据库和前缀，核对迁移历史连续无缺口，再应用到 `0110`。
2. 创建并校验两份 root 只读 JSON；其中 `repositoryId`、`allowedUserIds` 和真实仓库目录必须来自服务器现状。
3. 将示例 unit 中的项目路径、Node/npm 路径和可写目录改为服务器实际值。
4. 先运行 `npm run check:ai-evolution-release-publisher`。该命令只读核对配置文件权限、目标集合、实际目录，以及发布任务表的列和关键索引；再用迁移清单核对当前源码最新项为 `0110_add_ai_evolution_requested_rollback`。预检输出必须包含 `databaseWrites: 0` 和 `processMutation: false`。
5. 用隔离候选执行一次发布、健康失败、回退和 publisher 中途退出演练；核对候选状态、release job、事件、审计、实际服务身份和页面资源哈希一致后，才能把 AT-17 标记为通过。

不要同时启动两个使用不同目标锁实现的发布者。多个 publisher 实例可以共享任务队列，但必须都使用本项目的 MySQL 目标锁和 fencing token。
