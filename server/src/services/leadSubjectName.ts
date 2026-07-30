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
  '企业销售团队',
  '专家团队',
  '技术团队',
  '印度团队',
  '实验室',
  '课题组',
  '相关项目',
  '某项目',
  '作者',
  '负责人',
  '文章来源',
  '文章转载',
  '全新突破',
  '硬氪前线',
  '硬氪首发',
  '独家',
  '首发',
  '喜报',
  '来源',
  '清心新闻',
  '硬氪',
  '36氪',
  '十五五',
  '融资',
  '会赚钱',
  '保险科技',
  '消费级智能',
  '中国半导体',
  '入局物理智能',
  'X教授',
  '前瞻理论研究与创新平台',
  '数据',
  '小时',
  '主持',
  '学员们',
  '购票观众即',
  '6氪',
  '新股王',
  '信息系统',
  'AI软件',
  '卡脖子',
  '近期',
  '36氪首发',
  '二季度普华汇',
  'AI下半场',
  '外部危机和人工智能',
  '核聚变装置',
  'AI头条',
  '交易',
  '生物医药',
  '金融科技',
  '法律科技',
  '硬科技',
  '具身智能',
  '数字哨兵',
  '对等关税',
  '创客中国',
  '两优一先',
  '新石油',
  'AI团队',
  'AI智能',
  '人人创作',
  '全球首次',
  '值得尊敬',
  '公开数据',
  '国家信息',
  '国家医疗',
  '国际科技',
  '围绕智能',
  '建设科技',
  '助力科技',
  '打通医疗',
  '投硬科技',
  '致远榜样',
  '欧盟数据',
  '蔬菜自由',
  '韧性革命',
  '学术数据',
  '引领盛世',
  '机器人每',
  '能否稳定',
  '公毅计划',
          '多数科技',
  '整个科技',
  '黄山样本',
        '研究院',
  'C+轮',
  '一〇七',
  '不一样',
  '公司刚',
  '内卷式',
  '创变者',
  '反脆弱',
  '夯实率',
  '成果需',
  '短期内',
  '自项目',
  '若顺利',
  '金鱼脑',
  '韬定律',
  '冕开物',
  '鲍德温曾',
            '用户',
  '记者',
  '扫码',
  '真货',
  '豪赌',
  '本轮',
  '中国',
  '优异',
  '例外',
  '公司',
  '冷钱',
  '如何',
  '扩面',
  '汇智',
  '重塑',
  '最土',
  '帷幄',
  '梅花创投',
  '涌现新项目',
  '定价权',
  '财务数据',
])
const VERIFIED_SHORT_BRAND_SUBJECTS = new Set(['深庭纪'])

