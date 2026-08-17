import '../security/hardenImageSizeRuntime.js'
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { MaterialRequest } from '../models/types.js'
import { formatShanghaiDate } from '../utils/shanghaiTime.js'

const generatedRoot = path.resolve(process.cwd(), 'server/generated')

function userGeneratedDir(userId: string) {
  return path.resolve(generatedRoot, userId)
}

async function ensureDir(userId: string) {
  await mkdir(userGeneratedDir(userId), { recursive: true })
}

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 40)

async function generatePptx(request: MaterialRequest, outputDir: string) {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = '浙江赛智伯乐股权投资管理有限公司投资中台'
  pptx.subject = `${request.project.name} 投资建议书`
  pptx.title = request.project.name
  pptx.company = '浙江赛智伯乐股权投资管理有限公司'
  pptx.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
  }

  const blue = '1B4685'
  const lightBlue = 'F1F6FC'
  const yellow = 'F5B335'
  const ink = '16233A'
  const muted = '66758A'
  const line = 'DDE6F1'
  const logoPath = path.resolve(process.cwd(), 'public/cybernaut-logo.png')
  const sources = request.evidenceSources ?? []
  const highlights = request.highlights?.length ? request.highlights : [
    `${request.project.industry}与机构投资方向具备一定匹配度`,
    request.project.summary,
    '项目已建立结构化档案，但核心经营数据仍需交叉验证',
  ]
  const risks = request.risks?.length ? request.risks : [
    '关键经营指标与客户价值需通过原始资料和访谈核验',
    '融资与估值合理性需结合可比公司和财务预测判断',
    '资料不足处不应直接进入最终投资结论',
  ]
  const missing = request.missing?.length ? request.missing : ['审计财务数据', '客户访谈', '工商股权穿透']
  const isZeeLin = request.project.name.includes('智灵动力') || request.project.name.includes('ZeeLin')

  const addLogo = (slide: PptxGenJS.Slide, x = 10.9, y = 0.2, w = 1.75, h = 0.48) => {
    if (existsSync(logoPath)) slide.addImage({ path: logoPath, x, y, w, h })
    else slide.addText('赛智伯乐投资中台', { x, y, w, h, fontSize: 14, bold: true, color: blue, align: 'right', margin: 0 })
  }

  const addFooter = (slide: PptxGenJS.Slide, page: number, sourceText?: string) => {
    slide.addShape(pptx.ShapeType.line, { x: 0.55, y: 7.05, w: 12.2, h: 0, line: { color: line, width: 0.6 } })
    slide.addText(sourceText || `来源：项目档案与已授权资料 · 模板：${request.template}`, { x: 0.65, y: 7.12, w: 10.9, h: 0.18, color: '8B98AA', fontSize: 7.2, margin: 0, fit: 'shrink' })
    slide.addText(String(page), { x: 12.0, y: 7.1, w: 0.45, h: 0.18, color: '8B98AA', fontSize: 7.5, align: 'right', margin: 0 })
  }

  const contentFor = (title: string) => {
    if (title.includes('投资结论')) return {
      takeaway: isZeeLin ? '建议进入立项核验：产品矩阵可在线验证，但收入质量、团队真实性与产品复用率尚未形成投资闭环。' : `建议继续推进${request.project.name}，前提是关键经营指标、估值和核心风险完成交叉验证。`,
      cards: [
        { label: '产品与方向', value: highlights[0] ?? request.project.summary },
        { label: '商业化判断', value: highlights[1] ?? request.project.businessModel },
        { label: '当前结论', value: '方向具备研究价值，现阶段结论属于“有条件推进”，不等于最终投资决策。' },
      ],
    }
    if (title.includes('行业趋势') || title.includes('赛道机会')) return {
      takeaway: `${request.project.industry}正在从能力演示走向真实业务流程，能否稳定交付、持续复购并形成数据闭环是投资分水岭。`,
      cards: [
        { label: '需求变化', value: '客户采购从“模型能力”转向“业务结果”，产品需要进入高频、可量化的工作流。' },
        { label: '竞争焦点', value: '竞争壁垒由单点算法转向数据、场景知识、交付效率与渠道协同的组合。' },
        { label: '项目含义', value: request.project.market || '需要用客户付费、复购和交付毛利验证真实市场需求。' },
      ],
    }
    if (title.includes('政策')) return {
      takeaway: '政策和产业数字化提供方向性支撑，但政策利好不能替代客户需求、产品价值与可持续收入的验证。',
      cards: [
        { label: '政策口径', value: '正式版需补充国家、地方与行业主管部门的原文链接和发布日期。' },
        { label: '需求确定性', value: '重点判断预算来源、采购主体、采购频率与是否依赖一次性补贴。' },
        { label: '待补证据', value: missing.find((item) => item.includes('政策')) ?? '行业政策原文、客户预算和招投标数据待补充。' },
      ],
    }
    if (title.includes('痛点')) return {
      takeaway: '项目价值不在于功能数量，而在于能否对高频痛点形成更低成本、更高质量或更短周期的可量化改善。',
      cards: [
        { label: '客户痛点', value: '现有流程信息分散、专业知识依赖个人、交付周期长且结果难复用。' },
        { label: '产品解法', value: request.project.summary },
        { label: '验证方法', value: '通过客户访谈、合同范围、上线周期和前后指标对比交叉验证。' },
      ],
    }
    if (title.includes('公司发展') || title.includes('股权')) return {
      takeaway: `${request.project.companyName}已形成项目档案，但工商主体、股权穿透和历史融资应以合规数据源及原件为准。`,
      cards: [
        { label: '公司主体', value: `${request.project.companyName} · ${request.project.industry} · 当前阶段 ${request.project.stage}` },
        { label: '发展状态', value: request.project.summary },
        { label: '治理核验', value: missing.find((item) => item.includes('工商') || item.includes('股权')) ?? '工商档案、股东协议、代持和关联方待核验。' },
      ],
    }
    if (title.includes('核心产品')) return {
      takeaway: isZeeLin ? 'ZeeLin 已公开研究、视频、短剧、数字人和营销产品，投资关键是验证多产品能否共享同一底座并形成可复用收入。' : '核心产品需要同时证明“客户愿意用、愿意付费、可重复交付”，单次功能演示不足以构成壁垒。',
      cards: [
        { label: '产品定位', value: request.project.summary },
        { label: '业务模式', value: request.project.businessModel },
        { label: '验证重点', value: '区分标准产品、定制实施和服务收入，核验交付人天、续费率和毛利。' },
      ],
    }
    if (title.includes('技术')) return {
      takeaway: isZeeLin ? '自进化智能体框架与 FDE 路径具备叙事完整性，但需用复用率、性能基准和客户结果证明工程壁垒。' : '技术先进性只有转化为性能、成本、交付或数据优势，才会形成可持续投资壁垒。',
      cards: [
        { label: '技术主张', value: isZeeLin ? '企业材料披露自进化智能体框架、Agentic RAG、长期记忆和多智能体协作。' : request.project.summary },
        { label: '壁垒判断', value: '关注专有数据、场景知识、核心组件复用、性能基准与知识产权归属。' },
        { label: '核验任务', value: '代码与架构评审、知识产权清单、性能压测、客户环境复现。' },
      ],
    }
    if (title.includes('产业协同') || title.includes('生态')) return {
      takeaway: '产业资源只有落实为客户、渠道、联合产品或供应链能力，才能成为投资价值而非名单展示。',
      cards: [
        { label: '协同方向', value: '对接赛智伯乐产业资源、区域平台和被投企业，形成客户验证与联合解决方案机会。' },
        { label: '评价标准', value: '用在手合作协议、转化漏斗、交付责任和收益分配判断协同质量。' },
        { label: '风险提示', value: '框架协议、交流活动与真实订单必须分开披露。' },
      ],
    }
    if (title.includes('团队')) return {
      takeaway: '团队判断应同时覆盖技术、产品、销售和交付；核心成员的全职状态、股权绑定与历史业绩需要原件验证。',
      cards: [
        { label: '团队概况', value: request.project.team },
        { label: '能力匹配', value: '重点判断创始人认知、技术负责人深度、行业销售与规模交付经验。' },
        { label: '待核验', value: '劳动关系、竞业限制、核心成员稳定性、历史项目与持股安排。' },
      ],
    }
    if (title.includes('落地验证') || title.includes('标杆场景')) return {
      takeaway: '案例价值取决于真实付费、持续使用与结果改善；POC、试用、签约和收入确认应采用不同口径。',
      cards: [
        { label: '场景筛选', value: '优先验证高频、刚需、可量化且数据可获取的业务场景。' },
        { label: '核心指标', value: '客户数量、付费金额、上线周期、活跃使用、续费率、交付毛利。' },
        { label: '证据要求', value: '合同、发票、回款、系统日志和客户访谈至少形成两类交叉证据。' },
      ],
    }
    if (title.includes('客户访谈')) return {
      takeaway: '客户访谈的目标不是确认“关系存在”，而是验证采购动机、使用深度、替代成本和续费意愿。',
      cards: [
        { label: '业务负责人', value: '核验真实痛点、使用频率、结果改善和续费意愿。' },
        { label: '采购与财务', value: '核验合同、预算、付款条件、验收口径和回款节奏。' },
        { label: '交叉验证', value: missing.find((item) => item.includes('客户')) ?? '至少访谈 3 类角色，并与合同和系统数据相互印证。' },
      ],
    }
    if (title.includes('竞争格局') || title.includes('可比')) return {
      takeaway: '可比分析应拆分产品形态、目标客户、收入模式和交付成本，避免只按赛道标签进行估值类比。',
      cards: [
        { label: '直接竞争', value: '同类产品在核心工作流、性能、价格和渠道上的正面竞争。' },
        { label: '替代方案', value: '客户自研、人工服务、传统软件及通用模型均可能构成替代。' },
        { label: '估值口径', value: '收入质量、增长、毛利、续费和现金消耗应优先于融资新闻。' },
      ],
    }
    if (title.includes('商业模式')) return {
      takeaway: '规模化的关键是让标准产品收入增速高于定制交付人力，形成可预测续费和健康毛利。',
      cards: [
        { label: '当前模式', value: request.project.businessModel },
        { label: '收入拆分', value: '建议按订阅/API、私有化部署、实施服务和其他收入拆分合同与毛利。' },
        { label: '关键指标', value: 'ARR、续费率、客单价、销售周期、交付人天、贡献毛利和回款周期。' },
      ],
    }
    if (title.includes('市场空间')) return {
      takeaway: '市场空间应从可服务客户数、真实客单价和渗透节奏自下而上测算，避免直接引用宽口径行业规模。',
      cards: [
        { label: 'TAM', value: '全部潜在客户 × 理论客单价；仅用于说明长期天花板。' },
        { label: 'SAM', value: '当前产品、区域和渠道可触达的细分客户。' },
        { label: 'SOM', value: '结合销售产能、交付能力和竞争格局推算 3–5 年可实现份额。' },
      ],
    }
    if (title.includes('历史财务') || title.includes('订单')) return {
      takeaway: '当前缺少足以支持收入质量判断的审计口径数据；正式上会前必须完成合同—交付—验收—开票—回款穿透。',
      cards: [
        { label: '当前披露', value: isZeeLin ? '企业 BP 主要提供未来预测，未形成可独立核验的历史实际财务序列。' : `计划融资 ${request.project.financing}；投前估值 ${request.project.valuation}。` },
        { label: '质量检查', value: '核验收入确认、毛利归集、应收账龄、客户集中度、关联交易和经营现金流。' },
        { label: '资料缺口', value: missing.join('、') },
      ],
    }
    if (title.includes('盈利预测')) return {
      takeaway: '预测只能作为经营假设，不是已实现业绩；应通过客户数、客单价、交付产能和费用率逐层拆解。',
      cards: [
        { label: '企业预测', value: isZeeLin ? 'BP 展示 2026–2029 年收入预测；全部属于企业自述/模拟口径，正式版需取得模型底稿。' : '预测数据待项目方提供可编辑模型与关键假设。' },
        { label: '敏感变量', value: '客户转化、平均客单价、续费率、交付人效、模型/算力成本和销售费用率。' },
        { label: '压力测试', value: '设置基准、乐观和审慎三种情景，优先观察现金缺口与下一轮融资时点。' },
      ],
    }
    if (title.includes('融资方案')) return {
      takeaway: request.project.financing.includes('未披露') ? '本轮融资金额和估值尚未披露，不能在材料中假设；应先取得正式融资方案与资金预算。' : `本轮计划融资 ${request.project.financing}，投前估值 ${request.project.valuation}；需与里程碑和资金缺口匹配。`,
      cards: [
        { label: '融资口径', value: `融资：${request.project.financing}；估值：${request.project.valuation}` },
        { label: '资金用途', value: isZeeLin ? '企业 BP 计划用于平台研发、FDE 团队、内容工厂、算力模型与合资合作；金额分配待补。' : '研发、销售、交付和营运资金应与 18–24 个月里程碑逐项对应。' },
        { label: '决策要求', value: '明确投资金额、股比、交割条件、治理权利、反稀释及下一轮触发条件。' },
      ],
    }
    if (title.includes('风险')) return {
      takeaway: '核心风险应被转化为可执行的尽调任务、投资条款或投后监控指标，而不是停留在提示层面。',
      cards: [
        { label: '商业风险', value: risks[0] ?? '客户付费、复购和收入质量待验证。' },
        { label: '产品 / 组织风险', value: risks[1] ?? '产品规模化与团队稳定性待验证。' },
        { label: '应对措施', value: `${risks[2] ?? '设置前置核验与交割条件。'}；重大未闭环事项进入投决附带条件。` },
      ],
    }
    if (title.includes('退出路径')) return {
      takeaway: '退出回报取决于企业经营兑现与资本市场窗口，材料不对单一路径或回报倍数作无依据承诺。',
      cards: [
        { label: '产业并购', value: '关注产业方在产品、数据、客户和团队方面的战略协同价值。' },
        { label: '后续融资 / 股权转让', value: '以前置业绩里程碑、估值纪律和股东权利保障流动性。' },
        { label: '资本市场', value: '需结合收入规模、利润质量、合规治理和政策窗口动态评估。' },
      ],
    }
    if (title.includes('尽调结论') || title.includes('下一步')) return {
      takeaway: '下一阶段目标是把“企业自述”转化为可交叉验证的事实，并将未闭环问题明确到责任人、资料和完成时点。',
      cards: [
        { label: '优先事项', value: missing.slice(0, 3).join('、') },
        { label: '流程动作', value: `当前项目阶段为 ${request.project.stage}；下一阶段必须通过 OA 审批，不允许人工直接改状态。` },
        { label: '建议结论', value: '完成关键核验后再形成正式投资建议与交易方案；本材料仅为内部讨论初稿。' },
      ],
    }
    return {
      takeaway: `${title}需要用项目资料、公开来源和访谈证据共同支撑，资料不足处保持“待核验”。`,
      cards: [
        { label: '项目事实', value: request.project.summary },
        { label: '投资含义', value: request.project.businessModel },
        { label: '待核验', value: missing.join('、') },
      ],
    }
  }

  const cover = pptx.addSlide()
  cover.background = { color: 'F7FAFE' }
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 2.25, h: 7.5, fill: { color: blue }, line: { color: blue } })
  cover.addShape(pptx.ShapeType.rect, { x: 2.25, y: 0, w: 0.12, h: 7.5, fill: { color: yellow }, line: { color: yellow } })
  if (existsSync(logoPath)) cover.addImage({ path: logoPath, x: 0.35, y: 0.55, w: 1.55, h: 0.48 })
  else cover.addText('赛智伯乐投资中台', { x: 0.35, y: 0.55, w: 1.85, h: 0.4, color: 'FFFFFF', fontSize: 14, bold: true, margin: 0 })
  cover.addText('浙江赛智伯乐\nINVESTMENT RECOMMENDATION', { x: 0.35, y: 1.28, w: 1.55, h: 0.72, color: 'FFFFFF', fontSize: 10, bold: true, breakLine: false, margin: 0, fit: 'shrink' })
  cover.addText(request.project.name, { x: 2.9, y: 2.0, w: 8.9, h: 0.7, color: ink, fontSize: 30, bold: true, margin: 0, fit: 'shrink' })
  cover.addText('投资建议书（内部讨论稿）', { x: 2.92, y: 2.82, w: 5.6, h: 0.42, color: blue, fontSize: 18, bold: true, margin: 0 })
  cover.addText(request.project.summary, { x: 2.92, y: 3.5, w: 8.65, h: 1.0, color: muted, fontSize: 13.5, breakLine: false, margin: 0.02, fit: 'shrink', valign: 'middle' })
  cover.addText(`${request.project.industry} · 当前阶段 ${request.project.stage} · ${formatShanghaiDate(new Date())}`, { x: 2.92, y: 5.3, w: 7.5, h: 0.3, color: '6B7A90', fontSize: 10.5, margin: 0 })
  cover.addText('重要口径：企业自述、公开披露与待核验信息分开呈现；本文件不构成最终投资决策。', { x: 2.92, y: 6.38, w: 8.6, h: 0.36, color: '9A6B1B', fontSize: 8.5, margin: 0.02, fit: 'shrink' })
  cover.addText('内部资料 · 严禁外传', { x: 10.5, y: 7.05, w: 1.8, h: 0.2, color: '9AA6B6', fontSize: 7.5, align: 'right', margin: 0 })

  request.outline.slice(0, 22).forEach((title, index) => {
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.07, fill: { color: blue }, line: { color: blue } })
    addLogo(slide)
    slide.addShape(pptx.ShapeType.rect, { x: 0.55, y: 0.82, w: 0.82, h: 5.85, fill: { color: blue }, line: { color: blue } })
    slide.addShape(pptx.ShapeType.rect, { x: 0.55, y: 0.82, w: 0.82, h: 0.12, fill: { color: yellow }, line: { color: yellow } })
    slide.addText(String(index + 1).padStart(2, '0'), { x: 0.68, y: 1.16, w: 0.56, h: 0.35, color: 'FFFFFF', fontSize: 15, bold: true, align: 'center', margin: 0 })
    slide.addText(title, { x: 0.68, y: 1.75, w: 0.56, h: 3.85, color: 'FFFFFF', fontSize: 12, bold: true, breakLine: false, vert: 'vert270', align: 'center', valign: 'middle', margin: 0, fit: 'shrink' })
    slide.addText(title, { x: 1.72, y: 0.68, w: 8.8, h: 0.42, color: ink, fontSize: 21, bold: true, margin: 0, fit: 'shrink' })
    const content = contentFor(title)
    slide.addText(content.takeaway, { x: 1.72, y: 1.37, w: 10.65, h: 0.82, color: blue, fontSize: 17, bold: true, margin: 0.02, fit: 'shrink', valign: 'middle' })
    content.cards.forEach((card, cardIndex) => {
      const x = 1.72 + cardIndex * 3.58
      const cardColor = cardIndex === 2 ? 'FFF9EB' : lightBlue
      const cardLine = cardIndex === 2 ? 'F3D99E' : 'D8E5F4'
      slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.55, w: 3.28, h: 3.45, rectRadius: 0.05, fill: { color: cardColor }, line: { color: cardLine, width: 1 } })
      slide.addShape(pptx.ShapeType.rect, { x: x + 0.22, y: 2.83, w: 0.08, h: 0.34, fill: { color: cardIndex === 2 ? yellow : blue }, line: { color: cardIndex === 2 ? yellow : blue } })
      slide.addText(card.label, { x: x + 0.42, y: 2.81, w: 2.45, h: 0.34, color: ink, fontSize: 13, bold: true, margin: 0 })
      slide.addText(card.value, { x: x + 0.28, y: 3.42, w: 2.72, h: 2.05, color: muted, fontSize: 11.2, margin: 0.04, breakLine: false, fit: 'shrink', valign: 'top' })
      slide.addText(cardIndex === 0 ? '事实 / 证据' : cardIndex === 1 ? '投资含义' : '判断 / 待核验', { x: x + 0.28, y: 5.58, w: 2.72, h: 0.2, color: cardIndex === 2 ? 'A56A00' : '6F84A0', fontSize: 7.5, bold: true, margin: 0 })
    })
    const source = sources[index % Math.max(1, sources.length)]
    const sourceText = source
      ? `来源：${source.title}（${source.category}，可靠性 ${source.reliability}） · ${source.url}`
      : `来源：${request.files?.join('、') || '项目档案'} · 公开来源待补充`
    addFooter(slide, index + 2, sourceText)
  })

  const fileName = `${safeName(request.project.name)}_投资建议书_${Date.now()}.pptx`
  await pptx.writeFile({ fileName: path.join(outputDir, fileName) })
  return fileName
}

