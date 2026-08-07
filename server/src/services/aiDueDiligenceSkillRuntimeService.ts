import { execFile } from 'node:child_process'
import { stat, writeFile, access, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BusinessContent, EvidenceSource } from './aiBusinessContentService.js'
import { getAiSkillDirectory } from './aiSkillService.js'

const execFileAsync = promisify(execFile)
const SKILL_NAME = 'write-investment-dd-report' as const
const GW_BASE = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
const GW_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6'

type ProjectLike = {
  name: string
  companyName?: string | null
  industry?: string | null
  financing?: string | null
  valuation?: string | null
  summary?: string | null
  businessModel?: string | null
  market?: string | null
  team?: string | null
}

type DueDiligencePackage = {
  reportMode?: string
  blockedReasons?: string[]
  diligenceData?: Record<string, unknown>
  report?: Record<string, unknown>
}

function compactText(value: unknown, maximum = 1800) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function isPublicSource(source: EvidenceSource) {
  return /public|web|official|registry|patent|court|regulator/i.test(source.sourceType)
}

function isPrimaryProjectSource(source: EvidenceSource) {
  return /file|contract|financial|primary_document/i.test(source.sourceType)
}

function atomicStatements(source: EvidenceSource) {
  const rawLines = source.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const pageExcerpt = rawLines
    .filter((line) => /^页面正文摘录[：:]/.test(line))
    .map((line) => line.replace(/^页面正文摘录[：:]\s*/, ''))
  const usableLines = pageExcerpt.length > 0
    ? pageExcerpt
    : rawLines.filter((line) => !/^(?:证据属性|项目匹配|Q&A\s*分类|检索方式|检索问题|页面标题|发布主体|发布日期|访问日期|来源网址|原文链接|内容指纹|项目大模型|联网工作流|来源可靠性)[：:]/i.test(line))
  return usableLines
    .flatMap((line) => line.split(/(?<=[。！？；])\s*/))
    .map((line) => compactText(line, 600))
    .filter((line) => line.length >= 6 && !/(?:^|[：:])\s*(?:待核验|暂无|未知|未提取|未明确披露)[。；]?$/.test(line))
    .slice(0, 4)
}

function sourceStatus(source: EvidenceSource) {
  if (isPublicSource(source)) {
    return 'public_fact'
  }
  if (isPrimaryProjectSource(source)) {
    return 'verified'
  }
  return 'company_claim'
}

function sourceType(source: EvidenceSource) {
  if (isPublicSource(source)) {
    return 'public_authoritative'
  }
  if (isPrimaryProjectSource(source)) {
    return 'primary_document'
  }
  return 'management_record'
}

function buildEvidenceLedger(input: {
  project: ProjectLike
  sources: EvidenceSource[]
  sourceCutoffDate: string
}) {
  const legalEntity = input.project.companyName || input.project.name
  const facts = input.sources
    .flatMap((source, sourceIndex) => atomicStatements(source).map((statement) => ({
      source,
      sourceIndex,
      statement,
    })))
    .slice(0, 320)
    .map(({ source, sourceIndex, statement }, index) => ({
      id: `F${String(index + 1).padStart(3, '0')}`,
      source_index: sourceIndex,
      statement,
      entity: legalEntity,
      period: source.versionOrDate || input.sourceCutoffDate,
      unit: /\d/.test(statement) ? '以原始资料口径为准' : '不适用',
      source: source.locator || `${source.sourceType}://${source.sourceId || source.sourceName}#chunk=${source.chunkIndex ?? 0}`,
      source_type: sourceType(source),
      status: sourceStatus(source),
      materiality: 'low',
      conflicts: [],
      as_of_date: source.versionOrDate || input.sourceCutoffDate,
      intended_use: '尽调字段、正文事实与投资判断',
    }))
  if (facts.length === 0) {
    throw Object.assign(new Error('尽调报告没有可进入证据台账的项目事实'), {
      code: 'DUE_DILIGENCE_EVIDENCE_EMPTY',
    })
  }
  return {
    project: {
      name: input.project.name,
      legal_entity: legalEntity,
      cutoff_date: input.sourceCutoffDate,
      currency: 'CNY',
    },
    facts,
  }
}

