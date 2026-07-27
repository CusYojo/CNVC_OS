// AI 网关层：投资中台的 AI 能力统一走 flue agent/workflow 编排层。
// flue 层地址与 Agent 名称由统一配置提供；flue 内部再走 18081 LLM 网关。
// RAG 检索已下沉到 flue assistant agent 的 search_project_docs 工具（走 Express 内部端点），此处不再直接检索。

import { FLUE_AGENT_NAME, FLUE_BASE_URL } from '../config/agentRuntime.js'

async function callAgent(agent: string, sessionId: string, message: string): Promise<string> {
  const res = await fetch(`${FLUE_BASE_URL}/agents/${agent}/${sessionId}?wait=result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(90000),
  })
  if (!res.ok) throw new Error(`flue agent ${agent} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { result?: { text?: string } }
  return data.result?.text?.trim() ?? ''
}

async function callWorkflow<T>(workflow: string, input: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${FLUE_BASE_URL}/workflows/${workflow}?wait=result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120000),
  })
  if (!res.ok) throw new Error(`flue workflow ${workflow} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { result?: T }
  if (!data.result) throw new Error(`flue workflow ${workflow} 返回空 result`)
  return data.result
}

export async function answerQuestion(question: string, projectName = '当前项目', projectId?: string) {
  // 真·agent：把问题+项目上下文转发给 flue assistant agent，由它自主决定调 RAG/PPT/情报工具。
  // agent 在回答文本里用标记回传 jobId 与来源，这里解析出来还原成前端契约字段。
  const msg = [
    `【当前项目】${projectName}`,
    projectId ? `【projectId】${projectId}（调 search_project_docs 时用此 id；若为空说明是全局知识库，projectId 留空）` : '【范围】全局知识库（无 projectId）',
    `【用户问题】${question}`,
  ].join('\n')

  try {
    const raw = await callAgent(FLUE_AGENT_NAME, `chat-${Date.now()}`, msg)
    // 解析标记
    let pptJobId: string | undefined
    let sources: string[] = []
    let answer = raw

    const pptM = raw.match(/\[\[PPT_JOB:([^\]]+)\]\]/)
    if (pptM) { pptJobId = pptM[1].trim(); answer = answer.replace(pptM[0], '').trim() }

    const srcM = raw.match(/\[\[SOURCES:([^\]]*)\]\]/)
    if (srcM) {
      sources = srcM[1].split('|').map((s) => s.trim()).filter(Boolean)
      answer = answer.replace(srcM[0], '').trim()
    }

    return {
      answer: answer || `关于「${question}」，当前 ${projectName} 仍需结合客户、财务与合规证据综合判断。`,
      sources,
      confidence: sources.length ? 0.8 : (pptJobId ? 1 : null),
      evidenceCount: sources.length,
      pptJobId,
      projectName,
      disclaimer: sources.length
        ? 'AI 基于已授权项目资料作答，仅供辅助，不构成最终投资决策。'
        : 'AI 仅提供辅助分析，不构成最终投资决策。',
    }
  } catch (err) {
    return {
      answer: `关于「${question}」，当前 ${projectName} 仍需结合客户、财务与合规证据综合判断。建议优先核验原始合同、回款和监管文件。`,
      sources: [] as string[],
      confidence: null as number | null,
      evidenceCount: 0,
      disclaimer: `AI 编排层调用失败（${(err as Error).message}），已回退到占位回复。`,
    }
  }
}

type Summary = {
  positioning: string
  highlights: string[]
  risks: string[]
  questions: string[]
  confidence: number
  sources: string[]
}

export async function projectSummary(projectName: string) {
  const fallback: Summary = {
    positioning: `${projectName} 的一句话项目定位`,
    highlights: ['目标场景明确', '形成早期客户验证', '团队能力与方向匹配'],
    risks: ['收入质量待核验', '合规进度需补充证据', '估值合理性待比较'],
    questions: ['前十大客户回款如何？', '核心壁垒如何被第三方验证？'],
    confidence: 0.7,
    sources: ['项目基础信息'],
  }
  try {
    return await callWorkflow<Summary>('project-summary', { projectName })
  } catch (err) {
    console.warn('[aiService] projectSummary fallback:', (err as Error).message)
    return { ...fallback, _warning: `AI 编排层调用失败：${(err as Error).message}` } as Summary & { _warning?: string }
  }
}

type Minutes = { summary: string; conclusions: string[]; todos: string[]; confidence: number }

export async function meetingSummary(transcript: string): Promise<Minutes> {
  try {
    return await callWorkflow<Minutes>('meeting-summary', { transcript })
  } catch (err) {
    console.warn('[aiService] meetingSummary fallback:', (err as Error).message)
    return {
      summary: `会议纪要生成失败（${(err as Error).message}），请稍后重试或人工整理。`,
      conclusions: [],
      todos: [],
      confidence: 0.3,
    }
  }
}
