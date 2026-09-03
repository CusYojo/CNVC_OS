const REGION_PLACEHOLDERS = new Set([
  '',
  '待确认',
  '待核验',
  '待核实',
  '未披露',
  '未披露/待核实',
  '未披露/待验证',
  '不适用',
  '无',
  '-',
  'N/A',
  'null',
])

export const BUSINESS_REGIONS = [
  '北京', '上海', '天津', '重庆',
  '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '广西', '海南',
  '四川', '贵州', '云南', '西藏', '陕西', '甘肃',
  '青海', '宁夏', '新疆', '香港', '澳门', '台湾',
] as const

export type BusinessRegion = typeof BUSINESS_REGIONS[number]
export type RegionConfidence = '高' | '中'

export interface LeadRegionResolution {
  region: BusinessRegion
  source: string
  confidence: RegionConfidence
}

export function businessRegionStorageAliases(region: BusinessRegion): string[] {
  if (['北京', '上海', '天津', '重庆'].includes(region)) return [region, `${region}市`]
  if (region === '内蒙古') return [region, '内蒙古自治区']
  if (region === '广西') return [region, '广西壮族自治区']
  if (region === '西藏') return [region, '西藏自治区']
  if (region === '宁夏') return [region, '宁夏回族自治区']
  if (region === '新疆') return [region, '新疆维吾尔自治区']
  if (region === '香港') return [region, '香港特别行政区']
  if (region === '澳门') return [region, '澳门特别行政区']
  if (region === '台湾') return [region, '台湾省']
  return [region, `${region}省`]
}

const REGION_ALIASES: Array<[BusinessRegion, RegExp]> = [
  ['北京', /北京|北京市/],
  ['上海', /上海|上海市/],
  ['天津', /天津|天津市/],
  ['重庆', /重庆|重庆市/],
  ['河北', /河北|石家庄|唐山|保定|廊坊|雄安|秦皇岛|邯郸|沧州|承德|衡水|邢台/],
  ['山西', /山西|太原|大同|长治|晋城|晋中|运城|临汾|吕梁|忻州|朔州|阳泉/],
  ['内蒙古', /内蒙古|呼和浩特|包头|鄂尔多斯|赤峰|通辽|呼伦贝尔|乌海/],
  ['辽宁', /辽宁|沈阳|大连|鞍山|抚顺|本溪|丹东|锦州|营口|盘锦/],
  ['吉林', /吉林|长春|延边|四平|辽源|通化|白山|松原|白城/],
  ['黑龙江', /黑龙江|哈尔滨|齐齐哈尔|大庆|牡丹江|佳木斯|绥化|黑河/],
  ['江苏', /江苏|南京|苏州|无锡|常州|南通|扬州|镇江|泰州|盐城|徐州|淮安|连云港|宿迁|常熟|昆山|江阴|张家港/],
  ['浙江', /浙江|杭州|宁波|温州|嘉兴|湖州|绍兴|金华|衢州|舟山|台州|丽水|义乌|余杭|滨江|萧山/],
  ['安徽', /安徽|合肥|芜湖|蚌埠|淮南|马鞍山|淮北|铜陵|安庆|黄山|滁州|阜阳|宿州|六安|亳州|池州|宣城/],
  ['福建', /福建|福州|厦门|泉州|漳州|莆田|三明|南平|龙岩|宁德/],
  ['江西', /江西|南昌|九江|赣州|景德镇|萍乡|新余|鹰潭|吉安|宜春|抚州|上饶/],
  ['山东', /山东|济南|青岛|淄博|枣庄|东营|烟台|潍坊|济宁|泰安|威海|日照|临沂|德州|聊城|滨州|菏泽/],
  ['河南', /河南|郑州|开封|洛阳|平顶山|安阳|鹤壁|新乡|焦作|濮阳|许昌|漯河|三门峡|南阳|商丘|信阳|周口|驻马店/],
  ['湖北', /湖北|武汉|黄石|十堰|宜昌|襄阳|鄂州|荆门|孝感|荆州|黄冈|咸宁|随州/],
  ['湖南', /湖南|长沙|株洲|湘潭|衡阳|邵阳|岳阳|常德|张家界|益阳|郴州|永州|怀化|娄底|湘西/],
  ['广东', /广东|广州|深圳|珠海|汕头|佛山|韶关|湛江|肇庆|江门|茂名|惠州|梅州|汕尾|河源|阳江|清远|东莞|中山|潮州|揭阳|云浮|南沙|前海/],
  ['广西', /广西|南宁|柳州|桂林|梧州|北海|防城港|钦州|贵港|玉林|百色|贺州|河池|来宾|崇左/],
  ['海南', /海南|海口|三亚|三沙|儋州/],
  ['四川', /四川|成都|自贡|攀枝花|泸州|德阳|绵阳|广元|遂宁|内江|乐山|南充|眉山|宜宾|广安|达州|雅安|巴中|资阳/],
  ['贵州', /贵州|贵阳|六盘水|遵义|安顺|毕节|铜仁|黔西南|黔东南|黔南/],
  ['云南', /云南|昆明|曲靖|玉溪|保山|昭通|丽江|普洱|临沧|楚雄|红河|文山|西双版纳|大理|德宏|怒江|迪庆/],
  ['西藏', /西藏|拉萨|日喀则|昌都|林芝|山南|那曲|阿里/],
  ['陕西', /陕西|西安|铜川|宝鸡|咸阳|渭南|延安|汉中|榆林|安康|商洛/],
  ['甘肃', /甘肃|兰州|嘉峪关|金昌|白银|天水|武威|张掖|平凉|酒泉|庆阳|定西|陇南/],
  ['青海', /青海|西宁|海东|海北|黄南|海南州|果洛|玉树|海西/],
  ['宁夏', /宁夏|银川|石嘴山|吴忠|固原|中卫/],
  ['新疆', /新疆|乌鲁木齐|克拉玛依|吐鲁番|哈密|昌吉|博尔塔拉|巴音郭楞|阿克苏|克孜勒苏|喀什|和田|伊犁|塔城|阿勒泰/],
  ['香港', /香港/],
  ['澳门', /澳门/],
  ['台湾', /台湾|台北|新北|桃园|台中|台南|高雄|新竹/],
]