const REPORT_OUTLINES: Record<string, string[]> = {
  screening_public: [
    '投资判断', '公司与股权', '核心团队', '产品与技术', '客户与商业化',
    '市场与竞争', '合规与关键风险', '结论及建议',
  ],
  business_dd: [
    '专项结论', '公司与产品', '商业模式', '客户验证与收入质量',
    '市场与竞争', '业务风险与交易处理', '结论及建议',
  ],
  financial_dd: [
    '专项结论', '收入与毛利质量', '历史财务', '营运资金与现金消耗',
    '预测与资金需求', '财务风险与交易处理', '结论及建议',
  ],
  legal_dd: [
    '专项结论', '主体、股权与控制权', '知识产权与数据权属', '重大合同与关联交易',
    '许可、劳动与合规', '法律风险与交易处理', '结论及建议',
  ],
  technical_dd: [
    '专项结论', '团队与研发组织', '产品矩阵', '技术架构与性能',
    '知识产权与关键依赖', '技术风险与交易处理', '结论及建议',
  ],
  pre_ic: [
    '投资概要', '公司概况', '产品与技术', '业务情况', '行业和市场',
    '未来发展规划', '投资方案', '风险提示与对策', '投资结论及建议',
  ],
  comprehensive_ic: [
    '投资概要', '公司概况', '产品与技术', '业务情况', '行业和市场',
    '未来发展规划', '投资方案', '风险提示与对策', '投资结论及建议',
  ],
}

function requestedReportMode(value: unknown) {
  const scope = String(value ?? '')
  if (/财务/.test(scope)) return 'financial_dd'
  if (/法律|法务/.test(scope)) return 'legal_dd'
  if (/技术/.test(scope)) return 'technical_dd'
  if (/商业|业务/.test(scope)) return 'business_dd'
  if (/综合|上会|投委/.test(scope)) return 'pre_ic'
  return 'screening_public'
}

function reportTypeForMode(mode: string) {
  return {
    screening_public: 'screening',
    business_dd: 'business',
    financial_dd: 'financial',
    legal_dd: 'legal',
    technical_dd: 'technical',
    pre_ic: 'pre_ic',
    comprehensive_ic: 'comprehensive',
  }[mode] ?? 'screening'
}

function reportDate(cutoff: string) {
  const match = cutoff.match(/^(\d{4})-(\d{2})/)
  return match ? `${match[1]}年${Number(match[2])}月` : cutoff
}

async function readModelJson(response: Response) {
  if (!response.ok) {
    throw Object.assign(new Error(`尽调字段数据层模型请求失败（HTTP ${response.status}）`), {
      code: 'DUE_DILIGENCE_SKILL_MODEL_HTTP_ERROR',
    })
  }
  const payload = await response.json() as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>
  }
  const choice = payload.choices?.[0]
  if (choice?.finish_reason === 'length') {
    throw Object.assign(new Error('尽调字段数据层模型输出被截断'), {
      code: 'DUE_DILIGENCE_SKILL_MODEL_TRUNCATED',
    })
  }
  const raw = (choice?.message?.content || choice?.message?.reasoning_content || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(raw) as DueDiligencePackage
  } catch {
    throw Object.assign(new Error('尽调字段数据层模型未返回合法 JSON'), {
      code: 'DUE_DILIGENCE_SKILL_MODEL_INVALID_JSON',
    })
  }
}

