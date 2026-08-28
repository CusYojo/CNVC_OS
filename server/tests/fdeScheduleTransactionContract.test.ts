import assert from 'node:assert/strict'
import test from 'node:test'
import { isScheduleDeadlock, retryScheduleTransaction } from '../src/contracts/fdeScheduleTransactionContract.js'
import { errorHandler } from '../src/middleware/errorHandler.js'

const deadlock = () => Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 })

test('schedule retries the whole transaction after a wrapped MySQL deadlock', async () => {
  let attempts = 0
  const result = await retryScheduleTransaction(async () => {
    attempts++
    if (attempts === 1) throw new Error('query failed', { cause: deadlock() })
    return { id: 'committed' }
  })
  assert.deepEqual(result, { id: 'committed' })
  assert.equal(attempts, 2)
})

test('schedule retry budget returns a safe conflict without raw SQL in the message', async () => {
  let attempts = 0
  await assert.rejects(retryScheduleTransaction(async () => { attempts++; throw deadlock() }), {
    code: 'SCHEDULE_RETRY_REQUIRED', status: 409, message: '时间安排正在被其他操作更新，请刷新后重试',
  })
  assert.equal(attempts, 3)
})

test('business errors, lock timeouts, connection loss and unknown outcomes are not replayed', async () => {
  for (const error of [
    Object.assign(new Error('busy'), { code: 'TIME_CONFLICT', status: 409 }),
    Object.assign(new Error('timeout'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 }),
    Object.assign(new Error('commit response lost'), { code: 'ECONNRESET' }),
    Object.assign(new Error('not a verified MySQL error'), { code: 'ER_LOCK_DEADLOCK' }),
  ]) {
    let attempts = 0
    await assert.rejects(retryScheduleTransaction(async () => { attempts++; throw error }), value => value === error)
    assert.equal(attempts, 1)
  }
})

test('retry rechecks business conditions and cycle-safe cause traversal terminates', async () => {
  let attempts = 0
  await assert.rejects(retryScheduleTransaction(async () => {
    attempts++
    if (attempts === 1) throw deadlock()
    throw Object.assign(new Error('winner now occupies the slot'), { code: 'MEETING_TIME_CONFLICT' })
  }), { code: 'MEETING_TIME_CONFLICT' })
  assert.equal(attempts, 2)
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle
  assert.equal(isScheduleDeadlock(cycle), false)
  assert.equal(isScheduleDeadlock(null), false)
})

test('exhausted retry reaches HTTP as 409 without exposing the database cause', async () => {
  const failure = await retryScheduleTransaction(async () => { throw deadlock() }).catch(error => error)
  let status = 0, body: unknown
  const response = {
    locals: { requestId: 'schedule-test' },
    status(value: number) { status = value; return this },
    json(value: unknown) { body = value; return this },
  }
  errorHandler(failure, { method: 'POST', path: '/api/leader-time/test' } as Parameters<typeof errorHandler>[1], response as unknown as Parameters<typeof errorHandler>[2], () => {})
  assert.equal(status, 409)
  assert.deepEqual(body, { code: 'SCHEDULE_RETRY_REQUIRED', message: '时间安排正在被其他操作更新，请刷新后重试', details: null, requestId: 'schedule-test' })
  assert.ok(!JSON.stringify(body).includes('ER_LOCK_DEADLOCK'))
})
