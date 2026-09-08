# 个人微信 AI 直接接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让有效业务用户从头像菜单生成自己的微信二维码，扫码后立即获得隔离的个人机器人与 Agent 会话，并用 MySQL 全局租约消除多主机重复回复。

**架构：** 扫码会话绑定当前登录用户，扫码确认后由独立领域服务和 MySQL 仓储原子写入现有 `im_bots`、`agent_conversations`、`im_bot_bindings` 与审计表。微信桥接根据 `ownershipMode=personal` 严格验证发送者和固定会话，并使用专用 MySQL 连接持有全局 advisory lock。前端新增受保护的个人连接页，入口位于头像菜单。

**技术栈：** React 18、TypeScript、Express 5、Drizzle/MySQL、Zod、微信 iLink、Node test runner。

---

## 文件结构

- 创建 `server/src/contracts/personalWeixinAiContract.ts`：个人机器人配置、公共状态和身份匹配纯函数。
- 创建 `server/src/repositories/mysql/mysqlPersonalWeixinAiRepository.ts`：在一个 MySQL 事务中创建或更新个人机器人、会话、绑定和审计。
- 创建 `server/src/services/personalWeixinAiService.ts`：资格校验、扫码完成、个人状态读取和停用用例。
- 创建 `server/src/services/weixinBridgeLease.ts`：跨主机 MySQL advisory lock 生命周期。
- 创建 `server/tests/personalWeixinAiContract.test.ts`：配置脱敏和严格身份匹配测试。
- 创建 `server/tests/personalWeixinAiService.test.ts`：扫码归属、幂等重连、换号和停用测试。
- 创建 `server/tests/weixinBridgeLease.test.ts`：单领导与释放接管测试。
- 创建 `src/pages/PersonalWeixinAiPage.tsx`：普通用户扫码和连接状态页面。
- 创建 `server/tests/personalWeixinAiUi.test.ts`：路由与头像入口源码合约测试。
- 修改 `server/src/services/weixinQrLoginService.ts`：扫码会话记录模式与发起用户，个人完成路径不暴露凭据。
- 修改 `server/src/services/imIntegrationService.ts`：保留管理员共享机器人流程，导出个人连接所需安全视图。
- 修改 `server/src/routes/imIntegrations.ts`：新增 `/weixin/self` 四个普通用户接口。
- 修改 `server/src/services/weixinMessageBridge.ts`：个人机器人严格路由并接入全局租约。
- 修改 `server/src/repositories/mysql/mysqlImIntegrationRepository.ts`：提供个人机器人只读查询所需的所有者字段。
- 修改 `src/App.tsx`：注册 `/settings/weixin-ai` 受保护路由。
- 修改 `src/layout/AppLayout.tsx`：头像菜单增加“微信 AI”和连接状态。
- 修改 `src/styles.css`：个人连接页二维码及状态卡样式。

### 任务 1：定义个人机器人契约和安全视图

**文件：**
- 创建：`server/src/contracts/personalWeixinAiContract.ts`
- 创建：`server/tests/personalWeixinAiContract.test.ts`

- [ ] **步骤 1：编写失败的契约测试**

```ts
test('personal bot accepts only its owner identity and hides upstream identifiers', () => {
  const config = { ownershipMode: 'personal', accountId: 'bot-secret', accountUserId: 'wx-owner', connectedAt: '2026-09-08T00:00:00.000Z' }
  assert.equal(personalWeixinSenderAllowed(config, 'wx-owner'), true)
  assert.equal(personalWeixinSenderAllowed(config, 'wx-other'), false)
  assert.deepEqual(publicPersonalWeixinConfig(config), { ownershipMode: 'personal', connectedAt: '2026-09-08T00:00:00.000Z', accountHint: '***wner' })
})
```

- [ ] **步骤 2：运行测试并确认缺少契约模块**

运行：`.runtime/node22/node.exe --import tsx --test server/tests/personalWeixinAiContract.test.ts`

预期：FAIL，模块 `personalWeixinAiContract.js` 不存在。

- [ ] **步骤 3：实现契约纯函数**

