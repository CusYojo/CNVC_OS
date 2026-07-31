import { sanitizeClientVisibleEvidenceWording } from './aiClientVisibleTextService.js'

const COLLAPSED_WEB_FRAGMENT =
  /[^。！？；\n]*(?:\.{3}|…{1,3})\s*(?:展开|查看更多)[^。！？；\n]*[。！？；]?/gi
const SOURCE_REFERENCE_FRAGMENT =
  /(?:项目资料显示\s*[:：]\s*)?(?:原文链接|来源网址)\s*[:：]\s*https?:\/\/[^\s。；]+[。；]?/gi
const EVIDENCE_METADATA_LINE =
  /^(?:(?:证据属性|项目匹配|Q&A\s*分类|页面标题|发布主体|发布日期|访问日期|更新时间|内容指纹|项目大模型|来源网址|原文链接)\s*[:：]|发布日期待核验)/i
const INVESTMENT_PROPOSAL_WEB_NAVIGATION_TERMS = [
  '首页',
  '权威榜',
  '价值榜',
  '行业数据',
  '产业图谱',
  '行业研究',
  '企业入驻',
  '小程序',
  '登录',
  '登入',
  '关注',
  '已关注',
] as const
const INVESTMENT_PROPOSAL_WEB_SECTION_ANCHORS = [
  '融资历史',
  '公司简介',
  '产品介绍',
  '业务介绍',
] as const
const CLIENT_DRAFT_LABEL =
  /(^|[。！？；\n]\s*)(?:判断|依据|影响[\/／]约束|待办)\s*[:：]\s*/g
const CLIENT_SOURCE_PROCESS_WORDING =
  /(?:项目资料(?:库)?|(?:当前|现有)资料|会议纪要(?:显示|列示|记载|提及)?|已取得材料|原始(?:文件|资料)(?:核验|复核)?|资料(?:显示|列示|记载|提及))/i
const CLIENT_AI_STYLE_BOILERPLATE =
  /(?:值得注意的是|需要指出的是|不难看出|由此可见|综上所述|总体来看|在此背景下|从长远来看|多维度赋能|全方位赋能|打造[^。；]{0,24}新范式|构建[^。；]{0,24}生态闭环|实现[^。；]{0,18}从[^。；]{1,18}到[^。；]{1,18}的跃升)/
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

function navigationTermHits(value: string) {
  return INVESTMENT_PROPOSAL_WEB_NAVIGATION_TERMS
    .filter((term) => value.includes(term))
    .length
}

export function containsInvestmentProposalPageChrome(value: string) {
  return /(?:innoHere|英诺嘿呀)/i.test(value) && navigationTermHits(value) >= 2
    || navigationTermHits(value) >= 5
}

export function stripInvestmentProposalPageChrome(value: unknown) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((rawLine) => {
      let line = rawLine.replace(/\s+/g, ' ').trim()
      if (!containsInvestmentProposalPageChrome(line)) return line
      const anchors = INVESTMENT_PROPOSAL_WEB_SECTION_ANCHORS
        .map((anchor) => ({ anchor, index: line.lastIndexOf(anchor) }))
        .filter((item) => item.index >= 0)
        .sort((left, right) => right.index - left.index)
      const lastAnchor = anchors[0]
      if (lastAnchor) {
        line = line.slice(lastAnchor.index + lastAnchor.anchor.length).trim()
      } else {
        const loginBoundary = Math.max(line.lastIndexOf('登录'), line.lastIndexOf('登入'))
        if (loginBoundary >= 0) line = line.slice(loginBoundary + 2).trim()
      }
      return line
        .replace(/^(?:关注|已关注|融资历史|公司简介|产品介绍|业务介绍)\s*/g, '')
        .trim()
    })
    .filter(Boolean)
    .join('\n')
}

