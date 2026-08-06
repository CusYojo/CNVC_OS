import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BusinessContent } from '../src/services/aiBusinessContentService.js'
import {
  annotateGordenTextWeightQa,
  buildGordenIconRetryPrompt,
  buildGordenVisualQaPrompt,
  buildReferenceDrivenSemanticOverrides,
  buildGordenSlidePlan,
  buildGordenSlidePrompt,
  buildGordenTextContractRetryPrompt,
  buildGordenEditableLayerPrompts,
  gordenSlidePlanFingerprint,
  gordenLayoutGuardArgs,
  gordenUnplannedVisibleTexts,
  gordenVisionRetryDelayMs,
  gordenSkillPaths,
  isGordenVisionRetryableStatus,
  normalizeGordenLayout,
  referenceDrivenSkillPaths,
  reusableGordenVisualReview,
  selectInvestmentRecommendationReference,
  unsafeGordenIconFiles,
  upgradeGordenCheckpointTextLayouts,
} from '../src/services/aiGordenSuperPptService.js'
import {
  assertInvestmentRecommendationSkillChain,
  mustUseReferenceDrivenPptPipeline,
} from '../src/services/aiBusinessDocumentService.js'
import {
  safeAiTaskFailureMessage,
  safeAiTaskFailureStage,
} from '../src/services/aiTaskErrorService.js'
import { remapInvestmentRecommendationCheckpointSources } from '../src/services/aiTaskService.js'
import { AI_TEMPLATE_CATALOG } from '../src/services/aiTemplateCatalog.js'
import { prepareInvestmentRecommendationPptWorkflow } from '../src/services/aiInvestmentRecommendationPptWorkflowService.js'
import {
  AI_PPT_WORKFLOW_SKILLS,
  loadAiSkill,
} from '../src/services/aiSkillService.js'

const topics = [
  ['公司简介', '公司成立于 2024 年，主营工业智能软件。'],
  ['核心团队', '创始人拥有十年行业经验，履历仍需背调。'],
  ['财务分析', '2025 年收入 1200 万元，口径以审计报告为准。'],
  ['融资方案', '本轮拟融资 5000 万元，主要用于研发和市场拓展。'],
  ['估值分析', '拟投前估值 4 亿元，依据仍需可比公司复核。'],
  ['交易方案', '拟股权投资 3000 万元，交割条件以正式协议为准。'],
] as const

const content: BusinessContent = {
  title: '智灵动力投资建议书',
  executiveSummary: '公司面向工业场景提供智能软件，投资判断取决于客户续约、收入质量及本轮交易条款的核实结果。',
  executiveSummarySourceIndexes: [0],
  sections: topics.map(([title, summary], index) => ({
    title,
    summary,
    summarySourceIndexes: [index],
    findings: [{
      text: `${title}的详细事实、判断和待核验边界。`,
      status: '资料记载',
      sourceIndexes: [index],
    }],
  })),
  highlights: ['产品已进入工业客户验证，收入质量仍需结合合同与回款核对。'],
  risks: ['财务数据仍需审计', '交易条款仍需法务确认'],
  missing: [],
}

test('Gorden slide plan carries detailed company, team, finance, funding, valuation and deal content', () => {
  const plan = buildGordenSlidePlan({
    project: {
      name: '智灵动力',
      companyName: '杭州智灵动力科技有限公司',
      industry: '工业智能',
      stage: '成长期',
      financing: '本轮融资金额待核验',
      valuation: '估值口径待核验',
      businessModel: '以工业智能软件订阅与项目交付形成收入',
    },
    content,
    disclaimer: '本材料仅供内部投资决策使用。',
    references: ['项目档案', '公司官网'],
  })

  assert.equal(plan.length, topics.length + 2)
  assert.equal(plan[0].role, 'cover')
  assert.deepEqual(plan[0].expectedTexts, [
    '智灵动力投资建议书',
    '杭州智灵动力科技有限公司',
    '工业智能项目',
  ])
  assert.equal(plan[0].expectedTexts.some((text) => /^\d+$/u.test(text)), false)
  assert.equal(plan.at(-1)?.role, 'risk')
  assert.equal(plan.at(-1)?.title, '投资结论与关键风险')
  assert.ok(plan.at(-1)?.expectedTexts.includes('投资结论'))
  assert.ok(plan.at(-1)?.expectedTexts.includes('主要风险与待落实事项'))
  assert.ok(plan.at(-1)?.expectedTexts.includes('资料来源与声明'))
  assert.ok(plan.at(-1)?.expectedTexts.includes('引用资料：公司官网'))
  for (const [title, detail] of topics) {
    const slide = plan.find((item) => item.title === title)
    assert.ok(slide, `missing slide: ${title}`)
    assert.ok(slide.expectedTexts.includes(detail), `missing detail: ${detail}`)
  }
  assert.ok(plan.at(-1)?.expectedTexts.includes('本材料仅供内部投资决策使用。'))
})