async function generatePackage(input: {
  project: ProjectLike
  content: BusinessContent
  evidence: ReturnType<typeof buildEvidenceLedger>
  sourceCutoffDate: string
  diligenceScope: unknown
  sectionTitles: string[]
}) {
  const desiredMode = requestedReportMode(input.diligenceScope)
  const systemPrompt = `你是 write-investment-dd-report 的字段数据层编辑器。只依据给定证据台账和已生成章节内容，生成可被该 Skill 原生审计器直接验证的 JSON。

必须返回单个 JSON 对象：
{"reportMode":"","blockedReasons":[],"diligenceData":{},"report":{}}

规则：
1. 不得编造工商、股权、客户、合同、财务、知识产权、估值或交易数字。
2. 目标报告模式为 ${desiredMode}。只有对应 P0 字段均获得足够证据支持时才能使用；否则降级到证据能够完整支持的专项模式或 screening_public。若连 screening_public 的八项最低字段也不能完整支持，blockedReasons 必须列出缺失字段，diligenceData 和 report 可为空对象。
3. diligenceData 严格遵守 diligence-data-schema：project.report_mode 与 reportMode 一致；每个 supported 字段必须有足够来源等级、非空 data 和真实 evidence_ids；不得用 absent 字段冒充 supported。
4. report.meta.report_title 固定为“尽职调查报告”；report_type 与 reportMode 映射一致；只有 pre_ic/comprehensive_ic 可设置 template_profile=deta_v5_up_to_ic。
5. report.blocks 使用 heading/paragraph/table/key_value_table/callout；事实和重大判断必须引用 evidence_ids。专项、pre_ic、comprehensive 报告的表格必须包含 semantic_role 和 data_field_ids，并覆盖该模式全部必需角色。
6. 根据最终 reportMode 严格采用对应一级标题，不得把公开初筛或专项报告包装成完整上会稿：${JSON.stringify(REPORT_OUTLINES)}。
7. 正文只写公司事实、商业机制、投资影响和交易处理，不出现资料清单、检索过程、证据编号、工作底稿、免责声明或“引用资料”。
8. 不得输出 Markdown。`
  const userPrompt = `项目：${JSON.stringify({
    name: input.project.name,
    legalEntity: input.project.companyName || input.project.name,
    industry: input.project.industry,
    financing: input.project.financing,
    valuation: input.project.valuation,
    summary: input.project.summary,
    businessModel: input.project.businessModel,
    market: input.project.market,
    team: input.project.team,
  })}
资料截止日：${input.sourceCutoffDate}
已生成章节内容：${JSON.stringify(input.content).slice(0, 90_000)}
证据台账：${JSON.stringify(input.evidence).slice(0, 90_000)}`
  const response = await fetch(`${GW_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GW_KEY ? { Authorization: `Bearer ${GW_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 32_000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(
      Math.min(600_000, Math.max(180_000, Number(process.env.AI_DD_SKILL_PACKAGE_TIMEOUT_MS) || 360_000)),
    ),
  })
  const generated = await readModelJson(response)
  const blockedReasons = (generated.blockedReasons ?? []).map((item) => compactText(item, 300)).filter(Boolean)
  if (blockedReasons.length > 0 || !generated.diligenceData || !generated.report) {
    throw Object.assign(new Error(`尽调字段门禁未通过：${blockedReasons.join('；') || '关键字段证据不足'}`), {
      code: 'DUE_DILIGENCE_SKILL_FIELD_GATE_FAILED',
    })
  }
  const reportMode = String(generated.reportMode || desiredMode)
  const legalEntity = input.project.companyName || input.project.name
  generated.diligenceData.project = {
    ...((generated.diligenceData.project as Record<string, unknown> | undefined) ?? {}),
    name: input.project.name,
    legal_entity: legalEntity,
    cutoff_date: input.sourceCutoffDate,
    currency: 'CNY',
    report_mode: reportMode,
  }
  generated.report.meta = {
    ...((generated.report.meta as Record<string, unknown> | undefined) ?? {}),
    project_name: input.project.name,
    legal_entity: legalEntity,
    report_title: '尽职调查报告',
    report_date: reportDate(input.sourceCutoffDate),
    author: '投资团队',
    report_type: reportTypeForMode(reportMode),
    cutoff_date: input.sourceCutoffDate,
    confidentiality: '内部资料，严禁外传',
    ...(reportMode === 'pre_ic' || reportMode === 'comprehensive_ic'
      ? { template_profile: 'deta_v5_up_to_ic' }
      : { template_profile: undefined }),
  }
  return {
    reportMode,
    diligenceData: generated.diligenceData,
    report: generated.report,
  }
}

