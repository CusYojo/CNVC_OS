import { Router } from 'express'
import { retrieveKnowledge } from '../services/ragService.js'
import { FLUE_BASE_URL } from '../config/agentRuntime.js'

// 内部端点：仅供 flue assistant agent 的 tools 回调（x-internal-secret 校验，不走用户 JWT）。
// 复用既有 RAG / PPT / 情报编排逻辑，让 agent 能自主调用这些能力。
export const internalRouter = Router()

const SECRET = process.env.INTERNAL_SECRET || 'cybernaut-internal-2026'

internalRouter.use((req, res, next) => {
  if (req.header('x-internal-secret') !== SECRET) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'bad internal secret' }); return
  }
  next()
})

// 1) 项目资料检索（RAG）
internalRouter.post('/search-docs', async (req, res, next) => {
  try {
    const { query, projectId, compareLeadPool } = req.body ?? {}
    let context = ''
    let sources: string[] = []
    let hasEvidence = false
    if (projectId) {
      const chunks = await retrieveKnowledge('project', projectId, query, 5)
      if (chunks.length) {
        hasEvidence = true
        context = chunks.map((c, i) => `【项目资料${i + 1}｜${c.fileName}】\n${c.content}`).join('\n\n')
        sources = [...new Set(chunks.map((c) => c.fileName))]
      }
    }
    if (compareLeadPool) {
      const leadChunks = await retrieveKnowledge('lead', undefined, query, 5)
      if (leadChunks.length) {
        hasEvidence = true
        const block = leadChunks.map((c, i) => `【线索池${i + 1}｜${c.fileName}】\n${c.content}`).join('\n\n')
        context = context ? `${context}\n\n=== 共有线索池（可比对参照） ===\n${block}` : block
        sources = [...new Set([...sources, ...leadChunks.map((c) => `线索池·${c.fileName}`)])]
      }
    }
    res.json({ hasEvidence, context, sources })
  } catch (err) { next(err) }
})

// 2) 情报采集 —— 调 flue intel-collect workflow
internalRouter.post('/collect-intel', async (req, res, next) => {
  try {
    const { company } = req.body ?? {}
    if (!company) { res.status(400).json({ code: 'INVALID_ARGUMENT', message: '缺少 company' }); return }
    const r = await fetch(`${FLUE_BASE_URL}/workflows/intel-collect?wait=result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company }), signal: AbortSignal.timeout(120000),
    })
    if (!r.ok) { res.json({ report: '' }); return }
    const d = await r.json() as { result?: unknown }
    const report = d.result ? (typeof d.result === 'string' ? d.result : JSON.stringify(d.result, null, 2)) : ''
    res.json({ report })
  } catch (err) { next(err) }
})
