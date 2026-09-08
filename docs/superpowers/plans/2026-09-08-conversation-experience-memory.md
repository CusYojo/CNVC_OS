# 对话经验记忆实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 AI 助手增加默认开启的五轮经验总结、显式长期偏好候选、用户确认入库和下一轮服务端注入。

**架构：** MySQL 保存用户设置、候选、有效经验和决定审计；独立服务在每次成功回答结束后按幂等游标生成候选，在下一次创建 Runtime 前加载已采用经验。REST 接口只允许当前用户读写，React 在助手页提供开关、候选卡和经验管理，不复用已回滚的代码发布型“自进化”模块。

**技术栈：** TypeScript、Express、Drizzle ORM/MySQL、React、Zod、Node test runner、Vite。

---

## 文件结构

- 创建 `server/drizzle/0104_add_assistant_experience_memory.sql`：四张经验表、唯一键、索引和外键。
- 修改 `server/drizzle/meta/_journal.json`：登记 0104 迁移，时间戳严格晚于 0103。
- 修改 `server/src/db/schema.ts`：四张表的 Drizzle 定义与枚举联合类型。
- 创建 `server/src/services/assistantExperiencePolicy.ts`：轮次判定、显式偏好识别、候选清洗、提示拼接等无副作用规则。
- 创建 `server/src/services/assistantExperienceService.ts`：设置、候选、决定、经验生命周期及数据库幂等事务。
- 创建 `server/src/routes/assistantExperiences.ts`：当前用户的 REST API 和 Zod 校验。
- 修改 `server/src/routes/index.ts`：挂载 `/assistant-experiences`。
- 修改 `server/src/runtime/jwAgentRuntime.ts`：成功回合触发候选；创建 Runtime 时注入已采用经验。
- 创建 `src/components/AssistantExperiencePanel.tsx`：开关、候选审核、有效经验管理。
- 修改 `src/pages/AIAssistantPage.tsx`：挂载经验面板并在候选决定后刷新。
- 创建 `server/tests/assistantExperiencePolicy.test.ts`：周期、显式偏好、过滤和提示顺序单元测试。
- 创建 `server/tests/assistantExperienceMigration.test.ts`：迁移与 schema 契约测试。
- 创建 `server/tests/assistantExperienceApi.test.ts`：鉴权、采用/拒绝和版本冲突接口契约测试。
- 创建 `server/tests/assistantExperienceUi.test.tsx`：默认开关、卡片按钮和管理入口静态验收。

### 任务 1：锁定迁移和领域规则

**文件：**
- 创建：`server/tests/assistantExperienceMigration.test.ts`
- 创建：`server/tests/assistantExperiencePolicy.test.ts`
- 创建：`server/drizzle/0104_add_assistant_experience_memory.sql`
- 修改：`server/drizzle/meta/_journal.json`
- 修改：`server/src/db/schema.ts`
- 创建：`server/src/services/assistantExperiencePolicy.ts`

- [ ] **步骤 1：编写迁移失败测试**

测试读取 SQL、journal 和 schema，断言四张表、默认开启字段、候选轮次窗口唯一键、来源消息唯一键、有效经验唯一哈希以及 0104 journal 条目存在：

```ts
assert.match(sql, /CREATE TABLE `assistant_experience_settings`/)
assert.match(sql, /`auto_summary_enabled` boolean NOT NULL DEFAULT true/)
assert.match(sql, /CREATE TABLE `assistant_experience_candidates`/)
assert.match(sql, /CREATE TABLE `assistant_experiences`/)
assert.match(sql, /CREATE TABLE `assistant_experience_decisions`/)
assert.match(journal, /"tag": "0104_add_assistant_experience_memory"/)
```

- [ ] **步骤 2：运行迁移测试并确认失败**

运行：`node --import tsx --test server/tests/assistantExperienceMigration.test.ts`

预期：FAIL，提示缺少 `0104_add_assistant_experience_memory.sql` 或表定义。

- [ ] **步骤 3：编写规则失败测试**

