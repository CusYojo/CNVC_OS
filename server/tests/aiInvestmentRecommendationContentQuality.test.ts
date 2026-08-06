import assert from 'node:assert/strict'
import test from 'node:test'
import {
  enrichInvestmentRecommendationContentFromBrief,
  finalizeInvestmentRecommendationPptContent,
  investmentRecommendationContentQualityIssues,
  investmentRecommendationPendingResearchTopics,
  normalizeBusinessContent,
  sanitizeInvestmentRecommendationText,
  selectBusinessContentPromptSources,
  type BusinessContent,
} from '../src/services/aiBusinessContentService.js'
import type {
  ProjectKnowledgeBrief,
  ProjectKnowledgeTopic,
} from '../src/services/aiProjectKnowledgeBriefService.js'
import { AI_TEMPLATE_CATALOG } from '../src/services/aiTemplateCatalog.js'

test('investment recommendation sanitizer removes internal workflow and AI-style wording', () => {
  const sanitized = sanitizeInvestmentRecommendationText(
    '总体来看，根据当前项目资料库，项目处于线索阶段，建议继续跟踪。值得注意的是，公司具备长期投资价值。',
  )

  assert.doesNotMatch(
    sanitized,
    /总体来看|当前项目资料库|线索阶段|继续跟踪|值得注意的是|公司具备长期投资价值/,
  )
  assert.match(sanitized, /暂不形成确定性投资结论/)
  assert.match(sanitized, /具体经营与交易事实/)
})

test('investment recommendation finalizer does not reintroduce process wording for sparse content', () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  const content: BusinessContent = {
    title: '大衍科技投资建议书',
    executiveSummary: '',
    sections: template.sections.map((title) => ({
      title,
      summary: '',
      findings: [],
    })),
    highlights: [],
    risks: [],
    missing: [],
  }
  const finalized = finalizeInvestmentRecommendationPptContent(
    content,
    template,
    { name: '大衍科技', companyName: '大衍科技' },
  )

  const issues = investmentRecommendationContentQualityIssues(finalized, template.sections.length)
  assert.equal(
    issues.some((issue) => /项目阶段|资料处理|模型化套话/.test(issue)),
    false,
    issues.join('；'),
  )
  const visibleText = JSON.stringify(finalized)
  assert.doesNotMatch(visibleText, /项目资料库|当前资料|现有资料|项目阶段|继续跟踪|可核验事实/)
})

test('investment recommendation normalization preserves native tables', () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  const fallback: BusinessContent = {
    title: '智灵动力投资建议书',
    executiveSummary: '智灵动力面向工业客户提供智能软件，投资判断取决于收入质量、客户复购、估值和交易条件。',
    sections: template.sections.map((title) => ({ title, summary: '', findings: [] })),
    highlights: [],
    risks: [],
    missing: [],
  }
  const raw = {
    ...fallback,
    sections: template.sections.map((title, index) => ({
      title,
      summary: `${title}的中心判断与投资影响。`,
      findings: [{ text: `${title}的具体事实。`, status: '资料记载', sourceIndexes: [0] }],
      tables: index === 7 ? [{
        title: '历史财务表现',
        unit: '万元',
        columns: ['指标', '2024年', '2025年'],
        rows: [['营业收入', '800', '1200'], ['净利润', '-300', '-120']],
        status: '资料记载',
        sourceIndexes: [0],
      }] : [],
    })),
  }

  const normalized = normalizeBusinessContent(raw, template, fallback, 1)
  assert.equal(normalized.sections[7].tables?.length, 1)
  assert.deepEqual(normalized.sections[7].tables?.[0].rows, [
    ['营业收入', '800', '1200'],
    ['净利润', '-300', '-120'],
  ])
})