const INSTITUTION_REGIONS: Array<[BusinessRegion, RegExp]> = [
  ['北京', /清华大学|北京大学|北京航空航天大学|北京理工大学|中国人民大学|北京师范大学|中国科学院大学|中关村/],
  ['上海', /复旦大学|同济大学|华东师范大学|上海交通大学|上海交大|上海科技大学|紫竹高新区|张江/],
  ['浙江', /浙江大学|浙大|西湖大学|之江实验室|良渚实验室/],
  ['江苏', /南京大学|东南大学|南京航空航天大学|南京理工大学|苏州大学|江南大学/],
  ['安徽', /中国科学技术大学|中科大|合肥工业大学/],
  ['湖北', /武汉大学|华中科技大学|华中农业大学|武汉理工大学/],
  ['湖南', /中南大学|湖南大学|国防科技大学/],
  ['广东', /中山大学|华南理工大学|南方科技大学|深圳大学|香港中文大学（深圳）/],
  ['四川', /四川大学|电子科技大学|西南交通大学/],
  ['陕西', /西安交通大学|西北工业大学|西安电子科技大学/],
  ['天津', /天津大学|南开大学/],
  ['重庆', /重庆大学|西南大学/],
  ['福建', /厦门大学|福州大学/],
  ['山东', /山东大学|中国海洋大学/],
  ['辽宁', /大连理工大学|东北大学/],
  ['吉林', /吉林大学/],
  ['黑龙江', /哈尔滨工业大学|哈工大/],
]

const meaningfulRegionText = (value: unknown): string => {
  const text = String(value ?? '').trim()
  return text && !REGION_PLACEHOLDERS.has(text) ? text : ''
}

export function normalizeBusinessRegion(value: unknown): BusinessRegion | undefined {
  const text = meaningfulRegionText(value)
  if (!text) return undefined
  return REGION_ALIASES.find(([, pattern]) => pattern.test(text))?.[0]
}

function institutionRegion(value: unknown): BusinessRegion | undefined {
  const text = meaningfulRegionText(value)
  if (!text) return undefined
  return normalizeBusinessRegion(text)
    ?? INSTITUTION_REGIONS.find(([, pattern]) => pattern.test(text))?.[0]
}

function leadingRegion(value: unknown): BusinessRegion | undefined {
  const text = meaningfulRegionText(value)
  if (!text) return undefined
  return REGION_ALIASES.find(([, pattern]) => text.match(pattern)?.index === 0)?.[0]
}

function subjectAdministrativeRegion(value: unknown): BusinessRegion | undefined {
  const text = meaningfulRegionText(value)
  if (!text) return undefined
  // A city name inside a person/team label is not location evidence. Legal entities and
  // concrete projects may still use an administrative prefix (for example 武汉某某有限公司).
  if (/(?:创始人|联合创始人|负责人|教授|博士|先生|女士|团队|课题组)$/.test(text)
    && !/(?:公司|企业|项目|研究院|研究所|实验室)/.test(text)) return undefined
  return leadingRegion(text)
}

