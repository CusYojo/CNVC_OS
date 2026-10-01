export type JwAgentResponseMode = 'standard' | 'compact'

export function compactJwAgentThinkingConfig(model: string, mode: JwAgentResponseMode) {
  if (mode !== 'compact') return undefined
  const normalizedModel = model.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalizedModel.startsWith('doubaoseed20mini')
    ? { type: 'disabled' as const }
    : undefined
}

const COMPACT_READ_TOOLS = new Set([
  'mcp__investment__search_project_docs',
  'mcp__investment__get_project_summary',
  'mcp__investment__list_project_files',
  'mcp__investment__read_project_file',
  'mcp__investment__collect_public_intel',
])

export function jwAgentToolsForResponseMode<T extends string>(
  toolNames: readonly T[],
  mode: JwAgentResponseMode,
): T[] {
  return mode === 'compact'
    ? toolNames.filter((name) => COMPACT_READ_TOOLS.has(name))
    : [...toolNames]
}

export function compactJwAgentInstruction(projectScoped: boolean): string {
  return [
    '当前是小赛轻量快响应模式。用户提交需求后，必须优先使用现有授权信息完成，不得用空泛确认、重复问题或长时间规划代替有效结果。',
    projectScoped
      ? '对项目问题先读取项目主记录；只在问题确实依赖材料证据时再检索或读取文件，不做无目的全量遍历。'
      : '对全局问题使用当前会话和已授权信息直接回答，不主动要求绑定项目。',
    '只有缺少某个关键条件会导致结论误导时，才可以进行最多一次补充信息；该次只提一个合并问题。用户回答后不得再次追问，剩余缺口应作为限制条件明确列出。',
    '首个答案直接回应用户目标。涉及事实判断时说明依据或缺口，涉及行动时给出可执行的下一步；用户要求一句话或简单操作时保持简短。能用当前信息回答就直接回答。',
    '本模式不创建 AI 文档任务、不提交业务写入、不执行 Agent 演化；如用户需要这些操作，给出准备清单并引导到完整 AI 助手。',
  ].join('\n')
}

export function evaluateCompactInteraction(questionCount: number, usedRounds: number): {
  allowed: boolean
  nextUsedRounds: number
  reason: string | null
} {
  const normalizedUsedRounds = Math.max(0, Math.trunc(usedRounds))
  if (questionCount !== 1) {
    return {
      allowed: false,
      nextUsedRounds: normalizedUsedRounds,
      reason: '请把关键缺口合并为一个问题，或基于合理假设直接完成。',
    }
  }
  if (normalizedUsedRounds >= 1) {
    return {
      allowed: false,
      nextUsedRounds: normalizedUsedRounds,
      reason: '本轮已完成一次信息补充，请基于现有信息给出结果并明确剩余缺口。',
    }
  }
  return { allowed: true, nextUsedRounds: 1, reason: null }
}
