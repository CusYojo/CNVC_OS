import { redactSensitiveText } from '../security/redactSecrets.js'

export type RadarRunAction = 'auto' | 'paper-daily' | 'wechat-daily' | 'wechat-retry' | 'wechat-institution'

const ACTION_LABELS: Record<RadarRunAction, string> = {
  auto: '公共数据源采集',
  'paper-daily': '论文数据源采集',
  'wechat-daily': '公众号日采集',
  'wechat-retry': '公众号失败重试',
  'wechat-institution': '机构公众号补采',
}

function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function safeErrorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : error)
    .replace(/\b(credential|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 500)
}

export function summarizeRadarSourceRun(
  action: RadarRunAction,
  result?: Record<string, unknown>,
  error?: unknown,
) {
  const safeError = error ? safeErrorText(error) : ''
  const metrics = {
    fetched: count(result?.fetched),
    retained: count(result?.retained),
    written: count(result?.written),
    sources: count(result?.accounts) || listLength(result?.source_results),
    errors: listLength(result?.errors) || listLength(result?.error_samples),
    skipped: result?.skipped === true,
  }
  const status = safeError ? 'failed' as const : metrics.errors > 0 ? 'partial' as const : 'succeeded' as const
  const headline = `[数据源监控] ${ACTION_LABELS[action]}${status === 'failed' ? '失败' : status === 'partial' ? '部分成功' : '成功'}`
  const lines = metrics.skipped
    ? [headline, `- 已跳过：${String(result?.reason || '当前无待处理数据')}`]
    : [
        headline,
        `- 抓取 ${metrics.fetched} 条，保留 ${metrics.retained} 条，写入 ${metrics.written} 条`,
        `- 数据源/账号 ${metrics.sources} 个，异常 ${metrics.errors} 个`,
      ]
  if (safeError) lines.push(`- 错误：${safeError}`)
  return { action, label: ACTION_LABELS[action], status, metrics, error: safeError, message: lines.join('\n').slice(0, 4_000) }
}
