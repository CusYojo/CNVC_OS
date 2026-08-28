import assert from 'node:assert/strict'
import type { RequestHandler } from 'express'

// Never imported by production routes. Reading notices does not consume faults.
export function responsibilityResponseLossFixture(faults: Array<'before-commit' | 'after-commit'>): RequestHandler {
  assert.match(process.env.DB_FREFIX ?? '', /^fde_accept_[a-f0-9]{10}_$/)
  assert.equal(process.env.DB_FREFIX, process.env.FDE_ACCEPTANCE_PREFIX)
  const actions = process.env.FDE_RESPONSIBILITY_ASSIGNMENT_BROWSER_FIXTURE === '1' ? ['reroute'] : ['appeal', 'review']
  return (req, res, next) => {
    if (req.method !== 'POST' || !/^\/api\/responsibility\/projects\/[^/]+\/commands$/.test(req.path) || !actions.includes(req.body?.action) || !faults.length) return next()
    const fault = faults.shift(), response = { code: 'FIXTURE_RESPONSE_LOST', message: '隔离责任记录响应丢失，请核对原操作结果' }
    if (fault === 'before-commit') { res.status(502).json(response); return }
    const json = res.json.bind(res)
    res.json = body => res.statusCode < 400 ? json.call(res.status(502), response) : json(body)
    next()
  }
}