```ts
assert.equal(shouldCreatePeriodicCandidate({ enabled: true, processedTurns: 4, completedTurns: 5 }), true)
assert.equal(shouldCreatePeriodicCandidate({ enabled: false, processedTurns: 4, completedTurns: 5 }), false)
assert.equal(detectExplicitPreference('以后分析项目时先总结，再说原因'), true)
assert.equal(detectExplicitPreference('大衍科技成立于 2020 年'), false)
assert.equal(sanitizeCandidate('密码是 abc123'), null)
assert.match(buildExperiencePrompt([{ rule: '先总结，再说明原因', scopeType: 'project', version: 1 }]), /先总结/)
```

- [ ] **步骤 4：运行规则测试并确认失败**

运行：`node --import tsx --test server/tests/assistantExperiencePolicy.test.ts`

预期：FAIL，提示无法导入 `assistantExperiencePolicy.ts`。

- [ ] **步骤 5：实现迁移和 schema**

迁移字段固定为：设置表以 `user_id` 唯一；候选含 `conversation_id/project_id/trigger_type/start_turn/end_turn/source_message_id/rule/evidence/example/suggested_scope/content_hash/status/version/decided_at`；经验含 `user_id/scope_type/scope_key/rule/content_hash/status/version/source_candidate_id/last_used_at`；决定含候选、经验、动作、版本、操作者和时间。所有用户、会话、项目外键遵循现有删除策略，0104 的 `when` 大于 `1792050543000`。

- [ ] **步骤 6：实现纯规则模块**

```ts
export function detectExplicitPreference(text: string) {
  return /(?:以后|今后|往后|下次都|以后都)/u.test(text)
}

export function shouldCreatePeriodicCandidate(input: {
  enabled: boolean; processedTurns: number; completedTurns: number
}) {
  return input.enabled && Math.floor(input.completedTurns / 5) > Math.floor(input.processedTurns / 5)
}
```

候选清洗拒绝密码、token、cookie、连接串以及只有项目事实而没有行为规则的内容；提示最多加载 20 条、总长度 6000 字，项目范围排在全局范围之前。

- [ ] **步骤 7：运行两个测试和类型检查**

运行：`node --import tsx --test server/tests/assistantExperienceMigration.test.ts server/tests/assistantExperiencePolicy.test.ts && npm run check:types`

预期：测试 PASS；类型检查无新增错误。

- [ ] **步骤 8：提交领域基础**

```bash
git add server/drizzle/0104_add_assistant_experience_memory.sql server/drizzle/meta/_journal.json server/src/db/schema.ts server/src/services/assistantExperiencePolicy.ts server/tests/assistantExperienceMigration.test.ts server/tests/assistantExperiencePolicy.test.ts
git commit -m "feat: add assistant experience memory schema"
```

### 任务 2：实现候选、设置和经验生命周期

**文件：**
- 创建：`server/src/services/assistantExperienceService.ts`
- 创建：`server/tests/assistantExperienceService.test.ts`

- [ ] **步骤 1：编写服务失败测试**

用注入式存储假件覆盖：默认设置为 true；第 5 轮只创建一次周期候选；显式长期偏好立即创建候选；采用后创建有效经验；拒绝后不创建有效经验；重复决定返回同一结果；项目规则排在冲突全局规则之前。

```ts
const first = await service.recordCompletedTurn({ userId, conversationId, userMessageId, userText, projectId })
const replay = await service.recordCompletedTurn({ userId, conversationId, userMessageId, userText, projectId })
assert.equal(first.candidate?.id, replay.candidate?.id)
assert.equal(store.candidates.length, 1)
```

- [ ] **步骤 2：运行服务测试并确认失败**

运行：`node --import tsx --test server/tests/assistantExperienceService.test.ts`

预期：FAIL，提示服务模块不存在。

- [ ] **步骤 3：实现数据库服务**

导出 `getSettings`、`updateSettings`、`listCandidates`、`decideCandidate`、`listExperiences`、`updateExperience`、`deleteExperience`、`recordCompletedTurn` 和 `loadExperiencePrompt`。`recordCompletedTurn` 用用户消息 ID 与轮次窗口唯一键防重；候选生成失败只写受控日志并返回，不影响回答状态。

- [ ] **步骤 4：实现候选生成器**

生成器只读取本窗口用户文本和最终助手文本；优先把显式偏好规范化为祈使规则。五轮总结通过现有 AI gateway 请求严格 JSON：

```json
{"rule":"项目分析先给出结论摘要，再解释证据和原因","evidence":"用户明确要求以后先总结再说原因","example":"先列三条结论，再逐条说明依据","suggestedScope":"project"}
```