test('Gorden pages carry point-of-use sources and structured table rows', () => {
  const tableContent: BusinessContent = {
    ...content,
    sections: content.sections.map((section, index) => index === 2 ? {
      ...section,
      tables: [{
        title: '历史财务表现',
        unit: '万元',
        columns: ['指标', '2024年', '2025年'],
        rows: [
          ['营业收入', '800', '1200'],
          ['净利润', '-300', '-120'],
          ['经营现金流', '-450', '-500'],
        ],
        status: '资料记载',
        sourceIndexes: [0, 1],
      }],
    } : section),
  }
  const plan = buildGordenSlidePlan({
    project: { name: '智灵动力' },
    content: tableContent,
    disclaimer: '内部使用。',
    sources: [
      { sourceType: 'file', sourceName: '审计报告.pdf', content: '历史财务' },
      { sourceType: 'public_web', sourceName: '公司官网', content: '公司披露' },
    ],
  })
  const financialSlide = plan.find((slide) => slide.title === '财务分析')
  assert.ok(financialSlide)
  assert.ok(financialSlide.expectedTexts.includes('历史财务表现'))
  assert.ok(financialSlide.expectedTexts.includes('指标｜2024年｜2025年'))
  assert.ok(financialSlide.expectedTexts.includes('营业收入｜800｜1200'))
  assert.ok(financialSlide.expectedTexts.includes('资料来源：审计报告.pdf；公司官网'))

  const compactPlan = buildGordenSlidePlan({
    project: { name: '智灵动力' },
    content: tableContent,
    disclaimer: '内部使用。',
    sources: [
      { sourceType: 'file', sourceName: '审计报告.pdf', content: '历史财务' },
      { sourceType: 'public_web', sourceName: '公司官网', content: '公司披露' },
    ],
    pageCount: '5',
  })
  assert.ok(compactPlan[3].expectedTexts.includes('历史财务表现'))
  assert.ok(compactPlan[3].expectedTexts.includes('营业收入｜800｜1200'))
  assert.ok(compactPlan[3].expectedTexts.includes('资料来源：审计报告.pdf；公司官网'))
})

test('Gorden image prompt uses the loaded package contract and exact project text', async () => {
  const slide = buildGordenSlidePlan({
    project: { name: '智灵动力' },
    content,
    disclaimer: '内部使用。',
  })[1]
  const workflow = await prepareInvestmentRecommendationPptWorkflow(
    AI_TEMPLATE_CATALOG.investment_recommendation_ppt,
  )
  const prompt = buildGordenSlidePrompt({
    slide,
    projectName: '智灵动力',
    sourceNames: ['项目档案', '公司官网'],
    palette: ['#123456', '#ABCDEF'],
    skillContract: `GordenSuperPPTSkills 包版本：${workflow.gordenPackage.packageSha256.slice(0, 16)}\n复杂排版与每页不重样`,
  })

  assert.match(prompt, /唯一设计与执行规范：GordenSuperPPTSkills/)
  assert.match(prompt, /GordenSuperPPTSkills 包版本/)
  assert.match(prompt, /复杂排版与每页不重样/)
  assert.match(prompt, /不得生成写实人物、虚构产品、虚构客户 Logo 或虚构证书/)
  assert.doesNotMatch(prompt, /模板页作为唯一视觉参考/)
  assert.match(prompt, /必须逐字照排，不得改写、遗漏或新增/)
  assert.match(prompt, new RegExp(`可读文字总数必须恰好为 ${slide.expectedTexts.length} 条`))
  assert.match(prompt, /不得在页面上额外新增来源名称/)
  assert.match(prompt, /已明确列入上方“页面可见文字”清单/)
  assert.match(prompt, /清单没有对应文字时，删除该模块/)
  assert.match(prompt, /必须完整放在一个连续文本区域内/)
  assert.match(prompt, /不得自行生成 1、2、3/)
  assert.match(prompt, /禁止生成任何带文字的流程图/)
  assert.match(prompt, /大脑、信号采集、解码、外部设备/)
  assert.ok(slide.expectedTexts.every((value) => prompt.includes(value)))
})

test('Gorden editable icon layer excludes text and fixed-grid slicing assumptions', () => {
  const prompts = buildGordenEditableLayerPrompts('#00ff00')
  assert.match(prompts.icons, /不得包含任何中文、英文、数字/)
  assert.match(prompts.icons, /文字将由后续流程生成为原生可编辑文本/)
  assert.match(prompts.icons, /不得包含.*横线、竖线、分隔线/)
  assert.doesNotMatch(prompts.icons, /4×4 等分网格/)
  assert.match(prompts.icons, /连续纯色空隙/)
  assert.match(prompts.frame, /不得混入 #00ff00/)
})

test('Gorden final visual QA blocks content failures but permits decorative drift', () => {
  const prompt = buildGordenVisualQaPrompt(['公司主体', '未披露，待核验', '未披露，待核验'])
  assert.match(prompt, /交付安全门，不是像素级临摹评分/)
  assert.match(prompt, /文字被严重遮挡、裁切、重叠或小到不可读/)
  assert.match(prompt, /非阻断.*边框粗细或颜色/)
  assert.match(prompt, /意外多生成的重复文字/)
  assert.equal(prompt.match(/未披露，待核验/g)?.length, 2)
})

test('Gorden vision QA retries transient gateway failures and reuses passed checkpoints', () => {
  assert.equal(isGordenVisionRetryableStatus(429), true)
  assert.equal(isGordenVisionRetryableStatus(502), true)
  assert.equal(isGordenVisionRetryableStatus(400), false)
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(gordenVisionRetryDelayMs),
    [3_000, 8_000, 20_000, 45_000, 45_000],
  )
  assert.equal(reusableGordenVisualReview({ passed: true, criticalIssues: [] }), true)
  assert.equal(reusableGordenVisualReview({ passed: true, criticalIssues: ['缺字'] }), false)
  assert.equal(reusableGordenVisualReview({ passed: false, criticalIssues: [] }), false)
})

