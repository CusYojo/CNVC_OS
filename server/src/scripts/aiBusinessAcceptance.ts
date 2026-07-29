import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import {
  annotateDueDiligencePendingAfterResearch,
  composeBusinessContent,
  DUE_DILIGENCE_GENERATION_GROUPS,
  dueDiligenceContentQualityIssues,
  dueDiligencePendingResearchTopics,
  finalizeDueDiligenceContent,
  normalizeBusinessContent,
  type BusinessContent,
  type BusinessFinding,
  type BusinessTable,
  type EvidenceSource,
} from '../services/aiBusinessContentService.js'
import {
  generateBusinessDocx,
  generateBusinessPptx,
  generateBusinessPptxPreview,
} from '../services/aiBusinessDocumentService.js'
import { loadAiSkill } from '../services/aiSkillService.js'
import {
  AI_TASK_TYPES,
  AI_TEMPLATE_CATALOG,
  type AiBusinessTaskType,
} from '../services/aiTemplateCatalog.js'
import { cleanCorruptedText, decodeTextBuffer } from '../services/textQualityService.js'
import { curateEvidenceSources } from '../services/aiEvidenceQualityService.js'
import { fetchDueDiligenceNetworkEvidence } from '../services/aiDueDiligenceNetworkResearchService.js'

type Check = { name: string; passed: boolean; detail: string }