test('investment recommendation gap analysis searches low-density chapters even without pending status', () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  const content: BusinessContent = {
    title: '智灵动力投资建议书',
    executiveSummary: '公司已形成产品方向，但十二个专题仍缺少足以支撑投资判断的事实、数据和来源。',
    sections: template.sections.map((title) => ({
      title,
      summary: `${title}已有简短说明。`,
      findings: [{
        text: `${title}已有一项简短事实。`,
        status: '资料记载',
        sourceIndexes: [0],
      }],
    })),
    highlights: [],
    risks: [],
    missing: [],
  }

  const topics = investmentRecommendationPendingResearchTopics(content, 12)
  assert.equal(topics.length, 12)
  assert.ok(topics.some((topic) => /行业与市场空间.*TAM\/SAM\/SOM/.test(topic)))
  assert.ok(topics.some((topic) => /财务分析.*历史财务/.test(topic)))
  assert.ok(topics.some((topic) => /融资与估值.*投前投后估值/.test(topic)))
  assert.ok(topics.some((topic) => /投资方案.*持股比例/.test(topic)))
})

test('investment recommendation prompt reserves evidence slots for verified public sources', () => {
  const localSources = Array.from({ length: 80 }, (_, index) => ({
    sourceType: 'file',
    sourceName: `项目文件-${index}.pdf`,
    content: `本地项目事实 ${index}`,
  }))
  const publicSources = Array.from({ length: 30 }, (_, index) => ({
    sourceType: 'public_web_verified',
    sourceName: `公开来源-${index}`,
    content: `公开核验事实 ${index}`,
  }))

  const selected = selectBusinessContentPromptSources(
    'investment_recommendation_ppt',
    [...localSources, ...publicSources],
  )
  assert.equal(selected.length, 64)
  assert.equal(selected.filter(({ source }) => source.sourceType === 'file').length, 40)
  assert.equal(selected.filter(({ source }) => source.sourceType.startsWith('public_web')).length, 24)
  assert.equal(selected.at(-1)?.sourceIndex, 103)
})

test('investment recommendation professionality gate accepts a dense sourced IC draft', () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  const chapterContent = [
    ['投资判断建立在工业客户合同转化、2025年收入增长和本轮定价可比性三项条件上。', '公司产品已进入三个工业场景测试，合同、验收和回款决定商业化质量。', '本轮投资应把客户回款、投前估值和交割条件作为约束。'],
    ['公司于2022年成立，注册地位于杭州，围绕工业智能软件完成两次产品迭代。', '法律主体、注册资本和历史工商变更已形成时间线。', '2024年完成首个工业客户交付，成为商业化里程碑。'],
    ['创始团队覆盖工业软件、算法研发与企业销售，董事治理仍由创始股东主导。', '创始人持股55%，实际控制权与经营责任一致。', 'CTO具有十年算法研发履历，销售负责人承担重点客户转化。'],
    ['核心产品为工业智能分析平台，采用时序模型与数字孪生技术服务设备运维。', '平台通过私有化部署交付，支持数据采集、模型训练与告警。', '公司拥有8项软件著作权，关键性能指标以客户测试报告为准。'],
    ['公司通过软件许可和项目实施收费，2025年三个客户进入合同或验收阶段。', '客户验证严格区分测试、合同、交付、验收、收入和回款。', '前五大客户收入集中度较高，续约与复购决定收入可持续性。'],
    ['公司所在工业智能软件细分市场2025年规模约120亿元，近三年复合增长率18%。', 'TAM按工业软件需求测算，SAM限定设备运维场景，SOM以可覆盖客户数量估算。', '政策与降本增效需求推动渗透率提升，但统计口径存在差异。'],
    ['主要竞品包括甲公司和乙公司，替代方案还包括客户自研与传统运维软件。', '对标维度覆盖产品形态、部署方式、技术参数、价格和客户场景。', '公司的差异化在私有化部署与设备模型积累，壁垒仍需用复购验证。'],
    ['公司2024年收入800万元，2025年收入1200万元，毛利率由42%升至48%。', '经营现金流仍为负，研发费用和应收账款是主要资金占用。', '管理层预测与历史财务分开列示，收入以合同、验收和回款交叉验证。'],
    ['公司2024年完成A轮融资3000万元，本轮拟按投前4亿元融资5000万元。', '历史融资列明轮次、时间、金额和投资方，本轮估值区分投前与投后。', '可比公司估值需按收入阶段、增长率和商业化质量进行折价调整。'],
    ['拟以增资方式投资3000万元，按投前4亿元测算交割后持股约6.98%。', '交易方案包括资金用途、交割条件、董事席位、反稀释和信息权。', '投资金额、交易方式、持股比例与投后股本已经进行算术校验。'],
    ['核心投资逻辑来自工业智能需求增长、产品工程化、客户合同转化和团队行业经验。', '产品落地与客户转化表现支持收入增长假设，市场规模决定潜在回报上限。', '估值安全边际和持续融资能力是投资逻辑成立的必要条件。'],
    ['主要风险包括客户集中、收入回款、核心技术权属、股权治理和交割条件。', '客户合同与回款由财务流水核验，知识产权由权属清单核验。', '估值与持股比例若出现口径差异，应在正式投资协议签署前调整。'],
  ]
  const tableIndexes = new Set([2, 5, 6, 7, 8, 9])
  const content: BusinessContent = {
    title: '智灵动力投资建议书',
    executiveSummary: '智灵动力已经形成工业智能软件产品并进入客户合同转化阶段，2025年收入较上年增长但经营现金流仍为负。投资逻辑取决于客户验收回款、产品复购和本轮投前4亿元定价能否获得同阶段可比交易支持；建议把财务核验、估值调整和交割保护作为交易前提。',
    executiveSummarySourceIndexes: [0, 1],
    sections: template.sections.map((title, index) => ({
      title,
      summary: chapterContent[index][0],
      summarySourceIndexes: [index % 2],
      findings: chapterContent[index].slice(1).map((text) => ({
        text,
        status: '资料记载' as const,
        sourceIndexes: [index % 2],
      })),
      tables: tableIndexes.has(index) ? [{
        title: `${title}关键数据`,
        unit: index === 7 ? '万元、%' : '按披露口径',
        columns: ['维度', '当前口径', '比较或约束'],
        rows: [
          ['核心指标', index === 7 ? '2025年收入1200万元' : '2025年口径', '需同口径比较'],
          ['投资含义', '影响估值与交易条件', '以原始文件核验'],
        ],
        status: '资料记载' as const,
        sourceIndexes: [index % 2],
      }] : [],
    })),
    highlights: ['客户合同转化和产品工程化构成增长基础。'],
    risks: ['经营现金流、客户集中和估值口径可能改变投资结论。'],
    missing: [],
  }

  assert.deepEqual(
    investmentRecommendationContentQualityIssues(content, template.sections.length),
    [],
  )
})

