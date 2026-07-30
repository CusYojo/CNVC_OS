const COLLAPSED_WEB_FRAGMENT =
  /[^。！？；\n]*(?:\.{3}|…{1,3})\s*(?:展开|查看更多)[^。！？；\n]*[。！？；]?/gi
const SOURCE_REFERENCE_FRAGMENT =
  /(?:项目资料显示\s*[:：]\s*)?(?:原文链接|来源网址)\s*[:：]\s*https?:\/\/[^\s。；]+[。；]?/gi
const EVIDENCE_METADATA_LINE =
  /^(?:(?:证据属性|项目匹配|Q&A\s*分类|页面标题|发布主体|发布日期|访问日期|更新时间|内容指纹|项目大模型|来源网址|原文链接)\s*[:：]|发布日期待核验)/i
const CLIENT_DRAFT_LABEL =
  /(^|[。！？；\n]\s*)(?:判断|依据|影响[\/／]约束|待办)\s*[:：]\s*/g
const CLIENT_COLON_LABEL_NAMES = [
  '订单节奏',
  '订单情况',
  '订单结构',
  '交付节奏',
  '交付模式',
  '公司全称',
  '公司类型',
  '注册资本',
  '成立时间',
  '注册时间',
  '法定代表人',
  '企业发展阶段',
  '创始人',
  '管理团队',
  '公司地址',
  '注册地址',
  '地址',
  '经营范围',
  '一般项目',
  '主营业务',
  '商务团队',
  '核心团队',
  '财务情况',
  '收入',
  '收入情况',
  '收入结构',
  '收入模式',
  '客户结构',
  '客户情况',
  '客户进展',
  '商业模式',
  '产品进展',
  '技术路线',
  '融资情况',
  '融资进展',
  '财务投资机构',
  '现金流保障',
  '资金用途',
  '估值情况',
  '经营预测',
  '回报测算',
  '项目风险动态预警',
  '风险提示',
  '核心风险',
  '下一步安排',
  '下一步动作',
] as const
const CLIENT_COLON_LABEL = new RegExp(
  `(?:${CLIENT_COLON_LABEL_NAMES.join('|')})\\s*[:：]\\s*`,
  'g',
)
const INLINE_NUMBERED_SUBHEADING =
  /(^|[。！？；\n]\s*)(?:[（(]\s*[0-9a-zA-Z一二三四五六七八九十]+\s*[）)]|[0-9a-zA-Z一二三四五六七八九十]+\s*[、.．)）])\s*(?=[^。！？；\n])/g
const LEADING_ENUMERATOR =
  /^\s*(?:[（(]\s*[0-9a-zA-Z一二三四五六七八九十]+\s*[）)]|[0-9a-zA-Z一二三四五六七八九十]+\s*[、.．)）])\s*/
const LEADING_HEADING_BEFORE_ENUMERATOR =
  /^\s*(?:[0-9一二三四五六七八九十]+\s*[、.．)）]\s*)?[^。！？；：:\n]{2,24}\s+(?=(?:[（(]\s*[0-9a-zA-Z一二三四五六七八九十]+\s*[）)]|[0-9a-zA-Z一二三四五六七八九十]+\s*[、.．)）]))/

