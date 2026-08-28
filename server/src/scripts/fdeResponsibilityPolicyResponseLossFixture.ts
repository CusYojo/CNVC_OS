import assert from 'node:assert/strict'
import type { RequestHandler } from 'express'

// Test harness only; no production route imports this module.
export function responsibilityPolicyResponseLossFixture(faults: Array<'before-commit' | 'after-commit'>): RequestHandler {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  return (req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/api/responsibility-policies/commands' || !faults.length) return next()
    const fault = faults.shift(), response = { code: 'FIXTURE_RESPONSE_LOST', message: '隔离责任规则响应丢失，请核对原操作' }
    if (fault === 'before-commit') { res.status(502).json(response); return }
    const json = res.json.bind(res)
    res.json = body => res.statusCode < 400 ? json.call(res.status(502), response) : json(body)
    next()
  }
}