test('Gorden slide plan honors an explicit five-page request', () => {
  const plan = buildGordenSlidePlan({
    project: { name: '智灵动力' },
    content,
    disclaimer: '内部使用。',
    pageCount: '5',
  })
  assert.equal(plan.length, 5)
  assert.equal(plan[0].role, 'cover')
  assert.deepEqual(plan.map((slide) => slide.role), [
    'cover',
    'summary',
    'product',
    'investment-plan',
    'risk',
  ])
  assert.deepEqual(plan.slice(1, 4).map((slide) => slide.title), [
    '公司概况与投资摘要',
    '产品技术与商业验证',
    '财务表现、估值与交易方案',
  ])
  for (const [title] of topics) {
    assert.ok(plan.some((slide) => slide.expectedTexts.includes(title)), `missing grouped topic: ${title}`)
  }
  assert.equal(plan.flatMap((slide) => slide.expectedTexts).some((text) => /^\d+$/u.test(text)), false)
  assert.ok(plan[1].expectedTexts.includes(topics[0][1]))
  assert.ok(plan[1].expectedTexts.includes(topics[1][1]))
  assert.ok(plan[3].expectedTexts.some((text) => /1200 万元|5000 万元|4 亿元|3000 万元/.test(text)))
})

test('five-page planning keeps financial operating quality on the decision page', () => {
  const focusedContent: BusinessContent = {
    ...content,
    sections: [
      content.sections[0],
      {
        title: '产品、技术与工程化进展',
        summary: '公司围绕数据采集、仿真训练和工具链形成产品体系。',
        findings: [],
      },
      {
        title: '行业趋势与市场空间',
        summary: '行业仍处早期阶段，高质量数据供给是关键瓶颈。',
        findings: [],
      },
      {
        title: '财务表现与经营质量',
        summary: '收入、合同、验收、回款和复购需要统一核验。',
        findings: [],
      },
      {
        title: '融资、估值与交易安排',
        summary: '融资金额、估值和交割条件以正式协议为准。',
        findings: [],
      },
      {
        title: '融资、估值与交易安排（2）',
        summary: '历史融资和本轮交易口径需要统一。',
        findings: [],
      },
      {
        title: '关键风险与核验重点',
        summary: '主体、财务和客户真实性仍需重点核验。',
        findings: [],
      },
      {
        title: '关键风险与核验重点（2）',
        summary: '交割条件和回款证据尚需补强。',
        findings: [],
      },
    ],
  }
  const plan = buildGordenSlidePlan({
    project: { name: '大衍科技', industry: '具身智能' },
    content: focusedContent,
    disclaimer: '内部使用。',
    pageCount: '5',
  })
  assert.ok(plan[2].expectedTexts.includes('产品、技术与工程化进展'))
  assert.ok(plan[2].expectedTexts.includes('行业趋势与市场空间'))
  assert.equal(plan[2].expectedTexts.includes('财务表现与经营质量'), false)
  assert.ok(plan[3].expectedTexts.includes('财务表现与经营质量'))
  assert.ok(plan[3].expectedTexts.includes('融资、估值与交易安排'))
  assert.equal(plan[3].expectedTexts.filter((text) => text === '融资、估值与交易安排').length, 1)
  assert.equal(plan[3].expectedTexts.filter((text) => text === '关键风险与核验重点').length, 1)
  assert.equal(plan[3].expectedTexts.some((text) => /（2）/.test(text)), false)
  assert.equal(plan[3].expectedTexts.some((text) => /；/.test(text)), false)
  assert.ok(plan.slice(1, 4).every((slide) =>
    slide.expectedTexts.every((text) => text.length <= 110)))
})

