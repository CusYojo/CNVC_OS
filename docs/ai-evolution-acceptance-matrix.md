# AI 助手自进化验收矩阵

更新时间：2026-09-08。基线提交：`dfcadbb5824e018a9aeda962e201ee7a7f41f066`。

状态只描述本仓库当前可复现证据。`PASS` 表示对应自动验收已经实际执行；`BLOCKED` 表示缺少指定隔离设施；`NOT_RUN` 表示尚未对真实部署或真实模型执行。跳过项不登记为通过。

| ID | 状态 | 当前证据 | 未完成证据 |
| --- | --- | --- | --- |
| AT-01 | PASS | `aiEvolutionContract.test.ts`、`aiEvolutionService.test.ts` 验证类型、来源、范围和普通任务边界；回答操作与页面选区入口绑定真实消息 | — |
| AT-02 | PASS | `aiEvolutionMysql.test.ts` 的 repository 替身与 service 测试验证幂等契约；发布与反馈分别有冲突检查 | 隔离 MySQL 并发测试归入 AT-09 的环境门禁 |
| AT-03 | BLOCKED | repository、artifact、preview 和 source 单元测试均验证所有权与范围复核 | `aiEvolutionHttpAuth.test.ts` 需要 `EVOLUTION_TEST_MYSQL_URL` 指向隔离 MySQL |
| AT-04 | PASS | source schema、授权来源解析和模型补丁测试验证内容不能增加权限或命令 | — |
| AT-05 | BLOCKED | `aiEvolutionDocker.test.ts` 静态验证非 root、无网络、无宿主挂载、资源限制和租约标签 | Docker daemon 当前不可用，真实容器门禁未运行 |
| AT-06 | PASS | `evolutionCandidateBuild.test.ts`、`aiEvolutionStageBuild.test.ts` 验证候选构建只写指定目录且不激活 | Linux 权限语义的最终激活测试归入 AT-17 |
| AT-07 | PASS | `aiEvolutionLocalPreview.test.ts` 验证鉴权、fixture API、访问撤销和测试数据标识 | — |
| AT-08 | PASS | `aiEvolutionTestGate.test.ts`、browser gate 与 evaluator 测试验证固定门禁、隐藏样本和删测试不能通过 | — |
| AT-09 | BLOCKED | coordinator、worker、release recovery 和 requested rollback recovery 单元测试通过 | 真实 MySQL 租约并发与 Docker 中断恢复尚未运行 |
| AT-10 | PASS | coordinator、durable budget、elapsed time、worker lifecycle 测试验证取消确认、累计预算和有限修复 | — |
| AT-11 | PASS | experience application、resolver、output check、history 与 management 测试验证版本、未采用原因及遵守结果 | — |
| AT-12 | PASS | 聊天冻结入口与专业任务服务接线；application/skill application 测试验证明确快照 | — |
| AT-13 | PASS | experience management、history 和 source 测试验证停用、后续不注入及旧快照语义 | — |
| AT-14 | PASS | skill evaluation、executor、sample suite、page reviewer 和 comparison 测试验证同输入、硬门禁和可追溯产物 | 真实模型收益数据保持 `NOT_RUN`，不影响契约验收 |
| AT-15 | PASS | release policy、skill trial/promotion policy 和 candidate repository 契约验证哈希、修订与批准绑定 | — |
| AT-16 | PASS | reevaluation base、real Git reevaluation、build artifacts 测试验证基线变化后重新核对 | — |
| AT-17 | NOT_RUN | release adapter、coordinator、health、recovery、requested rollback 共覆盖激活及回退协议；人工回退已进入持久发布队列 | 未对真实服务器执行发布或回退；Docker/Linux 权限门禁未运行 |
| AT-18 | PASS | hook 使用数据库补拉与可见时轮询；local preview、事件序列和 390px fixture 已验证刷新及窄屏基本交互 | 真实网络断连的浏览器端到端演练可在部署验收时复测 |

当前完整源码回归命令：

```powershell
node --test --import tsx server/tests/aiEvolution*.test.ts server/tests/aiExperience*.test.ts
npm run check:types
npm run check:ai-evolution-change-manifest
```

当前环境探测结果：Docker Desktop Linux engine pipe 不存在；`127.0.0.1:43318` 没有隔离 MySQL。服务器业务数据库不作为测试数据库使用，也不会为了使验收变绿而写入测试数据。

真实设施就绪后仍需执行：

1. 启动隔离 Docker daemon 与专用 MySQL，设置测试专用连接变量。
2. 重新执行带 `real Docker`、`isolated MySQL` 标记的测试，确认零跳过。
3. 使用无数据库迁移的案例 C 候选完成一次隔离预览；是否调用真实模型需单独配置预算。
4. 在明确授权的非生产目标完成发布、人工回退和发布器中断恢复演练。
5. 将本矩阵的 AT-03、AT-05、AT-09、AT-17 更新为实际结果并附目标版本和日志哈希。