test('five-page investment recommendation uses a compact but still professional density gate', () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  const summaries = [
    '投资判断取决于产品落地、客户合同、收入质量、本轮估值与交易保护是否同时成立。',
    '公司于2022年成立并完成两次产品迭代，法律主体、注册地和关键历程已经核对。',
    '创始人负责经营，CTO负责算法研发，股东持股、实际控制人与董事治理关系清晰。',
    '核心产品采用时序模型与数字孪生技术，以私有化平台服务工业设备运维场景。',
    '公司按软件许可和实施服务收费，客户验证区分测试、合同、交付、验收与回款。',
    '细分市场规模约120亿元、近三年增长率18%，TAM与SAM按工业运维需求界定。',
    '主要竞品包括甲公司、乙公司与客户自研替代方案，对标部署方式、价格和客户场景。',
    '2025年收入1200万元、毛利率48%，经营现金流仍为负，历史数据与预测分开列示。',
    '公司拟按投前4亿元融资5000万元，历史融资轮次、投资方与投后估值分别列示。',
    '拟增资3000万元并取得约6.98%持股，交割条件、董事席位和反稀释条款需要落实。',
    '投资逻辑来自产品工程化、客户转化、市场增长与团队经验，估值安全边际构成约束。',
    '主要风险包括客户集中、回款、技术权属、股权治理、合规诉讼与交易交割风险。',
  ]
  const findings = [
    '客户验收回款和估值调整机制是本轮投资的两个核心前提。',
    '首个客户交付发生在2024年，构成商业化历程的关键节点。',
    '核心管理人员的分工与持股安排能够覆盖研发、销售和公司治理。',
    '产品性能指标以客户测试报告为准，知识产权权属已纳入交割核对。',
    '复购率与应收回款将直接检验软件许可模式的收入持续性。',
    '市场统计口径存在差异，投资测算采用较窄的设备运维应用范围。',
    '公司的私有化部署能力需要通过具名客户复购验证差异化壁垒。',
    '研发费用和应收账款是主要资金占用，现金续航取决于本轮融资。',
    '可比交易需按收入阶段、增长率和商业化质量对估值进行折价。',
    '投资金额、交易方式、持股比例与投后股本已经完成算术校验。',
    '核心假设可由合同转化、产品复购和收入增长三项指标持续验证。',
    '合同流水、知识产权清单与正式协议分别对应经营、技术和交易风险。',
  ]
  const content: BusinessContent = {
    title: '智灵动力投资建议书',
    executiveSummary: '智灵动力已经形成工业智能软件产品并进入客户合同转化阶段，投资逻辑取决于客户验收回款、产品复购和收入增长能否支持本轮投前4亿元定价。交易应以财务核验、估值调整和交割保护为前提。',
    executiveSummarySourceIndexes: [0],
    sections: template.sections.map((title, index) => ({
      title,
      summary: summaries[index],
      summarySourceIndexes: [index % 2],
      findings: [{
        text: findings[index],
        status: '资料记载' as const,
        sourceIndexes: [index % 2],
      }],
      tables: index === 7 ? [{
        title: '历史财务表现',
        unit: '万元、%',
        columns: ['指标', '2024年', '2025年'],
        rows: [['营业收入', '800', '1200'], ['毛利率', '42%', '48%']],
        status: '资料记载' as const,
        sourceIndexes: [0],
      }] : [],
    })),
    highlights: ['产品工程化、客户转化与细分市场增长共同构成投资基础。'],
    risks: ['客户集中、经营现金流和估值口径可能改变投资结论。'],
    missing: [],
  }

  const compactIssues = investmentRecommendationContentQualityIssues(
    content,
    template.sections.length,
    { pageCount: '5', sourceCount: 2 },
  )
  assert.deepEqual(compactIssues, [])
  assert.ok(
    investmentRecommendationContentQualityIssues(
      content,
      template.sections.length,
      { pageCount: '14', sourceCount: 2 },
    ).some((issue) => /有效发现|表格/.test(issue)),
  )
})

