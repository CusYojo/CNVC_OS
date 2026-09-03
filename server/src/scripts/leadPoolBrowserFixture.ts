import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { pool } from '../db/client.js'
import { errorHandler } from '../middleware/errorHandler.js'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { metaRouter } from '../routes/meta.js'

const app = express()
app.use(express.json())
const servedBuild = process.argv.includes('--served-build')
const sourceBuild = process.argv.includes('--source')
if (servedBuild && sourceBuild) throw new Error('--served-build and --source are mutually exclusive')

let leadFailuresRemaining = 0
type FixtureAuthMode = 'ordinary' | 'permission-admin' | 'legacy-admin'
let fixtureAuthMode: FixtureAuthMode = 'ordinary'
let syntheticConflictResolved = false
const syntheticLeadId = 'lead-pool-conflict-fixture'

function fixtureUser() {
  const legacyAdmin = fixtureAuthMode === 'legacy-admin'
  return {
    id: 'lead-pool-browser-acceptance',
    email: 'browser-acceptance@example.invalid',
    name: '线索池浏览器验收',
    role: legacyAdmin ? '系统管理员' : '投资经理',
    department: '验收部',
    status: '启用',
    permissionCodes: fixtureAuthMode === 'permission-admin' ? ['system.manage'] : [],
  }
}

app.post('/__fixture__/lead-failures', (req, res) => {
  leadFailuresRemaining = Math.max(0, Math.min(3, Math.floor(Number(req.body?.count) || 0)))
  res.json({ ok: true, leadFailuresRemaining })
})

app.post('/__fixture__/auth-mode', (req, res) => {
  const mode = String(req.body?.mode || '')
  if (!['ordinary', 'permission-admin', 'legacy-admin'].includes(mode)) {
    res.status(400).json({ ok: false, message: 'unknown fixture auth mode' })
    return
  }
  fixtureAuthMode = mode as FixtureAuthMode
  syntheticConflictResolved = false
  res.json({ ok: true, mode: fixtureAuthMode, user: fixtureUser() })
})

app.get('/api/auth/me', (_req, res) => {
  res.json({
    user: fixtureUser(),
    authMode: 'fixture',
  })
})

app.get(`/api/leads/${syntheticLeadId}`, (_req, res) => {
  res.json({
    id: syntheticLeadId,
    name: '冲突复核验收企业',
    companyName: '冲突复核验收企业有限公司',
    channel: '新闻',
    source: '隔离浏览器验收',
    sourceUrl: 'https://example.com/lead-profile-fixture',
    industry: '先进制造',
    round: 'A轮',
    region: '上海',
    website: 'https://example.com/',
    poolStatus: '公共池',
    score: 0,
    summary: '仅用于隔离浏览器验收的合成企业画像。',
    projectIntroduction: '仅用于隔离浏览器验收的合成企业画像。',
    projectIntroductionSourceUrl: 'https://example.com/lead-profile-fixture',
    team: '',
    product: '',
    financing: '',
    highlights: [],
    risks: [],
    suggestion: '',
    shareholders: [],
    founders: [],
    fundingRounds: [],
    companyNews: [],
    sources: [],
    investmentProfile: {
      schemaVersion: 'lead-investment-profile-v1',
      snapshotId: 'snapshot-browser-fixture',
      industry: { level1: '先进制造', level2: '半导体设备', segment: '薄膜沉积设备', chainPosition: '上游设备' },
      products: [{ name: '验收设备', productRoute: '原子层沉积', productionStage: '中试', productionStageStatus: 'realized' }],
      institutions: [{ name: '验收投资机构', round: 'A轮', role: 'lead', type: '产业资本', major: true }],
      academicLinks: [{ institution: '验收大学', relationType: '成果转化', commercialization: true }],
      financing: { status: '已完成融资', latestRound: 'A轮', latestRoundDate: '2026-08-01', latestAmount: '1亿元', completedRoundCount: 1 },
      valuation: { value: '8亿元', type: 'post_money', currency: 'CNY', date: '2026-08-01', round: 'A轮' },
      customers: {
        highestStage: 'L4', verifiedCount: 1, tierACount: 1, tierBCount: 0, tierCCount: 0,
        representatives: [{ name: '某保密客户', tier: 'A', stage: 'L4', anonymized: true }],
      },
      dataStatus: {
        verifiedDimensions: 6, applicableDimensions: 6,
        conflictCount: syntheticConflictResolved ? 0 : 1,
        status: syntheticConflictResolved ? 'verified' : 'conflicted', updatedAt: '2026-09-02',
      },
    },
  })
})

app.get(`/api/leads/${syntheticLeadId}/verified-profile`, (_req, res) => {
  res.json({
    introductions: {
      companyIntroduction: '合成企业介绍', teamIntroduction: null,
      projectIntroduction: '仅用于隔离浏览器验收的合成企业画像。',
    },
    introductionSources: {
      companyIntroduction: [{ sourceUrl: 'https://example.com/lead-profile-fixture', title: '合成来源' }],
      teamIntroduction: [],
      projectIntroduction: [{ sourceUrl: 'https://example.com/lead-profile-fixture', title: '合成来源' }],
    },
  })
})