function explicitLocationRegion(subjects: unknown[], ...values: unknown[]): BusinessRegion | undefined {
  const subjectTokens = subjects
    .map((value) => meaningfulRegionText(value))
    .filter((value) => value.length >= 2)
    .flatMap((value) => [
      value,
      value.replace(/(?:股份有限公司|有限责任公司|有限公司|公司|企业|项目|团队|实验室|研究院|研究所|研究中心)$/, ''),
    ])
    .filter((value, index, all) => value.length >= 2 && all.indexOf(value) === index)
  const patterns = [
    /(?:注册地|注册地址|工商注册地址|注册于|注册在|总部所在地|总部位于|总部设于|总部设在|公司所在地|公司位于|企业所在地|企业位于|公司落户|企业落户|项目所在地|项目位于|项目落地于|项目落户|基地所在地|基地位于|基地落地于|坐落于)\s*[：:为在]?\s*([^，。；;\n]{2,48})/g,
  ]
  for (const value of values) {
    const text = meaningfulRegionText(value).slice(0, 12000)
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const matchIndex = match.index ?? 0
        const context = text.slice(Math.max(0, matchIndex - 160), Math.min(text.length, matchIndex + match[0].length + 80))
        if (subjectTokens.length && !subjectTokens.some((token) => context.includes(token))) continue
        const region = normalizeBusinessRegion(match[1])
        if (region) return region
      }
    }
  }
  return undefined
}

function isAcademicSubject(input: LeadRegionInput): boolean {
  return /高校|院校|大学|学院|研究院|研究所|实验室|课题组|教授团队|科研团队|研究团队/.test([
    input.sourceGroup,
    input.channel,
    input.subjectName,
    input.profile?.affiliatedInstitutions,
    input.profile?.lab,
  ].map((value) => String(value ?? '')).join(' '))
}

export interface LeadRegionInput {
  businessRegion?: unknown
  businessRegionSource?: unknown
  businessRegionConfidence?: unknown
  registry?: Record<string, unknown>
  profile?: Record<string, unknown>
  subjectName?: unknown
  companyName?: unknown
  sourceGroup?: unknown
  channel?: unknown
  sourceName?: unknown
  accountName?: unknown
  sourceTitle?: unknown
  summary?: unknown
  articleText?: unknown
}

export function resolveLeadBusinessRegion(input: LeadRegionInput): LeadRegionResolution | undefined {
  const stored = normalizeBusinessRegion(input.businessRegion)
  let storedResolution: LeadRegionResolution | undefined
  if (stored) {
    storedResolution = {
      region: stored,
      source: meaningfulRegionText(input.businessRegionSource) || '标准地区字段',
      confidence: input.businessRegionConfidence === '中' ? '中' : '高',
    }
    if (storedResolution.confidence === '高') return storedResolution
  }

  const registry = input.registry ?? {}
  for (const value of [registry.regLocation, registry.registeredAddress, registry.address]) {
    const region = normalizeBusinessRegion(value)
    if (region) return { region, source: '工商注册地', confidence: '高' }
  }

  const profile = input.profile ?? {}
  let mediumProfileRegion: LeadRegionResolution | undefined
  for (const value of [profile.regLocation, profile.registeredAddress, profile.region, profile.location]) {
    const region = normalizeBusinessRegion(value)
    if (!region) continue
    const resolution: LeadRegionResolution = {
      region,
      source: meaningfulRegionText(profile.regionSource) || '雷达结构化地区',
      confidence: profile.regionConfidence === '中' ? '中' : '高',
    }
    if (resolution.confidence === '高') return resolution
    mediumProfileRegion = resolution
    break
  }

  const companyRegion = subjectAdministrativeRegion(input.companyName)
  if (companyRegion) return { region: companyRegion, source: '主体名称行政区划', confidence: '中' }

  const subjectRegion = subjectAdministrativeRegion(input.subjectName)
  if (subjectRegion) return { region: subjectRegion, source: '主体名称行政区划', confidence: '中' }

  const explicit = explicitLocationRegion(
    [input.companyName, input.subjectName],
    input.sourceTitle,
    input.summary,
    input.articleText,
  )
  if (explicit) return { region: explicit, source: '来源原文明确地点', confidence: '中' }

  if (mediumProfileRegion) return mediumProfileRegion

  // 公司法定全称或项目名称以行政区划开头时，可作为业务地区候选；
  // 不扫描普通正文中的孤立城市词，避免把会议举办地误认为公司注册地。
  if (isAcademicSubject(input)) {
    for (const value of [
      profile.affiliatedInstitutions,
      profile.lab,
      input.sourceName,
      input.accountName,
      input.subjectName,
    ]) {
      const region = institutionRegion(value)
      if (region) return { region, source: '所属高校/研究机构', confidence: '中' }
    }
  }

  return storedResolution
}
