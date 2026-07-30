const COLLAPSED_WEB_FRAGMENT =
  /[^。！？；\n]*(?:\.{3}|…{1,3})\s*(?:展开|查看更多)[^。！？；\n]*[。！？；]?/gi
const SOURCE_REFERENCE_FRAGMENT =
  /(?:项目资料显示\s*[:：]\s*)?(?:原文链接|来源网址)\s*[:：]\s*https?:\/\/[^\s。；]+[。；]?/gi
const EVIDENCE_METADATA_LINE =
  /^(?:(?:证据属性|项目匹配|Q&A\s*分类|页面标题|发布主体|发布日期|访问日期|更新时间|内容指纹|项目大模型|来源网址|原文链接)\s*[:：]|发布日期待核验)/i
const CLIENT_PROSE_LABEL =
  /(^|[。！？；\n]\s*)(?:判断|依据|影响[\/／]约束|待办)\s*[:：]\s*/g

function normalizeWhitespace(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/[；;]\s*[；;]/g, '；')
    .replace(/^[；;，,\s]+|[；;，,\s]+$/g, '')
    .trim()
}

function withoutCollapsedWebFragments(value: string) {
  COLLAPSED_WEB_FRAGMENT.lastIndex = 0
  SOURCE_REFERENCE_FRAGMENT.lastIndex = 0
  return value
    .replace(COLLAPSED_WEB_FRAGMENT, ' ')
    .replace(SOURCE_REFERENCE_FRAGMENT, ' ')
}

export function containsInvestmentProposalWebArtifact(value: string) {
  COLLAPSED_WEB_FRAGMENT.lastIndex = 0
  SOURCE_REFERENCE_FRAGMENT.lastIndex = 0
  return COLLAPSED_WEB_FRAGMENT.test(value)
    || SOURCE_REFERENCE_FRAGMENT.test(value)
    || /(?:原文链接|来源网址)\s*[:：]/i.test(value)
}

export function containsInvestmentProposalProseLabel(value: string) {
  CLIENT_PROSE_LABEL.lastIndex = 0
  return CLIENT_PROSE_LABEL.test(value)
}

export function sanitizeInvestmentProposalClientText(value: unknown) {
  let text = withoutCollapsedWebFragments(String(value ?? ''))
    .replace(/(^|[。！？；\n]\s*)项目资料显示\s*[:：]\s*/g, '$1')
  CLIENT_PROSE_LABEL.lastIndex = 0
  text = text.replace(CLIENT_PROSE_LABEL, (_match, prefix: string, offset: number) =>
    offset === 0 ? '' : prefix)
  text = text
    .replace(/\s+(?:依据|影响[\/／]约束|待办)\s*[:：]\s*/g, '；')
    .replace(/\n+(?:依据|影响[\/／]约束|待办)\s*[:：]\s*/g, '；')
  return normalizeWhitespace(text)
}

function boundedAtCompleteBoundary(value: string, maxCharacters: number) {
  if (value.length <= maxCharacters) return value
  const candidate = value.slice(0, maxCharacters + 1)
  const boundary = Math.max(
    candidate.lastIndexOf('\n'),
    candidate.lastIndexOf('。'),
    candidate.lastIndexOf('！'),
    candidate.lastIndexOf('？'),
    candidate.lastIndexOf('；'),
  )
  if (boundary >= Math.floor(maxCharacters * 0.55)) {
    return candidate.slice(0, boundary + 1).trim()
  }
  // 找不到完整语义边界时保留完整值，避免把长地址、经营范围或技术字段截断。
  return value
}

export function sanitizeInvestmentProposalEvidenceContent(
  value: unknown,
  maxCharacters = 1800,
) {
  const lines = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .flatMap((rawLine) => {
      const line = rawLine.replace(/\s+/g, ' ').trim()
      if (!line) return []
      const bodyLine = line.replace(/^页面正文摘录\s*[:：]\s*/i, '').trim()
      if (
        EVIDENCE_METADATA_LINE.test(line)
        || containsInvestmentProposalWebArtifact(bodyLine)
        || /^(?:查看更多|查看地图|短信验证码|发送验证码)\b/i.test(bodyLine)
      ) return []
      return bodyLine ? [bodyLine] : []
    })
  return boundedAtCompleteBoundary(
    normalizeWhitespace([...new Set(lines)].join('\n')),
    maxCharacters,
  )
}