JSON 解析或安全过滤失败时不建候选。

- [ ] **步骤 5：运行服务测试**

运行：`node --import tsx --test server/tests/assistantExperienceService.test.ts server/tests/assistantExperiencePolicy.test.ts`

预期：全部 PASS。

- [ ] **步骤 6：提交服务**

```bash
git add server/src/services/assistantExperienceService.ts server/tests/assistantExperienceService.test.ts
git commit -m "feat: manage assistant experience candidates"
```

### 任务 3：提供当前用户 REST API

**文件：**
- 创建：`server/src/routes/assistantExperiences.ts`
- 修改：`server/src/routes/index.ts`
- 创建：`server/tests/assistantExperienceApi.test.ts`

- [ ] **步骤 1：编写 API 失败测试**

覆盖以下契约：

```text
GET    /api/assistant-experiences/settings
PATCH  /api/assistant-experiences/settings
GET    /api/assistant-experiences/candidates?status=pending&conversationId=...
POST   /api/assistant-experiences/candidates/:id/decision
GET    /api/assistant-experiences
PATCH  /api/assistant-experiences/:id
DELETE /api/assistant-experiences/:id
```

断言未登录为 401、跨用户资源为 404、过期 `version` 为 409、重复 `idempotencyKey` 返回相同决定。

- [ ] **步骤 2：运行 API 测试并确认失败**

运行：`node --import tsx --test server/tests/assistantExperienceApi.test.ts`

预期：FAIL，路由不存在。

- [ ] **步骤 3：实现路由与输入校验**

```ts
const decisionBody = z.object({
  action: z.enum(['adopt', 'reject']),
  version: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
  editedRule: z.string().trim().min(3).max(2000).optional(),
  scopeType: z.enum(['global', 'project']).optional(),
})
```

所有服务调用只使用 `req.user!.uid`，项目范围采用时重新执行项目访问校验。

- [ ] **步骤 4：运行 API 测试和类型检查**

运行：`node --import tsx --test server/tests/assistantExperienceApi.test.ts && npm run check:types`

预期：PASS，无新增类型错误。

- [ ] **步骤 5：提交 API**

```bash
git add server/src/routes/assistantExperiences.ts server/src/routes/index.ts server/tests/assistantExperienceApi.test.ts
git commit -m "feat: expose assistant experience review api"
```

### 任务 4：接入回答完成事件和下一轮提示

**文件：**
- 修改：`server/src/runtime/jwAgentRuntime.ts`
- 创建：`server/tests/assistantExperienceRuntime.test.ts`

- [ ] **步骤 1：编写 Runtime 失败测试**

断言代码在成功 `result` 后调用 `recordCompletedTurn`，错误/取消不计数；创建 Runtime 前调用 `loadExperiencePrompt`；提示被追加到 `systemPrompt.append`；任务快照记录经验 ID 和版本。

- [ ] **步骤 2：运行 Runtime 测试并确认失败**

运行：`node --import tsx --test server/tests/assistantExperienceRuntime.test.ts`

预期：FAIL，缺少经验服务接线。

- [ ] **步骤 3：注入已采用经验**

在 `createRuntimeSession` 读取当前用户和项目的有效经验，追加独立的 `[用户已确认的回答经验]` 段；把 `{id, version}` 写进 Runtime 元数据。若读取失败，记录脱敏警告并继续创建会话。

- [ ] **步骤 4：在成功回答后生成候选**

给 `RuntimeSession` 保存本轮用户消息 ID/文本；`raw.type === 'result' && !raw.is_error` 且已经持久化 assistant 消息后，异步调用 `recordCompletedTurn`。生成完成后调用 `publishJwAgentChange`，让页面刷新候选；失败不能把会话改成 error。

- [ ] **步骤 5：运行 Runtime 与相关回归测试**

运行：`node --import tsx --test server/tests/assistantExperienceRuntime.test.ts server/tests/assistantExperienceService.test.ts server/tests/aiTaskChatEvent.test.ts`

预期：全部 PASS。

- [ ] **步骤 6：提交 Runtime 接入**

```bash
git add server/src/runtime/jwAgentRuntime.ts server/tests/assistantExperienceRuntime.test.ts
git commit -m "feat: apply approved experiences to assistant turns"
```