async function generateDocx(request: MaterialRequest, outputDir: string) {
  const sections = request.outline.map((title, index) => [
    new Paragraph({ text: `${index + 1}. ${title}`, heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 180 } }),
    new Paragraph({
      children: [new TextRun({ text: index === 0 ? `本项目建议继续推进，但需以关键资料补充与客户验证为前提。${request.project.summary}` : `本章节基于已授权项目资料生成初稿。${request.project.businessModel}`, color: '445269', size: 22 })],
      spacing: { after: 180 },
    }),
    new Paragraph({ text: '资料不足处已明确标记为待补充，不构成最终投资意见。', bullet: { level: 0 }, spacing: { after: 100 } }),
  ]).flat()
  const doc = new Document({
    creator: '浙江赛智伯乐股权投资管理有限公司投资中台',
    title: `${request.project.name} 投资备忘录`,
    description: 'AI 生成初稿，需人工审核',
    sections: [{
      properties: {},
      children: [
        new Paragraph({ children: [new TextRun({ text: '浙江赛智伯乐股权投资管理有限公司投资中台', bold: true, color: '1B4685', size: 24 })], spacing: { after: 720 } }),
        new Paragraph({ text: request.project.name, heading: HeadingLevel.TITLE, spacing: { after: 240 } }),
        new Paragraph({ children: [new TextRun({ text: '投资备忘录（AI 初稿）', bold: true, color: '3977E8', size: 28 })], spacing: { after: 420 } }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('所属行业')] }), new TableCell({ children: [new Paragraph(request.project.industry)] }), new TableCell({ children: [new Paragraph('项目阶段')] }), new TableCell({ children: [new Paragraph(request.project.stage)] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('计划融资')] }), new TableCell({ children: [new Paragraph(request.project.financing)] }), new TableCell({ children: [new Paragraph('投前估值')] }), new TableCell({ children: [new Paragraph(request.project.valuation)] })] }),
          ],
        }),
        new Paragraph({ text: '重要声明：本文件由 AI 基于已授权资料生成，仅供内部研究，不构成最终投资决策。', spacing: { before: 420, after: 420 } }),
        ...sections,
      ],
    }],
  })
  const fileName = `${safeName(request.project.name)}_投资备忘录_${Date.now()}.docx`
  const buffer = await Packer.toBuffer(doc)
  await import('node:fs/promises').then((fs) => fs.writeFile(path.join(outputDir, fileName), buffer))
  return fileName
}

