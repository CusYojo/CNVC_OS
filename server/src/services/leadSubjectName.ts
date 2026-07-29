const SUBJECT_PLACEHOLDERS = new Set([
  '',
  '待核验',
  '待核实',
  '未披露',
  '未披露/待核实',
  '未披露/待验证',
  '未识别/待核实',
  '未命名项目',
  '主体待确认',
  '不适用',
  '无',
  '-',
  'N/A',
  'null',
])

const GENERIC_SUBJECTS = new Set([
  '人工智能',
  '大模型',
  '机器人',
  '新材料',
  '新能源',
  '项目',
  '团队',
  '研究团队',
  '实验室',
  '课题组',
  '相关项目',
  '某项目',
  '作者',
  '负责人',
])

const VAGUE_START_RE = /^(?:他|她|其|该|这|此|其中|上述|相关|目前|未来|同时|此外|另|据|对于|关于|要求|需要|应当|必须|支持|推动|加强|开展|主动|曾|曾经|担任|联创|联合创始人?|并|基于|后两年|共享|为|以|从|在|将|把|被|联合|面对|通过|围绕|聚焦|一是|二是|三是|四是)/
const VAGUE_BODY_RE = /(?:岗位记录|关键证明|证明材料|要求主动|主动适应|为核心业务|核心业务的|系统梳理|以及团队|进入导师课题组|共享两个学院|获颁|获评|荣获|获奖|荣誉|Award|等信息|等材料|等证明|等方面|等工作|带来的变化)/i
const VAGUE_END_RE = /(?:材料|记录|信息|情况|内容|要求|工作|方面|变化|问题|任务|路径|策略|证明)$/
const PREDICATE_RE = /(?:要求|适应|指出|表示|强调|认为|提出|推动|支持|开展|实现|完成|获得|发布|宣布|提供|形成|建立|构建|促进|提升|加强|记录|证明|担任|任职|毕业|来自|师从|进入|共享|梳理|发表|结合)/
const NUMBERED_TECH_FRAGMENT_RE = /^[\u4e00-\u9fffA-Za-z]{1,8}[-—–][\u4e00-\u9fffA-Za-z]{1,8}\d{1,2}$/
const GENERIC_INSTITUTION_TECH_RE = /^(?:清华|北大|北航|上交大|复旦|浙大|中科大|哈工大).*(?:机器人|芯片|人工智能|团队|项目)$/
const LOW_VALUE_RADAR_RE = /(?:院系之声.{0,30}(?:荣誉|获奖|Award)|(?:教授|研究员|学者).{0,30}(?:获颁|获评|荣获|获奖|Award|荣誉)|(?:获得|获评|入选|荣获).{0,24}(?:奖|荣誉|称号|教学团队)|(?:科学技术奖|科技奖|自然科学奖|技术发明奖|科技进步奖).{0,40}(?:揭晓|获奖|表彰)|\d+\s*项.{0,12}(?:获奖|获表彰)|(?:国家级|省级).{0,16}(?:教学团队|教学成果|荣誉|奖)|要报.{0,12}专业吗|招生(?:简章|宣传|咨询|专业|对象)?|培养方案|课程介绍|实验班介绍|研修班|培训班|结业证书|能力提升计划|名家面对面|学员企业|毕业典礼|毕业致辞|发表致辞|兼任|受聘|履新|任命|(?:记者|人物)?专访|人物访谈|观点访谈|深度解读|系统剖析)/i
const PURE_ACADEMIC_RADAR_RE = /(?:(?:课题组|团队|实验室).{0,100}(?:发表|论文|研究|揭示|破解|开发|发现|成果)|(?:学术成果|科研成果|研究进展|研究论文|最新研究|多项研究|两项研究).{0,100}(?:课题组|团队|教授|研究员|实验室|突破|发现|揭示|开发)?|(?:团队|课题组).{0,60}(?:算法|模型|数据|机制|通路|架构))/i
const COMMERCIAL_RADAR_RE = /(?:成果转化|技术转移|转化落地|产业化|中试|技术平台|工程化|技术许可|专利转让|孵化(?:成立|企业|公司)|创办公司|成立公司|产品获批|注册证|临床应用|应用新场景|示范应用|产业应用|客户验证|客户订单|采购|中标|签约|量产|营收|商业化)/i

