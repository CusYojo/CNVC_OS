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
  buildReferenceDrivenSemanticOverrides,
  buildGordenSlidePlan,
  buildGordenSlidePrompt,
  buildGordenEditableLayerPrompts,
  gordenSlidePlanFingerprint,
  gordenLayoutGuardArgs,
  gordenUnplannedVisibleTexts,
  gordenSkillPaths,
  normalizeGordenLayout,
  referenceDrivenSkillPaths,
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
  executiveSummary: '项目具备产业协同潜力，建议在核心数据核验完成后推进。',
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
  highlights: ['产业协同潜力'],
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
  })

  assert.equal(plan.length, topics.length + 2)
  assert.equal(plan[0].role, 'cover')
  assert.ok(plan[0].expectedTexts.includes('项目阶段'))
  assert.ok(plan[0].expectedTexts.includes('成长期'))
  assert.ok(plan[0].expectedTexts.includes('业务定位'))
  assert.ok(plan[0].expectedTexts.includes('以工业智能软件订阅与项目交付形成收入'))
  assert.ok(plan[0].expectedTexts.includes('融资概况'))
  assert.ok(plan[0].expectedTexts.includes('估值口径'))
  assert.ok(plan[0].expectedTexts.includes('项目重点'))
  assert.equal(plan[0].expectedTexts.some((text) => /^\d+$/u.test(text)), false)
  assert.equal(plan.at(-1)?.role, 'closing')
  for (const [title, detail] of topics) {
    const slide = plan.find((item) => item.title === title)
    assert.ok(slide, `missing slide: ${title}`)
    assert.ok(slide.expectedTexts.includes(detail), `missing detail: ${detail}`)
  }
  assert.ok(plan.at(-1)?.expectedTexts.includes('本材料仅供内部投资决策使用。'))
})

test('Gorden image prompt enforces template-style-only reuse and exact project text', () => {
  const slide = buildGordenSlidePlan({
    project: { name: '智灵动力' },
    content,
    disclaimer: '内部使用。',
  })[1]
  const prompt = buildGordenSlidePrompt({
    slide,
    projectName: '智灵动力',
    sourceNames: ['项目档案', '公司官网'],
    palette: ['#123456', '#ABCDEF'],
  })

  assert.match(prompt, /模板页作为唯一视觉参考/)
  assert.match(prompt, /不得残留任何模板样本事实/)
  assert.match(prompt, /必须逐字照排，不得改写、遗漏或新增/)
  assert.match(prompt, new RegExp(`可读文字总数必须恰好为 ${slide.expectedTexts.length} 条`))
  assert.match(prompt, /来源名称，仅用于事实边界，不得出现在页面上/)
  assert.match(prompt, /清单没有对应文字时，删除该模块/)
  assert.match(prompt, /必须完整放在一个连续文本区域内/)
  assert.match(prompt, /不得自行生成 1、2、3/)
  assert.ok(slide.expectedTexts.every((value) => prompt.includes(value)))
})

test('Gorden editable icon layer excludes text and fixed-grid slicing assumptions', () => {
  const prompts = buildGordenEditableLayerPrompts('#00ff00')
  assert.match(prompts.icons, /不得包含任何中文、英文、数字/)
  assert.match(prompts.icons, /文字将由后续流程生成为原生可编辑文本/)
  assert.match(prompts.icons, /不得包含.*横线、竖线、分隔线/)
  assert.doesNotMatch(prompts.icons, /4×4 等分网格/)
  assert.match(prompts.icons, /连续纯色空隙/)
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
  assert.equal(plan.at(-1)?.role, 'closing')
  for (const [title] of topics) {
    assert.ok(plan.some((slide) => slide.expectedTexts.includes(title)), `missing grouped topic: ${title}`)
  }
  assert.equal(plan.flatMap((slide) => slide.expectedTexts).some((text) => /^\d+$/u.test(text)), false)
  assert.doesNotMatch(plan[1].title, /｜/)
  assert.ok(plan[1].expectedTexts.length <= 9)
})

test('Gorden cover preserves duplicate fallback values for distinct cards', () => {
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
  assert.equal(
    plan[0].expectedTexts.filter((text) => text === '待资料解析后补充').length,
    2,
  )
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
  assert.match(safeAiTaskFailureMessage(error), /文字缺失、异常换行或版式差异/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal visual details/)
})

test('Gorden layout guard failures expose a specific safe stage', () => {
  const error = Object.assign(new Error('internal layout details'), {
    code: 'GORDEN_LAYOUT_GUARD_REJECTED',
  })
  assert.equal(safeAiTaskFailureStage(error), 'Gorden 页面布局检查未通过')
  assert.match(safeAiTaskFailureMessage(error), /字号、换行或字重/)
  assert.doesNotMatch(safeAiTaskFailureMessage(error), /internal layout details/)
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

test('investment recommendation artifact metadata must prove the full three-skill chain', () => {
  assert.doesNotThrow(() => assertInvestmentRecommendationSkillChain({
    generationSkill: 'create-reference-driven-editable-ppt',
    generationRuntime: 'GordenSuperPPTSkills+pdf-bridge+pdf-to-editable-ppt',
    workflowAudit: {
      strictSequence: [
        'create-reference-driven-editable-ppt',
        'GordenSuperPPTSkill',
        'pdf-to-editable-ppt',
      ],
    },
  }))
  assert.throws(
    () => assertInvestmentRecommendationSkillChain({
      generationSkill: 'create-reference-driven-editable-ppt',
    }),
    /Gorden、PDF 桥接/,
  )
})

test('investment recommendation PPT workflow contains only the three approved skills', async () => {
  assert.deepEqual(
    AI_PPT_WORKFLOW_SKILLS.map((item) => item.name),
    [
      'create-reference-driven-editable-ppt',
      'GordenSuperPPTSkill',
      'pdf-to-editable-ppt',
    ],
  )
  const orchestrator = await loadAiSkill('create-reference-driven-editable-ppt')
  const converter = await loadAiSkill('pdf-to-editable-ppt')
  const gorden = await loadAiSkill('GordenSuperPPTSkill')
  assert.equal(orchestrator.name, 'create-reference-driven-editable-ppt')
  assert.equal(converter.name, 'pdf-to-editable-ppt')
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

test('the built-in investment recommendation template is forced through the reference-driven workflow', async () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  assert.equal(mustUseReferenceDrivenPptPipeline(template), true)
  const workflow = await prepareInvestmentRecommendationPptWorkflow(template)
  assert.equal(workflow.sourceMode, 'native-pptx')
  assert.deepEqual(
    workflow.skills.map((item) => item.name),
    [
      'create-reference-driven-editable-ppt',
      'GordenSuperPPTSkill',
      'pdf-to-editable-ppt',
    ],
  )
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