```ts
export const PERSONAL_WEIXIN_MODE = 'personal' as const
export function personalWeixinSenderAllowed(config: Record<string, unknown>, senderId: string) {
  return config.ownershipMode === PERSONAL_WEIXIN_MODE
    && typeof config.accountUserId === 'string'
    && config.accountUserId.length > 0
    && config.accountUserId === senderId
}
export function publicPersonalWeixinConfig(config: Record<string, unknown>) {
  const id = typeof config.accountUserId === 'string' ? config.accountUserId : ''
  return { ownershipMode: PERSONAL_WEIXIN_MODE, connectedAt: String(config.connectedAt || ''), accountHint: id ? `***${id.slice(-4)}` : '' }
}
```

同时定义 `PersonalWeixinAiView`，只包含 `connected`、`eligible`、`botId`、`version`、`lastConnectedAt`、`accountHint` 和安全的 `reason`。

- [ ] **步骤 4：运行契约测试**

运行：`.runtime/node22/node.exe --import tsx --test server/tests/personalWeixinAiContract.test.ts`

预期：PASS。

- [ ] **步骤 5：提交契约**

```bash
git add server/src/contracts/personalWeixinAiContract.ts server/tests/personalWeixinAiContract.test.ts
git commit -m "feat: define personal WeChat AI contract"
```

### 任务 2：实现个人扫码会话和原子连接

**文件：**
- 创建：`server/src/repositories/mysql/mysqlPersonalWeixinAiRepository.ts`
- 创建：`server/src/services/personalWeixinAiService.ts`
- 创建：`server/tests/personalWeixinAiService.test.ts`
- 修改：`server/src/services/weixinQrLoginService.ts`
- 修改：`server/src/services/imIntegrationService.ts`
- 修改：`server/src/repositories/mysql/mysqlImIntegrationRepository.ts`

- [ ] **步骤 1：编写失败的服务测试**

使用内存依赖验证以下明确场景：

```ts
test('scan completion belongs to the starter and creates one isolated connection', async () => {
  const deps = fixture()
  const login = await startPersonalWeixinLogin('user-a', deps)
  await assert.rejects(() => completePersonalWeixinLogin(login.sessionKey, 'user-b', deps), /不属于当前用户/)
  const first = await completePersonalWeixinLogin(login.sessionKey, 'user-a', deps)
  const replay = await completePersonalWeixinLogin(login.sessionKey, 'user-a', deps)
  assert.equal(first.botId, replay.botId)
  assert.equal(deps.enabledBots.length, 1)
  assert.equal(deps.bindings[0].userId, 'user-a')
  assert.equal(deps.conversations[0].userId, 'user-a')
})
```

再覆盖纯系统管理员、停用用户、相同微信身份重连复用会话、不同微信身份重连创建新会话，以及停用同时关闭机器人和绑定。

- [ ] **步骤 2：运行测试并确认个人服务不存在**

运行：`.runtime/node22/node.exe --env-file-if-exists=.env --import tsx --test server/tests/personalWeixinAiService.test.ts`

预期：FAIL，缺少个人连接服务导出。

- [ ] **步骤 3：让扫码会话绑定发起用户**

将扫码会话改为判别联合：

```ts
type LoginSession = {
  sessionKey: string; qrcode: string; qrcodeUrl: string; startedAt: number; baseUrl: string
  purpose: 'admin-shared' | 'personal'
  ownerUserId: string | null
  completion?: { connected: true; botId: string }
}
```

保留 `startWeixinQrLogin()` 和 `waitForWeixinQrLogin()` 的管理员行为；新增 `startPersonalWeixinQrLogin(userId)` 和 `waitForPersonalWeixinQrLogin(sessionKey, actor)`。个人等待函数先验证 `ownerUserId === actor.userId`，确认后把上游凭据直接交给 `connectPersonalWeixinAi()`，绝不返回令牌。

- [ ] **步骤 4：实现资格校验和原子仓储**

`personalWeixinAiService.ts` 使用与公司知识库一致的有效业务角色规则：用户启用，且存在 `fde_category IS NOT NULL AND fde_category <> 'system_admin'` 的启用角色；没有角色绑定的旧用户仅在其旧 `users.role <> '系统管理员'` 时兼容。

`mysqlPersonalWeixinAiRepository.ts` 在一个 `db.transaction()` 中：

