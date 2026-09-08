import assert from 'node:assert/strict'
import test from 'node:test'

import type { ImActor } from '../src/services/imIntegrationService.js'
import {
  connectPersonalWeixinAi,
  disconnectPersonalWeixinAi,
  getPersonalWeixinAi,
  type PersonalWeixinAiRepository,
} from '../src/services/personalWeixinAiService.js'

const actor = (userId: string): ImActor => ({ userId, userName: userId, role: '投资经理' })

function fixture(options: { eligible?: boolean } = {}) {
  let record: Awaited<ReturnType<PersonalWeixinAiRepository['connect']>> | null = null
  let connects = 0
  const repository: PersonalWeixinAiRepository = {
    async eligibility() { return { eligible: options.eligible ?? true, reason: (options.eligible ?? true) ? null : '当前账号不可用或仅有系统管理职责' } },
    async findForUser() { return record },
    async connect(input) {
      connects += 1
      record = {
        botId: record?.botId ?? 'bot-a', version: (record?.version ?? 0) + 1,
        enabled: true, config: { ownershipMode: 'personal', accountId: input.accountId, accountUserId: input.accountUserId, connectedAt: '2026-09-08T00:00:00.000Z' },
        lastConnectedAt: new Date('2026-09-08T00:00:00.000Z'),
      }
      return record
    },
    async disconnect(input) {
      if (!record) return 'not_found'
      if (record.version !== input.expectedVersion) return 'conflict'
      record = { ...record, enabled: false, version: record.version + 1, lastConnectedAt: null }
      return { status: 'ok', record }
    },
  }
  return { repository, get connects() { return connects } }
}

test('personal connection returns a safe owner-scoped view and reconnects idempotently', async () => {
  const deps = fixture()
  const input = { accountId: 'bot-secret', accountUserId: 'wx-owner', botToken: 'x'.repeat(32), baseUrl: 'https://ilinkai.weixin.qq.com' }
  const first = await connectPersonalWeixinAi(input, actor('user-a'), deps.repository)
  const second = await connectPersonalWeixinAi(input, actor('user-a'), deps.repository)
  assert.equal(first.botId, second.botId)
  assert.equal(first.connected, true)
  assert.equal(first.accountHint, '***wner')
  assert.equal(JSON.stringify(first).includes('bot-secret'), false)
  assert.equal(deps.connects, 2)
})

test('ineligible users cannot connect', async () => {
  const deps = fixture({ eligible: false })
  await assert.rejects(() => connectPersonalWeixinAi({
    accountId: 'bot', accountUserId: 'wx', botToken: 'x'.repeat(32), baseUrl: 'https://ilinkai.weixin.qq.com',
  }, actor('system-admin'), deps.repository), /系统管理职责/)
  assert.equal(deps.connects, 0)
})

test('status reports eligibility and disconnect uses optimistic version', async () => {
  const deps = fixture()
  const empty = await getPersonalWeixinAi(actor('user-a'), deps.repository)
  assert.deepEqual(empty, { connected: false, eligible: true, botId: null, version: null, lastConnectedAt: null, accountHint: '', reason: null })
  const connected = await connectPersonalWeixinAi({ accountId: 'bot', accountUserId: 'wx-owner', botToken: 'x'.repeat(32), baseUrl: 'https://ilinkai.weixin.qq.com' }, actor('user-a'), deps.repository)
  await assert.rejects(() => disconnectPersonalWeixinAi(actor('user-a'), connected.version + 1, deps.repository), /已发生变化/)
  const stopped = await disconnectPersonalWeixinAi(actor('user-a'), connected.version, deps.repository)
  assert.equal(stopped.connected, false)
})
