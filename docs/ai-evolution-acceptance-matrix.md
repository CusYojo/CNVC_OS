# AI 助手自进化验收矩阵

更新时间：2026-09-12。基线提交：`dfcadbb5824e018a9aeda962e201ee7a7f41f066`。

状态只描述本仓库当前可复现证据。`PASS` 表示对应自动验收已经实际执行；`BLOCKED` 表示缺少指定隔离设施；`NOT_RUN` 表示尚未对真实部署或真实模型执行。跳过项不登记为通过。

| ID | 状态 | 当前证据 | 未完成证据 |
| --- | --- | --- | --- |
| AT-01 | PASS | `aiEvolutionContract.test.ts`、`aiEvolutionService.test.ts` 验证类型、来源、范围和普通任务边界；回答操作与页面选区入口绑定真实消息 | — |
| AT-02 | PASS | `aiEvolutionMysql.test.ts` 的 repository 替身与 service 测试验证幂等契约；发布与反馈分别有冲突检查 | 隔离 MySQL 并发测试归入 AT-09 的环境门禁 |
| AT-03 | PASS | repository、artifact、preview 和 source 测试验证所有权与范围复核；真实隔离 MySQL HTTP 验证会话、CSRF、Origin、跨用户候选/运行和停用账号撤权 | — |
| AT-04 | PASS | source schema、授权来源解析和模型补丁测试验证内容不能增加权限或命令 | — |
| AT-05 | PASS | `aiEvolutionDocker.test.ts` 已在 Docker 29.7.2 实际创建容器，验证非 root、无网络、只读根目录、无宿主挂载/Docker socket、资源限制、归属标签、输出完整性和终止确认 | — |
| AT-06 | PASS | `evolutionCandidateBuild.test.ts`、`aiEvolutionStageBuild.test.ts` 验证候选构建只写指定目录且不激活 | Linux 权限语义的最终激活测试归入 AT-17 |
| AT-07 | PASS | `aiEvolutionLocalPreview.test.ts` 验证鉴权、fixture API、访问撤销和测试数据标识 | — |
| AT-08 | PASS | `aiEvolutionTestGate.test.ts`、browser gate 与 evaluator 测试验证固定门禁、隐藏样本和删测试不能通过；不可写门禁镜像实际执行权限 2 项、契约 41 项 | — |
| AT-09 | PASS | coordinator、worker、release recovery 和 requested rollback recovery 单元测试通过；真实隔离 MySQL 与 Docker 测试强制终止持有租约的宿主进程，新宿主在租约过期后回收旧容器、记录 `lease_revoked`/`interrupted` 并拒绝旧执行器心跳 | — |
| AT-10 | PASS | coordinator、durable budget、elapsed time、worker lifecycle 测试验证取消确认、累计预算和有限修复 | — |
| AT-11 | PASS | experience application、resolver、output check、history 与 management 测试验证版本、未采用原因及遵守结果 | — |
| AT-12 | PASS | 聊天冻结入口与专业任务服务接线；application/skill application 测试验证明确快照 | — |
| AT-13 | PASS | experience management、history 和 source 测试验证停用、后续不注入及旧快照语义 | — |
| AT-14 | PASS | skill evaluation、executor、sample suite、page reviewer 和 comparison 测试验证同输入、硬门禁和可追溯产物；实际 Docker 执行可见/隐藏样本并生成 DOCX、PDF 和页面证据，格式失败保持最终 `FAIL` | 真实模型收益数据保持 `NOT_RUN`，不影响契约验收 |
| AT-15 | PASS | release policy、skill trial/promotion policy 和 candidate repository 契约验证哈希、修订与批准绑定 | — |
| AT-16 | PASS | reevaluation base、real Git reevaluation、build artifacts 测试验证基线变化后重新核对 | — |
| AT-17 | PASS | 2026-09-15 已在授权服务器完成 root 管理的固定发布目标、独立 publisher、成对构建激活和真实服务回退；回退前后 Web/服务端哈希均改变，旧版与恢复后的当前版本均通过 HTTP 200 健康检查。`accept:build-release` 同时验证停机激活、公开读取、回退指针、旧版本恢复和失败版本保留 | 未代替人工批准任何 AI 候选；首次真实候选仍须在工作台按候选哈希单独批准 |
| AT-18 | PASS | hook 使用数据库补拉与可见时轮询；自包含浏览器 fixture 已通过真实会话、HTTP、MySQL 的试用提升和回退；完整代码修复运行的 1280px/390px 页面证据已人工复核 | 真实网络断连的浏览器端到端演练可在部署验收时复测 |

EVO-15 的观察入口已实现：经验应用和候选均可提交绑定授权对象的反馈；工作台按 7、30、90 天展示应用率、遵守率和候选通过率，并同时展示分子、分母、样本量及未评估数。当前数据模型不能可靠证明“同一规则再次纠正”或“回归已经确认且观察期完成”，因此重复纠正率和生产回归率明确显示为证据不足，不以反馈条数冒充正式指标。对应验证为 `aiEvolutionApplicationFeedbackUi.test.ts`、`aiEvolutionFeedbackSchema.test.ts` 和 `aiEvolutionMetrics.test.ts`。

产物长期保留期仍属于设计第 19 节要求在首批内部试用前收敛的选择。当前已实现预览到期后独立关闭、执行环境按租约归属清理、失败证据保留；在确定保留期与审计要求前，不删除仍被候选、技能版本或回退链引用的产物。

当前完整源码回归命令：

```powershell
node --test --import tsx server/tests/aiEvolution*.test.ts server/tests/aiExperience*.test.ts
npm run check:types
npm run check:ai-evolution-change-manifest
```

2026-09-12 最新设施验证：Docker Desktop Linux engine 29.7.2 已可用；临时 `mysql:8.4.5` 只绑定 `127.0.0.1:43318`，数据库为 `evolution_isolated_test`、前缀为 `evo_test_`。共享业务数据库仅执行只读结构审计，17 张自进化表及关键字段均为 `compatible`，没有删除、重建或写入残留数据。真实固定提交候选构建生成 1,749 个产物且 `activated=false`；完整代码修复运行 `81c1786c-b083-4f2d-b1bc-cc88adf5447e` 在首轮页面门禁失败后完成一次受限修复并最终 `PASS`，候选 `db4a05bd-2f2f-4c0e-94bc-55a9dca7c996` 等待人工批准，证据目录 `C:\Users\21749\AppData\Local\Temp\evolution-full-run-1U2Klq`，桌面 1280px 与移动 390px 截图已人工复核，未见内容横向溢出或卡片重叠。宿主中断恢复测试也已在真实 Docker 与隔离 MySQL 上确认旧租约撤销、容器回收、运行中断和旧心跳拒绝。

真实设施就绪后仍需执行：

1. 在明确授权的非生产服务器目标完成发布、人工回退和发布器中断恢复演练。
2. 部署后复测真实网络断连、长期任务恢复及候选访问到期撤销。
3. 将 AT-17 更新为实际结果并附目标版本、候选哈希和发布日志哈希。