### 任务 5：实现开关、候选审核和经验管理界面

**文件：**
- 创建：`src/components/AssistantExperiencePanel.tsx`
- 修改：`src/pages/AIAssistantPage.tsx`
- 创建：`server/tests/assistantExperienceUi.test.tsx`

- [ ] **步骤 1：编写 UI 失败测试**

静态渲染并断言存在“自动总结经验”“每 5 轮总结一次”“采用”“不采用”“已采用经验”，关闭开关调用 PATCH，采用和拒绝调用决定接口；页面中不出现旧的“自进化发布”“技能版本”“回滚发布”等入口。

- [ ] **步骤 2：运行 UI 测试并确认失败**

运行：`node --import tsx --test server/tests/assistantExperienceUi.test.tsx`

预期：FAIL，组件不存在。

- [ ] **步骤 3：实现 API 状态与开关**

组件接收 `conversationId` 和 `projectId`，加载设置、当前会话待确认候选和有效经验。开关初始值使用服务端默认 true，保存期间禁用，失败恢复原值并显示错误。

- [ ] **步骤 4：实现候选卡**

卡片展示规则、依据、示例和可修改的范围。采用或拒绝时生成 `crypto.randomUUID()` 幂等键；成功后从待处理列表移除，采用结果同步到有效经验列表。

- [ ] **步骤 5：实现经验管理**

有效经验支持编辑规则、启用/停用和删除；每个更新携带当前版本，409 时重新加载并提示“经验已在其他窗口更新”。

- [ ] **步骤 6：挂载到 AI 助手页面**

在现有页面右侧区域加入“经验”入口和未处理数量；窄屏使用抽屉，宽屏使用侧栏。每次 Runtime snapshot 更新时间变化时只刷新候选列表，不重复刷新全部消息。

- [ ] **步骤 7：运行 UI 测试和前端构建**

运行：`node --import tsx --test server/tests/assistantExperienceUi.test.tsx && npm run build`

预期：测试 PASS，Vite 与 server TypeScript 构建成功。

- [ ] **步骤 8：提交 UI**

```bash
git add src/components/AssistantExperiencePanel.tsx src/pages/AIAssistantPage.tsx server/tests/assistantExperienceUi.test.tsx
git commit -m "feat: add assistant experience review panel"
```

### 任务 6：端到端验收与文档

**文件：**
- 创建：`server/src/scripts/assistantExperienceAcceptance.ts`
- 修改：`package.json`
- 创建：`docs/assistant-experience-memory.md`

- [ ] **步骤 1：编写本地验收脚本**

脚本创建隔离用户、项目和会话，模拟四轮确认无候选、第五轮恰好一条、重复事件仍一条、拒绝后不加载、采用“先总结再说原因”后提示顺序正确、关闭开关后十轮无周期候选，并清理测试数据。

- [ ] **步骤 2：增加验收命令**

```json
"accept:assistant-experience": "node --env-file-if-exists=.env --import tsx server/src/scripts/assistantExperienceAcceptance.ts"
```

- [ ] **步骤 3：编写运维文档**

文档说明四张表、默认开启行为、迁移命令、功能不需要额外进程或 Docker、采用/拒绝语义、停用方法和只回退应用代码时迁移可保留的兼容性。

- [ ] **步骤 4：运行完整验证**

运行：

```bash
node --import tsx --test server/tests/assistantExperience*.test.ts server/tests/assistantExperienceUi.test.tsx
npm run check:types
npm run build
git diff --check
```

有可用隔离 MySQL 时再运行：`npm run accept:assistant-experience`。

预期：所有静态测试、类型检查和构建 PASS；数据库验收输出 `periodicCandidateCount:1`、`replayCandidateCount:1`、`adoptedPromptApplied:true`、`disabledCandidateCount:0`。

- [ ] **步骤 5：提交验收和文档**

```bash
git add server/src/scripts/assistantExperienceAcceptance.ts package.json docs/assistant-experience-memory.md
git commit -m "test: verify assistant experience memory flow"
```

- [ ] **步骤 6：检查最终分支**

运行：`git status --short && git log --oneline --decorate -7`

预期：工作树干净；功能提交均位于 `feat/conversation-experience-memory`，基线保持 `b74d4b7`，未部署服务器、未执行生产迁移。