test('five-page planning does not join unrelated duplicate summaries into one text box', () => {
  const plan = buildGordenSlidePlan({
    project: { name: '大衍科技', industry: '具身智能' },
    content: {
      ...content,
      sections: [
        content.sections[0],
        {
          title: '产品、技术与工程化进展',
          summary: '公司围绕数据采集、仿真训练和工具链形成产品体系。',
          findings: [],
        },
        {
          title: '融资、估值与交易安排',
          summary: '团队材料显示公司具备自动驾驶、AI与数字孪生背景的专家资源。',
          findings: [{ text: '核心团队由产业专家构成。', status: '资料记载', sourceIndexes: [0] }],
        },
        {
          title: '融资、估值与交易安排（2）',
          summary: '公司自述采用场景重建与生成式AI融合的技术路线。',
          findings: [],
        },
        {
          title: '融资、估值与交易安排（3）',
          summary: '已有交易框架采用增资入股与老股受让，并设置交割条件、治理权利及回购安排。',
          findings: [],
        },
        {
          title: '财务表现与经营质量',
          summary: '合同、验收、收入与回款口径仍需核验。',
          findings: [{ text: '交流纪要记载2025年收入主要来自数据销售。', status: '资料记载', sourceIndexes: [1] }],
        },
        {
          title: '关键风险与核验重点',
          summary: '已有交易框架倾向于增资入股与老股受让。',
          findings: [],
        },
        {
          title: '关键风险与核验重点（2）',
          summary: '核心风险包括主体与股权口径、收入与客户真实性以及技术可复制性。',
          findings: [],
        },
      ],
    },
    disclaimer: '内部使用。',
    pageCount: '5',
  })
  const decisionTexts = plan[3].expectedTexts
  assert.ok(decisionTexts.some((text) => /增资入股.*交割条件.*回购安排/.test(text)))
  assert.ok(decisionTexts.some((text) => /核心风险包括主体与股权口径/.test(text)))
  assert.equal(decisionTexts.some((text) => /团队材料显示/.test(text)), false)
  assert.equal(decisionTexts.some((text) => /场景重建与生成式AI/.test(text)), false)
  assert.equal(decisionTexts.some((text) => /；/.test(text)), false)
  assert.equal(decisionTexts.some((text) => /核心团队由产业专家构成/.test(text)), false)
  assert.ok(decisionTexts.every((text) => text.length <= 84))
})

test('Gorden text-contract retry removes invented architecture labels without relaxing facts', () => {
  const slide = buildGordenSlidePlan({
    project: { name: '大衍科技', industry: '具身智能' },
    content,
    disclaimer: '内部使用。',
    pageCount: '5',
  })[2]
  const prompt = buildGordenTextContractRetryPrompt({
    slide,
    unexpectedText: ['应用层', '平台层', '技术与商业验证路径'],
    missingTextIndexes: [2],
    attempt: 1,
  })
  assert.match(prompt, /先清除页面中的全部可读文字/)
  assert.match(prompt, /应用层；平台层；技术与商业验证路径/)
  assert.match(prompt, /必须恢复的缺失文字索引：\s*2/)
  assert.match(prompt, /禁止拆成层级标签、流程节点、图例、导航、编号卡片或自拟短语/)
  assert.match(prompt, /不得新增公司名、Logo 文字、来源名、日期、页码、年份、金额、比例/)
  assert.ok(slide.expectedTexts.every((text) => prompt.includes(text)))
})

test('Gorden cover stays restrained even when project fields are incomplete', () => {
  const plan = buildGordenSlidePlan({
    project: {
      name: '智灵动力',
      businessModel: '待资料解析后补充',
      valuation: '待资料解析后补充',
    },
    content,
    disclaimer: '内部使用。',
    pageCount: '5',
  })
  assert.deepEqual(plan[0].expectedTexts, ['智灵动力投资建议书', '智灵动力'])
  assert.equal(plan[0].expectedTexts.includes('待资料解析后补充'), false)
  assert.equal(plan.flatMap((slide) => slide.expectedTexts).some((text) => /项目阶段|线索阶段|待资料解析后补充/.test(text)), false)
})

test('five-page planning never exposes internal project stage metadata', () => {
  const plan = buildGordenSlidePlan({
    project: {
      name: '大衍科技',
      companyName: '大衍科技（桐乡）有限公司',
      industry: '具身智能',
      stage: '线索',
      businessModel: '待资料解析后补充',
      financing: '未披露，待核验',
      valuation: '未披露，待核验',
    },
    content,
    disclaimer: '本演示文稿仅供内部审议，不构成最终投资决策。',
    pageCount: '5',
  })
  const visibleText = plan.flatMap((slide) => slide.expectedTexts).join(' ')
  assert.doesNotMatch(visibleText, /项目阶段|线索阶段|待资料解析后补充|AI\s*(?:辅助|生成|初稿)/i)
  assert.doesNotMatch(visibleText, /融资概况：未披露|估值口径：未披露/)
})

test('investment PPT always disables docs and uploaded template references', () => {
  const robotics = selectInvestmentRecommendationReference({
    template: AI_TEMPLATE_CATALOG.investment_recommendation_ppt,
    project: { name: '大衍科技', industry: '具身智能' },
    content,
  })
  assert.equal(robotics.mode, 'gorden-native')
  assert.equal(robotics.id, 'gorden-skills-native')
  assert.equal(robotics.path, undefined)
  assert.deepEqual(robotics.sourceTemplates, [])

  const custom = selectInvestmentRecommendationReference({
    template: {
      referencePath: '/tmp/user-template.pptx',
      customAnalysis: {} as never,
    },
    project: { name: '自定义项目' },
    content,
  })
  assert.equal(custom.mode, 'gorden-native')
  assert.equal(custom.path, undefined)
  assert.deepEqual(custom.sourceTemplates, [])
})