async function resolvePython() {
  const candidates = [
    process.env.AI_DD_SKILL_PYTHON,
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python3'),
    'python3',
  ].filter((value): value is string => Boolean(value))
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (candidate.includes(path.sep)) await access(candidate)
      await execFileAsync(candidate, ['-c', 'import docx,fitz,lxml'], { timeout: 10_000 })
      return candidate
    } catch {
      // 继续检查下一个解释器。
    }
  }
  throw Object.assign(new Error('write-investment-dd-report 缺少 python-docx/PyMuPDF/lxml 运行环境'), {
    code: 'DUE_DILIGENCE_SKILL_RUNTIME_UNAVAILABLE',
  })
}

async function runPython(input: {
  python: string
  script: string
  args: string[]
  label: string
  timeout?: number
  blockWarnings?: boolean
}) {
  try {
    const result = await execFileAsync(input.python, [input.script, ...input.args], {
      timeout: input.timeout ?? 180_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    if (input.blockWarnings && /(?:^|\n)WARNING:/m.test(output)) {
      throw new Error(output)
    }
    return output
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const details = compactText(failure.stdout || failure.stderr || failure.message, 1200)
    throw Object.assign(new Error(`${input.label}未通过${details ? `：${details}` : ''}`), {
      code: 'DUE_DILIGENCE_SKILL_VALIDATION_FAILED',
      cause: failure,
    })
  }
}

export async function generateDueDiligenceReportWithSkill(input: {
  outputPath: string
  taskDirectory: string
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  diligenceScope: unknown
  sectionTitles: string[]
}) {
  const primaryProjectSourceCount = input.sources.filter(isPrimaryProjectSource).length
  const publicSourceCount = input.sources.filter(isPublicSource).length
  if (primaryProjectSourceCount === 0 && publicSourceCount > 0) {
    throw Object.assign(
      new Error('当前尽调主要依赖公开信息，但尚未形成通过八领域覆盖审计的 public-research.json'),
      { code: 'DUE_DILIGENCE_PUBLIC_RESEARCH_AUDIT_REQUIRED' },
    )
  }
  const skillDirectory = getAiSkillDirectory(SKILL_NAME)
  const scripts = path.join(skillDirectory, 'scripts')
  const python = await resolvePython()
  const workDirectory = path.join(input.taskDirectory, '.write-investment-dd-report')
  const renderDirectory = path.join(workDirectory, 'render')
  const evidencePath = path.join(workDirectory, 'evidence.json')
  const diligenceDataPath = path.join(workDirectory, 'diligence-data.json')
  const reportPath = path.join(workDirectory, 'report.json')
  const qaPdfPath = path.join(workDirectory, 'visual-qa.pdf')
  await mkdir(workDirectory, { recursive: true })

  await runPython({
    python,
    script: path.join(scripts, 'check_runtime.py'),
    args: [],
    label: '尽调 Skill 运行时检查',
  })
  const evidence = buildEvidenceLedger(input)
  const generated = await generatePackage({ ...input, evidence })
  await Promise.all([
    writeFile(evidencePath, JSON.stringify(evidence, null, 2), 'utf8'),
    writeFile(diligenceDataPath, JSON.stringify(generated.diligenceData, null, 2), 'utf8'),
    writeFile(reportPath, JSON.stringify(generated.report, null, 2), 'utf8'),
  ])

  const auditOutputs: Record<string, string> = {}
  auditOutputs.evidence = await runPython({
    python,
    script: path.join(scripts, 'audit_evidence.py'),
    args: [evidencePath],
    label: '尽调证据审计',
    blockWarnings: true,
  })
  auditOutputs.fields = await runPython({
    python,
    script: path.join(scripts, 'audit_ic_completeness.py'),
    args: [diligenceDataPath, '--report', reportPath, '--evidence', evidencePath],
    label: '尽调字段完整性审计',
    blockWarnings: true,
  })
  auditOutputs.content = await runPython({
    python,
    script: path.join(scripts, 'audit_report_content.py'),
    args: [reportPath, '--evidence', evidencePath],
    label: '尽调报告内容审计',
    blockWarnings: true,
  })
  auditOutputs.narrative = await runPython({
    python,
    script: path.join(scripts, 'audit_narrative_quality.py'),
    args: [reportPath, '--strict'],
    label: '尽调人工文风审计',
  })
  await runPython({
    python,
    script: path.join(scripts, 'build_report_docx.py'),
    args: [
      '--input', reportPath,
      '--diligence-data', diligenceDataPath,
      '--evidence', evidencePath,
      '--output', input.outputPath,
    ],
    label: '尽调 Skill 原生 DOCX 生成',
  })
  auditOutputs.docx = await runPython({
    python,
    script: path.join(scripts, 'audit_docx_style.py'),
    args: [input.outputPath],
    label: '尽调 DOCX 样式审计',
    blockWarnings: true,
  })
  auditOutputs.visual = await runPython({
    python,
    script: path.join(scripts, 'render_and_verify.py'),
    args: [input.outputPath, '--output-dir', renderDirectory, '--emit-pdf', qaPdfPath],
    label: '尽调逐页渲染检查',
    timeout: 240_000,
    blockWarnings: true,
  })
  const pages = (await readdir(renderDirectory)).filter((name) => /^page-\d+\.png$/i.test(name))
  if (pages.length === 0) {
    throw Object.assign(new Error('尽调逐页渲染没有生成页面图'), {
      code: 'DUE_DILIGENCE_SKILL_VISUAL_QA_EMPTY',
    })
  }
  const outputStat = await stat(input.outputPath)
  const reportBlocks = Array.isArray(generated.report.blocks) ? generated.report.blocks : []
  const sectionTitles = reportBlocks
    .filter((block) => block && typeof block === 'object'
      && (block as Record<string, unknown>).type === 'heading'
      && Number((block as Record<string, unknown>).level) === 1)
    .map((block) => compactText((block as Record<string, unknown>).title, 80))
    .filter(Boolean)
  const tableCount = reportBlocks.filter((block) =>
    block && typeof block === 'object' && ['table', 'key_value_table'].includes(
      String((block as Record<string, unknown>).type || ''),
    )).length
  const usedEvidenceIds = new Set(reportBlocks.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const ids = (block as Record<string, unknown>).evidence_ids
    return Array.isArray(ids) ? ids.map(String) : []
  }))
  const usedSourceIndexes = [...new Set(evidence.facts
    .filter((fact) => usedEvidenceIds.has(fact.id))
    .map((fact) => fact.source_index))]
    .sort((left, right) => left - right)
  return {
    bytes: outputStat.size,
    formatter: 'write-investment-dd-report-native-v1',
    skillName: SKILL_NAME,
    reportMode: generated.reportMode,
    pageIntent: 'long-form',
    templateApplied: true,
    typography: { body: '仿宋_GB2312', heading: '黑体' },
    tableCount,
    sectionTitles,
    usedSourceIndexes,
    fieldAuditPassed: true,
    contentAuditPassed: true,
    narrativeAuditPassed: true,
    docxAuditPassed: true,
    visualQaPassed: true,
    renderedPageCount: pages.length,
    internalQaPdf: qaPdfPath,
    auditOutputs,
  }
}
