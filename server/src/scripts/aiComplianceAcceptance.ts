import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  COMPLIANCE_MISSING_DATA_SENTENCE,
  parseComplianceDocumentBlueprint,
} from '../services/aiComplianceBlueprintService.js'
import {
  buildComplianceEvidencePackets,
  cleanComplianceBodyText,
  composeComplianceStatement,
  ensureComplianceSentenceEnding,
  isReadableComplianceProductFinding,
  isReadableComplianceTeamFinding,
  reviewComplianceContent,
} from '../services/aiComplianceWorkflowService.js'
import {
  reviewGeneratedComplianceDocx,
} from '../services/aiComplianceOutputService.js'
import { fetchComplianceModelEvidence } from '../services/aiComplianceModelResearchService.js'
import { fetchDueDiligenceNetworkEvidence } from '../services/aiDueDiligenceNetworkResearchService.js'
import { generateBusinessDocx } from '../services/aiBusinessDocumentService.js'
import { isDiagnosticEvidenceSourceName } from '../services/aiEvidenceQualityService.js'
import { loadAiSkill } from '../services/aiSkillService.js'
import { AI_TEMPLATE_CATALOG } from '../services/aiTemplateCatalog.js'

type Check = {
  name: string
  passed: boolean
  detail: string
}

const checks: Check[] = []