test('Gorden checkpoint fingerprint ignores old file paths but rejects changed page content', () => {
  const base = buildGordenSlidePlan({
    project: { name: '智灵动力' },
    content,
    disclaimer: '内部使用。',
    pageCount: '5',
  })
  const oldRun = base.map((slide) => ({
    ...slide,
    referencePage: `/old-run/page-${slide.number}.png`,
    sourceIndexes: [...slide.sourceIndexes].reverse(),
  }))
  assert.equal(gordenSlidePlanFingerprint(base), gordenSlidePlanFingerprint(oldRun))
  const changed = base.map((slide, index) => index === 1
    ? { ...slide, expectedTexts: [...slide.expectedTexts, '新增内容'] }
    : slide)
  assert.notEqual(gordenSlidePlanFingerprint(base), gordenSlidePlanFingerprint(changed))
})

test('Gorden visual failures expose a safe actionable stage instead of the generic fallback', () => {
  const error = Object.assign(new Error('internal visual details'), {
    code: 'GORDEN_VISUAL_QA_REJECTED',
  })
  assert.equal(safeAiTaskFailureStage(error), 'Gorden 最终视觉复核未通过')
  assert.match(safeAiTaskFailureMessage(error), /文字缺失、严重遮挡、裁切或不可读/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal visual details/)
})

test('investment recommendation quality failures describe the professionality gate', () => {
  const error = Object.assign(new Error('internal content review details'), {
    code: 'INVESTMENT_RECOMMENDATION_CONTENT_QUALITY_REJECTED',
  })
  assert.equal(safeAiTaskFailureStage(error), '投资建议书正文专业性检查未通过')
  assert.match(safeAiTaskFailureMessage(error), /章节完整性、证据覆盖、数据表格、标题匹配/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal content review details/)

  const categorized = Object.assign(new Error('hidden'), {
    code: 'INVESTMENT_RECOMMENDATION_CONTENT_QUALITY_REJECTED',
    qualityIssues: [
      '章节“财务分析”内容过少',
      '仅 4/12 个章节关联了来源，证据覆盖不足',
      '正文包含多项数字但缺少结构化表格',
    ],
  })
  assert.match(safeAiTaskFailureMessage(categorized), /尚需完善：章节内容、来源引用、数据与表格/)
})

test('Gorden vision gateway failures expose the retained-page recovery path', () => {
  const error = Object.assign(new Error('internal gateway response'), {
    code: 'GORDEN_VISION_GATEWAY_FAILED',
    status: 502,
  })
  assert.equal(safeAiTaskFailureStage(error), 'Gorden 页面视觉定位未完成')
  assert.match(safeAiTaskFailureMessage(error), /保留成品页和已完成图层/)
  assert.match(safeAiTaskFailureMessage(error), /当前页面检查点恢复/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal gateway response/)
})

test('Gorden layout guard failures expose a specific safe stage', () => {
  const error = Object.assign(new Error('internal layout details'), {
    code: 'GORDEN_LAYOUT_GUARD_REJECTED',
  })
  assert.equal(safeAiTaskFailureStage(error), 'Gorden 页面布局检查未通过')
  assert.match(safeAiTaskFailureMessage(error), /字号、换行或字重/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal layout details/)
})

test('reference-driven bridge failures preserve the published image deck', () => {
  const error = Object.assign(new Error('internal bridge details'), {
    code: 'REFERENCE_DRIVEN_PDF_BRIDGE_FAILED',
  })
  assert.equal(safeAiTaskFailureStage(error), '图片版 PDF 桥接未完成')
  assert.match(safeAiTaskFailureMessage(error), /图片高保真版已经保留/)
  assert.match(safeAiTaskFailureMessage(error), /继续生成/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal bridge details/)
})

test('editable conversion failures distinguish the second delivery stage', () => {
  const error = Object.assign(new Error('internal conversion details'), {
    code: 'PDF_TEMPLATE_CONVERSION_FAILED',
  })
  assert.equal(safeAiTaskFailureStage(error), '元素级可编辑转换未完成')
  assert.match(safeAiTaskFailureMessage(error), /图片高保真版已经保留/)
  assert.match(safeAiTaskFailureMessage(error), /元素级可编辑转换/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal conversion details/)
})

test('Gorden layout guard blocks errors but does not promote warnings to failures', () => {
  assert.deepEqual(gordenLayoutGuardArgs({
    script: 'layout_guard.py',
    sourceImage: 'source.png',
    layoutPath: 'layout.json',
  }), ['layout_guard.py', 'source.png', 'layout.json'])
})

test('Gorden text gate ignores duplicate reports of planned text but preserves real extras', () => {
  assert.deepEqual(
    gordenUnplannedVisibleTexts(
      ['项目暂未形成可验证的医疗竞争定位。', '1'],
      [' 项目暂未形成可验证的医疗竞争定位。 ', '１', '来源名称'],
    ),
    ['来源名称'],
  )
  assert.deepEqual(
    gordenUnplannedVisibleTexts(['行业：AI医疗'], ['AI']),
    [],
  )
  assert.deepEqual(
    gordenUnplannedVisibleTexts(['项目重点'], ['|', '•', '—', '【】']),
    [],
  )
  assert.deepEqual(
    gordenUnplannedVisibleTexts(['项目重点'], ['|模板标签']),
    ['|模板标签'],
  )
})