const VAGUE_START_RE = /^(?:他|她|其|该|这|此|其中|上述|相关|目前|未来|同时|此外|另|据|根据|我要|我们要|对于|关于|要求|需要|应当|必须|支持|推动|加强|开展|引导|主动|持续|继续|曾|曾经|担任|联创|联合创始人?|成立|投资|创始人|科研人员|参赛|本次|全体|让|让更多|让我|使我|并使|并|基于|后两年|共享|作为|为|用于|以|从|在|将|把|被|由|于|联合|面对|通过|围绕|聚焦|了解|开拓|真实|价值|推荐阅读|背靠|赠礼环节|学员们|购票观众|课题被|科创报国|促进|紧跟|对标|正是|也|过去|活动在|锤炼|需要|更多|不再|只有|至今|随后|共同|双方|各自|截止|落地|年初|年末|年底|月初|月末|算|深刻|深刻认识|深刻体会|深刻理解|与|代表|对|一是|二是|三是|四是)/
const VAGUE_BODY_RE = /(?:岗位记录|关键证明|证明材料|要求主动|主动适应|走出实验室|为核心业务|核心业务的|系统梳理|以及团队|进入导师课题组|共享两个学院|获颁|获评|荣获|获奖|荣誉|Award|文章来源|论文合作者|合作者为|受试者|研究参与者|筛选期|完全开放|依托高校|顺利通过|一行到访|成功举办|先后发言|按姓氏拼音排序|首先来到|带队|不是在实验室|老师.*介绍|分别介绍了|介绍了其|第一城|早些时候|一批|多家|数个|能够替代|能够|key observation|by the paper|(?:已经|已|正在)组建|已打通|过往所投公司的创业团队|等信息|等材料|等证明|等方面|等工作|带来的变化)/i
const VAGUE_END_RE = /(?:材料|记录|信息|情况|内容|要求|工作|方面|变化|问题|任务|路径|策略|证明|累计|责编|来源|目前|近期|斩|再|消息|报道)$/
const PREDICATE_RE = /(?:要求|适应|指出|表示|强调|认为|提出|推动|支持|开展|引导|走出|打造|落地|实现|完成|获得|发布|宣布|提供|形成|建立|构建|促进|提升|加强|记录|证明|担任|任职|毕业|来自|师从|进入|共享|梳理|发表|结合|参与|经历|合作者|申请|接受|走访|到访|举办|发言|带队|来到|组建|体会|体会到了?|感受到|意识到|认识到|学到|了解到)/
const NUMBERED_TECH_FRAGMENT_RE = /^[\u4e00-\u9fffA-Za-z]{1,8}[-—–][\u4e00-\u9fffA-Za-z]{1,8}\d{1,2}$/
const GENERIC_INSTITUTION_TECH_RE = /^(?:清华|北大|北航|上交大|复旦|浙大|中科大|哈工大)(?:系)?(?:机器人|芯片|人工智能|大模型)(?:团队|项目)?$/
const DESCRIPTIVE_COMPANY_SUBJECT_RE = /^(?:(?:清华|北大|北航|上交大|复旦|浙大|中科大|哈工大)(?:系)?.{1,28}(?:企业|公司)|.{1,30}(?:装备商|制造商|研发商|提供商|服务商))$/
const SUBJECT_MARKER_RE = /(?:股份有限公司|有限责任公司|有限公司|公司|企业|项目|团队|实验室|研究院|研究所|研究中心|工程中心|课题组|创新群体|创新联合体|中试基地|产业基地|创新平台|技术平台|研发平台|试验平台|装置|系统|产品|计划)$/
const ENGLISH_ENTITY_MARKER_RE = /(?:AI|Labs?|Laboratory|Institute|Center|Centre|Technologies|Technology|Robotics|Bio|Systems?|Platform|Project)$/i
const LOW_VALUE_RADAR_RE = /(?:院系之声.{0,30}(?:荣誉|获奖|Award)|(?:教授|研究员|学者).{0,30}(?:获颁|获评|荣获|获奖|Award|荣誉|发文|发表文章)|(?:获得|获评|入选|荣获|获).{0,24}(?:奖|荣誉|称号|教学团队|表彰|标兵|勋章)|(?:科学技术奖|科技奖|自然科学奖|技术发明奖|科技进步奖).{0,40}(?:揭晓|获奖|表彰)|\d+\s*项.{0,12}(?:获奖|获表彰)|(?:国家级|省级|全国高校).{0,16}(?:教学团队|教学成果|荣誉|奖|标兵)|奖学金|受试者招募|招募(?:研究参与者|受试者)|参与本研究|临床试验.{0,50}(?:招募|受试者|研究参与者)|实践成果.{0,24}(?:申请|硕士学位)|学位答辩|专业学位培养改革|论文.{0,40}(?:期刊|发表|刊发|接受|接收|accepted)|学术成果|研究论文|文章来源|转载全文|毕业(?:季|典礼|致辞|生|倒计时|设计)|毕业生去哪儿|校友招聘|社会招聘|诚聘|实习生|招聘|党支部|党员|党务|党建|革命先辈|校史|悼念|缅怀|研修班|训练营|课程|移动课堂|工作坊|讲座(?:预告)?|活动(?:预告|抢先知)|Information Session|参访|探访|参观|调研|走访|到访|企业走访交流活动|师生校友|院友沙龙|创新大赛|参赛队伍|\d+\s*家.{0,24}(?:企业|公司).{0,30}(?:融资|投资)|专场(?:科创)?路演|路演举办|加速计划.{0,20}(?:招募|启动)|最前线|解码硬科技|罚单|行业进入强监管|(?:\d+点\d*氪|氪星|创投|财经)(?:晚报|早报)?|为什么资本|什么样的.{0,20}(?:能|会)|行业观察|赛道观察|赴港上市|登陆资本市场|IPO认购|上市获|融资净买入|股息率|榜单|合作会议|专题会议|世界顶尖科学家论坛|院士云集|共议|要报.{0,12}专业吗|招生(?:简章|宣传|咨询|专业|对象)?|培养方案|课程介绍|实验班介绍|培训班|结业证书|能力提升计划|名家面对面|学员企业|发表致辞|兼任|受聘|履新|任命|(?:记者|人物)?专访|人物访谈|观点访谈|深度解读|系统剖析)/i
const HARD_EDITORIAL_RADAR_RE = /(?:氪星晚报|\d+点\d*氪|(?:^|[|｜:：\s])(?:早报|晚报)(?:[|｜:：\s]|$)|^(?:对谈|访谈|专访|秋声)\s*[|｜:：]|投资狂潮|终极能源之战|行业综述|迟到的狂欢)/i
const PURE_ACADEMIC_RADAR_RE = /(?:(?:课题组|团队|实验室).{0,100}(?:发表|论文|研究|揭示|破解|开发|发现|成果)|(?:学术成果|科研成果|研究进展|研究论文|最新研究|多项研究|两项研究|研究成果|合作论文).{0,100}(?:课题组|团队|教授|研究员|实验室|突破|发现|揭示|开发|发表|刊发|接收)?|(?:论文|研究成果).{0,80}(?:发表|刊发|接收|accepted|publication)|(?:发表于|在线发表于|accepted by).{0,60}(?:期刊|journal|nature|science|IEEE)|Science Publication|论文摘要|(?:团队|课题组).{0,60}(?:算法|模型|数据|机制|通路|架构))/i
const COMMERCIAL_RADAR_RE = /(?:成果转化|技术转移|转化落地|产业化|中试|技术平台|工程化|技术许可|专利转让|孵化(?:成立|企业|公司)|创办公司|成立公司|产品获批|注册证|临床应用|应用新场景|示范应用|产业应用|客户验证|客户订单|采购|中标|签约|量产|营收|商业化)/i
const VERIFIED_SOURCE_SUBJECT_RULES: Array<{ pattern: RegExp; subject: string }> = [
  { pattern: /北航机器人所团队创业.{0,24}智能变刚度关节/, subject: '航墨科技' },
  { pattern: /清华系初创完成数亿元种子轮融资.{0,30}世界模型/, subject: '厘清智能' },
  { pattern: /前大疆科学家创业.{0,30}(?:四轮|耀途资本|锦秋基金)/, subject: '硅羽科技' },
]