function check(name: string, condition: unknown, detail: string) {
  assert.ok(condition, `${name}：${detail}`)
  checks.push({ name, passed: true, detail })
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function main() {
  const outputDirectory = path.resolve(
    process.env.AI_COMPLIANCE_ACCEPTANCE_DIR
      ?? '/private/tmp/codex-compliance-skill-acceptance',
  )
  await mkdir(outputDirectory, { recursive: true })

  const template = AI_TEMPLATE_CATALOG.compliance_statement
  const [skill, blueprint] = await Promise.all([
    loadAiSkill(template.skillName),
    parseComplianceDocumentBlueprint(template),
  ])

  check(
    '模板语料库完整',
    blueprint.templates.length === 2,
    `${blueprint.templates.length}份DOCX模板`,
  )
  check(
    '模板摘要固定',
    blueprint.templates.map((item) => item.sha256).join(',') === [
      '5b51cda592736fc3b2bfc69bcc75875f5588496d47f7a6b6691b21daae8b115e',
      'ce793bf645a35ffa81d76665f1acaad4d3f2d46d3a47f824f1be6c258cb84e1e',
    ].join(','),
    blueprint.templates.map((item) => `${item.fileName}:${item.sha256.slice(0, 12)}`).join('；'),
  )
  check(
    'Document Blueprint章节树固定',
    blueprint.sectionTree.map((item) => item.title).join('、')
      === '公司情况介绍、投资理由、投资计划、投资情形分析'
      && blueprint.sectionTree[0].children.join('、') === '公司简介、核心团队、产品及技术',
    JSON.stringify(blueprint.sectionTree),
  )
  check(
    '模板页面系统一致',
    blueprint.templates.every((item) =>
      item.page.widthDxa === 11906
      && item.page.heightDxa === 16838
      && item.page.marginTopDxa === 1440
      && item.page.marginRightDxa === 1800
      && item.page.marginBottomDxa === 1440
      && item.page.marginLeftDxa === 1800),
    'A4纵向，上下1440/左右1800 DXA',
  )
  check(
    'Skill加载四份约束',
    [
      'references/template-spec.md',
      'references/workflow-contract.md',
      'references/reviewer-contract.md',
      'references/output-contract.md',
    ].every((name) => skill.referenceNames.includes(name)),
    skill.referenceNames.join('、'),
  )
  check(
    'Prompt禁止整篇一次生成',
    /不得一次性生成整篇|禁止一次性生成整篇|不要一次生成整份文档|不得生成整份文档/.test(
      `${skill.instructions}\n${skill.referenceInstructions}`,
    ),
    'Skill与reference要求逐章节生成',
  )
  check(
    'Skill不提及样本文件',
    !/样本|sample/i.test(`${skill.description}\n${skill.instructions}\n${skill.referenceInstructions}`),
    'Skill仅引用核心规范，不登记样本DOCX',
  )
  check(
    '缺失资料采用自然句式并禁用旧占位语',
    blueprint.fixedContent.missingDataSentence === COMPLIANCE_MISSING_DATA_SENTENCE
      && skill.referenceInstructions.includes('正文禁止使用')
      && skill.referenceInstructions.includes('当前项目暂无相关资料')
      && skill.referenceInstructions.includes('关键核验对象'),
    COMPLIANCE_MISSING_DATA_SENTENCE,
  )
  check(
    '性能和解析诊断文件可在候选截断前识别',
    [
      'perf_1784264832953.txt',
      'localperf_1784264895234.txt',
      '大文件测试_1784264758.txt',
      '解析测试_1784262637.txt',
      '卡住排查_1784264322.txt',
    ].every(isDiagnosticEvidenceSourceName)
      && !isDiagnosticEvidenceSourceName('智灵动力0611BP.pptx')
      && !isDiagnosticEvidenceSourceName('20260630-沈阳与智灵FDE团队交流纪要V1.pdf'),
    '诊断来源被排除，正式BP和纪要保留',
  )

  const project = {
    name: '生产验收企业项目',
    companyName: '生产验收企业有限公司',
  }
  const modelResearch = await fetchComplianceModelEvidence({
    project: {
      name: '智灵动力项目',
      companyName: '智灵动力科技有限公司',
      industry: '具身智能',
    },
    sourceCutoffDate: '2026-07-25',
    missingSections: ['公司简介', '核心团队', '产品及技术', '投资理由'],
    fetchImpl: (async (url) => {
      if (String(url).includes('/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                results: [{
                  topic: '官网、产品及技术',
                  title: '智灵动力项目公开介绍',
                  url: 'https://example.com/zhiling-power',
                  publisher: '示例官方来源',
                  publishedAt: '2026-07-01',
                }],
              }),
            },
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        '<html><head><title>智灵动力项目公开介绍</title></head><body>'
        + '智灵动力科技有限公司聚焦具身智能产品与机器人核心技术研发。'
        + '公司公开介绍包含创始团队、实验室合作、产品验证、融资事件和商业化进展。'.repeat(8)
        + '</body></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      )
    }) as typeof fetch,
    resolveHost: async () => ['93.184.216.34'],
    now: new Date('2026-07-25T08:00:00Z'),
  })
  check(
    '项目大模型网络补全返回可缓存证据',
    modelResearch.sources.length === 1
      && modelResearch.sources[0]?.sourceType === 'public_web_llm'
      && modelResearch.sources[0]?.locator === 'https://example.com/zhiling-power'
      && modelResearch.audit.verifiedSourceCount === 1,
    JSON.stringify(modelResearch.audit),
  )
  const researchedPackets = buildComplianceEvidencePackets(modelResearch.sources)
  check(
    '项目大模型补全证据进入对应章节',
    researchedPackets.find((packet) => packet.sectionTitle === '产品及技术')?.items.length === 1,
    researchedPackets.map((packet) => `${packet.sectionTitle}:${packet.items.length}`).join('、'),
  )
  let agentRequestBody = ''
  const agentResearch = await fetchDueDiligenceNetworkEvidence({
    project: {
      name: '阿尔法心理项目',
      companyName: '南京威豆网络科技有限公司',
    },
    sourceCutoffDate: '2026-07-25',
    pendingTopics: [
      '公司简介、主体工商、核心团队、创始人、产品技术和商业化公开信息',
      '投资方式、投资限制、返投政策、返投认定口径及可公开查询的返投记录',
    ],
    fetchImpl: async (_input, init) => {
      agentRequestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({
        result: {
          searchEvidence: [
            {
              query: '南京威豆网络科技有限公司 公司简介 主营业务',
              title: '阿尔法心理公司介绍',
              snippet: '南京威豆网络科技有限公司运营阿尔法心理产品，提供心理健康相关服务。',
              url: 'https://example.com/alpha/company',
              publisher: '公司官网',
              publishedAt: '2026-06-01',
              reliability: '公司官网',
            },
            {
              query: '南京威豆网络科技有限公司 核心团队 创始人',
              title: '阿尔法心理核心团队',
              snippet: '阿尔法心理公开页面披露创始人和核心团队的职责及经历。',
              url: 'https://example.com/alpha/team',
              publisher: '公司官网',
              publishedAt: '2026-06-02',
              reliability: '公司官网',
            },
            {
              query: '南京威豆网络科技有限公司 产品 技术 客户',
              title: '阿尔法心理产品与技术',
              snippet: '阿尔法心理公开介绍其心理服务产品、技术平台与客户应用场景。',
              url: 'https://example.com/alpha/product',
              publisher: '公司官网',
              publishedAt: '2026-06-03',
              reliability: '公司官网',
            },
            {
              query: '某政府引导基金 返投政策 返投认定口径 公开记录',
              title: '政府投资基金返投认定办法',
              snippet: '公开办法规定返投比例、返投项目认定范围、认定程序和统计口径。',
              url: 'https://example.gov.cn/fund/return-investment',
              publisher: '政府部门',
              publishedAt: '2026-05-01',
              reliability: '政府官网',
            },
          ],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    now: new Date('2026-07-25T08:00:00Z'),
  })
  check(
    '合规任务使用既有联网Agent补全公司团队产品及返投',
    agentRequestBody.includes('返投认定口径')
      && agentResearch.audit.provider === 'flue_intel_collect'
      && agentResearch.sources.length === 4
      && agentResearch.sources.every((source) =>
        source.sourceType === 'public_web_agent_search'
        && source.sourceName.startsWith('项目大模型网络补全·')),
    JSON.stringify(agentResearch.audit),
  )
  const agentPackets = buildComplianceEvidencePackets(agentResearch.sources)
  check(
    '联网Agent证据按主题进入公司团队产品及合规核查',
    ['公司简介', '核心团队', '产品及技术', '投资情形分析'].every((sectionTitle) =>
      (agentPackets.find((packet) => packet.sectionTitle === sectionTitle)?.items.length ?? 0) > 0),
    agentPackets.map((packet) => `${packet.sectionTitle}:${packet.items.length}`).join('、'),
  )
  const previousAgentDisableLlm = process.env.AI_COMPLIANCE_DISABLE_LLM
  process.env.AI_COMPLIANCE_DISABLE_LLM = '1'
  const agentFallbackWorkflow = await composeComplianceStatement({
    template,
    skill,
    blueprint,
    project: {
      name: '阿尔法心理项目',
      companyName: '南京威豆网络科技有限公司',
    },
    sources: agentResearch.sources,
    sourceCutoffDate: '2026-07-25',
    parameters: {},
  })
  if (previousAgentDisableLlm === undefined) delete process.env.AI_COMPLIANCE_DISABLE_LLM
  else process.env.AI_COMPLIANCE_DISABLE_LLM = previousAgentDisableLlm
  const returnInvestmentFinding = agentFallbackWorkflow.content.sections
    .find((section) => section.title === '投资情形分析')
    ?.findings[1]
  check(
    '返投公开依据生成待核验内容而非整项空缺',
    returnInvestmentFinding?.status === '待核验'
      && !returnInvestmentFinding.text.includes(COMPLIANCE_MISSING_DATA_SENTENCE)
      && returnInvestmentFinding.sourceIndexes.length === 1,
    returnInvestmentFinding?.text ?? '未生成返投核查项',
  )
  const agentDocxPath = path.join(outputDirectory, '阿尔法心理_联网补全场景自测.docx')
  await generateBusinessDocx({
    outputPath: agentDocxPath,
    template,
    project: {
      name: '阿尔法心理项目',
      companyName: '南京威豆网络科技有限公司',
    },
    content: agentFallbackWorkflow.content,
    sources: agentResearch.sources,
    sourceCutoffDate: '2026-07-25',
    generatedAt: new Date('2026-07-25T00:00:00+08:00'),
    blueprint,
  })
  const agentDocxReview = await reviewGeneratedComplianceDocx({
    filePath: agentDocxPath,
    template,
    blueprint,
    content: agentFallbackWorkflow.content,
    projectName: '阿尔法心理项目',
  })
  check(
    '阿尔法心理联网补全场景DOCX通过Word结构与字体验收',
    agentDocxReview.passed,
    agentDocxReview.issues.length
      ? agentDocxReview.issues.map((issue) => `${issue.code}:${issue.message}`).join('；')
      : agentDocxPath,
  )
  const localProjectSources = [
    {
      sourceType: 'file',
      sourceId: 'zhiling-bp',
      sourceName: '智灵动力BP.pptx',
      chunkIndex: 0,
      versionOrDate: '2026-05-16',
      content: [
        '智灵动力科技有限公司成立于2024年，定位为企业级自进化智能体技术公司，当前处于天使轮融资阶段。',
        '公司业务采用FDE交付模式进入企业工作流，商业模式包括项目服务费、软件订阅费和持续运维费。',
        '核心团队由创始人、CEO和CTO组成，具备人工智能研究、企业服务产品研发和产业客户交付经历。',
        '产品以ZeeLin自进化智能体平台为底座，具备算法训练、模型调用、工具编排、流程自动化和知识库能力。',
        '现有客户验证覆盖金融科技、品牌营销和企业研究场景，已形成标杆项目和商业化交付。',
        '公司正在推进3000万元天使轮融资，拟用于产品研发、客户交付和团队扩充。',
      ].join('\n'),
    },
  ]
  const localProjectPackets = buildComplianceEvidencePackets(localProjectSources)
  check(
    '本地项目BP优先覆盖公开事实章节',
    ['公司简介', '核心团队', '产品及技术', '投资理由', '投资计划', '投资情形分析'].every((sectionTitle) =>
      (localProjectPackets.find((packet) => packet.sectionTitle === sectionTitle)?.items.length ?? 0) > 0),
    localProjectPackets.map((packet) => `${packet.sectionTitle}:${packet.items.length}`).join('、'),
  )
  check(
    '来源材料编号不会进入报告正文',
    [
      cleanComplianceBodyText('（二）短剧相关业务'),
      cleanComplianceBodyText('3 、 学术团队：沈教授负责前沿技术研究'),
      cleanComplianceBodyText('1、业务主体：由合肥全资子公司运营'),
      cleanComplianceBodyText('二、智灵财务尽调相关'),
      cleanComplianceBodyText('1 沈阳与智灵FDE团队交流纪要'),
    ].join('、') === [
      '短剧相关业务',
      '沈教授负责前沿技术研究',
      '业务主体由合肥全资子公司运营',
      '智灵财务尽调相关',
      '沈阳与智灵FDE团队交流纪要',
    ].join('、'),
    '清除来源编号，并把标签式小标题改写为自然段落',
  )
  check(
    '团队、产品、拆分数字和句末标点门禁生效',
    isReadableComplianceTeamFinding('杨林（创始人、CEO）具有自动驾驶算法研发经历，现负责公司技术路线和核心产品研发。')
      && isReadableComplianceProductFinding('R2S2R端到端数据闭环方案。该方案联动真实数据与合成数据，用于智能体训练场景的数据生产与验证。')
      && cleanComplianceBodyText('以 1 0% 真实数据联动 90% 合成数据，规划营收 4 000万元、团队 3 0人。')
        === '以 10% 真实数据联动 90% 合成数据，规划营收 4000万元、团队 30人。'
      && ensureComplianceSentenceEnding('公司本轮拟融资人民币5,000万元')
        === '公司本轮拟融资人民币5,000万元。',
    '一人一段、一能力一段、数字连续且正文完整收句',
  )
  check(
    '取证过程不会进入客户可见正文',
    [
      cleanComplianceBodyText('现有项目材料显示，智灵动力正在推进新一轮融资。'),
      cleanComplianceBodyText('交流纪要记载，公司已形成算法优化交付能力。'),
      cleanComplianceBodyText('根据当前项目资料，公司拟通过增资方式融资。'),
      cleanComplianceBodyText('公开资料可提供通用核查线索，适用规则要求完成返投认定。'),
    ].join('、') === [
      '智灵动力正在推进新一轮融资。',
      '公司已形成算法优化交付能力。',
      '公司拟通过增资方式融资。',
      '相关公开规则和记录表明，适用规则要求完成返投认定。',
    ].join('、'),
    '来源名称与检索过程仅进入审计元数据，正文直接陈述事实和判断',
  )
  const outlineRichSources = [{
    sourceType: 'file',
    sourceId: 'zhiling-outline-rich',
    sourceName: '智灵动力交流纪要.pdf',
    chunkIndex: 0,
    versionOrDate: '2026-06-30',
    content: [
      '（二）短剧相关业务 1 、 TikTok短剧转绘业务 （1）业务主体：由合肥全资子公司运营，面向海外内容客户提供转绘服务。',
      '3 、 学术团队：沈教授带领清华学生团队负责前沿技术研究与论文产出。',
      '（三）算法优化业务 1 、 业务模式：为客户提供算法加速、参数优化和性能提升服务。',
      '四、智灵融资进展相关 （一）存量资产处置 1 、 公司计划推进新一轮融资。',
    ].join('\n'),
  }]
  const outlinePackets = buildComplianceEvidencePackets(outlineRichSources)
  check(
    '章节证据切片清除原始目录号',
    outlinePackets.flatMap((packet) => packet.items)
      .every((item) => !/^\s*(?:[一二三四五六七八九十百]+[、．]|[（(][^）)]+[）)]|\d+[、．])/.test(item.excerpt)),
    outlinePackets.flatMap((packet) => packet.items).map((item) => item.excerpt).join('；'),
  )
  const previousDisableLlm = process.env.AI_COMPLIANCE_DISABLE_LLM
  process.env.AI_COMPLIANCE_DISABLE_LLM = '1'
  const localFallbackWorkflow = await composeComplianceStatement({
    template,
    skill,
    blueprint,
    project: {
      name: '智灵动力验收项目',
      companyName: '智灵动力科技有限公司',
    },
    sources: localProjectSources,
    sourceCutoffDate: '2026-07-25',
    parameters: {},
  })
  if (previousDisableLlm === undefined) delete process.env.AI_COMPLIANCE_DISABLE_LLM
  else process.env.AI_COMPLIANCE_DISABLE_LLM = previousDisableLlm
  check(
    '章节模型不可用时本章兜底不跨章复制事实',
    localFallbackWorkflow.reviewReports.at(-1)?.passed
      && localFallbackWorkflow.reviewReports.at(-1)?.issues.every((issue) =>
        issue.code !== 'DUPLICATED_FACT'),
    localFallbackWorkflow.reviewReports.at(-1)?.issues
      .map((issue) => `${issue.code}:${issue.message}`)
      .join('、') || 'Reviewer无重复事实问题',
  )
  const evidencePackets = buildComplianceEvidencePackets([])
  check(
    '零证据章节包为空',
    evidencePackets.length === 6
      && evidencePackets.every((packet) => packet.items.length === 0),
    '6个叶子章节均无伪造证据',
  )
  const workflow = await composeComplianceStatement({
    template,
    skill,
    blueprint,
    project,
    sources: [],
    sourceCutoffDate: '2026-07-25',
    parameters: {},
  })
  const finalContentReview = workflow.reviewReports.at(-1)
  check(
    '零证据工作流通过Reviewer',
    finalContentReview?.passed,
    `报告${workflow.reviewReports.length}轮，问题${finalContentReview?.issueCount ?? -1}项`,
  )
  const missingFindings = workflow.content.sections.flatMap((section) =>
    section.findings.filter((finding) => finding.status === '资料缺口'))
  check(
    '零证据不调用模型且逐项使用自然的待确认表述',
    workflow.reviewerRegenerationRounds === 0
      && missingFindings.length >= 16
      && missingFindings.every((finding) =>
        !finding.text.includes('当前项目暂无相关资料')
        && !/(?:关键核验对象|关键核验条件|尚未闭环|条件性分析|条件化判断|取证边界|核验边界|形成单项结论|完成专项分析|本节需取得)/.test(finding.text)
        && /(?:应核对|需核对|尚待确认|尚未确定|仍需核对|以.+为准|暂不能判断)/.test(finding.text)
        && finding.sourceIndexes.length === 0),
    `${missingFindings.length}项资料缺口均直接说明待确认事实及所需文件`,
  )
  check(
    '投资理由固定五项',
    workflow.content.sections.find((section) =>
      section.title === '投资理由')?.findings.length === 5,
    '五段连续正文由核心规范约束',
  )
  check(
    '投资情形分析固定七项',
    workflow.content.sections.find((section) =>
      section.title === '投资情形分析')?.findings.length === 7,
    '七项顺序由Blueprint约束',
  )
  const proseFindings = workflow.content.sections
    .filter((section) => ['投资理由', '投资计划', '投资情形分析'].includes(section.title))
    .flatMap((section) => section.findings)
  check(
    '投资理由、投资计划和合规核查均为无标签连续正文',
    proseFindings.every((finding) =>
      !/^\s*\d+[、.．]\s*/.test(finding.text)
      && !/^[^，。；！？\n]{2,24}[：:]\s*\S/.test(finding.text)),
    proseFindings.map((finding) => finding.text.slice(0, 30)).join('；'),
  )

  const leakedContent = structuredClone(workflow.content)
  leakedContent.sections.find((section) => section.title === '公司简介')!.findings[0].text
    += ' 模板项目德塔智能可直接视为本项目事实。'
  const leakageReview = reviewComplianceContent({
    content: leakedContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截模板主体泄漏',
    leakageReview.issues.some((issue) => issue.code === 'TEMPLATE_FACT_LEAK'),
    leakageReview.issues.map((issue) => issue.code).join('、'),
  )

  const sourceProcessContent = structuredClone(workflow.content)
  sourceProcessContent.sections
    .find((section) => section.title === '公司简介')!.findings[0].text =
      '现有项目材料显示，智灵动力正在推进新一轮融资。'
  const sourceProcessReview = reviewComplianceContent({
    content: sourceProcessContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截项目资料和取证过程进入正文',
    sourceProcessReview.issues.some((issue) => issue.code === 'SOURCE_PROCESS_LEAK'),
    sourceProcessReview.issues.map((issue) => issue.code).join('、'),
  )

  const aiStyleContent = structuredClone(workflow.content)
  aiStyleContent.sections
    .find((section) => section.title === '投资理由')!.findings[0].text =
      '创始人或主要商务负责人是本章关键核验对象，相关核验条件尚未闭环。'
  const aiStyleReview = reviewComplianceContent({
    content: aiStyleContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截模型化套话和抽象概括',
    aiStyleReview.issues.some((issue) => issue.code === 'AI_STYLE_DRIFT'),
    aiStyleReview.issues.map((issue) => issue.code).join('、'),
  )

  const invalidCitationContent = structuredClone(workflow.content)
  const invalidFinding = invalidCitationContent.sections
    .find((section) => section.title === '公司简介')!.findings[0]
  invalidFinding.text = '生产验收企业有限公司已完成工商登记。'
  invalidFinding.status = '资料记载'
  invalidFinding.sourceIndexes = [99]
  const invalidCitationReview = reviewComplianceContent({
    content: invalidCitationContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截无效引用',
    invalidCitationReview.issues.some((issue) => issue.code === 'SOURCE_INDEX_INVALID')
      && invalidCitationReview.issues.some((issue) => issue.code === 'CITATION_IRRELEVANT'),
    invalidCitationReview.issues.map((issue) => issue.code).join('、'),
  )

  const unsupportedPendingContent = structuredClone(workflow.content)
  const unsupportedPendingFinding = unsupportedPendingContent.sections
    .find((section) => section.title === '核心团队')!.findings[0]
  unsupportedPendingFinding.text = '核心团队已经形成完整的复合背景。'
  unsupportedPendingFinding.status = '待核验'
  unsupportedPendingFinding.sourceIndexes = []
  const unsupportedPendingReview = reviewComplianceContent({
    content: unsupportedPendingContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截无依据的待核验事实',
    unsupportedPendingReview.issues.some((issue) => issue.code === 'CITATION_MISSING'),
    unsupportedPendingReview.issues.map((issue) => issue.code).join('、'),
  )

  const missingSectionContent = structuredClone(workflow.content)
  missingSectionContent.sections = missingSectionContent.sections.filter((section) =>
    section.title !== '投资计划')
  const missingSectionReview = reviewComplianceContent({
    content: missingSectionContent,
    template,
    blueprint,
    project,
    sources: [],
  })
  check(
    'Reviewer拦截章节遗漏',
    missingSectionReview.issues.some((issue) => issue.code === 'SECTION_MISSING')
      && missingSectionReview.issues.some((issue) => issue.code === 'SECTION_ORDER'),
    missingSectionReview.issues.map((issue) => issue.code).join('、'),
  )

  const docxPath = path.join(outputDirectory, '合规性说明_零证据自测.docx')
  const generation = await generateBusinessDocx({
    outputPath: docxPath,
    template,
    project,
    content: workflow.content,
    sources: [],
    sourceCutoffDate: '2026-07-25',
    generatedAt: new Date('2026-07-25T00:00:00+08:00'),
    blueprint,
  })
  const wordReview = await reviewGeneratedComplianceDocx({
    filePath: docxPath,
    template,
    blueprint,
    content: workflow.content,
    projectName: project.name,
  })
  check(
    'Word Reviewer通过',
    wordReview.passed,
    wordReview.issues.length
      ? wordReview.issues.map((issue) => `${issue.code}:${issue.message}`).join('；')
      : 'OpenXML、章节、固定内容、页面、模板部件、正式章节编号及正文段落全部通过',
  )
  check(
    'Word OpenXML 内部关系闭包完整',
    wordReview.metadata.relationshipClosureValidated === true
      && wordReview.metadata.fontEmbedRelationshipsValidated === true,
    '字体、主题、样式及其他内部关系不得指向缺失部件',
  )
  check(
    'Word正文隔离审计元数据',
    wordReview.metadata.forbiddenContentValidated === true,
    '状态标签、责任声明、风险、缺口汇总、引用清单和免责声明不进入正文',
  )
  check(
    'Word中文字体和标题字形符合核心规范',
    wordReview.metadata.typographyValidated === true
      && wordReview.metadata.fontFallbackAliasesValidated === true,
    '标题黑体14pt常规，一级/二级标题宋体12pt加粗且编号缩进不受列表样式污染',
  )

  const docxBuffer = await readFile(docxPath)
  const report = {
    generatedAt: new Date().toISOString(),
    passed: checks.every((item) => item.passed),
    checks,
    blueprint: {
      version: blueprint.version,
      sha256: blueprint.blueprintSha256,
      templates: blueprint.templates.map((item) => ({
        fileName: item.fileName,
        sha256: item.sha256,
      })),
    },
    workflow: {
      generationMode: workflow.generationMode,
      evidencePackets: workflow.evidencePackets.map((packet) => ({
        sectionTitle: packet.sectionTitle,
        itemCount: packet.items.length,
      })),
      reviewerRegenerationRounds: workflow.reviewerRegenerationRounds,
    },
    artifacts: {
      docx: { path: docxPath, bytes: docxBuffer.length, sha256: sha256(docxBuffer) },
    },
    generation,
    reviews: {
      content: finalContentReview,
      word: wordReview,
    },
  }
  const reportPath = path.join(outputDirectory, 'acceptance-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
