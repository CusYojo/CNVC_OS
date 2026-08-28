import assert from 'node:assert/strict'
import type { RequestHandler } from 'express'

export type MaterialResponseFault = 'after-commit' | 'before-commit'
// Test-only middleware. Never registered by the application; random test prefix
// required even when a caller imports this fixture directly.
export function materialResponseLossFixture(faults: MaterialResponseFault[]): RequestHandler {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  return (req, res, next) => {
    if (req.method !== 'POST' || !/^\/api\/projects\/[^/]+\/material-submissions(?:\/[^/]+\/(?:decision|withdraw))?$/.test(req.path) || !faults.length) { next(); return }
    const fault = faults.shift()
    const response = { code: 'FIXTURE_RESPONSE_LOST', message: '隔离夹具模拟响应丢失，请核对提交结果' }
    if (fault === 'before-commit') { res.status(502).json(response); return }
    const json = res.json.bind(res)
    res.json = (body: unknown) => res.statusCode < 400 ? json.call(res.status(502), response) : json(body)
    next()
  }
}
