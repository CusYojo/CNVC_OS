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

const actor = { userId: 'secondary-admin', userName: '多角色测试用户', role: '董事长', department: '管理层' }
const boundaries = [
  { name: '模型', permission: 'ai.configure', guard: models.assertAiModelAdmin, list: models.listModelSettings },
  { name: '能力', permission: 'ai.configure', guard: capabilities.assertAiCapabilityAdmin, list: capabilities.listCapabilitySettings },
  { name: 'IM', permission: 'im.manage', guard: im.assertImAdmin, list: im.listImSettings },
]

for (const boundary of boundaries) {
  test(`${boundary.name}管理接受附加角色权限，并在权限撤销后拒绝访问`, async (t) => {
    let granted = [boundary.permission]
    const permissionLookup = t.mock.method(identityRepositories.users, 'listPermissionCodes', async (userId: string) => {
      assert.equal(userId, actor.userId)
      return granted
    })
    await boundary.guard(actor)
    granted = []
    await assert.rejects(boundary.guard(actor), { code: 'ROLE_FORBIDDEN', status: 403 })
    assert.equal(permissionLookup.mock.callCount(), 2)
  })

  test(`${boundary.name}管理不能仅凭管理员主角色名称或无关权限放行`, async (t) => {
    t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => ['fde.governance.manage', 'system.manage'])
    for (const role of ['董事长', '系统管理员', 'AI平台管理员', '运营管理员']) {
      await assert.rejects(boundary.guard({ ...actor, role }), { code: 'ROLE_FORBIDDEN', status: 403 })
    }
  })

  test(`${boundary.name}设置读取等待权限结果，拒绝时不读取配置`, async (t) => {
    let release!: (codes: string[]) => void
    t.mock.method(identityRepositories.users, 'listPermissionCodes', () => new Promise<string[]>(resolve => { release = resolve }))
    const modelRead = t.mock.method(aiConfigurationRepository, 'listModelSettings', async () => { throw new Error('unauthorized read') })
    const capabilityRead = t.mock.method(aiConfigurationRepository, 'listCapabilitySettings', async () => { throw new Error('unauthorized read') })
    const imRead = t.mock.method(imIntegrationRepository, 'listSettingsData', async () => { throw new Error('unauthorized read') })
    const pending = boundary.list(actor)
    assert.equal(modelRead.mock.callCount() + capabilityRead.mock.callCount() + imRead.mock.callCount(), 0)
    release([])
    await assert.rejects(pending, { code: 'ROLE_FORBIDDEN', status: 403 })
    assert.equal(modelRead.mock.callCount() + capabilityRead.mock.callCount() + imRead.mock.callCount(), 0)
  })
}

test('附加管理员可读取模型、能力与 IM 设置', async (t) => {
  t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => ['ai.configure', 'im.manage'])
  t.mock.method(aiConfigurationRepository, 'listModelSettings', async () => ({ providers: [], models: [], routes: [] }))
  t.mock.method(aiConfigurationRepository, 'listCapabilitySettings', async () => ({ capabilities: [], bindings: [], projects: [] }))
  t.mock.method(imIntegrationRepository, 'listSettingsData', async () => ({ bots: [], bindings: [], outbox: [], logs: [], users: [], projects: [], conversations: [] }))
  assert.deepEqual((await models.listModelSettings(actor)).providers, [])
  assert.deepEqual((await capabilities.listCapabilitySettings(actor)).capabilities, [])
  assert.deepEqual((await im.listImSettings(actor)).bots, [])
})

test('权限查询失败时配置管理不放行', async (t) => {
  const failure = new Error('permission lookup failed')
  t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => { throw failure })
  for (const boundary of boundaries) await assert.rejects(boundary.guard(actor), error => error === failure)
})

test('IM 发送的管理员标记使用已授予权限，保留普通绑定用户路径', async (t) => {
  let granted = ['im.manage']
  t.mock.method(identityRepositories.users, 'listPermissionCodes', async () => granted)
  const enqueue = t.mock.method(imIntegrationRepository, 'enqueueMessageWithAudit', async (input) => {
    assert.equal(input.actorUserId, actor.userId)
    assert.equal(input.actorIsAdmin, granted.includes('im.manage'))
    return { status: 'forbidden' as const }
  })
  const input = { botId: 'bot', bindingId: 'binding', idempotencyKey: 'message', message: 'test' }
  await assert.rejects(im.enqueueImMessage(input, actor), { code: 'IM_BINDING_FORBIDDEN' })
  granted = []
  await assert.rejects(im.enqueueImMessage(input, actor), { code: 'IM_BINDING_FORBIDDEN' })
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