app.get(`/api/leads/${syntheticLeadId}/verified-facts`, (_req, res) => {
  res.json({
    facts: [{
      id: 'fact-browser-industry', subjectType: 'company', factKey: 'industry.segment',
      value: '薄膜沉积设备', verificationStatus: 'verified', investmentProfileSource: true,
      evidence: [{ sourceUrl: 'https://example.com/lead-profile-fixture', title: '行业与产品公开来源' }],
    }],
    total: 1, hasMore: false, page: 1, pageSize: 100,
  })
})

app.get(`/api/leads/${syntheticLeadId}/enrichment/conflicts`, (_req, res) => {
  if (fixtureAuthMode === 'ordinary') {
    res.status(403).json({ code: 'ROLE_FORBIDDEN', message: '仅具有系统管理权限的用户可访问' })
    return
  }
  res.json({
    leadId: syntheticLeadId,
    conflicts: syntheticConflictResolved ? [] : [{
      id: 'conflict-browser-fixture', factKey: 'industry.segment', instanceKey: 'singleton',
      status: 'open', severity: 'material', automaticReason: '两个公开来源给出的细分赛道不一致',
      candidates: [{
        id: 'fact-browser-candidate', value: '先进薄膜设备', evidenceLevel: 'E2',
        verificationStatus: 'verified', isCurrent: false,
        evidence: [{
          sourceUrl: 'https://example.org/lead-profile-conflict', title: '冲突候选公开来源',
          quote: '该企业聚焦先进薄膜设备。', reliability: 'E2',
        }],
      }],
    }],
  })
})

app.post(`/api/leads/${syntheticLeadId}/enrichment/conflicts/:conflictId/resolve`, (req, res) => {
  if (fixtureAuthMode === 'ordinary') {
    res.status(403).json({ code: 'ROLE_FORBIDDEN', message: '仅具有系统管理权限的用户可访问' })
    return
  }
  if (!['accept_fact', 'dismiss'].includes(String(req.body?.decision)) || String(req.body?.reason || '').trim().length < 4) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: '裁决参数无效' })
    return
  }
  syntheticConflictResolved = true
  res.status(202).json({ resolved: true, leadId: syntheticLeadId, conflictId: req.params.conflictId })
})

app.get([
  '/api/projects',
  '/api/meetings',
  '/api/todos',
  '/api/risks',
  '/api/ai-summaries',
  '/api/projects/files/all',
  '/api/templates',
  '/api/oa/requests',
  '/api/oa/workflow-logs',
], (_req, res) => res.json({ list: [] }))

app.use('/api', (req: AuthedRequest, res, next) => {
  res.locals.requestId = 'lead-pool-browser-fixture'
  req.user = {
    uid: 'lead-pool-browser-acceptance',
    email: 'browser-acceptance@example.invalid',
    name: '线索池浏览器验收',
    role: '投资经理',
    department: '验收部',
  }
  if (req.method === 'GET' && req.path === '/leads' && leadFailuresRemaining > 0) {
    leadFailuresRemaining -= 1
    res.status(503).json({
      code: 'LEAD_POOL_FIXTURE_FAILURE',
      message: '线索池浏览器验收模拟读取失败',
      details: { leadFailuresRemaining },
      requestId: res.locals.requestId,
    })
    return
  }
  next()
})
app.use('/api/leads', async (req, _res, next) => {
  if (req.method === 'GET' && req.query.keyword === 'lead-pool-slow-request') {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  next()
})
app.use('/api', metaRouter)
app.use('/api', (_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'fixture endpoint unavailable' }))
app.use(errorHandler)

let releaseId: string | null = null
let closeFrontend = async () => {}
if (sourceBuild) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sbl-lead-pool-browser-source-'))
  const distDir = path.join(temporaryRoot, 'dist')
  try {
    const { build } = await import('vite')
    await build({
      root: process.cwd(),
      logLevel: 'error',
      build: { outDir: distDir, emptyOutDir: true },
    })
    const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8')
    app.use(express.static(distDir))
    app.use((_req, res) => res.type('html').send(indexHtml))
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
  closeFrontend = async () => { await rm(temporaryRoot, { recursive: true, force: true }) }
} else {
  const pointerPath = path.resolve(process.cwd(), servedBuild
    ? '.runtime/build-rollback.json'
    : '.runtime/build-candidate.json')
  const buildPointer = JSON.parse(await readFile(pointerPath, 'utf8')) as { releaseId: string }
  releaseId = buildPointer.releaseId
  if (!/^build-[0-9]{8}T[0-9]{9}Z-[0-9]+-[a-f0-9]{8}$/.test(releaseId)) {
    throw new Error('线索池浏览器验收构建版本标识无效')
  }
  const distDir = servedBuild
    ? path.resolve(process.cwd(), 'dist')
    : path.resolve(process.cwd(), '.runtime', 'build-candidates', releaseId, 'dist')
  const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8')
  app.use(express.static(distDir))
  app.use((_req, res) => res.type('html').send(indexHtml))
}

const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve)
  server.once('error', reject)
})
const port = (server.address() as AddressInfo).port
console.log(JSON.stringify({
  ok: true,
  buildSource: sourceBuild ? 'source' : servedBuild ? 'served' : 'candidate',
  releaseId,
  url: `http://127.0.0.1:${port}/projects?view=leads`,
}))

let closingPromise: Promise<void> | null = null
function close() {
  if (closingPromise) return closingPromise
  closingPromise = (async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeFrontend()
    await pool.end()
  })()
  return closingPromise
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
      })
  })
}