export function containsInvestmentProposalWebArtifact(value: string) {
  COLLAPSED_WEB_FRAGMENT.lastIndex = 0
  SOURCE_REFERENCE_FRAGMENT.lastIndex = 0
  return COLLAPSED_WEB_FRAGMENT.test(value)
    || SOURCE_REFERENCE_FRAGMENT.test(value)
    || /(?:原文链接|来源网址)\s*[:：]/i.test(value)
    || containsInvestmentProposalPageChrome(value)
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

export function containsInvestmentProposalSourceProcessWording(value: string) {
  return CLIENT_SOURCE_PROCESS_WORDING.test(value)
}

export function containsInvestmentProposalAiStyleBoilerplate(value: string) {
  return CLIENT_AI_STYLE_BOILERPLATE.test(value)
}

function rewriteClientSourceProcessWording(value: string) {
  return value
    .replace(
      /本提案依据截至([^，；。]+?)当前项目资料库中已授权、可追溯的资料形成[；;]\s*关键结论须回到原始文件复核[。.]?/g,
      '本提案反映截至$1已确认的项目情况，供当前阶段审议使用。',
    )
    .replace(/(?:现有资料未提供|当前项目资料库未覆盖|项目资料库未覆盖)/g, '尚未明确')
    .replace(/当前资料不足以形成/g, '现阶段尚不能形成')
    .replace(/当前项目暂无相关资料[。.]?/g, '现阶段尚不能形成结论。')
    .replace(/已取得材料仅(?:显示|列示|记载|提及)/g, '现阶段仅能确认')
    .replace(/完成关键原始(?:文件|资料)核验/g, '完成关键事实核验')
    .replace(/(?:回到|依据|对照)?原始(?:文件|资料)(?:进行)?(?:核验|复核)/g, '完成专项核验')
    .replace(/原始(?:文件|资料)/g, '关键文件')
    .replace(/(?:基于|根据)(?:截至[^，；。]+)?(?:当前)?项目资料(?:库)?[，,]?/g, '')
    .replace(
      /(?:当前项目资料(?:库)?|项目资料(?:库)?|现有资料|当前资料|会议纪要)(?:中)?(?:显示|列示|记载|提及|表明|说明)(?:的)?[，,:：]?/g,
      '',
    )
    .replace(/资料(?:显示|列示|记载|提及)(?:的)?[，,:：]?/g, '')
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
    withoutCollapsedWebFragments(stripInvestmentProposalPageChrome(
      rewriteClientSourceProcessWording(sanitizeClientVisibleEvidenceWording(value)),
    )),
  )
    .replace(/(^|[。！？；\n]\s*)项目资料显示\s*[:：]\s*/g, '$1')
  CLIENT_DRAFT_LABEL.lastIndex = 0
  text = text.replace(CLIENT_DRAFT_LABEL, (_match, prefix: string, offset: number) =>
    offset === 0 ? '' : prefix)
  text = text
    .replace(/\s+(?:依据|影响[\/／]约束|待办)\s*[:：]\s*/g, '；')
    .replace(/\n+(?:依据|影响[\/／]约束|待办)\s*[:：]\s*/g, '；')
  text = rewriteClientColonLabels(stripInlineNumberedSubheadings(text))
  return rewriteClientSourceProcessWording(
    sanitizeClientVisibleEvidenceWording(normalizeWhitespace(text)),
  )
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
      const bodyLine = stripInvestmentProposalPageChrome(
        line.replace(/^页面正文摘录\s*[:：]\s*/i, '').trim(),
      )
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

const PRODUCT_FORM =
  /(?:[A-Za-z][A-Za-z0-9.+/_ -]{1,30}|[\u3400-\u9fffA-Za-z0-9.+/_ -]{2,32})(?:平台|系统|引擎|模型|算法|框架|软件|硬件|机器人|芯片|设备)/
const PRODUCT_TECHNOLOGY =
  /(?:模型|算法|框架|架构|多模态|视觉|推理|训练|蒸馏|参数|数据集|API|SDK|传感|控制|编译|知识产权|专利|软件著作权)/i
const PRODUCT_MATURITY =
  /(?:上线|发布|内测|研发中|迭代|训练完成|商业化|落地|交付|部署|用户|客户|认证|测试)/
const PRODUCT_SECTION_BOUNDARY =
  /(?:^|\s)(?:\d+\s*)?(?:四、|五、|六、|（\s*[五六七八九十]\s*）)\s*(?:智灵)?(?:融资|交易|风险|其他|财务|运营)/

function normalizeProductEvidenceSpacing(value: string) {
  let text = value
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')
    .replace(/\s*\/\s*/g, '/')
    .replace(/(\d)\s+([万亿%])/g, '$1$2')
    .replace(/\s+([，。！？；：])/g, '$1')
    .replace(/([，。！？；：])\s+/g, '$1')
  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
  }
  return text.trim()
}

