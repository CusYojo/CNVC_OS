# FDE 投后阶段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 打款审批后项目进入并保留在投后阶段，提供文件、更新说明和领导站内提醒。

**架构：** 将投后加入 FDE 阶段序列，项目生命周期保持 active。独立投后更新/附件表保存不可覆盖的说明和关联文件；提醒写入现有 todos，由项目治理绑定的董事长、总裁接收。

**技术栈：** React、TypeScript、Express、Drizzle、MySQL、Node test runner。

---

## 文件结构

- 修改：`server/src/db/schema.ts`、`server/drizzle/meta/_journal.json`、`server/src/services/oaWorkflowService.ts`、`server/src/contracts/fdeWorkflowPolicyContract.ts`、`server/src/routes/oa.ts`。
- 创建：`server/drizzle/0117_add_fde_post_investment.sql`、`server/src/services/fdePostInvestmentService.ts`、`server/src/routes/fdePostInvestment.ts`、`server/tests/fdePostInvestmentService.test.ts`。
- 修改：`src/pages/ProjectDetailPage.tsx`、`src/pages/ProjectsPage.tsx`、`src/pages/WorkflowPage.tsx`、`src/types/index.ts`；创建 `src/components/PostInvestmentPanel.tsx`。

### 任务 1：先写失败的服务测试

- [ ] 将打款完成测试改为断言：`stage === '投后'`、`lifecycle === 'active'`，并可由 `listProjects` 查询到。
- [ ] 新增投后服务测试：项目成员保存“本月经营正常”，选择董事长后该董事长的 todo 标题含“投后更新”；项目外人员保存时被拒绝。
- [ ] 运行 `node --import tsx --test server/tests/fdePostInvestmentService.test.ts`，预期因模块/阶段不存在而失败。

### 任务 2：建立数据模型与迁移

- [ ] 在 `schema.ts` 定义 `projectPostInvestmentUpdates`：`id`、`projectId`、`authorId`、`content`、`createdAt`；再定义附件表，以更新 ID 与 `project_files.id` 关联。
- [ ] 创建 `0117_add_fde_post_investment.sql`：创建两张表；发布策略新版本，将打款后的目标阶段设为投后；把 FDE 项目 `已 Close` 更新为 `投后` 与 active。每条 SQL 之间加入 `--> statement-breakpoint`。
- [ ] 登记 `_journal.json`，以隔离前缀执行迁移，确认投后两张表存在。

### 任务 3：实现命令、权限和提醒

- [ ] 创建 `fdePostInvestmentService.ts`，实现 `listPostInvestmentUpdates(projectId, userId)` 和 `createPostInvestmentUpdate({ projectId, userId, content, fileIds, leaderIds })`。
- [ ] 创建命令验证：项目必须处于投后；填写人必须是项目成员；文件必须归属项目；接收人必须是治理配置的董事长或总裁。无接收人时允许保存但不能发送提醒。
- [ ] 在事务内保存说明、附件和每位接收人的 `todos` 通知；标题为“投后更新：{项目名}”。
- [ ] 添加 GET/POST `/projects/:projectId/post-investment-updates` 路由，并在路由总入口注册。
- [ ] 将 OA FDE 阶段序列、策略与审批完成逻辑从 `打款 → 已 Close` 改为 `打款 → 投后`；投后完成时不关闭项目任务或生命周期。
- [ ] 重跑任务 1 测试，预期 PASS。

### 任务 4：实现 B 双栏页面

- [ ] 在类型、项目筛选与流程页面中加入 FDE 投后，投后项目不再被隐藏。
- [ ] 创建 `PostInvestmentPanel`：左栏复用项目文件上传和文件列表；右栏为说明输入、关联文件、董事长/总裁选择、“保存”与“保存并提醒领导”，下方按时间倒序展示历史更新。
- [ ] 在项目详情页仅当阶段为投后时渲染该面板；成功后刷新文件、项目和更新列表。
- [ ] 运行 `npm run check:types`，预期 exit 0。

### 任务 5：应用测试库迁移并交付验证

- [ ] 运行 `node --env-file='C:\Users\21749\Desktop\project\conversation-experience-memory\.env' --import tsx server/src/scripts/migrateMySqlSchema.ts`，预期输出 `schema migrations ready`。
- [ ] 再次运行投后服务测试和 `npm run check:types`；只读查询确认 FDE `已 Close` 为 0、投后项目 lifecycle 为 active。
- [ ] 使用 `git add src server/src server/tests server/drizzle` 后提交，提交信息为 `feat: add FDE post-investment stage`。