function cleanSubjectName(value: unknown): string {
  return String(value ?? '')
    .replace(/^(?:群聊线索|项目线索|项目名称|主体名称)\s*[|｜:：]\s*/i, '')
    .trim()
    .replace(/^[“”"'「」『』\s]+|[“”"'「」『』\s]+$/g, '')
    .replace(/[，。！？；;：:,.\s]+$/g, '')
    .trim()
}

export function isSpecificLeadSubjectName(value: unknown, allowPaperTitle = false): boolean {
  const name = cleanSubjectName(value)
  if (!name || SUBJECT_PLACEHOLDERS.has(name)) return false
  if (allowPaperTitle) return name.length >= 2 && name.length <= 180
  if (name.length < 2 || name.length > 60) return false
  if (GENERIC_SUBJECTS.has(name)) return false
  if (NUMBERED_TECH_FRAGMENT_RE.test(name)) return false
  if (GENERIC_INSTITUTION_TECH_RE.test(name)) return false
  if (/[，。！？；;：:\n]/.test(name)) return false
  if (VAGUE_START_RE.test(name) || VAGUE_BODY_RE.test(name) || VAGUE_END_RE.test(name)) return false
  if (name.includes('等') && !/(?:邓|等等科技|等等智能)/.test(name)) return false
  if (PREDICATE_RE.test(name) && !/(?:公司|企业|项目|团队|实验室|研究院|研究中心|工程中心|课题组)$/.test(name)) return false
  if (name.length > 22 && /(?:的|了|是|与|及|以|在|为|将|把|被|对于|关于|之|正在)/.test(name)) return false
  return true
}

export function isLowValueRadarContent(...values: unknown[]): boolean {
  return values.some((value) => LOW_VALUE_RADAR_RE.test(String(value ?? '').slice(0, 2400)))
}

export function isNonInvestableRadarContent(input: {
  hasCompanySubject?: boolean
  hasInvestmentEvidence?: boolean
  values: unknown[]
}): boolean {
  if (input.hasCompanySubject || input.hasInvestmentEvidence) return false
  const text = input.values.map((value) => String(value ?? '').slice(0, 2400)).join('\n')
  if (LOW_VALUE_RADAR_RE.test(text)) return true
  return PURE_ACADEMIC_RADAR_RE.test(text) && !COMMERCIAL_RADAR_RE.test(text)
}

function splitCandidates(value: unknown): string[] {
  return String(value ?? '')
    .split(/[；;\n|｜]/)
    .map(cleanSubjectName)
    .filter(Boolean)
}

function extractNamedFragments(value: unknown): string[] {
  const text = String(value ?? '')
  const fragments: string[] = []
  const patterns = [
    /([\u4e00-\u9fffA-Za-z0-9（）()·&＋+\-]{2,80}(?:股份有限公司|有限责任公司|有限公司))/g,
    /((?:[\u4e00-\u9fff]{2,20}(?:大学|学院|研究所|医院))[\u4e00-\u9fff·]{0,16}(?:教授|研究员|博士)?团队)/g,
    /([\u4e00-\u9fffA-Za-z0-9·]{2,30}(?:重点实验室|实验室|研究中心|工程中心|研究院|课题组))/g,
    /([\u4e00-\u9fff·]{2,6}(?:教授|研究员|博士)?团队)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) fragments.push(cleanSubjectName(match[1]))
  }

  // “作者 | 张三：某大学某学院教授”类材料没有直接写“团队”，
  // 但可以安全地形成“机构 + 负责人 + 团队”主体，不再截取正文谓语片段。
  const authorPattern = /([\u4e00-\u9fff·]{2,4})\s*[：:]\s*([\u4e00-\u9fff]{2,24}(?:大学|学院|研究所|医院))/g
  for (const match of text.matchAll(authorPattern)) {
    fragments.push(`${cleanSubjectName(match[2])}${cleanSubjectName(match[1])}团队`)
  }
  return fragments
}

function extractPrimaryNewsSubjects(value: unknown): string[] {
  const text = String(value ?? '').slice(0, 1800)
  if (!text) return []
  const nameChars = String.raw`[\u4e00-\u9fffA-Za-z0-9（）()·&＋+\-]`
  const descriptor = String.raw`(?:${nameChars}{0,20}(?:企业|公司))?`
  const wrapperOpen = String.raw`[「『“"]?`
  const wrapperClose = String.raw`[」』”"]?`
  const event = String.raw`(?=(?:(?:近日|日前|近期)\s*)?(?:(?:连续|已|正式)\s*)*(?:宣布)?(?:完成|获得|获|成立于|是一家))`
  const patterns = [
    new RegExp(String.raw`(?:获悉|消息显示|公开信息显示)[，,\s]*(?:(?:近日|日前|近期)[，,\s]*)?${descriptor}\s*${wrapperOpen}(${nameChars}{2,40}?)${wrapperClose}\s*${event}`, 'g'),
    new RegExp(String.raw`(?:^|[。；;\n])\s*${descriptor}\s*${wrapperOpen}(${nameChars}{2,40}?)${wrapperClose}\s*${event}`, 'g'),
    new RegExp(String.raw`(?:^|[。；;\n])\s*(${nameChars}{2,30})(?=成立于|是一家|专注于|致力于)`, 'g'),
  ]
  const subjects: string[] = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = cleanSubjectName(match[1])
      if (isSpecificLeadSubjectName(candidate)) subjects.push(candidate)
    }
  }
  return subjects.filter((value, index, all) => all.indexOf(value) === index)
}

export interface RadarSubjectNameInput {
  isPaper?: boolean
  companyNames?: unknown[]
  projectName?: unknown
  lab?: unknown
  team?: unknown
  title?: unknown
  articleText?: unknown
  excludedNames?: unknown[]
}

export function deriveRadarSubjectName(input: RadarSubjectNameInput): string {
  const excluded = new Set((input.excludedNames ?? []).map(cleanSubjectName).filter(Boolean))
  const pick = (values: unknown[], allowPaperTitle = false, respectExcluded = true): string => {
    const candidates = values
      .flatMap((value) => [...splitCandidates(value), ...extractNamedFragments(value)])
      .filter((value, index, all) => all.indexOf(value) === index)
      .filter((value) => !respectExcluded || !excluded.has(value))
      .filter((value) => isSpecificLeadSubjectName(value, allowPaperTitle))
      .sort((left, right) => right.length - left.length)
    return candidates[0] ?? ''
  }

  const company = pick(input.companyNames ?? [], false, false)
  if (company) return company

  if (!input.isPaper) {
    const articleSubject = extractPrimaryNewsSubjects(input.articleText)[0]
    if (articleSubject) return articleSubject
  }

  const researchSubject = pick([input.lab, input.team])
  if (researchSubject) return researchSubject

  const project = pick([input.projectName], Boolean(input.isPaper), false)
  if (project) return project

  return pick([input.title], Boolean(input.isPaper))
}