function cleanProductEvidenceSentence(value: string) {
  let text = value
    .replace(/^.*?技术体系与产品矩阵\s*/i, '')
    .replace(/^.*?其他成熟产品\s*/i, '')
    .replace(/^\s*(?:[（(]\s*[0-9一二三四五六七八九十]+\s*[）)]|[0-9一二三四五六七八九十]+\s*[、.．)）])\s*/, '')
    .replace(/^(?:顶层|中层|底层)\s*[:：]\s*/, '')
    .replace(
      /^((?:[A-Za-z][A-Za-z0-9.+/_ -]{1,30}|[\u3400-\u9fffA-Za-z0-9.+/_ -]{2,32})(?:平台|系统|引擎|模型|算法|框架|软件|硬件|机器人|芯片|设备))\s*[:：]\s*/,
      '$1',
    )
    .replace(/\s+作为/g, '作为')
    .replace(/\s+该(平台|系统|引擎|模型|算法|框架)/g, '，该$1')
    .replace(/(?:先进的|强大的)/g, '')
    .replace(/[，,]\s*综合性能超越[^；。]+/g, '')
    .trim()
  text = sanitizeInvestmentProposalClientText(text)
  return normalizeProductEvidenceSpacing(text
    .replace(/^[；，,\s]+|[；，,\s]+$/g, '')
    .replace(/[。！？；;]+$/, '')
    .trim())
}

function productEvidenceEntries(value: unknown) {
  let content = sanitizeInvestmentProposalEvidenceContent(value, 8000)
    .replace(/\s+/g, ' ')
  const productSectionStart = content.search(/(?:技术体系与产品矩阵|产品与技术矩阵|产品技术矩阵)/)
  if (productSectionStart >= 0) content = content.slice(productSectionStart)
  content = content.replace(PRODUCT_SECTION_BOUNDARY, '。')
  return content
    .split(/(?<=[。！？；;])|(?=[（(]\s*[0-9一二三四五六七八九十]+\s*[）)])/)
    .map((raw, order) => {
      const text = cleanProductEvidenceSentence(raw)
      const product = text.match(PRODUCT_FORM)?.[0] ?? ''
      const layer = /顶层\s*[:：]/.test(raw)
        ? 'top'
        : /中层\s*[:：]/.test(raw)
          ? 'middle'
          : /底层\s*[:：]/.test(raw)
            ? 'bottom'
            : ''
      const score = (product ? 5 : 0)
        + (PRODUCT_TECHNOLOGY.test(text) ? 3 : 0)
        + (PRODUCT_MATURITY.test(text) ? 2 : 0)
      return { raw, text, product, layer, score, order }
    })
    .filter((item) =>
      item.text.length >= 12
      && item.text.length <= 420
      && item.score >= 3
      && !containsInvestmentProposalPageChrome(item.text))
}

export function summarizeInvestmentProposalProductEvidence(value: unknown) {
  const entries = productEvidenceEntries(value)
  const paragraphs: string[] = []
  const layerEntries = ['top', 'middle', 'bottom']
    .flatMap((layer) => {
      const entry = entries.find((item) => item.layer === layer)
      return entry ? [entry] : []
    })
  if (layerEntries.length >= 2) {
    const layerNames: Record<string, string> = {
      top: '顶层采用',
      middle: '中层采用',
      bottom: '底层为',
    }
    paragraphs.push(sanitizeInvestmentProposalClientText(
      `公司的三层技术架构中，${layerEntries
        .map((item) => `${layerNames[item.layer]}${item.text}`)
        .join('；')}。`,
    ))
  }

  const products: string[] = []
  entries
    .filter((item) => !item.layer && item.product)
    .sort((left, right) => left.order - right.order)
    .forEach((item) => {
      const key = item.product.replace(/\s+/g, '').toLowerCase()
      if (products.some((existing) =>
        existing.replace(/\s+/g, '').toLowerCase().includes(key))) return
      products.push(item.text)
    })
  if (products.length) {
    paragraphs.push(sanitizeInvestmentProposalClientText(
      `公司产品包括${products.slice(0, 5).join('；')}。`,
    ))
  }

  if (!paragraphs.length) {
    entries
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .slice(0, 2)
      .forEach((item) => paragraphs.push(sanitizeInvestmentProposalClientText(item.text)))
  }
  return [...new Set(paragraphs)]
    .map((paragraph) =>
      normalizeProductEvidenceSpacing(paragraph.replace(/。{2,}/g, '。').trim()))
    .filter((paragraph) => paragraph.length >= 12)
    .slice(0, 3)
}