function cleanSubjectName(value: unknown): string {
  return String(value ?? '')
    .replace(/^(?:群聊线索|项目线索|项目名称|主体名称)\s*[|｜:：]\s*/i, '')
    .trim()
    .replace(/^[“”"'「」『』）)\]】\s]+|[“”"'「」『』\s]+$/g, '')
    .replace(/[，。！？；;：:,.\s]+$/g, '')
    .trim()
}

export function isSpecificLeadSubjectName(value: unknown, allowPaperTitle = false): boolean {
  const name = cleanSubjectName(value)
  if (!name || SUBJECT_PLACEHOLDERS.has(name)) return false
  if (allowPaperTitle) return name.length >= 2 && name.length <= 180
  if (name.length < 2 || name.length > 60) return false
  // 短中文名（2-3字）无主体标记的几乎不可能是实体名，拒绝。
  // 英文名（如 DeepSeek、Meshy）保留最小2字限制。
  if (
    name.length < 4
    && !SUBJECT_MARKER_RE.test(name)
    && !/[A-Za-z]/.test(name)
    && !VERIFIED_SHORT_BRAND_SUBJECTS.has(name)
  ) return false
  if (GENERIC_SUBJECTS.has(name)) return false
  if (NUMBERED_TECH_FRAGMENT_RE.test(name)) return false
  if (GENERIC_INSTITUTION_TECH_RE.test(name)) return false
  if (DESCRIPTIVE_COMPANY_SUBJECT_RE.test(name)) return false
  if ((name.includes('（') && !name.includes('）')) || (name.includes('(') && !name.includes(')'))) return false
  if (/[，。！？；;：:、|｜丨\n]/.test(name)) return false
  if (VAGUE_START_RE.test(name) || VAGUE_BODY_RE.test(name) || VAGUE_END_RE.test(name)) return false
  if (/^(?:(?:\d+|数|多)?人|个人|创始人?)创业团队$/.test(name)) return false
  if (/^[\u4e00-\u9fff]{2,18}(?:触觉|感知|技术|科技|机器人|硬件|软件|设备|材料|能源|半导体)企业$/.test(name)) return false
  if (/^[\u4e00-\u9fff]{2,24}(?:文化创意|消费|家居|生活方式|文创)品牌$/.test(name)) return false
  if (name.includes('等') && !/(?:邓|等等科技|等等智能)/.test(name)) return false
  if (PREDICATE_RE.test(name) && !/(?:公司|企业|项目|团队|实验室|研究院|研究中心|工程中心|课题组)$/.test(name)) return false
  const englishWords = name.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? []
  const verifiedEnglishBrand = /^[A-Z][A-Z0-9.-]*(?:\s+[A-Z][A-Z0-9.-]*){1,3}$/.test(name)
  if (englishWords.length >= 2 && !verifiedEnglishBrand && !SUBJECT_MARKER_RE.test(name) && !ENGLISH_ENTITY_MARKER_RE.test(name)) return false
  if (!SUBJECT_MARKER_RE.test(name) && /(?:的|了|是|以|在|为|将|把|被|对于|关于|正在|让|到|体会|感受|觉得|知道|认识|深刻|意识|理解|了解|学到|得到)/.test(name)) return false
  // 拒绝明显是完整句子的名称（含问号、感叹号、句号）
  if (/[？！。！]/.test(name)) return false
  // 拒绝长英文标题（>40字符且纯英文，通常是论文标题）
  if (/^[A-Za-z0-9\s:,\-()\[\]&;+]+$/.test(name) && name.length > 40) return false
  // 拒绝问句（包含"如何/为什么/是否/怎么/什么/怎样"等疑问词，且无主体标记）
  if (/(?:如何|为什么|是否|怎么|怎样|什么)/.test(name) && !SUBJECT_MARKER_RE.test(name)) return false
  // 拒绝明显的多公司融资综述标题（"N家企业获得融资"模式）
  if (/\d+\s*[家个]/.test(name) && /(?:企业|公司|融资|上市)/.test(name)) return false
  // 拒绝以年份/日期开头的泛化描述（如"2026年全球市场..."、"2025年全国医疗"）
  if (/^(?:19|20)\d{2}[年\s]/.test(name) && !SUBJECT_MARKER_RE.test(name)) return false
  // 拒绝以纯数字、日期、序号开头（如"7月13日-7月22日 第三期"、"1999年"）
  if (/^(?:\d+[月日年个只家项位次]|第\s*\d+\s*期)/.test(name)) return false
  // 拒绝新闻标题被当作主体名（含融资/估值/亿元/上市+逗号，或含"融资.*亿"等标题句式）
  if (/(?:融资余额|融资.*亿|完成.*融资|获得.*融资|(?:万亿|亿元)|估值|亿美元|万美元|上市|IPO|登陆|完成.{0,8}轮|获得.{0,8}投|.{0,4}融资.*亿|突破.{0,4}[万亿])/.test(name) &&
      (name.length > 8 || /[，,、]/.test(name))) return false
  // 纯英文片段 >25 字且以非大写字母开头（多为截断的英文句子片段）
  if (/^[a-z]/.test(name) && /^[A-Za-z0-9\s:,\-()]+$/.test(name) && name.length > 25) return false
  // 纯英文 >25 字无实体标记（论文标题/期刊名）
  if (/^[A-Za-z0-9\s:,\-()&;]+$/.test(name) && name.length > 25 && !ENGLISH_ENTITY_MARKER_RE.test(name)) return false
  // 带主体标记但 >12 字且含"代表/对/将/到/被"等句法虚词的长名，实际上是句子片段
  if (name.length > 12 && SUBJECT_MARKER_RE.test(name) && /(?:代表|对|将|到|被)/.test(name)) return false
  return true
}

export function isLowValueRadarContent(...values: unknown[]): boolean {
  return values.some((value) => LOW_VALUE_RADAR_RE.test(String(value ?? '').slice(0, 2400)))
}

export function isNonInvestableRadarContent(input: {
  hasCompanySubject?: boolean
  hasInvestmentEvidence?: boolean
  subjectName?: unknown
  values: unknown[]
}): boolean {
  const text = input.values.map((value) => String(value ?? '').slice(0, 2400)).join('\n')
  if (HARD_EDITORIAL_RADAR_RE.test(text)) return true
  if ((
    String(input.values[0] ?? '').slice(0, 1000).match(/(?:完成|获得|获).{0,24}(?:融资|投资)/gi) ?? []
  ).length >= 2) return true
  if (input.hasInvestmentEvidence) return false
  if (LOW_VALUE_RADAR_RE.test(text)) return true
  if (PURE_ACADEMIC_RADAR_RE.test(text) && !COMMERCIAL_RADAR_RE.test(text)) return true
  if (input.hasCompanySubject) return false
  // 高校新闻中的“成果转化、签约、产业化”等词经常只是大会主题或倡议，
  // 不能单独构成投资线索。没有公司和融资事实时，必须先能识别出一个
  // 以项目/团队/实验室/平台/产品等结尾的具体标的，再判断商业化信号。
  const subjectName = cleanSubjectName(input.subjectName)
  if (!isSpecificLeadSubjectName(subjectName) || !SUBJECT_MARKER_RE.test(subjectName)) return true
  return !COMMERCIAL_RADAR_RE.test(text)
}

function normalizeProjectCandidate(value: unknown): string {
  let candidate = cleanSubjectName(value)
  const describedBrand = candidate.match(/(?:研发商|制造商|提供商|品牌|独角兽|公司|企业)([\u4e00-\u9fffA-Za-z0-9·&＋+\-\s]{2,24})$/)
  if (describedBrand) candidate = cleanSubjectName(describedBrand[1])
  candidate = candidate.replace(/^(?:超声脑机接口公司|端侧大模型独角兽|清华系端侧大模型独角兽|消费级智能硬件品牌)/, '')
  candidate = candidate.replace(/^(?:推出的|研发的|打造的|研制的)/, '')
  candidate = candidate.replace(/^投资(?=[\u4e00-\u9fffA-Za-z0-9])/, '')
  candidate = candidate.replace(/(?:目前|近期|已经|已|正式|斩)$/, '')
  if (/^[A-Za-z0-9·&＋+\-]{2,24}团队$/i.test(candidate)) candidate = candidate.replace(/团队$/, '项目')
  if (/(?:系)?初创$/.test(candidate)) candidate += '项目'
  if (candidate && !SUBJECT_MARKER_RE.test(candidate) && /(?:智能体|外骨骼|机器人|模型|芯片|装置|平台|系统|产品)$/.test(candidate)) {
    candidate += '项目'
  }
  return candidate
}

function isReliableCompanySubjectName(value: unknown): boolean {
  const candidate = cleanSubjectName(value)
  if (!isSpecificLeadSubjectName(candidate)) return false
  if (/(?:揭牌|推进会|在|于|由).{2,}(?:股份有限公司|有限责任公司|有限公司)$/.test(candidate)) return false
  return true
}

function extractDescriptiveProjectSubjects(titleValue: unknown, textValue: unknown): string[] {
  const title = String(titleValue ?? '').trim()
  const text = String(textValue ?? '').slice(0, 1200)
  const technology = String.raw`(?:智能体|外骨骼|机器人|芯片|模型|平台|系统|装置|产品)`
  const match = text.match(new RegExp(String.raw`(?:打造|研发|推出|开发|聚焦|面向)[^，。\n]{0,36}?([\u4e00-\u9fffA-Za-z0-9·&＋+\-]{2,20}${technology})`, 'i'))
  if (!match) return []
  let candidate = cleanSubjectName(match[1])
  const technologyTail = candidate.match(new RegExp(String.raw`(?:的)([^的]{2,16}${technology})$`, 'i'))
  if (technologyTail) candidate = technologyTail[1]
  const founderPrefix = title.match(/^(前[^，,]{2,18}?科学家)创业/)
  candidate = `${founderPrefix?.[1] ?? ''}${candidate}`
  candidate = normalizeProjectCandidate(candidate)
  return isSpecificLeadSubjectName(candidate) ? [candidate] : []
}

function splitCandidates(value: unknown): string[] {
  return String(value ?? '')
    .split(/[；;\n|｜]/)
    .map(cleanSubjectName)
    .flatMap((candidate) => {
      const coordinatedSubjects = candidate
        .split(/(?:与|联合)/)
        .map(cleanSubjectName)
        .filter((part) => SUBJECT_MARKER_RE.test(part))
      return coordinatedSubjects.length >= 2 ? coordinatedSubjects : [candidate]
    })
    .filter(Boolean)
}

function extractNamedFragments(value: unknown): string[] {
  const text = String(value ?? '')
  const fragments: string[] = []
  const patterns = [
    /([A-Z][A-Za-z0-9+&.-]*(?:\s+[A-Za-z][A-Za-z0-9+&.-]*){1,5}联合实验室)/g,
    /([\u4e00-\u9fffA-Za-z0-9（）()·&＋+\-]{2,60}(?:股份有限公司|有限责任公司|有限公司))/g,
    /((?:[\u4e00-\u9fff]{2,20}(?:大学|学院|研究所|医院))[\u4e00-\u9fff·]{0,16}(?:教授|研究员|博士)?团队)/g,
    /([\u4e00-\u9fffA-Za-z0-9·]{2,30}(?:重点实验室|实验室|研究中心|工程中心|研究院|课题组|创新群体|创新联合体|中试基地|产业基地|创新平台|技术平台|研发平台|试验平台))/g,
    /([\u4e00-\u9fff·]{2,6}(?:教授|研究员|博士)?团队)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = cleanSubjectName(match[1])
      const coordinatedSubjects = candidate
        .split(/(?:与|联合)/)
        .map(cleanSubjectName)
        .filter((part) => SUBJECT_MARKER_RE.test(part))
      if (coordinatedSubjects.length >= 2) fragments.push(...coordinatedSubjects)
      else fragments.push(candidate)
    }
  }

  // “作者 | 张三：某大学某学院教授”类材料没有直接写“团队”，
  // 但可以安全地形成“机构 + 负责人 + 团队”主体，不再截取正文谓语片段。
  const authorPattern = /([\u4e00-\u9fff·]{2,4})\s*[：:]\s*([\u4e00-\u9fff]{2,24}(?:大学|学院|研究所|医院))/g
  for (const match of text.matchAll(authorPattern)) {
    fragments.push(`${cleanSubjectName(match[2])}${cleanSubjectName(match[1])}团队`)
  }
  return fragments
}

function extractTitleProjectSubjects(value: unknown): string[] {
  const text = String(value ?? '').trim()
    .replace(/^(?:(?:36氪|硬氪)?(?:前线|首发)|独家|首发|喜报|快讯|重磅)\s*[|｜:：]\s*/i, '')
  if (!text) return []
  const nameChars = String.raw`[\u4e00-\u9fffA-Za-z0-9（）()·&＋+\-]`
  const projectMarker = String.raw`(?:产业技术中试基地|创新联合体|中试基地|产业基地|创新平台|技术平台|研发平台|试验平台|示范基地|转化基地|项目|计划|装置|系统)`
  const pattern = new RegExp(String.raw`(?:^|[\s|｜！!。；;，,\n])\s*(${nameChars}{2,60}?${projectMarker})(?=在|落地|签约|揭牌|启用|发布|完成|获|，|。|$)`, 'g')
  const subjects = [...text.matchAll(pattern)]
    .map((match) => cleanSubjectName(match[1]))
    .filter((candidate) => isSpecificLeadSubjectName(candidate))
  return subjects.filter((candidate, index, all) => all.indexOf(candidate) === index)
}

function extractFinancingTitleSubjects(value: unknown): string[] {
  const text = String(value ?? '').trim()
    .replace(/^(?:(?:36氪|硬氪)?(?:前线|首发)|码刻|独家|首发|喜报|快讯|重磅)\s*[|｜:：]\s*/i, '')
  const responseSubject = text.match(/^([A-Za-z][A-Za-z0-9&+.-]{1,30})(?=回应(?:融资|投资)报道)/i)
  const explicitBrand = text.match(/(?:应用|企业|公司|品牌|平台|装备商)\s*([A-Za-z][A-Za-z0-9&+.-]*(?:\s+[A-Za-z][A-Za-z0-9&+.-]*){0,3}|[\u4e00-\u9fff·]{2,16})(?=(?:目前|近期|已经|已|正式)?(?:斩获|完成|获得|获).{0,24}(?:融资|投资))/i)
  const match = responseSubject
    ?? explicitBrand
    ?? text.match(/(?:^|[，,；;！!])\s*([\u4e00-\u9fffA-Za-z0-9（）()·&＋+\-\s]{2,30}?)(?=(?:目前|近期|已经|已|正式)?(?:斩获|完成|获得|获).{0,24}(?:融资|投资))/i)
  if (!match) return []
  const candidate = normalizeProjectCandidate(match[1])
  return isSpecificLeadSubjectName(candidate) ? [candidate] : []
}

function extractPrimaryNewsSubjects(value: unknown): string[] {
  const text = String(value ?? '')
    .replace(/^(?:(?:36氪|硬氪)?(?:前线|首发)|码刻|独家|首发|喜报|快讯|重磅)\s*[|｜:：]\s*/i, '')
    .slice(0, 1800)
  if (!text) return []
  const nameChars = String.raw`[\u4e00-\u9fffA-Za-z0-9（）()·&＋+\-]`
  const descriptor = String.raw`(?:${nameChars}{0,28}(?:企业|公司|品牌|提供商|供应商|研发商|制造商|独角兽))?`
  const wrapperOpen = String.raw`[「『“"]?`
  const wrapperClose = String.raw`[」』”"]?`
  const event = String.raw`(?=(?:(?:近日|日前|近期|今日)\s*)?(?:\d+\s*个?月(?:内)?\s*)*(?:(?:官宣|宣布)\s*)?(?:(?:连续|已|正式)\s*)*(?:完成|获得|获|成立(?:于)?|是一家))`
  const patterns = [
    new RegExp(String.raw`(?:获悉|消息显示|公开信息显示)[，,\s]*(?:(?:近日|日前|近期)[，,\s]*)?${descriptor}\s*${wrapperOpen}(${nameChars}{2,40}?)${wrapperClose}(?:[（(][^）)]{1,30}[）)])?\s*${event}`, 'g'),
    new RegExp(String.raw`(?:^|[。；;\n])\s*(?:(?:近日|日前|近期|今日)[，,\s]*)?(?:\d{1,4}年)?\d{0,2}月?\d{0,2}日?[，,\s]*${descriptor}\s*${wrapperOpen}(${nameChars}{2,40}?)${wrapperClose}(?:[（(][^）)]{1,30}[）)])?\s*${event}`, 'g'),
    new RegExp(String.raw`(?:孵化创立|孵化成立|创办|创立)(?:的)?\s*${wrapperOpen}(${nameChars}{2,30}?)${wrapperClose}(?:[（(][^）)]{1,30}[）)])?\s*(?=(?:官宣|宣布)?(?:连续)?完成.{0,30}(?:融资|投资))`, 'g'),
    new RegExp(String.raw`(?:^|[。；;\n])\s*(${nameChars}{2,30})(?=成立(?:于)?|是一家|专注于|致力于)`, 'g'),
    new RegExp(String.raw`(?:^|[。；;\n])\s*(${nameChars}{2,30}?)(?=(?:完成|获得|获).{0,24}(?:融资|投资))`, 'g'),
    new RegExp(String.raw`(?:离职|创业者)?创办\s*${wrapperOpen}(${nameChars}{2,30})${wrapperClose}(?=[，,。；;\s])`, 'g'),
    /(?:制造商|研发商|公司|企业)\s*([A-Z][A-Za-z0-9&+.-]*(?:\s+[A-Z][A-Za-z0-9&+.-]*){0,3})(?=\s*(?:获得|完成|宣布|获))/g,
    /(?:^|[，。；;\n])\s*(?:\d{4}年\d{1,2}月[，,\s]*)?([A-Z][A-Za-z0-9&+.-]*(?:\s+[A-Z][A-Za-z0-9&+.-]*){1,3})(?=\s*成立(?:于)?[，,。\s])/g,
    /中文名\s*[“「『"]?([\u4e00-\u9fffA-Za-z0-9·&＋+\-\s]{2,30}?)[”」』"]?(?=[，,。；;])/g,
    /(?:公司(?:名|叫做?)|品牌(?:名|叫做?))\s*[“「『"]?([\u4e00-\u9fffA-Za-z0-9·&＋+\-\s]{2,30}?)[”」』"]?(?=[，,。；;])/g,
  ]
  const subjects: string[] = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = normalizeProjectCandidate(match[1])
      if (isSpecificLeadSubjectName(candidate)) subjects.push(candidate)
    }
  }
  return subjects.filter((value, index, all) => all.indexOf(value) === index)
}