```ts
// 1. SELECT personal bot for owner FOR UPDATE
// 2. 相同 accountUserId 时复用 conversation；不同身份时创建 global conversation
// 3. 创建或更新 encrypted bot，config.ownershipMode='personal'
// 4. 将该 bot 的旧 bindings 全部 enabled=false
// 5. 按 botId + externalConversationId 创建或启用唯一 binding
// 6. 仅在 binding 和 conversation 均有效后设置 bot.enabled=true
// 7. 写 audit_logs，提交事务
```

所有值使用参数化查询或现有 Drizzle 表对象；凭据加密继续调用 `encryptIntegrationCredential()`。服务返回 `publicPersonalWeixinConfig()` 生成的安全视图。

- [ ] **步骤 5：实现读取和停用**

`getPersonalWeixinAi(actor)` 只按 `createdBy=actor.userId` 和 `ownershipMode=personal` 查询。`disconnectPersonalWeixinAi(actor, expectedVersion)` 在事务中校验所有者及版本，将 bot 和全部 bindings 设为 disabled，写审计但不删除会话。

- [ ] **步骤 6：运行服务和现有扫码测试**

运行：`.runtime/node22/node.exe --env-file-if-exists=.env --import tsx --test server/tests/personalWeixinAiService.test.ts server/src/services/weixinMessageBridge.test.ts server/src/scripts/imIntegrationAcceptance.ts`

预期：个人服务测试通过；现有管理员扫码和 IM 配置行为不回归。若验收脚本要求写测试库，只运行其只读/内存模式，不对共享业务库开启写入开关。

- [ ] **步骤 7：提交个人连接服务**

```bash
git add server/src/repositories/mysql/mysqlPersonalWeixinAiRepository.ts server/src/repositories/mysql/mysqlImIntegrationRepository.ts server/src/services/personalWeixinAiService.ts server/src/services/weixinQrLoginService.ts server/src/services/imIntegrationService.ts server/tests/personalWeixinAiService.test.ts
git commit -m "feat: connect personal WeChat AI accounts"
```

### 任务 3：暴露普通用户自助接口

**文件：**
- 修改：`server/src/routes/imIntegrations.ts`
- 修改：`server/tests/personalWeixinAiService.test.ts`

- [ ] **步骤 1：增加失败的路由合约断言**

```ts
assert.match(routes, /post\('\/weixin\/self\/login\/start'/)
assert.match(routes, /post\('\/weixin\/self\/login\/wait'/)
assert.match(routes, /get\('\/weixin\/self'/)
assert.match(routes, /post\('\/weixin\/self\/disconnect'/)
assert.doesNotMatch(selfRouteBlock, /requireImAdmin/)
```

同时测试 wait 输入只接受 UUID `sessionKey`，disconnect 必须提供正整数 `expectedVersion` 和 UUID `idempotencyKey`。

- [ ] **步骤 2：运行并确认路由缺失**

运行：`.runtime/node22/node.exe --import tsx --test server/tests/personalWeixinAiService.test.ts`

预期：FAIL，缺少 `/weixin/self` 路由。

- [ ] **步骤 3：添加四个自助路由**

路由位于 `requireImIntegrationsEnabled` 之后，但不挂 `requireImAdmin`。每个处理器使用现有 `actor(req)`，由领域服务校验用户资格和所有权；管理员共享机器人的原路由保持不变。

- [ ] **步骤 4：运行路由和鉴权测试**

运行：`.runtime/node22/node.exe --env-file-if-exists=.env --import tsx --test server/tests/personalWeixinAiService.test.ts server/tests/authSession.test.ts`

预期：PASS；未登录请求仍由上层 session middleware 拒绝。

- [ ] **步骤 5：提交接口**

```bash
git add server/src/routes/imIntegrations.ts server/tests/personalWeixinAiService.test.ts
git commit -m "feat: expose personal WeChat AI endpoints"
```

### 任务 4：隔离个人消息并消除跨主机重复回复

**文件：**
- 创建：`server/src/services/weixinBridgeLease.ts`
- 创建：`server/tests/weixinBridgeLease.test.ts`
- 修改：`server/src/services/weixinMessageBridge.ts`
- 修改：`server/src/services/weixinMessageBridge.test.ts`

- [ ] **步骤 1：编写失败的身份隔离和租约测试**