test('Gorden retries only unsafe icon layers with an explicit safe margin', () => {
  assert.deepEqual(unsafeGordenIconFiles({
    icons: [
      { file: 'safe.png', edge_touch: { left: false, bottom: false } },
      { file: 'edge.png', edge_touch: { right: true } },
    ],
  }), ['edge.png'])
  const prompt = buildGordenIconRetryPrompt({
    keyColor: '#00ff00',
    attempt: 2,
    unsafeIconFiles: ['edge.png'],
  })
  assert.match(prompt, /至少 12%/)
  assert.match(prompt, /禁止生成贴边横幅/)
})

test('Gorden strict text-weight QA permits a regular body with bold title and card labels', () => {
  const slide = annotateGordenTextWeightQa({
    texts: [
      { text: '投资结论与后续事项', bold: true },
      { text: '这是用于投资委员会阅读的常规正文段落。'.repeat(12), bold: false },
      { text: '主体与团队归属待确认', bold: true },
      { text: '产品与合规证据待确认', bold: true },
      { text: '估值与融资口径待确认', bold: true },
      { text: '人员与财务数据待确认', bold: true },
      { text: '仅供内部讨论，不构成最终投资决策', bold: true },
    ],
  })
  assert.equal(slide.allow_all_bold_text, true)
  assert.match(String((slide.qa_notes as string[])[0]), /正文段落为常规字重/)

  const compactNarrative = annotateGordenTextWeightQa({
    texts: [
      ...Array.from({ length: 17 }, (_unused, index) => ({
        text: `标题或卡片标签 ${index + 1}`,
        bold: true,
      })),
      {
        text: '项目位于 AI 医疗领域，具体竞争力仍需结合市场和客户证据进一步核验。',
        bold: false,
        word_wrap: true,
        estimated_line_count: 4,
      },
    ],
  })
  assert.equal(compactNarrative.allow_all_bold_text, true)
  assert.match(String((compactNarrative.qa_notes as string[])[0]), /正文段落为常规字重/)

  const accidentalAllBold = annotateGordenTextWeightQa({
    texts: Array.from({ length: 7 }, (_unused, index) => ({
      text: index === 1 ? '错误地全部加粗的长正文'.repeat(20) : `标签 ${index + 1}`,
      bold: true,
    })),
  })
  assert.equal(accidentalAllBold.allow_all_bold_text, true)
  assert.match(String((accidentalAllBold.qa_notes as string[])[0]), /全粗体/)
})

test('Gorden layout keeps pixel font units, prevents false wrapping and removes duplicate badge icons', () => {
  const result = normalizeGordenLayout({
    vision: {
      texts: [
        {
          textIndex: 1,
          source_bbox: [20, 30, 1493, 37],
          size_px: 28,
          color: '#172033',
          bold: false,
          align: 'left',
          valign: 'middle',
        },
        {
          textIndex: 2,
          source_bbox: [100, 200, 680, 118],
          size_px: 24,
          color: '#334155',
          bold: false,
          align: 'left',
          valign: 'top',
        },
        {
          textIndex: 3,
          source_bbox: [1051, 211, 47, 59],
          size_px: 25,
          color: '#FFFFFF',
          bold: true,
          align: 'center',
          valign: 'middle',
        },
      ],
      icons: [{
        file: 'badge.png',
        source_bbox: [1031, 199, 77, 77],
        visible_text: '3',
      }],
      unexpectedText: [],
    },
    plan: {
      number: 1,
      role: 'body',
      title: '测试页',
      expectedTexts: [
        '融资、估值与交易安排｜项目概览与发展阶段｜产品、技术与工程化进展｜客户验证与商业化进展',
        '这是用于验证正文换行判断的较长内容。'.repeat(12),
        '3',
      ],
      sourceIndexes: [],
    },
    iconManifest: { icons: [{ file: 'badge.png' }] },
    pageRoot: '/tmp/gorden-page',
    width: 2048,
    height: 1152,
    font: 'Microsoft YaHei',
  }) as { texts: Array<Record<string, unknown>>; icons: Array<Record<string, unknown>> }

  assert.equal(result.texts[0].size, undefined)
  assert.equal(result.texts[0].size_px, 28)
  assert.equal(result.texts[0].word_wrap, false)
  assert.equal(result.texts[1].word_wrap, true)
  assert.ok(Number(result.texts[1].estimated_line_count) > 1)
  assert.equal(result.texts[2].rendered_by_icon, undefined)
  assert.equal(result.texts[2].opacity, undefined)
  assert.equal(result.icons.length, 0)
  assert.match(String((result as unknown as { qa_notes: string[] }).qa_notes[0]), /重复图标切片/)
})

