import assert from 'node:assert/strict'
import type { RequestHandler } from 'express'

export type OfficeResponseFault = 'before-commit' | 'after-commit'
// Only a guarded test server may install this. Production routes have no fault
// headers, URL switches or response-loss configuration.
export function officeResponseLossFixture(faults: OfficeResponseFault[], includeResolution = true): RequestHandler {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  return (req, res, next) => {
    if (!includeResolution && req.path.endsWith('/commands/resolve')) { next(); return }
    if (req.method !== 'POST' || !/^\/api\/oa\/office\/requests\/[^/]+\/(?:save|actions|attachments\/[^/]+(?:\/grants)?|commands\/resolve)$/.test(req.path) || !faults.length) { next(); return }
    const fault = faults.shift(), response = { code: 'FIXTURE_RESPONSE_LOST', message: '隔离夹具模拟响应丢失，请核对原请求' }
    if (fault === 'before-commit') { res.status(502).json(response); return }
    const json = res.json.bind(res)
    res.json = (body: unknown) => res.statusCode < 400 ? json.call(res.status(502), response) : json(body)
    next()
  }
}

export function officePolicyResponseLossFixture(faults: OfficeResponseFault[]): RequestHandler {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  return (req, res, next) => {
    if (req.method !== 'POST' || !/^\/api\/system-administration\/(?:office-policy-versions\/[^/]+\/(?:save|publish)|office-policies\/[^/]+\/enabled)$/.test(req.path) || !faults.length) return next()
    const fault = faults.shift(), response = { code: 'FIXTURE_RESPONSE_LOST', message: '隔离规则响应丢失，请核对原操作' }
    if (fault === 'before-commit') { res.status(502).json(response); return }
    const json = res.json.bind(res)
    res.json = body => res.statusCode < 400 ? json.call(res.status(502), response) : json(body)
    next()
  }
}