test('investment recommendation deterministically re-homes brief facts and adds editable data tables', () => {
  const template = AI_TEMPLATE_CATALOG.investment_recommendation_ppt
  const factsByTopic: Record<ProjectKnowledgeTopic, string[]> = {
    '公司主体与历史沿革': [
      '智灵动力于2022年在杭州成立，注册资本为1,000万元，2024年完成首个工业客户交付。',
      '公司法律主体及两次工商变更均已按登记日期形成历史沿革。',
    ],
    '股权、融资与治理': [
      '创始人直接持股55%，董事会由三名董事组成，实际控制权与经营责任一致。',
      '公司2024年完成A轮融资3,000万元，本轮计划新增融资5,000万元。',
    ],
    '创始人与核心团队': [
      '创始人具有工业软件销售经历，CTO拥有十年算法研发经验。',
      '核心团队分工覆盖产品研发、客户交付、销售转化与公司治理。',
    ],
    '产品、技术与知识产权': [
      '核心产品采用时序模型与数字孪生技术，为工业设备提供预测性维护。',
      '公司拥有8项软件著作权，产品支持私有化部署、模型训练与实时告警。',
    ],
    '商业模式、客户与供应链': [
      '公司按照软件许可与项目实施收费，三个工业客户已进入合同或验收阶段。',
      '客户验证区分测试、合同、交付、验收、收入确认与回款六个环节。',
    ],
    '行业、市场与竞争': [
      '工业智能软件细分市场2025年规模约120亿元，近三年复合增长率为18%。',
      '主要竞品包括甲公司和乙公司，替代方案还包括客户自研与传统运维软件。',
      '公司的差异化集中在私有化部署和工业设备模型积累，仍需由复购率验证。',
    ],
    '财务、现金流与预测': [
      '公司2024年营业收入800万元，2025年营业收入1,200万元。',
      '毛利率由42%升至48%，经营现金流仍为负，研发费用与应收账款占用资金。',
    ],
    '交易方案、估值与退出': [
      '本轮拟按投前4亿元估值融资5,000万元，历史融资与本轮定价分别列示。',
      '拟以增资方式投资3,000万元，交割后持股比例约6.98%。',
      '交易条件包括董事席位、反稀释、信息权、资金用途与交割先决条件。',
      '退出安排包括并购、后续融资转让与符合条件时的资本市场退出。',
    ],
    '合规、风险与待确认事项': [
      '主要风险包括客户集中、应收回款、知识产权权属、股权治理与交易交割。',
      '客户合同、银行流水、软件著作权清单和正式投资协议分别对应经营、技术与交易核验。',
    ],
  }
  let sourceIndex = 0
  const facts = Object.entries(factsByTopic).flatMap(([topic, texts]) =>
    texts.map((text) => ({
      topic: topic as ProjectKnowledgeTopic,
      text,
      sourceIndexes: [sourceIndex++],
      nature: '事实' as const,
    })))
  const brief: ProjectKnowledgeBrief = {
    version: 'project-knowledge-study-v1',
    projectName: '智灵动力',
    companyName: '智灵动力有限公司',
    sourceCutoffDate: '2026-08-06',
    facts,
    chronology: [],
    conflicts: [],
    gaps: [],
    recommendedTables: [{
      topic: '财务、现金流与预测',
      title: '历史财务表现',
      columns: ['指标', '2024年', '2025年'],
      rows: [
        ['营业收入', '800万元', '1,200万元'],
        ['毛利率', '42%', '48%'],
      ],
      sourceIndexes: [12, 13],
    }],
    audit: {
      mode: 'deterministic-study',
      model: 'test',
      sourceDocumentCount: 20,
      sourceFilesRepresented: [],
      selectedSourceFiles: [],
      sourceFileCoverageRatio: 1,
      sourceChunkCount: 20,
      includedChunkCount: 20,
      includedCharacterCount: 4_000,
      corpusSha256: 'test-corpus',
    },
  }
  const sparse: BusinessContent = {
    title: '智灵动力投资建议书',
    executiveSummary: '智灵动力的投资判断取决于工业客户转化、收入质量、本轮估值和交易保护能否同时成立；客户验收回款、经营现金流与投前定价是决定风险收益比的主要约束。',
    executiveSummarySourceIndexes: [0],
    sections: template.sections.map((title) => ({
      title,
      summary: '创始团队持续推进相关工作。',
      findings: [{
        text: '创始团队持续推进相关工作并形成了一定积累。',
        status: '资料记载' as const,
        sourceIndexes: [0],
      }],
      tables: [],
    })),
    highlights: ['产品工程化、客户转化与市场增长构成潜在收益来源。'],
    risks: ['客户集中、现金流和本轮估值可能改变投资结论。'],
    missing: [],
  }

  const enriched = enrichInvestmentRecommendationContentFromBrief(
    sparse,
    brief,
    { pageCount: 5 },
  )

  const product = enriched.sections.find((section) => /产品/.test(section.title))
  const market = enriched.sections.find((section) => /行业与市场/.test(section.title))
  const finance = enriched.sections.find((section) => /财务分析/.test(section.title))
  const transaction = enriched.sections.find((section) => /投资方案/.test(section.title))
  assert.match(`${product?.summary} ${product?.findings.map((item) => item.text).join(' ')}`, /时序模型|数字孪生|软件著作权/)
  assert.match(`${market?.summary} ${market?.findings.map((item) => item.text).join(' ')}`, /120亿元|增长率/)
  assert.equal(finance?.tables?.[0].title, '历史财务表现')
  assert.deepEqual(finance?.tables?.[0].columns, ['指标', '2024年', '2025年'])
  assert.match(`${transaction?.summary} ${transaction?.findings.map((item) => item.text).join(' ')}`, /投资|增资|持股|交割/)
  assert.ok(enriched.sections.every((section) =>
    !/创始团队持续推进相关工作/.test(section.summary)
    || /股权|团队/.test(section.title)))
  assert.equal(
    investmentRecommendationContentQualityIssues(
      enriched,
      template.sections.length,
      { pageCount: 5, sourceCount: facts.length },
    ).some((issue) => /章节内容|正文与标题职责不匹配|数据、交易条款/.test(issue)),
    false,
  )
})
