import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import ts from 'typescript'

// This suite mocks repository calls and must never connect to the configured business DB.
Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: 'configuration_admin_unit', DB_USERNAME: 'unit', DB_PASSWORD: 'unit', DB_FREFIX: 'unit_' })
const { pool } = await import('../src/db/client.js')
const { identityRepositories, aiConfigurationRepository, imIntegrationRepository } = await import('../src/repositories/index.js')
const models = await import('../src/services/aiModelSettingsService.js')
const capabilities = await import('../src/services/aiCapabilityService.js')
const im = await import('../src/services/imIntegrationService.js')
after(() => pool.end())

const businessActor = { userId: 'business-user', userName: '业务用户', role: '投资经理', department: '投资部' }
const aiAdminActor = { ...businessActor, userId: 'ai-admin', userName: 'AI 管理员', role: 'AI平台管理员' }
const systemAdminActor = { ...businessActor, userId: 'system-admin', userName: '系统管理员', role: '系统管理员' }

for (const boundary of [
  { name: '模型', guard: models.assertAiModelAdmin },
  { name: '能力', guard: capabilities.assertAiCapabilityAdmin },
]) {
  test(`${boundary.name}管理仅接受明确的 AI 或系统管理角色`, async () => {
    await boundary.guard(aiAdminActor)
    await boundary.guard(systemAdminActor)
    for (const role of ['董事长', '合伙人', '投资经理', '法务', '风控', '董秘', '运营管理员']) {
      await assert.rejects(boundary.guard({ ...businessActor, role }), { code: 'ROLE_FORBIDDEN', status: 403 })
    }
  })
}

test('未授权用户读取模型设置前即被拒绝', async (t) => {
  const read = t.mock.method(aiConfigurationRepository, 'listModelSettings', async () => { throw new Error('unauthorized read') })
  await assert.rejects(models.listModelSettings(businessActor), { code: 'ROLE_FORBIDDEN', status: 403 })
  assert.equal(read.mock.callCount(), 0)
})

test('未授权用户读取能力设置前即被拒绝', async (t) => {
  const read = t.mock.method(aiConfigurationRepository, 'listCapabilitySettings', async () => { throw new Error('unauthorized read') })
  await assert.rejects(capabilities.listCapabilitySettings(businessActor), { code: 'ROLE_FORBIDDEN', status: 403 })
  assert.equal(read.mock.callCount(), 0)
})

test('AI 平台管理员可读取模型与能力配置', async (t) => {
  t.mock.method(aiConfigurationRepository, 'listModelSettings', async () => ({ providers: [], models: [], routes: [] }))
  t.mock.method(aiConfigurationRepository, 'listCapabilitySettings', async () => ({ capabilities: [], bindings: [], projects: [] }))
  assert.deepEqual((await models.listModelSettings(aiAdminActor)).providers, [])
  assert.deepEqual((await capabilities.listCapabilitySettings(aiAdminActor)).capabilities, [])
})

test('IM 管理使用明确权限码，撤销后立即拒绝', async (t) => {
  let granted = ['im.manage']
  const lookup = t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => granted)
  await im.assertImAdmin(businessActor)
  granted = []
  await assert.rejects(im.assertImAdmin(businessActor), { code: 'ROLE_FORBIDDEN', status: 403 })
  assert.equal(lookup.mock.callCount(), 2)
})

test('IM 设置读取会等待权限结果，拒绝时不读数据', async (t) => {
  let release!: (codes: string[]) => void
  t.mock.method(identityRepositories.users, 'listPermissionCodes', () => new Promise<string[]>(resolve => { release = resolve }))
  const read = t.mock.method(imIntegrationRepository, 'listSettingsData', async () => { throw new Error('unauthorized read') })
  const pending = im.listImSettings(businessActor)
  assert.equal(read.mock.callCount(), 0)
  release([])
  await assert.rejects(pending, { code: 'ROLE_FORBIDDEN', status: 403 })
  assert.equal(read.mock.callCount(), 0)
})

test('IM 管理权限用户可读取设置', async (t) => {
  t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => ['im.manage'])
  t.mock.method(imIntegrationRepository, 'listSettingsData', async () => ({ bots: [], bindings: [], outbox: [], logs: [], users: [], projects: [], conversations: [] }))
  assert.deepEqual((await im.listImSettings(businessActor)).bots, [])
})

test('IM 权限查询失败时不放行', async (t) => {
  const failure = new Error('permission lookup failed')
  t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => { throw failure })
  await assert.rejects(im.assertImAdmin(businessActor), error => error === failure)
})

test('IM 发送的管理员标记使用已授予权限，保留普通绑定用户路径', async (t) => {
  let granted = ['im.manage']
  t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => granted)
  const enqueue = t.mock.method(imIntegrationRepository, 'enqueueMessageWithAudit', async (input) => {
    assert.equal(input.actorUserId, businessActor.userId)
    assert.equal(input.actorIsAdmin, granted.includes('im.manage'))
    return { status: 'forbidden' as const }
  })
  const input = { botId: 'bot', bindingId: 'binding', idempotencyKey: 'message', message: 'test' }
  await assert.rejects(im.enqueueImMessage(input, businessActor), { code: 'IM_BINDING_FORBIDDEN' })
  granted = []
  await assert.rejects(im.enqueueImMessage(input, businessActor), { code: 'IM_BINDING_FORBIDDEN' })
  assert.equal(enqueue.mock.callCount(), 2)
})

test('所有配置读写入口均等待异步权限检查', () => {
  for (const [file, guard] of [['aiModelSettingsService', 'assertAiModelAdmin'], ['aiCapabilityService', 'assertAiCapabilityAdmin'], ['imIntegrationService', 'assertImAdmin']]) {
    const source = ts.createSourceFile(`${file}.ts`, readFileSync(new URL(`../src/services/${file}.ts`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
    let checks = 0
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === guard) {
        checks++
        assert.ok(ts.isAwaitExpression(node.parent), `${file} has an unawaited ${guard}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.ok(checks > 0)
  }
})