test('Gorden resume upgrades legacy text layouts with estimated line counts', () => {
  const [text] = upgradeGordenCheckpointTextLayouts([{
    text: '项目位于 AI 医疗领域，具体竞争力仍需结合市场和客户证据进一步核验。',
    source_bbox: [101, 682, 265, 114],
    size_px: 27,
    bold: false,
    word_wrap: true,
  }])
  assert.equal(text.estimated_line_count, 4)
  assert.equal(text.word_wrap, true)
})

test('investment PPT resume checkpoint remaps duplicate source identities in order', () => {
  const checkpointContent: BusinessContent = {
    title: '测试投资建议书',
    executiveSummary: '摘要',
    executiveSummarySourceIndexes: [0, 2],
    sections: [{
      title: '公司简介',
      summary: '简介',
      summarySourceIndexes: [1],
      findings: [{ text: '事实', status: '资料记载', sourceIndexes: [0, 1, 2] }],
    }],
    highlights: [],
    risks: [],
    missing: [],
  }
  const checkpointSources = [
    { type: 'file', name: '项目资料.pdf', locator: 'file://project' },
    { type: 'file', name: '项目资料.pdf', locator: 'file://project' },
    { type: 'public_web', name: '行业页面', locator: 'https://example.com' },
  ]
  const currentSources = [
    { sourceType: 'public_web', sourceName: '行业页面', locator: 'https://example.com', content: '行业' },
    { sourceType: 'file', sourceName: '项目资料.pdf', locator: 'file://project', content: '第一段' },
    { sourceType: 'file', sourceName: '项目资料.pdf', locator: 'file://project', content: '第二段' },
  ]
  const remapped = remapInvestmentRecommendationCheckpointSources({
    content: checkpointContent,
    checkpointSources,
    currentSources,
  })
  assert.deepEqual(remapped.executiveSummarySourceIndexes, [1, 0])
  assert.deepEqual(remapped.sections[0].summarySourceIndexes, [2])
  assert.deepEqual(remapped.sections[0].findings[0].sourceIndexes, [1, 2, 0])
})

test('investment recommendation artifact metadata must prove the two-stage editable chain', () => {
  assert.doesNotThrow(() => assertInvestmentRecommendationSkillChain({
    generationSkill: 'create-reference-driven-editable-ppt',
    generationRuntime: 'create-reference-driven-editable-ppt',
    templateApplied: false,
    editableLevel: 'all',
    workflowAudit: {
      strictSequence: [
        'create-reference-driven-editable-ppt',
        'GordenSuperPPTSkill',
        'GordenImagePPTGen',
        'pdf-to-editable-ppt',
      ],
      packageSha256: 'a'.repeat(64),
      packageComponents: [
        'GordenSuperPPTSkill',
        'GordenImagePPTGen',
        'GordenImage2PPTX',
      ],
      skillInstructionsInjected: true,
      imageDeckPublishedBeforeEditable: true,
      pipelineHandoffPassed: true,
    },
  }))
  assert.throws(
    () => assertInvestmentRecommendationSkillChain({
      generationSkill: 'create-reference-driven-editable-ppt',
      generationRuntime: 'create-reference-driven-editable-ppt',
      templateApplied: true,
    }),
    /图片版先交付/,
  )
})

test('investment recommendation PPT workflow uses the Gorden super skill', async () => {
  assert.ok(AI_PPT_WORKFLOW_SKILLS.some((item) => item.name === 'GordenSuperPPTSkill'))
  const gorden = await loadAiSkill('GordenSuperPPTSkill')
  assert.equal(gorden.name, 'GordenSuperPPTSkill')
  assert.match(gorden.description, /一键全流程 PPT/)
  assert.match(gorden.instructions, /GordenImagePPTGen/)
  assert.match(gorden.instructions, /GordenImage2PPTX/)

  const paths = gordenSkillPaths()
  for (const file of [
    paths.ingest,
    paths.generateImage,
    paths.composeImageDeck,
    paths.chromaKey,
    paths.sliceGrid,
    paths.layoutGuard,
    paths.placementQa,
    paths.visualCompareQa,
    paths.composeEditable,
  ]) {
    assert.equal(existsSync(file), true, `missing Gorden runtime: ${file}`)
  }
  const referencePaths = referenceDrivenSkillPaths()
  for (const file of [
    referencePaths.resolveDependencies,
    referencePaths.packageSlidesAsPdf,
    referencePaths.validatePipelineHandoff,
    referencePaths.convertPdf,
    referencePaths.checkEnvironment,
  ]) {
    assert.equal(existsSync(file), true, `missing reference-driven runtime: ${file}`)
  }
})