const COLON_LABEL_REWRITES: Record<string, string> = {
  订单节奏: '公司订单交付方面，',
  订单情况: '公司订单方面，',
  订单结构: '公司订单结构方面，',
  交付节奏: '公司交付方面，',
  交付模式: '公司采用',
  公司全称: '公司法律主体为',
  公司类型: '公司类型为',
  注册资本: '公司注册资本为',
  成立时间: '公司成立于',
  注册时间: '公司成立于',
  法定代表人: '公司法定代表人为',
  企业发展阶段: '公司目前',
  创始人: '公司创始人为',
  管理团队: '公司管理团队包括',
  公司地址: '公司注册地址为',
  注册地址: '公司注册地址为',
  地址: '公司注册地址为',
  经营范围: '公司经营范围包括',
  一般项目: '公司经营范围包括',
  主营业务: '公司主营业务为',
  商务团队: '公司商务团队现有',
  核心团队: '公司核心团队包括',
  财务情况: '公司财务方面，',
  收入: '公司收入主要来自',
  收入情况: '公司收入方面，',
  收入结构: '公司收入结构方面，',
  收入模式: '公司收入主要来自',
  客户结构: '公司客户结构方面，',
  客户情况: '公司客户方面，',
  客户进展: '公司客户拓展方面，',
  商业模式: '公司商业模式为',
  产品进展: '公司产品进展方面，',
  技术路线: '公司技术路线为',
  融资情况: '公司融资方面，',
  融资进展: '公司融资进展方面，',
  财务投资机构: '财务投资机构跟进方面，',
  现金流保障: '',
  资金用途: '本轮资金拟用于',
  估值情况: '公司估值方面，',
  经营预测: '公司经营预测显示，',
  回报测算: '项目回报测算显示，',
  项目风险动态预警: '该风控功能',
  风险提示: '项目主要风险在于',
  核心风险: '项目核心风险在于',
  下一步安排: '下一步建议',
  下一步动作: '下一步建议',
}

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
  CLIENT_DRAFT_LABEL.lastIndex = 0
  return CLIENT_DRAFT_LABEL.test(value)
}

export function containsInvestmentProposalColonLabel(value: string) {
  CLIENT_COLON_LABEL.lastIndex = 0
  return CLIENT_COLON_LABEL.test(value)
}

export function containsInvestmentProposalInlineSubheading(value: string) {
  INLINE_NUMBERED_SUBHEADING.lastIndex = 0
  return INLINE_NUMBERED_SUBHEADING.test(value)
}

function stripLeadingInlineSubheadings(value: string) {
  let text = value
  for (let pass = 0; pass < 5; pass += 1) {
    const next = text
      .replace(LEADING_HEADING_BEFORE_ENUMERATOR, '')
      .replace(LEADING_ENUMERATOR, '')
      .trimStart()
    if (next === text) break
    text = next
  }
  return text
}

function stripInlineNumberedSubheadings(value: string) {
  return value
    .split(/([。！？；\n])/)
    .map((part) => /^[。！？；\n]$/.test(part)
      ? part
      : stripLeadingInlineSubheadings(part))
    .join('')
}

function rewriteClientColonLabels(value: string) {
  let text = value.replace(
    /(^|[。！？；\n]\s*)财务情况\s*[:：]\s*(?:[（(]\s*[a-zA-Z]\s*[）)]\s*)?收入\s*[:：]\s*/g,
    '$1公司收入主要来自',
  )
  CLIENT_COLON_LABEL.lastIndex = 0
  text = text.replace(
    new RegExp(`(${CLIENT_COLON_LABEL_NAMES.join('|')})\\s*[:：]\\s*`, 'g'),
    (_match, label: string, offset: number, input: string) => {
      const prior = input.slice(0, offset).trimEnd()
      const separator = prior && !/[。！？；\n]$/.test(prior) ? '；' : ''
      return `${separator}${COLON_LABEL_REWRITES[label] ?? `${label}方面，`}`
    },
  )
  return text
}

export function sanitizeInvestmentProposalClientText(value: unknown) {
  let text = stripInlineNumberedSubheadings(
    withoutCollapsedWebFragments(String(value ?? '')),
  )
    .replace(/(^|[。！？；\n]\s*)项目资料显示\s*[:：]\s*/g, '$1')
  CLIENT_DRAFT_LABEL.lastIndex = 0
  text = text.replace(CLIENT_DRAFT_LABEL, (_match, prefix: string, offset: number) =>
    offset === 0 ? '' : prefix)
  text = text
    .replace(/\s+(?:依据|影响[\/／]约束|待办)\s*[:：]\s*/g, '；')
    .replace(/\n+(?:依据|影响[\/／]约束|待办)\s*[:：]\s*/g, '；')
  text = rewriteClientColonLabels(stripInlineNumberedSubheadings(text))
  return normalizeWhitespace(text)
    .replace(/([。！？；])\n+/g, '$1')
    .replace(/\n+/g, '；')
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