```ts
test('personal bot never creates a fallback owner binding', async () => {
  const result = await routePersonalWeixinSender({ createdBy: 'user-a', config: { ownershipMode: 'personal', accountUserId: 'wx-a' } }, 'wx-b')
  assert.equal(result, 'owner_mismatch')
  assert.equal(createBindingCalls, 0)
})

test('only one bridge lease owns the database lock', async () => {
  const first = await acquireWeixinBridgeLease(poolA)
  const second = await acquireWeixinBridgeLease(poolB)
  assert.equal(first.acquired, true)
  assert.equal(second.acquired, false)
  await first.release()
  assert.equal((await acquireWeixinBridgeLease(poolB)).acquired, true)
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`.runtime/node22/node.exe --env-file-if-exists=.env --import tsx --test server/src/services/weixinMessageBridge.test.ts server/tests/weixinBridgeLease.test.ts`

预期：FAIL，个人路由和数据库租约尚未实现。

- [ ] **步骤 3：实现严格个人路由**

在 `activeBots()` 中携带 `ownershipMode`。`dispatchInbound()` 在处理任何文本、链接、图片或文件之前分流：个人机器人仅当 `from_user_id === accountUserId`、所有者启用且现有 binding 的 `userId === createdBy` 时继续；否则发送固定拒绝消息并返回。个人模式绝不调用 `ensureInboundBinding()`。

共享机器人保留现有行为，但把 `ensureInboundBinding()` 限制为明确的 legacy/shared 分支，避免个人机器人误用管理员身份。

- [ ] **步骤 4：实现 MySQL advisory lock**

`weixinBridgeLease.ts` 通过 `pool.getConnection()` 获取独占连接，执行参数化 `SELECT GET_LOCK(?,0)`；锁名为配置数据库名的 SHA-256 摘要加 `weixin-bridge`，长度不超过 64。返回对象的 `release()` 执行 `RELEASE_LOCK` 并释放连接；未获得锁立即释放连接。

`attemptStartWeixinMessageBridge()` 先取得本机文件锁，再异步取得数据库锁，二者都成功才调用 `bridgeTick()`。standby 每 5 秒重试；`stopWeixinMessageBridge()` 先停止 poll，再释放数据库租约和文件锁。

- [ ] **步骤 5：运行桥接测试**

运行：`.runtime/node22/node.exe --env-file-if-exists=.env --import tsx --test server/src/services/weixinMessageBridge.test.ts server/tests/weixinBridgeLease.test.ts server/tests/weixinLinkIntake.test.ts`

预期：个人身份隔离、共享机器人回归、租约独占和微信文章收录测试全部通过。

- [ ] **步骤 6：提交路由隔离和租约**

```bash
git add server/src/services/weixinBridgeLease.ts server/src/services/weixinMessageBridge.ts server/src/services/weixinMessageBridge.test.ts server/tests/weixinBridgeLease.test.ts
git commit -m "fix: isolate personal WeChat bots and elect one poller"
```

### 任务 5：实现头像入口和个人连接页面

**文件：**
- 创建：`src/pages/PersonalWeixinAiPage.tsx`
- 创建：`server/tests/personalWeixinAiUi.test.ts`
- 修改：`src/App.tsx`
- 修改：`src/layout/AppLayout.tsx`
- 修改：`src/styles.css`

- [ ] **步骤 1：编写失败的 UI 合约测试**

```ts
test('profile menu exposes personal WeChat AI and page uses self endpoints', async () => {
  const layout = await readFile('src/layout/AppLayout.tsx', 'utf8')
  const page = await readFile('src/pages/PersonalWeixinAiPage.tsx', 'utf8')
  assert.match(layout, /微信 AI/)
  assert.match(layout, /\/settings\/weixin-ai/)
  assert.match(page, /\/integrations\/im\/weixin\/self/)
  assert.doesNotMatch(page, /\/integrations\/im\/weixin\/login\/start/)
})
```

- [ ] **步骤 2：运行并确认页面不存在**

运行：`.runtime/node22/node.exe --import tsx --test server/tests/personalWeixinAiUi.test.ts`

预期：FAIL，`PersonalWeixinAiPage.tsx` 不存在。

- [ ] **步骤 3：注册页面和头像菜单**

在 `src/App.tsx` 的 `ProtectedLayout` 下注册：

```tsx
<Route path="/settings/weixin-ai" element={<PersonalWeixinAiPage />} />
```

在头像菜单的“AI 助手”与“修改登录密码”之间加入按钮，图标使用现有 `QrCode` 或 `MessagesSquare`，点击关闭菜单并导航。页面状态通过轻量 GET `/integrations/im/weixin/self` 读取，菜单文字显示“微信 AI”，状态用绿点/灰点及 `title` 提示，不在每次布局渲染中启动扫码。

- [ ] **步骤 4：实现四态连接页**

`PersonalWeixinAiPage.tsx` 使用现有 `apiGet`、`apiPost`、`Button` 和卡片样式实现：未连接、扫码中、已连接、失败。点击生成后显示 `qrcodeUrl` 和本地倒计时，同时调用 wait；离开页面用 `AbortController` 停止前端等待显示，但不泄露 sessionKey。重新连接重新扫码，停用提交 `expectedVersion` 和稳定到结果确定前不变的 `idempotencyKey`。

页面文案固定包含：“请使用本人微信扫码”“连接后消息只进入你的独立 AI 会话”“扫码不会增加项目或知识库权限”。

- [ ] **步骤 5：实现响应式样式和浏览器检查**

在 `src/styles.css` 增加 `.fde-personal-weixin-*` 样式，桌面二维码与说明双栏，窄屏单栏；二维码图片有明确 alt 文本，按钮和状态不只依赖颜色。

运行本地 Vite，使用模拟 self API 检查 1440px 和 390px：头像入口可见；二维码不溢出；连接成功和失败有文字；键盘可以进入按钮并关闭页面。

- [ ] **步骤 6：运行 UI 测试和前端类型检查**

运行：`.runtime/node22/node.exe --import tsx --test server/tests/personalWeixinAiUi.test.ts`

运行：`.runtime/node22/node.exe node_modules/typescript/bin/tsc -b`

预期：测试和前端类型检查均通过。

- [ ] **步骤 7：提交前端入口**

```bash
git add src/pages/PersonalWeixinAiPage.tsx src/App.tsx src/layout/AppLayout.tsx src/styles.css server/tests/personalWeixinAiUi.test.ts
git commit -m "feat: add personal WeChat AI profile entry"
```

### 任务 6：完整回归与交付检查

**文件：**
- 修改：`WEIXIN_LINK_INTAKE.md`
- 修改：`docs/superpowers/specs/2026-09-08-personal-weixin-ai-design.md`

- [ ] **步骤 1：更新运行说明**

在 `WEIXIN_LINK_INTAKE.md` 增加普通用户入口 `/settings/weixin-ai`、每人独立机器人、业务角色要求和 MySQL 全局轮询锁说明。规格的实现状态只记录实际完成项，不写服务器已部署。

- [ ] **步骤 2：运行直接相关测试**

```powershell
.runtime/node22/node.exe --env-file-if-exists=.env --import tsx --test `
  server/tests/personalWeixinAiContract.test.ts `
  server/tests/personalWeixinAiService.test.ts `
  server/tests/weixinBridgeLease.test.ts `
  server/tests/personalWeixinAiUi.test.ts `
  server/src/services/weixinMessageBridge.test.ts `
  server/tests/weixinLinkIntake.test.ts `
  server/tests/weixinBrowserArticle.test.ts
```

预期：全部 PASS，0 failure。

- [ ] **步骤 3：运行类型和补丁检查**

```powershell
.runtime/node22/node.exe node_modules/typescript/bin/tsc -b
.runtime/node22/node.exe node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit
git diff --check origin/main...HEAD
git status --short
```

预期：两个类型检查退出码 0；补丁无空白错误；状态中只有本计划明确列出的文件。

- [ ] **步骤 4：本地只读/模拟验收**

启动服务后验证 `/api/health` 和 `/api/health/components` 返回 200。浏览器使用模拟 iLink 响应完成两个虚拟用户的扫码与消息隔离；不得在共享业务库创建测试机器人、绑定或会话。另以两个独立 MySQL 连接验证 advisory lock 获取与释放，但不写表。

- [ ] **步骤 5：提交文档并复核提交范围**

```bash
git add WEIXIN_LINK_INTAKE.md docs/superpowers/specs/2026-09-08-personal-weixin-ai-design.md
git commit -m "docs: document personal WeChat AI access"
git log --oneline origin/main..HEAD
git diff --name-only origin/main...HEAD
```

预期：提交历史只包含个人微信 AI 设计和实现；不包含本机 Node 运行时、`.env`、日志、二维码或其他工作区改动。