test('Gorden runtime paths support the flat production skill layout', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gorden-flat-skills-'))
  try {
    for (const skillName of [
      'GordenSuperPPTSkill',
      'GordenImagePPTGen',
      'GordenImage2PPTX',
    ]) {
      const directory = path.join(root, skillName)
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: test\n---\n')
    }

    const paths = gordenSkillPaths(root)
    assert.equal(paths.bundle, root)
    assert.equal(paths.superRoot, path.join(root, 'GordenSuperPPTSkill'))
    assert.equal(paths.imageGenRoot, path.join(root, 'GordenImagePPTGen'))
    assert.equal(paths.image2Root, path.join(root, 'GordenImage2PPTX'))
    assert.equal(
      paths.generateImage,
      path.join(root, 'GordenImagePPTGen', 'scripts', 'generate_gateway_slide_image.py'),
    )
    assert.equal(
      paths.composeEditable,
      path.join(root, 'GordenImage2PPTX', 'scripts', 'compose_pptx.py'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Gorden runtime paths prefer the nested local skill layout', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gorden-nested-skills-'))
  const bundle = path.join(root, 'GordenSuperPPTSkills')
  try {
    for (const skillName of [
      'GordenSuperPPTSkill',
      'GordenImagePPTGen',
      'GordenImage2PPTX',
    ]) {
      const directory = path.join(bundle, skillName)
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: test\n---\n')
    }

    const paths = gordenSkillPaths(root)
    assert.equal(paths.bundle, bundle)
    assert.equal(paths.superRoot, path.join(bundle, 'GordenSuperPPTSkill'))
    assert.equal(paths.imageGenRoot, path.join(bundle, 'GordenImagePPTGen'))
    assert.equal(paths.image2Root, path.join(bundle, 'GordenImage2PPTX'))
    assert.equal(
      paths.generateImage,
      path.join(bundle, 'GordenImagePPTGen', 'scripts', 'generate_gateway_slide_image.py'),
    )
    assert.equal(
      paths.composeEditable,
      path.join(bundle, 'GordenImage2PPTX', 'scripts', 'compose_pptx.py'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the built-in investment recommendation task uses the staged reference-driven pipeline', async () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  assert.equal(mustUseReferenceDrivenPptPipeline(template), true)
  const workflow = await prepareInvestmentRecommendationPptWorkflow(template)
  assert.equal(workflow.sourceMode, 'gorden-native')
  assert.deepEqual(
    workflow.skills.map((item) => item.name),
    [
      'create-reference-driven-editable-ppt',
      'GordenSuperPPTSkill',
      'pdf-to-editable-ppt',
    ],
  )
  assert.equal(workflow.generationPolicy.templateReuse, 'none')
  assert.equal(workflow.generationPolicy.bridgePolicy, 'image-deck-to-pdf-to-editable-pptx')
  assert.deepEqual([
    workflow.gordenSkill.name,
    workflow.gordenPackage.imageGenerationSkill.name,
    workflow.gordenPackage.imageToEditableSkill.name,
  ], [
    'GordenSuperPPTSkill',
    'GordenImagePPTGen',
    'GordenImage2PPTX',
  ])
  assert.match(workflow.gordenPackage.corePromptContract, /内容优先/)
  assert.match(workflow.gordenPackage.corePromptContract, /每页不重样/)
  assert.match(workflow.gordenPackage.designTemplates, /M15 财务数据页/)
  assert.match(workflow.gordenPackage.packageSha256, /^[a-f0-9]{64}$/)
})

test('reference-driven semantic bridge preserves four layers with stable names', () => {
  const result = buildReferenceDrivenSemanticOverrides({
    dimensions: [{ width: 2560, height: 1440 }],
    slides: [{
      background: '/tmp/background.png',
      frame: '/tmp/frame.png',
      icons: [{ file: '/tmp/icon.png', x: 0.1, y: 0.2, w: 0.05, h: 0.1 }],
      texts: [{
        text: '投资结论',
        x: 0.2,
        y: 0.1,
        w: 0.3,
        h: 0.08,
        size: 24,
        color: '#123456',
        bold: true,
      }],
    }],
  }) as { slides: Record<string, any> }
  const slide = result.slides['1']
  assert.equal(slide.review.completed, true)
  assert.equal(slide.review.expectedCounts.covers, 1)
  assert.equal(slide.review.expectedCounts.icons, 2)
  assert.equal(slide.review.expectedCounts.texts, 1)
  assert.equal(slide.covers[0].name, 'slide-01-background')
  assert.equal(slide.icons[0].name, 'slide-01-frame')
  assert.equal(slide.texts[0].name, 'slide-01-text-001')
  assert.deepEqual(slide.skipTextRegions[0], {
    left: 0,
    top: 0,
    width: 2560,
    height: 1440,
  })
})

test('reference-driven bridge converts source pixel font size to points and skips icon-rendered labels', () => {
  const result = buildReferenceDrivenSemanticOverrides({
    dimensions: [{ width: 2048, height: 1152 }],
    slides: [{
      background: '/tmp/background.png',
      frame: '/tmp/frame.png',
      icons: [],
      texts: [
        {
          text: '正常正文',
          x: 0.1,
          y: 0.1,
          w: 0.3,
          h: 0.08,
          size_px: 23,
          color: '#123456',
        },
        {
          text: '3',
          x: 0.5,
          y: 0.5,
          w: 0.05,
          h: 0.05,
          size_px: 25,
          rendered_by_icon: true,
        },
      ],
    }],
  }) as { slides: Record<string, any> }
  const slide = result.slides['1']
  assert.equal(slide.review.expectedCounts.texts, 1)
  assert.equal(slide.texts.length, 1)
  assert.ok(Math.abs(slide.texts[0].textStyle.fontSize - 10.78125) < 0.0001)
})