async function generateXlsx(request: MaterialRequest, outputDir: string) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '浙江赛智伯乐股权投资管理有限公司投资中台'
  const summary = workbook.addWorksheet('项目概览')
  summary.columns = [{ header: '字段', key: 'field', width: 24 }, { header: '内容', key: 'value', width: 70 }]
  summary.addRows([
    { field: '项目名称', value: request.project.name },
    { field: '所属行业', value: request.project.industry },
    { field: '融资金额', value: request.project.financing },
    { field: '投前估值', value: request.project.valuation },
    { field: '项目阶段', value: request.project.stage },
    { field: '项目简介', value: request.project.summary },
  ])
  summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3977E8' } }
  summary.eachRow((row) => { row.alignment = { vertical: 'middle', wrapText: true }; row.height = 26 })

  const financial = workbook.addWorksheet('财务分析')
  financial.columns = [
    { header: '指标', key: 'metric', width: 24 },
    { header: '2024A', key: 'y2024', width: 16 },
    { header: '2025A', key: 'y2025', width: 16 },
    { header: '2026E', key: 'y2026', width: 16 },
    { header: '2027E', key: 'y2027', width: 16 },
    { header: '备注', key: 'note', width: 36 },
  ]
  financial.addRows([
    { metric: '营业收入（万元）', y2024: '待补充', y2025: '待补充', y2026: '待补充', y2027: '待补充', note: '请替换为审计口径数据' },
    { metric: '收入增长率', y2024: '-', y2025: { formula: 'IFERROR(C2/B2-1,0)' }, y2026: { formula: 'IFERROR(D2/C2-1,0)' }, y2027: { formula: 'IFERROR(E2/D2-1,0)' }, note: '公式已预置' },
    { metric: '综合毛利率', y2024: '待补充', y2025: '待补充', y2026: '待补充', y2027: '待补充', note: '核验成本归集口径' },
    { metric: '经营现金流（万元）', y2024: '待补充', y2025: '待补充', y2026: '待补充', y2027: '待补充', note: '' },
  ])
  financial.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  financial.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3977E8' } }
  financial.views = [{ state: 'frozen', ySplit: 1 }]
  const fileName = `${safeName(request.project.name)}_财务分析_${Date.now()}.xlsx`
  await workbook.xlsx.writeFile(path.join(outputDir, fileName))
  return fileName
}

export async function generateMaterial(request: MaterialRequest, userId: string) {
  await ensureDir(userId)
  const outputDir = userGeneratedDir(userId)
  const fileName = request.type === 'xlsx'
    ? await generateXlsx(request, outputDir)
    : request.type === 'docx'
      ? await generateDocx(request, outputDir)
      : await generatePptx(request, outputDir)
  return { fileName, url: `/api/generated/${encodeURIComponent(fileName)}` }
}