function extractQuotedFinancingSubjects(value: unknown): string[] {
  const text = String(value ?? '').trim()
    .replace(/^(?:(?:36氪|硬氪)?(?:前线|首发)|码刻|独家|首发|喜报|快讯|重磅)\s*[|｜:：]\s*/i, '')
  const subjects: string[] = []
  const pattern = /[「『“"]([\u4e00-\u9fffA-Za-z0-9·&＋+\-\s]{2,30})[」』”"](?=[^「『“"]{0,36}(?:完成|获得|获|融资|投资))/gi
  for (const match of text.matchAll(pattern)) {
    const candidate = normalizeProjectCandidate(match[1])
    if (isSpecificLeadSubjectName(candidate)) subjects.push(candidate)
  }
  return subjects.filter((value, index, all) => all.indexOf(value) === index)
}

function extractEventLegalCompanySubjects(value: unknown): string[] {
  const text = String(value ?? '').slice(0, 3000)
  const legalCompany = String.raw`([\u4e00-\u9fffA-Za-z0-9（）()·&＋+\-]{2,80}(?:股份有限公司|有限责任公司|有限公司))`
  const pattern = new RegExp(
    String.raw`(?:^|[，。；;：:\n])\s*[「『“"]?${legalCompany}[」』”"]?\s*`
    + String.raw`(?=近日|日前|宣布|完成|获得|获|成立于|总部|`
    + String.raw`通过(?:港交所|上市聆讯)|提交(?:上市|IPO)|冲刺(?:港股|上市|IPO)|拟(?:上市|IPO))`,
    'gi',
  )
  const subjects = [...text.matchAll(pattern)]
    .map((match) => cleanSubjectName(match[1]))
    .filter((candidate) => isReliableCompanySubjectName(candidate))
  return subjects.filter((value, index, all) => all.indexOf(value) === index)
}

function extractVerifiedSourceSubject(value: unknown): string {
  const title = String(value ?? '')
  return VERIFIED_SOURCE_SUBJECT_RULES.find((rule) => rule.pattern.test(title))?.subject ?? ''
}

function extractExplicitTargetSubject(...values: unknown[]): string {
  const patterns = [
    /(?:投资标的|投资于)\s*[「『“"]?([\u4e00-\u9fffA-Za-z0-9·&＋+\-]{2,30}?)[」』”"]?(?=完成|获得|获|宣布|融资|投资|[，,。；;：:\s]|$)/i,
    /(?:走访|到访)\s*[「『“"]?([\u4e00-\u9fffA-Za-z0-9·&＋+\-]{2,30}?)[」』”"]?(?=完成|签约|发布|[，,。；;：:\s]|$)/i,
  ]
  for (const value of values) {
    const text = String(value ?? '').slice(0, 2400)
    for (const pattern of patterns) {
      const candidate = normalizeProjectCandidate(text.match(pattern)?.[1])
      if (isSpecificLeadSubjectName(candidate)) return candidate
    }
  }
  return ''
}

export interface RadarSubjectNameInput {
  isPaper?: boolean
  existingName?: unknown
  companyNames?: unknown[]
  projectName?: unknown
  lab?: unknown
  team?: unknown
  title?: unknown
  articleText?: unknown
  excludedNames?: unknown[]
  channel?: unknown
}

export function deriveRadarSubjectName(input: RadarSubjectNameInput): string {
  const excluded = new Set((input.excludedNames ?? []).map(cleanSubjectName).filter(Boolean))
  const pick = (values: unknown[], allowPaperTitle = false, respectExcluded = true): string => {
    const candidates = values
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .flatMap((value) => [...splitCandidates(value), ...extractNamedFragments(value)])
      .filter((value, index, all) => all.indexOf(value) === index)
      .filter((value) => !respectExcluded || !excluded.has(value))
      .filter((value) => isSpecificLeadSubjectName(value, allowPaperTitle))
      // 即使通过了 isSpecificLeadSubjectName，过长的名称也可能是句子片段。
      // 有主体标记（实验室/研究院/公司）但长度>30 且含虚词的，往往是文章内嵌的长句。
      .filter((value) => {
        if (value.length <= 30) return true
        // 长名称如果含"和/与/均/都/的/了/是/在/正在/到"等虚词，大概率是句子片段
        if (/(?:的|了|是|在|正在|到|和|与|均|都)/.test(value)) return false
        return true
      })
      .sort((left, right) => right.length - left.length)
    return candidates[0] ?? ''
  }

  const reliableCompanies = (input.companyNames ?? []).filter(isReliableCompanySubjectName)
  const legalCompany = pick(reliableCompanies.filter((value) => /(?:股份有限公司|有限责任公司|有限公司)$/.test(cleanSubjectName(value))), false, false)
  const existingCandidate = cleanSubjectName(input.existingName)
  const existingEvidence = [
    input.title,
    input.articleText,
  ].map((value) => String(value ?? '').replace(/\s+/g, '').toLowerCase()).join('\n')
  const existingNeedle = existingCandidate
    .replace(/(?:股份有限公司|有限责任公司|有限公司)$/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
  const existingSubject = isReliableCompanySubjectName(existingCandidate)
    && (
      /(?:股份有限公司|有限责任公司|有限公司)$/.test(existingCandidate)
      || (existingNeedle.length >= 2 && existingEvidence.includes(existingNeedle))
    )
    ? existingCandidate
    : ''

  if (!input.isPaper) {
    const verifiedSourceSubject = extractVerifiedSourceSubject(input.title)
    if (verifiedSourceSubject) return verifiedSourceSubject
    // “投资标的 X”“走访 X”中的 X 是文章明确指向的标的，优先级高于
    // 后续采集可能误绑到投资方/来源方的工商主体。
    const explicitTargetSubject = extractExplicitTargetSubject(input.title, input.articleText)
    if (explicitTargetSubject) return explicitTargetSubject
  }

  // 存量主体只有在正文/标题中有直接证据（或本身是完整法定名称）时才优先；
  // 这可避免工商补全把投资方、来源机构覆盖成融资主体。
  if (existingSubject) return existingSubject
  if (legalCompany) return legalCompany

  // 高校 / 学术文章：全文 extractPrimaryNewsSubjects 容易把
  // "让我深刻体会到科技成果转化是连接实验室…" 这类文章内句子误提取为主体名称。
  // 优先提取实验室/课题组/机构+团队，再回退到公司名称，不再用 news_subject 兜底。
  const channel = String(input.channel ?? '')
  const titleStr = String(input.title ?? '')
  const isAcademic = channel === '高校公众号' || /(?:学术成果|科研成果|课题组|实验室)/.test(titleStr)

  if (!input.isPaper && isAcademic) {
    // 优先从标题和正文提取命名的研究主体（实验室/团队/课题组）
    const academicNamedSubject = pick([
      extractNamedFragments(input.title),
      extractNamedFragments(input.articleText),
    ])
    if (academicNamedSubject) return academicNamedSubject

    // 回退到公司名称
    const company = pick(reliableCompanies, false, false)
    if (company) return company

    // 最后用标题
    const titleSubject = cleanSubjectName(input.title)
    if (isSpecificLeadSubjectName(titleSubject)) return titleSubject.slice(0, 60)
    return '未命名项目'
  }

  if (!input.isPaper) {
    const quotedTitleSubject = extractQuotedFinancingSubjects(input.title)[0]
    if (quotedTitleSubject) return quotedTitleSubject
    const financingTitleSubject = extractFinancingTitleSubjects(input.title)[0]
    // 标题里的明确品牌/公司优先于正文，避免把 Meshy 等融资主体抽成正文短语；
    // “某高校团队/某项目完成投资”仍先看正文，正文通常会给出真实公司名。
    if (financingTitleSubject && !/(?:团队|项目|产品|平台)$/.test(financingTitleSubject)) return financingTitleSubject
    const quotedArticleSubject = extractQuotedFinancingSubjects(input.articleText)[0]
    if (quotedArticleSubject) return quotedArticleSubject
    const eventLegalCompany = extractEventLegalCompanySubjects(input.articleText)[0]
    if (eventLegalCompany) return eventLegalCompany
    const articleSubject = extractPrimaryNewsSubjects(input.articleText)[0]
    if (articleSubject) return articleSubject
    if (financingTitleSubject) return financingTitleSubject
    const titleNewsSubject = extractPrimaryNewsSubjects(input.title)[0]
    if (titleNewsSubject) return titleNewsSubject
    const titleProject = pick(extractTitleProjectSubjects(input.title), false, false)
    if (titleProject) return titleProject
    const titleNamedSubject = pick(extractNamedFragments(input.title))
    if (titleNamedSubject) return titleNamedSubject
    const descriptiveProject = pick(extractDescriptiveProjectSubjects(input.title, input.articleText), false, false)
    if (descriptiveProject) return descriptiveProject
  }

  const company = pick(reliableCompanies, false, false)
  if (company) return company

  const researchSubject = pick([input.lab, input.team])
  if (researchSubject) return researchSubject

  const project = pick([normalizeProjectCandidate(input.projectName)], Boolean(input.isPaper), false)
  if (project) return project

  return pick([input.title], Boolean(input.isPaper))
}

export function isBetterLeadSubjectName(currentValue: unknown, nextValue: unknown): boolean {
  const current = cleanSubjectName(currentValue)
  const next = cleanSubjectName(nextValue)
  if (!isSpecificLeadSubjectName(next)) return false
  if (!isSpecificLeadSubjectName(current)) return true
  const currentIsLegalCompany = /(?:股份有限公司|有限责任公司|有限公司)$/.test(current)
  const nextIsLegalCompany = /(?:股份有限公司|有限责任公司|有限公司)$/.test(next)
  if (nextIsLegalCompany && !currentIsLegalCompany) return true
  if (currentIsLegalCompany && !nextIsLegalCompany) return false
  return next.length > current.length + 2 && next.includes(current) && SUBJECT_MARKER_RE.test(next)
}