const outputDir = path.resolve(
  process.env.AI_ACCEPTANCE_DIR || path.join(tmpdir(), 'cybernaut-ai-business-acceptance'),
)
const sourceCutoffDate = '2026-07-24'
const requestedTypes = new Set(
  String(process.env.AI_ACCEPTANCE_TYPES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)

const project = {
  name: '业务验收示例项目',
  companyName: '杭州示例科技有限公司',
  industry: '企业服务与人工智能',
  stage: '尽调',
  financing: '拟进行 A 轮融资；金额及用途以正式交易文件为准',
  valuation: '估值尚待交易文件及可比公司分析核验',
  summary: '公司围绕企业知识管理提供软件产品，本验收数据为脱敏虚构内容。',
  businessModel: '拟采用软件订阅及实施服务模式，合同、收入确认和续费数据待核验。',
  market: '目标市场规模、增长率和竞争格局需以经批准的第三方报告交叉验证。',
  team: '核心团队背景以脱敏项目档案记载为准，任职经历仍需背调。',
}

const sources: EvidenceSource[] = [
  {
    sourceType: 'project_record',
    sourceId: 'acceptance-project',
    sourceName: '项目档案（脱敏验收数据）',
    chunkIndex: 0,
    content: '项目处于尽调阶段；公司定位、融资计划及基础团队信息已经录入项目档案。',
  },
  {
    sourceType: 'file',
    sourceId: 'acceptance-bp',
    sourceName: '示例项目商业计划书（脱敏）',
    chunkIndex: 3,
    content: '企业自述产品已形成标准化模块，客户、收入和续费数据仍需底稿核验。',
  },
  {
    sourceType: 'file',
    sourceId: 'acceptance-bp',
    sourceName: '示例项目商业计划书（脱敏）',
    chunkIndex: 4,
    content: '商业计划书另行说明产品采用订阅和实施服务模式，合同与收入确认口径仍需底稿核验。',
  },
  {
    sourceType: 'meeting',
    sourceId: 'acceptance-interview',
    sourceName: '管理层访谈纪要（脱敏）',
    chunkIndex: 1,
    content: '管理层说明本轮资金主要用于产品研发和市场拓展；实际用途以交易文件为准。',
  },
  {
    sourceType: 'file',
    sourceId: 'acceptance-unused',
    sourceName: '未使用来源（不得进入文尾）',
    chunkIndex: 9,
    content: '这是一条格式完整但未被任何正文发现引用的验收资料。',
  },
]

function findings(sectionIndex: number): BusinessFinding[] {
  return [
    {
      text: `本节已根据脱敏项目档案与样本证据整理；第 ${sectionIndex + 1} 项事实须回到原始资料复核。`,
      status: '资料记载',
      sourceIndexes: [sectionIndex % 4],
    },
    {
      text: '基于现有证据形成的分析判断不等同于经审计事实，投资团队应完成交叉验证。',
      status: 'AI推断',
      sourceIndexes: [0, 1],
    },
    {
      text: '合同、财务、客户及法律资质原件尚未在本次脱敏验收数据中提供。',
      status: sectionIndex % 2 === 0 ? '待核验' : '资料缺口',
      sourceIndexes: [],
    },
  ]
}

function contentFor(type: AiBusinessTaskType): BusinessContent {
  const template = AI_TEMPLATE_CATALOG[type]
  const dueFocus: Record<string, string> = {
    投资概要: '客户验证、收入质量与核心权属安排',
    公司概况: '公司主体、主营业务和发展阶段',
    股权结构及融资历程: '股东结构、历史融资和资金到位情况',
    公司治理与管理团队: '核心人员分工、任职稳定性和治理机制',
    产品与核心技术: '产品能力、技术实现和知识产权边界',
    商业模式与经营情况: '收费方式、交付流程和收入确认条件',
    客户与商业化进展: '客户阶段、合同交付和续费回款',
    行业概况与市场空间: '目标客户范围、采购约束和可服务空间',
    产业链与竞争格局: '上下游依赖、替代方案和具名竞品差异',
    财务分析: '历史收入、成本费用和现金消耗',
    估值合理性分析: '融资口径、可比交易和估值前提',
    投资方案: '推进前提、责任分工和下一审批动作',
    投资亮点: '产品差异、客户验证和资本关注信号',
    法律合规与资质: '主体登记、业务资质和争议风险',
    风险分析: '可能改变推进结论的触发条件和缓释动作',
    后续核验事项: '需要原件或相关主体确认的重大未决事项',
  }
  const tablesFor = (title: string): BusinessTable[] => {
    if (type === 'due_diligence_report' && title === '财务分析') {
      return [{
        title: '历史财务摘要',
        unit: '万元',
        columns: ['项目', '2025年', '2024年'],
        rows: [
          ['营业收入', '2,000', '1,200'],
          ['净利润', '120', '-100'],
        ],
        status: '资料记载',
        sourceIndexes: [1],
      }]
    }
    if (type !== 'investment_proposal') return []
    if (title === '（六）财务摘要') {
      return [{
        title: '历史财务摘要',
        unit: '万元',
        columns: ['项目', '2024A', '2025A'],
        rows: [
          ['营业收入', '1,200', '2,000'],
          ['净利润', '-100', '120'],
        ],
        status: '资料记载',
        sourceIndexes: [1],
      }]
    }
    if (title === '（二）本轮公司估值和投资方案') {
      return [{
        title: '本轮投资方案',
        unit: '万元',
        columns: ['投资形式', '投资金额', '估值口径'],
        rows: [['增资', '待核验', '以正式交易文件为准']],
        status: '待核验',
        sourceIndexes: [3],
      }]
    }
    return []
  }
  const raw: BusinessContent = {
    title: `${project.name}${template.label}`,
    executiveSummary: type === 'due_diligence_report'
      ? `阶段与推进建议：继续跟踪。杭州示例科技已形成企业知识管理软件产品和订阅加实施服务的商业路径，但客户合同、收入确认、续费回款及核心权属安排尚不足以支持进入下一审批环节。建议优先核对重点客户从试用到合同、交付、验收和回款的完整链条，同时确认核心团队任职、知识产权归属及本轮融资文件；上述事项完成后再评估是否申请进入下一阶段。`
      : `本初稿采用公司标准模板，依据截至 ${sourceCutoffDate} 的脱敏证据形成。资料记载、AI 推断、待核验事项及资料缺口已分开标识，所有结论仍须业务审核。`,
    sections: template.sections.map((title, index) => {
      if (type !== 'due_diligence_report') {
        return {
          title,
          summary: `${title}按照 docs 中可编辑主样本提炼的章节结构生成。`,
          findings: findings(index),
          tables: tablesFor(title),
        }
      }
      const focus = dueFocus[title]
      const sectionFindings: BusinessFinding[] = [
        {
          text: `杭州示例科技围绕企业知识管理软件推进${focus}，相关事项已纳入本轮尽调核查范围。`,
          status: '资料记载',
          sourceIndexes: [index % 4],
        },
        {
          text: `${focus}将直接影响项目由尽调阶段进入下一审批环节的条件设置，投资团队应据此安排核验优先级和责任分工。`,
          status: 'AI推断',
          sourceIndexes: [0, 1],
        },
      ]
      if (title === '公司治理与管理团队') {
        sectionFindings.push({
          text: '核心团队成员的完整任职经历及知识产权贡献关系仍需取得劳动合同、履历证明和权属文件确认。',
          status: '待核验',
          sourceIndexes: [],
        })
      }
      return {
        title,
        summary: `${focus}直接关系到杭州示例科技能否由尽调阶段进入下一审批环节。`,
        findings: sectionFindings,
        tables: tablesFor(title),
      }
    }),
    highlights: ['产品定位较清晰，但商业证据仍需补强', '业务模式具备可讨论基础，尚不能作为已核验结论', '任务产物保留模板版本和来源定位'],
    risks: ['关键财务及客户数据尚未经独立核验', '法律合规结论必须由法务审核', '模型生成内容不得替代最终投资决策'],
    missing: ['审计口径财务底稿', '核心客户合同及访谈记录', '工商、知识产权及合规原件'],
  }
  const normalized = normalizeBusinessContent(raw, template, raw, sources.length)
  if (type === 'investment_proposal') {
    normalized.executiveSummary = normalized.executiveSummary
      .replace('及资料缺口已分开标识', '已分开标识')
    normalized.sections.forEach((section) => {
      section.findings.forEach((finding) => {
        if (finding.status === '资料缺口') finding.status = '待核验'
      })
    })
    normalized.missing = []
  }
  return type === 'due_diligence_report'
    ? finalizeDueDiligenceContent(normalized)
    : normalized
}

async function openXmlText(filePath: string, prefix: RegExp) {
  const zip = await JSZip.loadAsync(await readFile(filePath))
  const names = Object.keys(zip.files).filter((name) => prefix.test(name))
  const xml = (await Promise.all(names.map((name) => zip.file(name)!.async('string')))).join('\n')
  return { zip, names, xml }
}

function assert(checks: Check[], name: string, condition: boolean, detail: string) {
  checks.push({ name, passed: condition, detail })
  if (!condition) throw new Error(`${name}：${detail}`)
}

async function main() {
  await mkdir(outputDir, { recursive: true })
  const checks: Check[] = []
  const artifacts: string[] = []
  const dueDiligenceGroupedSections = DUE_DILIGENCE_GENERATION_GROUPS
    .flatMap((group) => [...group.sections])
  assert(
    checks,
    'AI-010 八个章组完整覆盖且只覆盖十六个固定模块',
    DUE_DILIGENCE_GENERATION_GROUPS.length === 8
      && DUE_DILIGENCE_GENERATION_GROUPS.every((group) => group.sections.length <= 4)
      && dueDiligenceGroupedSections.length === AI_TEMPLATE_CATALOG.due_diligence_report.sections.length
      && dueDiligenceGroupedSections.every((title, index) =>
        title === AI_TEMPLATE_CATALOG.due_diligence_report.sections[index])
      && new Set(dueDiligenceGroupedSections).size === dueDiligenceGroupedSections.length,
    '单次最多四个模块；合并顺序与模板十六模块完全一致',
  )
  const dueDiligenceSkill = await loadAiSkill('write-due-diligence-report')
  const requestedChapterGroups: string[][] = []
  const progressEvents: Array<{ completedChapters: number; phase: string }> = []
  let productChapterTruncated = false
  const segmentedContent = await composeBusinessContent({
    type: 'due_diligence_report',
    template: AI_TEMPLATE_CATALOG.due_diligence_report,
    skill: dueDiligenceSkill,
    project,
    sources,
    sourceCutoffDate,
    parameters: { diligenceScope: '商业尽调' },
    dueDiligencePass: 'gap-analysis',
    dueDiligenceRuntime: {
      concurrency: 3,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages?: Array<{ role?: string; content?: string }>
        }
        const systemPrompt = body.messages?.find((message) => message.role === 'system')?.content ?? ''
        if (systemPrompt.includes('形成不重复正文的决策摘要')) {
          return new Response(JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  title: '杭州示例科技有限公司尽调报告',
                  executiveSummary: '阶段与推进建议：继续跟踪。项目已形成企业知识管理软件与订阅加实施服务的业务方向，产品能力和团队分工仍需以原始记录交叉确认；客户合同、交付验收、收入确认、续费回款、知识产权权属及本轮融资文件可能改变阶段判断。建议依次核对工商与权属、重点客户完整交易链条、历史财务和资金用途，在关键事项闭环后再决定是否申请立项。',
                  executiveSummarySourceIndexes: [0, 1],
                  highlights: ['企业知识管理软件已形成明确应用方向'],
                  risks: ['客户交易链条和权属边界仍需核验'],
                }),
              },
            }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        const matched = systemPrompt.match(/sections 必须且只能按指定顺序返回：(.+)。/)
        const sectionTitles = matched?.[1].split('、').filter(Boolean) ?? []
        requestedChapterGroups.push(sectionTitles)
        if (sectionTitles.length === 1
          && sectionTitles[0] === '产品与核心技术'
          && !productChapterTruncated) {
          productChapterTruncated = true
          return new Response(JSON.stringify({
            choices: [{
              finish_reason: 'length',
              message: { content: '{"sections":[' },
            }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                sections: sectionTitles.map((title) => ({
                  title,
                  summary: `${title}的关键事实和投资影响需结合原始文件完成交叉确认。`,
                  findings: [{
                    text: `${title}：应核对具名主体、时间、关系及原始凭证，并据此判断该事项是否改变项目推进条件。`,
                    status: '待核验',
                    sourceIndexes: [],
                  }],
                  tables: [],
                })),
              }),
            },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
      onProgress: async (event) => {
        progressEvents.push({
          completedChapters: event.completedChapters,
          phase: event.phase,
        })
      },
    },
  })
  assert(
    checks,
    'AI-010 截断时只重试受影响章组且从未请求整篇十六模块 JSON',
    requestedChapterGroups.length === 9
      && requestedChapterGroups.every((group) => group.length >= 1 && group.length <= 4)
      && requestedChapterGroups.filter((group) =>
        group.length === 1 && group[0] === '产品与核心技术').length === 2
      && DUE_DILIGENCE_GENERATION_GROUPS.every((expected) =>
        requestedChapterGroups.some((actual) =>
          actual.join('、') === expected.sections.join('、')))
      && segmentedContent.sections.every((section, index) =>
        section.title === AI_TEMPLATE_CATALOG.due_diligence_report.sections[index])
      && segmentedContent.generationAudit?.blueprintVersion === 'due-diligence-eight-chapter-v1'
      && progressEvents.some((event) => event.phase === 'regenerating')
      && progressEvents.some((event) => event.completedChapters === 8),
    '产品与技术首轮截断后仅该章重试；其他章组只请求一次，合并后仍为模板规定的 16 模块',
  )
  let researchRequestBody = ''
  const researchProbe = await fetchDueDiligenceNetworkEvidence({
    project,
    sourceCutoffDate,
    pendingTopics: ['核心团队：核验创始人教育及任职经历'],
    fetchImpl: async (_input, init) => {
      researchRequestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({
        result: {
          searchEvidence: [{
            query: '杭州示例科技有限公司 创始人 教育 任职',
            title: '杭州示例科技核心团队介绍',
            snippet: '公司官网披露创始人的教育及任职经历。',
            url: 'https://example.com/team',
            publisher: '示例科技',
            publishedAt: '2026-06-01',
            reliability: '公司官网',
          }],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    now: new Date('2026-07-24T08:00:00Z'),
  })
  assert(
    checks,
    'AI-010 联网检索 Agent 接收待核验问题并形成可缓存证据',
    researchRequestBody.includes('核心团队：核验创始人教育及任职经历')
      && researchProbe.audit.provider === 'flue_intel_collect'
      && researchProbe.audit.status === 'succeeded'
      && researchProbe.sources[0]?.sourceType === 'public_web_agent_search'
      && researchProbe.sources[0]?.locator === 'https://example.com/team',
    JSON.stringify(researchProbe.audit),
  )
  const utf16Probe = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('中文编码验收', 'utf16le'),
  ])
  const decodedProbe = decodeTextBuffer(utf16Probe)
  assert(
    checks,
    '文本导入可识别 UTF-16LE 中文',
    decodedProbe.encoding === 'utf-16le' && decodedProbe.text === '中文编码验收',
    `${decodedProbe.encoding}:${decodedProbe.text}`,
  )
  const gb18030Probe = decodeTextBuffer(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
  assert(
    checks,
    '文本导入可识别 GB18030 中文',
    gb18030Probe.encoding === 'gb18030' && gb18030Probe.text === '中文',
    `${gb18030Probe.encoding}:${gb18030Probe.text}`,
  )
  const repairedProbe = cleanCorruptedText('u�Z��m��Z�vڱ�这是一份用于验收的中文项目资料，包含足够的可读内容。')
  assert(
    checks,
    '历史损坏片段不会把替换字符带入产物',
    repairedProbe.usable && !repairedProbe.cleaned.includes('\uFFFD') && repairedProbe.cleaned.startsWith('这是一份'),
    repairedProbe.cleaned,
  )
  const windows1252Broken = Buffer.from('中文编码测试', 'utf8').toString('latin1')
  const mojibakeProbe = cleanCorruptedText(`项目摘要：${windows1252Broken}，后续中文内容保持正常。`)
  assert(
    checks,
    '历史 Windows-1252 错译可恢复为中文',
    mojibakeProbe.usable
      && mojibakeProbe.cleaned.includes('中文编码测试')
      && !/[äåæçèé][\u0080-\u00FF\u2010-\u2030]{1,2}/.test(mojibakeProbe.cleaned),
    mojibakeProbe.cleaned,
  )
  const curatedProbe = curateEvidenceSources([
    {
      sourceType: 'file',
      sourceId: 'quality-a',
      sourceName: '有效经营资料.docx',
      chunkIndex: 1,
      content: '公司已签署两份客户合同，合同金额、交付进度和回款情况仍需以合同原件及银行流水核验。',
    },
    {
      sourceType: 'file',
      sourceId: 'quality-a',
      sourceName: '有效经营资料.docx',
      chunkIndex: 2,
      content: '公司已签署两份客户合同，合同金额、交付进度和回款情况仍需以合同原件及银行流水核验。',
    },
    {
      sourceType: 'file',
      sourceId: 'quality-test',
      sourceName: '大文件测试.txt',
      chunkIndex: 0,
      content: '赛智伯乐投资中台大文件上传测试。'.repeat(60),
    },
  ])
  assert(
    checks,
    '证据预处理排除测试与重复片段',
    curatedProbe.usable.length === 1
      && curatedProbe.usable[0].sourceName === '有效经营资料.docx'
      && curatedProbe.rejected.length >= 2,
    `采用 ${curatedProbe.usable.length} 条，排除 ${curatedProbe.rejected.length} 条`,
  )
  assert(
    checks,
    '文档任务以当前项目资料库证据为生成基础',
    sources.some((source) => source.sourceType === 'file')
      && sources.some((source) => source.sourceType === 'meeting')
      && !sources.some((source) => source.sourceType.startsWith('public_web')),
    `${sources.length} 条项目证据`,
  )
  for (const type of AI_TASK_TYPES.filter((type) =>
    requestedTypes.size === 0 || requestedTypes.has(type))) {
    const template = AI_TEMPLATE_CATALOG[type]
    assert(checks, `${type} 主样本存在`, existsSync(template.referencePath), template.referencePath)
    if (type === 'project_qa') {
      assert(
        checks,
        'AI-011 Q&A 由独立 DOCX Pipeline 验收',
        template.outputFormat === 'docx',
        '项目 Q&A 使用独立可编辑 DOCX 生成器',
      )
      continue
    }
    const content = contentFor(type)
    if (type === 'compliance_statement') {
      const analysis = content.sections.find((section) => section.title === '投资情形分析')
      const container = content.sections.find((section) => section.title === '公司情况介绍')
      assert(
        checks,
        'AI-007 逻辑槽映射为模板固定检查结构',
        container?.findings.length === 0
          && analysis?.findings.length === 7
          && [
            '投资方式及投资限制',
            '返投要求',
            '关联交易',
            '投资方向',
            '投资配置',
            '投资集中度',
            '其他法律法规、监管规定及基金合规要求',
          ].every((topic, index) => analysis.findings[index]?.text.startsWith(topic)),
        '公司情况介绍仅作容器；投资情形分析固定七项并按模板顺序返回',
      )
    }
    if (template.outputFormat === 'pptx') {
      const outputPath = path.join(outputDir, 'AI-009_业务验收_投资建议书.pptx')
      const result = await generateBusinessPptx({
        outputPath,
        template,
        project,
        content,
        sources,
        sourceCutoffDate,
        pageCount: '12-15页',
      })
      const previewPath = path.join(outputDir, 'AI-009_业务验收_投资建议书.preview.png')
      const preview = await generateBusinessPptxPreview({
        outputPath: previewPath,
        template,
        project,
        content,
        sourceCutoffDate,
      })
      artifacts.push(outputPath, previewPath)
      const { zip, names, xml } = await openXmlText(outputPath, /^ppt\/slides\/slide\d+\.xml$/)
      const previewBuffer = await readFile(previewPath)
      assert(checks, 'AI-009 PPTX 为有效 OpenXML', Boolean(zip.file('ppt/presentation.xml')), outputPath)
      assert(checks, 'AI-009 页数符合 12-15 页参数', names.length >= 12 && names.length <= 15, `实际 ${names.length} 页`)
      const editableTexts = (xml.match(/<a:t>/g) || []).length
      assert(checks, 'AI-009 核心文本为可编辑对象', editableTexts >= names.length * 3, `文本对象 ${editableTexts}`)
      assert(
        checks,
        'AI-009 含原生可编辑表格与形状',
        xml.includes('<a:tbl>') && xml.includes('<p:sp>'),
        '项目核心信息表格及状态标识形状',
      )
      assert(
        checks,
        'AI-009 预览图有效且与封面元数据一致',
        previewBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          && previewBuffer.length > 1000
          && preview.width === 1600
          && preview.height === 900,
        `${preview.width}×${preview.height}，${previewBuffer.length} bytes`,
      )
      assert(checks, 'AI-009 含免责声明', xml.includes(template.disclaimer), template.disclaimer)
      assert(checks, 'AI-009 含来源与截止日', xml.includes('来源：') && xml.includes(sourceCutoffDate), sourceCutoffDate)
      const finalSlideXml = await zip.file(`ppt/slides/slide${names.length}.xml`)?.async('string') || ''
      assert(
        checks,
        'AI-009 文尾包含去重后的引用资料',
        finalSlideXml.includes('引用资料与责任声明')
          && finalSlideXml.includes('示例项目商业计划书（脱敏）')
          && !finalSlideXml.includes('未使用来源（不得进入文尾）')
          && (finalSlideXml.match(/示例项目商业计划书（脱敏）/g) || []).length === 1,
        '最后一页只列正文实际使用来源，同一文件合并片段',
      )
      assert(checks, 'AI-009 生成元数据页数一致', result.slideCount === names.length, `${result.slideCount}/${names.length}`)
      const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string') || ''
      const forbiddenSampleTerms = ['佳量', '德塔', 'Epilcure', '曹鹏', 'recommendation-jialiang']
      assert(checks, 'AI-009 中文文本语言标记正确', !xml.includes('lang="en-US"') && xml.includes('lang="zh-CN"'), '全部中文文本使用 zh-CN')
      assert(checks, 'AI-009 设置东亚主题字体', /<a:ea[^>]+typeface="微软雅黑"/.test(themeXml), '微软雅黑')
      assert(checks, 'AI-009 不含损坏字符', !xml.includes('\uFFFD'), '未发现 U+FFFD')
      assert(checks, 'AI-009 不泄露示例项目与内部模板编号', forbiddenSampleTerms.every((term) => !xml.includes(term)), forbiddenSampleTerms.join('、'))
      assert(
        checks,
        'AI-009 已应用公司模板资产',
        result.templateApplied && result.inheritedCompanyAssets >= 3 && Boolean(result.templateSha256),
        `资产 ${result.inheritedCompanyAssets}，模板摘要 ${result.templateSha256.slice(0, 12)}`,
      )
      continue
    }

    const prefix = type === 'compliance_statement'
      ? 'AI-007_业务验收_合规性说明'
      : type === 'investment_proposal'
        ? 'AI-008_业务验收_投资提案'
        : 'AI-010_业务验收_尽调报告'
    const outputPath = path.join(outputDir, `${prefix}.docx`)
    const result = await generateBusinessDocx({ outputPath, template, project, content, sources, sourceCutoffDate })
    artifacts.push(outputPath)
    const { zip, xml } = await openXmlText(outputPath, /^word\/.*\.xml$/)
    assert(checks, `${type} DOCX 为有效 OpenXML`, Boolean(zip.file('word/document.xml')), outputPath)
    assert(checks, `${type} 含可编辑文本`, (xml.match(/<w:t/g) || []).length > template.sections.length * 2, `章节 ${template.sections.length}`)
    const documentXml = await zip.file('word/document.xml')?.async('string') || ''
    if (type === 'compliance_statement') {
      assert(
        checks,
        'AI-007 正式正文仅保留核心规范结构',
        ['公司情况介绍', '公司简介', '核心团队', '产品及技术', '投资理由', '投资计划', '投资情形分析']
          .every((section) => documentXml.includes(section))
          && ['摘要', '已核验事实', '风险提示', '待核验事项', '资料缺口', '免责声明', '引用资料']
            .every((section) => !documentXml.includes(section))
          && !documentXml.includes(template.disclaimer),
        '四章、三个公司子节、无模板外正文板块',
      )
    } else if (type === 'due_diligence_report') {
      const pendingTopics = dueDiligencePendingResearchTopics(content)
      assert(
        checks,
        'AI-010 将待核验 finding 转成定向联网检索问题',
        pendingTopics.length > 0
          && pendingTopics.length <= 16
          && pendingTopics.every((topic) => topic.includes('：')),
        `${pendingTopics.length} 个具体检索问题`,
      )
      const annotatedPending = annotateDueDiligencePendingAfterResearch(content, 'no_results')
      const annotatedPendingSection = annotatedPending.sections
        .find((section) => section.title === '后续核验事项')
      assert(
        checks,
        'AI-010 联网后只集中保留重大后续核验事项',
        Boolean(annotatedPendingSection)
          && (annotatedPendingSection?.findings.length ?? 0) > 0
          && (annotatedPendingSection?.findings.length ?? 0) <= 8
          && annotatedPending.sections
            .filter((section) => section.title !== '后续核验事项')
            .every((section) => section.findings.every((finding) => finding.status !== '待核验'))
          && !/项目资料库|联网检索|证据不足/.test(annotatedPendingSection!.summary),
        `${annotatedPendingSection?.findings.length ?? 0} 项集中保留`,
      )
      const qualityIssues = dueDiligenceContentQualityIssues(content, template.sections)
      assert(
        checks,
        'AI-010 通过投资经理可读性门禁',
        qualityIssues.length === 0,
        qualityIssues.join('；') || '无过程性空话、资料分片、孤立数字或稀疏章节',
      )
      const badQualityIssues = dueDiligenceContentQualityIssues({
        ...content,
        executiveSummary: '本初稿依据现有资料形成，结论强度以所列状态和引用为准。',
        sections: content.sections.map((section, index) => index === 1
          ? {
              ...section,
              summary: '现有资料可支持初步梳理。',
              findings: [{
                text: '1000',
                status: '资料记载',
                sourceIndexes: [0],
              }],
            }
          : section),
      }, template.sections)
      assert(
        checks,
        'AI-010 拦截问题样本中的过程性空话和原始资料分片',
        badQualityIssues.some((issue) => issue.includes('资料处理过程'))
          && badQualityIssues.some((issue) => issue.includes('资料分片')),
        badQualityIssues.join('；'),
      )
      const misplacedContentIssues = dueDiligenceContentQualityIssues({
        ...content,
        sections: content.sections.map((section) => {
          if (section.title === '产品与核心技术') {
            return {
              ...section,
              summary: '页面正文摘录：公司详情、首页、权威榜和行业数据。',
              findings: [{
                text: '智灵动力公司详情、产品介绍、企业入驻、小程序、登入、关注、已关注。',
                status: '资料记载',
                sourceIndexes: [0],
              }],
            }
          }
          if (section.title === '财务分析') {
            return {
              ...section,
              summary: '融资估值与投资方信息如下。',
              findings: [{
                text: '1亿元',
                status: '资料记载',
                sourceIndexes: [0],
              }],
              tables: [],
            }
          }
          return section
        }),
      }, template.sections)
      assert(
        checks,
        'AI-010 拦截产品网页残留、模块错配和伪财务分析',
        misplacedContentIssues.some((issue) => issue.includes('网页导航'))
          && misplacedContentIssues.some((issue) => issue.includes('财务分析的正文主题与标题不匹配'))
          && misplacedContentIssues.some((issue) => issue.includes('资料分片')),
        misplacedContentIssues.join('；'),
      )
      assert(checks, `${type} 章节完整`, template.sections.every((section) => xml.includes(section)), template.sections.join('、'))
      assert(
        checks,
        'AI-010 正文不输出资料缺口占位、免责声明或文末引用资料',
        !documentXml.includes('资料缺口')
          && !documentXml.includes('责任声明')
          && !documentXml.includes('引用资料')
          && !documentXml.includes('免责声明'),
        '报告在 8.2 后续核验事项结束；来源仅留存在系统审计记录',
      )
      assert(
        checks,
        'AI-010 输出供投资决策使用的项目推进结论',
        (documentXml.match(/阶段与推进建议：继续跟踪/g) || []).length >= 2,
        '执行摘要与投资概要均使用同一个项目推进结论',
      )
      assert(
        checks,
        'AI-010 正式正文不显示内部证据状态标签',
        !documentXml.includes('【资料记载】')
          && !documentXml.includes('【AI推断】')
          && !documentXml.includes('【待核验】')
          && !documentXml.includes('来源明细保存在系统审计记录中'),
        '状态和来源索引仅保存在系统审计结构',
      )
      assert(
        checks,
        'AI-010 正文不向投资经理解释资料处理过程',
        [
          '现有资料',
          '现有材料',
          '项目资料库',
          '本节',
          '证据不足',
          '结论强度',
          '初步梳理',
          '检索问题',
          '联网检索',
        ].every((phrase) => !documentXml.includes(phrase)),
        '正文只写项目事实、投资含义、限制和动作',
      )
      assert(
        checks,
        'AI-010 使用模板式原生表格呈现结构化数据',
        documentXml.includes('历史财务摘要')
          && documentXml.includes('营业收入')
          && documentXml.includes('净利润'),
        '财务等行列数据使用可编辑 Word 表格',
      )
      assert(
        checks,
        'AI-010 财务表使用模板式灰表头、左对齐表题和数字右对齐',
        /<w:pStyle w:val="91"\/>[\s\S]*?<w:t[^>]*>历史财务摘要<\/w:t>/.test(documentXml)
          && documentXml.includes('w:fill="E7E6E6"')
          && documentXml.includes('<w:jc w:val="right"/>'),
        '财务表题沿用正文样式，单位独立，浅灰表头，数值列右对齐',
      )
      assert(
        checks,
        'AI-010 小结和分析先于概览及数据表',
        documentXml.indexOf('客户验证、收入质量与核心权属安排直接关系')
          < documentXml.indexOf('公司主体')
          && documentXml.indexOf('历史收入、成本费用和现金消耗将直接影响')
            < documentXml.indexOf('历史财务摘要'),
        '先给判断与分析，再呈现概览表或数据表',
      )
    } else if (type === 'investment_proposal') {
      assert(checks, `${type} 章节完整`, template.sections.every((section) => xml.includes(section)), template.sections.join('、'))
      assert(
        checks,
        `${type} 不生成资料缺口、免责声明或文末引用资料`,
        !documentXml.includes('资料缺口')
          && !documentXml.includes('免责声明')
          && !documentXml.includes('引用资料')
          && !documentXml.includes(template.disclaimer),
        '正文以机构落款和日期结束；来源保存在任务审计数据',
      )
      assert(
        checks,
        `${type} 保留正文核验状态但不展开来源附录`,
        documentXml.includes('资料记载')
          && documentXml.includes('待核验')
          && !documentXml.includes('示例项目商业计划书（脱敏）')
          && !documentXml.includes('未使用来源（不得进入文尾）'),
        '资料记载 / 待核验 / 无来源附录',
      )
    }
    assert(
      checks,
      `${type} 全篇不重复同一分析段落`,
      (documentXml.match(/基于现有证据形成的分析判断不等同于经审计事实/g) || []).length <= 1,
      '重复分析段落最多出现一次',
    )
    assert(
      checks,
      `${type} 不使用通用元数据封面`,
      !documentXml.includes('文件性质') && !documentXml.includes('生成时间'),
      '遵循对应 docs 模板的正文结构',
    )
    const expectedBodyFont = type === 'compliance_statement'
      ? (process.env.AI_DOCUMENT_SONG_FONT || '宋体')
      : (process.env.AI_DOCUMENT_FANGSONG_FONT || '仿宋')
    const expectedHeadingFont = process.env.AI_DOCUMENT_SANS_FONT || '黑体'
    const expectedCoverFont = process.env.AI_DOCUMENT_SONG_FONT || '宋体'
    const forbiddenSampleTerms = ['佳量', '德塔', 'Epilcure', '曹鹏', template.templateVersion]
    assert(checks, `${type} 不含损坏字符`, !xml.includes('\uFFFD'), '未发现 U+FFFD')
    assert(checks, `${type} 不使用 Arial Unicode MS`, !xml.includes('Arial Unicode MS'), expectedBodyFont)
    assert(
      checks,
      `${type} 使用模板中文字体`,
      (xml.includes(`w:eastAsia="${expectedBodyFont}"`)
        || ((type === 'compliance_statement' || type === 'investment_proposal')
          && xml.includes('w:eastAsia="Songti SC"')))
        && (xml.includes(`w:eastAsia="${expectedHeadingFont}"`)
          || (type === 'compliance_statement' && xml.includes('w:eastAsia="STHeiti"'))
          || (type === 'investment_proposal' && xml.includes('w:eastAsia="Heiti SC"'))),
      `${expectedBodyFont}/${expectedHeadingFont}`,
    )
    assert(checks, `${type} 不泄露示例项目与内部模板编号`, forbiddenSampleTerms.every((term) => !xml.includes(term)), forbiddenSampleTerms.join('、'))
    assert(
      checks,
      `${type} 已应用公司模板可复用部件`,
      result.templateApplied
        && (type === 'investment_proposal'
          ? result.templateCorpus.length === 9
          : result.templateParts.length > 0)
        && Boolean(result.templateSha256),
      `模板部件 ${result.templateParts.join('、') || '按蒸馏令牌生成'}，摘要 ${result.templateSha256.slice(0, 12)}`,
    )
    if (type !== 'compliance_statement') {
      assert(checks, `${type} 包含模板式页眉页码`, Boolean(zip.file('word/header1.xml')) && Boolean(zip.file('word/footer1.xml')), '页眉与页码')
    }
    if (type === 'investment_proposal') {
      assert(checks, 'AI-008 使用模板式投委会称谓', documentXml.includes('各位投资决策委员会成员：'), '提案正式开篇')
      assert(
        checks,
        'AI-008 使用模板中文章节层级',
        ['一、基本情况简介', '（一）公司简介', '六、结论'].every((title) => documentXml.includes(title))
          && !documentXml.includes('1. 一、基本情况简介'),
        '中文一级/二级标题，不添加英文数字前缀',
      )
      assert(
        checks,
        'AI-008 使用 16pt 标题、12pt 正文和固定 24pt 行距',
        documentXml.includes('<w:sz w:val="32"')
          && documentXml.includes('<w:sz w:val="24"')
          && documentXml.includes('w:line="480"')
          && documentXml.includes('w:lineRule="exact"')
          && (
            documentXml.includes(`w:eastAsia="${process.env.AI_DOCUMENT_KAITI_FONT || '楷体'}"`)
            || documentXml.includes('w:eastAsia="Kaiti SC"')
          ),
        '标题 32 半点；正文 24 半点；固定 480 twips；二级标题楷体',
      )
      assert(
        checks,
        'AI-008 不创建独立封面或目录页',
        !documentXml.includes('>目录</w:t>')
          && !/TOC\b/.test(documentXml)
          && !/<w:br\b[^>]*w:type="page"/.test(documentXml),
        '单节自然流排，无封面分页、目录域或手动分页',
      )
      assert(
        checks,
        'AI-008 生成模板式原生表格',
        documentXml.includes('<w:tbl>')
          && documentXml.includes('历史财务摘要')
          && documentXml.includes('w:fill="D9D9D9"'),
        '原生可编辑表格、灰底表头',
      )
      assert(
        checks,
        'AI-008 全部九份模板进入生成元数据',
        result.templateCorpus.length === 9,
        `${result.templateCorpus.length} 份`,
      )
    }

    if (type === 'due_diligence_report') {
      const dueHeaderXml = await zip.file('word/header1.xml')?.async('string') || ''
      const dueSettingsXml = await zip.file('word/settings.xml')?.async('string') || ''
      assert(
        checks,
        'AI-010 使用模板八章与十六个二级模块',
        [
          '1、投资概要',
          '2、公司与团队',
          '3、产品与技术',
          '4、业务与商业化',
          '5、行业与竞争',
          '6、财务与估值',
          '7、投资判断',
          '8、风险与核验',
          ...template.sections,
        ].every((title) => documentXml.includes(title)),
        '目录与正文均采用八章、十六模块层级',
      )
      assert(
        checks,
        'AI-010 正文标题与目录使用相同编号',
        /<w:pStyle w:val="79"\/>[\s\S]*?<w:t[^>]*>1、投资概要<\/w:t>/.test(documentXml)
          && /<w:pStyle w:val="86"\/>[\s\S]*?<w:t[^>]*>2\.1 公司概况<\/w:t>/.test(documentXml)
          && /<w:pStyle w:val="86"\/>[\s\S]*?<w:t[^>]*>2\.4 法律合规与资质<\/w:t>/.test(documentXml)
          && /<w:pStyle w:val="86"\/>[\s\S]*?<w:t[^>]*>8\.2 后续核验事项<\/w:t>/.test(documentXml)
          && /<w:pStyle w:val="79"\/>[\s\S]*?<w:t[^>]*>8、风险与核验<\/w:t>/.test(documentXml),
        '一级标题 1、～8、；二级标题 2.1 等与目录一致',
      )
      const orderedHeadings = [
        '2.3 公司治理与管理团队',
        '2.4 法律合规与资质',
        '3.1 产品与核心技术',
        '4.1 商业模式与经营情况',
        '4.2 客户与商业化进展',
        '5.1 行业概况与市场空间',
        '5.2 产业链与竞争格局',
        '6.1 财务分析',
        '6.2 估值合理性分析',
        '7.1 投资方案',
        '7.2 投资亮点',
        '8.1 风险分析',
        '8.2 后续核验事项',
      ]
      assert(
        checks,
        'AI-010 二级标题按投资经理阅读顺序排列',
        orderedHeadings.every((heading, index) => index === 0
          || documentXml.lastIndexOf(orderedHeadings[index - 1])
            < documentXml.lastIndexOf(heading)),
        orderedHeadings.join(' → '),
      )
      assert(
        checks,
        'AI-010 使用 Word/WPS 可更新目录域',
        /TOC (?=[^<]*\\h)(?=[^<]*\\o &quot;1-2&quot;)(?=[^<]*\\u)/.test(documentXml)
          && documentXml.includes('w:outlineLvl w:val="0"')
          && documentXml.includes('w:outlineLvl w:val="1"')
          && documentXml.includes('w:dirty="true"')
          && dueSettingsXml.includes('<w:updateFields')
          && (documentXml.match(/>1、投资概要<\/w:t>/g) || []).length >= 2
          && (documentXml.match(/>8、风险与核验<\/w:t>/g) || []).length >= 2,
        'TOC 域覆盖一、二级标题，并含首次打开可读的缓存条目；更新后生成页码和点引导符',
      )
      assert(
        checks,
        'AI-010 真实引用主模板样式并保留三分节',
        (documentXml.match(/<w:pStyle w:val="79"\/>/g) || []).length >= 8
          && (documentXml.match(/<w:pStyle w:val="86"\/>/g) || []).length >= 16
          && documentXml.includes('<w:pStyle w:val="91"/>')
          && documentXml.includes('<w:pStyle w:val="101"/>')
          && (documentXml.match(/<w:numId w:val="0"\/>/g) || []).length >= 24
          && (documentXml.match(/<w:sectPr/g) || []).length >= 3,
        '星实一标 79、二标 86、正文 91、来源批注 101；段落级关闭模板中文编号；封面/目录/正文三分节',
      )
      assert(
        checks,
        'AI-010 封面字体字号与主模板一致',
        (documentXml.match(/w:sz w:val="44"/g) || []).length >= 7
          && (documentXml.match(/w:sz w:val="32"/g) || []).length >= 2
          && documentXml.includes(`w:eastAsia="${expectedCoverFont}"`)
          && ['尽', '职', '调', '查', '报', '告'].every((character) =>
            new RegExp(`<w:t[^>]*>${character}</w:t>`).test(documentXml)),
        `公司名及“尽职调查报告”六字纵排为 ${expectedCoverFont} 22 pt；年月和机构为 ${expectedCoverFont} 16 pt`,
      )
      assert(
        checks,
        'AI-010 页眉沿用主模板细线且不写死机构名称',
        dueHeaderXml.includes('<w:pBdr>')
          && dueHeaderXml.includes('<w:bottom')
          && !dueHeaderXml.includes('浙江赛智伯乐'),
        '封面无页眉；目录与正文使用无文字的黑色细线页眉',
      )
      assert(
        checks,
        'AI-010 生成模板式项目概览表',
        documentXml.includes('<w:tbl>')
          && ['公司主体', '所属行业', '项目阶段', '融资安排', '估值口径'].every((term) =>
            documentXml.includes(term)),
        '投资概要中的原生可编辑项目概览表',
      )
      assert(
        checks,
        'AI-010 全部十二份模板进入生成元数据',
        result.templateCorpus.length === 12,
        `${result.templateCorpus.length} 份`,
      )
    }

    if (type === 'compliance_statement') {
      assert(
        checks,
        'AI-007 使用模板四段式层级而非八个同级标题',
        !documentXml.includes('1. 公司情况介绍')
          && !documentXml.includes('2. 公司简介')
          && ['公司情况介绍', '公司简介', '核心团队', '产品及技术', '投资理由', '投资计划', '投资情形分析']
            .every((title) => documentXml.includes(title))
          && documentXml.includes('<w:numId w:val="1"/>')
          && documentXml.includes('<w:numId w:val="2"/>')
          && documentXml.includes('<w:numId w:val="4"/>'),
        '四个一级部分、三个公司子节、独立重启的七项检查编号',
      )
      assert(
        checks,
        'AI-007 页面和字体令牌与模板一致',
        documentXml.includes('<w:pgSz w:w="11906" w:h="16838"')
          && documentXml.includes('<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"')
          && (documentXml.includes('w:eastAsia="黑体"') || documentXml.includes('w:eastAsia="STHeiti"'))
          && (documentXml.includes('w:eastAsia="宋体"') || documentXml.includes('w:eastAsia="Songti SC"'))
          && !zip.file('word/header1.xml')
          && !zip.file('word/footer1.xml'),
        'A4、上下1440/左右1800 DXA、黑体标题、宋体正文、无可见页眉页脚',
      )
      assert(
        checks,
        'AI-007 DOCX 隔离审计元数据且不生成伴生产物',
        !xml.includes(template.disclaimer)
          && !xml.includes('[S1]'),
        '免责声明、来源标记、风险和缺口只保留在审计元数据；只交付 DOCX',
      )
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    outputDir,
    passed: checks.every((check) => check.passed),
    checks,
    artifacts,
    note: '自动验收使用脱敏虚构数据；法务签字及 Microsoft Office/WPS 人工兼容验收仍需业务人员完成。',
  }
  const reportPath = path.join(outputDir, 'acceptance-report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
