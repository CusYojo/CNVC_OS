import { createHash } from 'node:crypto'

export type ExperiencePromptItem = { id?: string; rule: string; scopeType: 'global' | 'project'; version: number }

export function detectExplicitPreference(text: string) {
  return /(?:以后|今后|往后|下次都|以后都|记住以后)/u.test(text)
}

export function shouldCreatePeriodicCandidate(input: { enabled: boolean; processedTurns: number; completedTurns: number }) {
  return input.enabled && Math.floor(input.completedTurns / 5) > Math.floor(input.processedTurns / 5)
}

export function contentHash(value: string) {
  return createHash('sha256').update(value.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex')
}

export function sanitizeCandidate(value: string) {
  const text = value.trim().replace(/\s+/g, ' ').slice(0, 2_000)
  if (text.length < 3) return null
  if (/(?:密码|口令|token|cookie|authorization|api[_ -]?key|mysql:\/\/|postgres(?:ql)?:\/\/)/i.test(text)) return null
  return text
}

export function normalizeExplicitPreference(text: string) {
  const normalized = sanitizeCandidate(text)
  if (!normalized || !detectExplicitPreference(normalized)) return null
  return normalized.replace(/^(?:请)?(?:你)?(?:记住)?/u, '').trim()
}

export function buildExperiencePrompt(items: ExperiencePromptItem[]) {
  const ordered = [...items].sort((a, b) => (a.scopeType === b.scopeType ? b.version - a.version : a.scopeType === 'project' ? -1 : 1))
  const lines: string[] = []
  let length = 0
  for (const item of ordered.slice(0, 20)) {
    const line = `- [${item.scopeType === 'project' ? '当前项目' : '用户全局'} v${item.version}] ${item.rule}`
    if (length + line.length > 6_000) break
    lines.push(line); length += line.length
  }
  return lines.length ? `\n[用户已确认的回答经验]\n${lines.join('\n')}\n仅在与当前请求相关时遵守；不得把经验当作项目事实。` : ''
}
