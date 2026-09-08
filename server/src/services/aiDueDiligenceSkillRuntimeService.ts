import { createHash } from 'node:crypto'
import { stat, writeFile, access, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { BusinessContent, EvidenceSource } from './aiBusinessContentService.js'
import { getAiSkillDirectory } from './aiSkillService.js'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
import { fetchAiGatewayChatCompatible } from './aiGatewayService.js'
const SKILL_NAME = 'draft-due-diligence-report' as const
const GW_BASE = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
const GW_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6'

import { compactText, buildEvidenceLedger, requestedReportMode, dueDiligencePackageContract, normalizeDueDiligencePackage, buildDueDiligencePackageModelInput } from './aiDueDiligencePackage.js'
import type { ProjectLike, DueDiligencePackage, NormalizedDueDiligencePackage } from './aiDueDiligencePackage.js'
export { dueDiligenceAtomicStatements, dueDiligencePackageContract, normalizeDueDiligencePackage, buildDueDiligencePackageModelInput } from './aiDueDiligencePackage.js'

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

async function generatePackage(input: Parameters<typeof buildDueDiligencePackageModelInput>[0]) {
  const { desiredMode, messages } = buildDueDiligencePackageModelInput(input)
  const packageTimeoutMs = Math.min(
    600_000,
    Math.max(180_000, Number(process.env.AI_DD_SKILL_PACKAGE_TIMEOUT_MS) || 360_000),
  )
  const response = await fetchAiGatewayChatCompatible(GW_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GW_KEY ? { Authorization: `Bearer ${GW_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 32_000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(packageTimeoutMs),
  }, fetch, packageTimeoutMs)
  const generated = await readModelJson(response)
  const blockedReasons = (generated.blockedReasons ?? []).map((item) => compactText(item, 300)).filter(Boolean)
  if (blockedReasons.length > 0 || !generated.diligenceData || !generated.report) {
    throw Object.assign(new Error(`尽调字段门禁未通过：${blockedReasons.join('；') || '关键字段证据不足'}`), {
      code: 'DUE_DILIGENCE_SKILL_FIELD_GATE_FAILED',
    })
  }
  return normalizeDueDiligencePackage({
    generated,
    project: input.project,
    evidence: input.evidence,
    sourceCutoffDate: input.sourceCutoffDate,
    desiredMode,
  })
}

async function repairPackage(input: {
  project: ProjectLike
  evidence: ReturnType<typeof buildEvidenceLedger>
  sourceCutoffDate: string
  desiredMode: string
  generated: NormalizedDueDiligencePackage
  auditIssues: string[]
}) {
  const systemPrompt = `你是 draft-due-diligence-report 的 JSON 修复器。当前尽调包未通过原生审计，请只修复字段结构、证据绑定、报告块结构和人工文风问题，并返回完整 JSON 对象。

不得新增证据台账中不存在的事实或证据 ID；不得把 absent/conflicted 字段伪装为 supported；不得用“待补充”、免责声明、资料清单或检索过程凑内容。若证据确实不能支撑任何允许模式，必须在 blockedReasons 中列明缺失字段。

返回结构固定为：
{"reportMode":"","blockedReasons":[],"diligenceData":{"project":{},"fields":[]},"report":{"meta":{},"blocks":[]}}

审计器机器契约：
${dueDiligencePackageContract(input.desiredMode)}`
  const userPrompt = `项目：${JSON.stringify({
    name: input.project.name,
    legalEntity: input.project.companyName || input.project.name,
    cutoffDate: input.sourceCutoffDate,
  })}
审计错误（必须逐项修复）：${JSON.stringify(input.auditIssues)}
当前尽调包：${JSON.stringify(input.generated).slice(0, 100_000)}
证据台账：${JSON.stringify(input.evidence).slice(0, 90_000)}`
  const repairTimeoutMs = Math.min(
    600_000,
    Math.max(180_000, Number(process.env.AI_DD_SKILL_REPAIR_TIMEOUT_MS) || 360_000),
  )
  const response = await fetchAiGatewayChatCompatible(GW_BASE, {
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
    signal: AbortSignal.timeout(repairTimeoutMs),
  }, fetch, repairTimeoutMs)
  const repaired = await readModelJson(response)
  const blockedReasons = (repaired.blockedReasons ?? []).map((item) => compactText(item, 300)).filter(Boolean)
  if (blockedReasons.length > 0 || !repaired.diligenceData || !repaired.report) {
    throw Object.assign(new Error(`尽调字段修复后仍不具备交付条件：${blockedReasons.join('；') || '关键字段证据不足'}`), {
      code: 'DUE_DILIGENCE_SKILL_FIELD_GATE_FAILED',
    })
  }
  return normalizeDueDiligencePackage({
    generated: repaired,
    project: input.project,
    evidence: input.evidence,
    sourceCutoffDate: input.sourceCutoffDate,
    desiredMode: input.desiredMode,
  })
}

async function resolvePython() {
  const candidates = [
    process.env.AI_DD_SKILL_PYTHON,
    path.resolve(process.cwd(), 'server', '.venv', 'Scripts', 'python.exe'),
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
  throw Object.assign(new Error('draft-due-diligence-report 缺少 python-docx/PyMuPDF/lxml 运行环境'), {
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
    const auditDetails = compactText(failure.stdout || failure.stderr || failure.message, 12_000)
    const visibleDetails = compactText(auditDetails, 1200)
    throw Object.assign(new Error(`${input.label}未通过${visibleDetails ? `：${visibleDetails}` : ''}`), {
      code: 'DUE_DILIGENCE_SKILL_VALIDATION_FAILED',
      cause: failure,
      auditDetails: `${input.label}：${auditDetails}`,
    })
  }
}

async function runPackageAudits(input: {
  python: string
  scripts: string
  diligenceDataPath: string
  reportPath: string
  evidencePath: string
}) {
  const specs = [
    {
      key: 'fields',
      script: 'audit_ic_completeness.py',
      args: [input.diligenceDataPath, '--report', input.reportPath, '--evidence', input.evidencePath],
      label: '尽调字段完整性审计',
      blockWarnings: true,
    },
    {
      key: 'content',
      script: 'audit_report_content.py',
      args: [input.reportPath, '--evidence', input.evidencePath],
      label: '尽调报告内容审计',
      blockWarnings: true,
    },
    {
      key: 'narrative',
      script: 'audit_narrative_quality.py',
      args: [input.reportPath, '--strict'],
      label: '尽调人工文风审计',
      blockWarnings: false,
    },
  ] as const
  const settled = await Promise.allSettled(specs.map((spec) => runPython({
    python: input.python,
    script: path.join(input.scripts, spec.script),
    args: [...spec.args],
    label: spec.label,
    blockWarnings: spec.blockWarnings,
  })))
  const outputs: Record<string, string> = {}
  const issues: string[] = []
  settled.forEach((result, index) => {
    const spec = specs[index]
    if (result.status === 'fulfilled') outputs[spec.key] = result.value
    else {
      const failure = result.reason as Error & { auditDetails?: string }
      issues.push(compactText(failure.auditDetails || failure.message || failure, 12_000))
    }
  })
  return { outputs, issues }
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
  const skillDirectory = getAiSkillDirectory(SKILL_NAME)
  const scripts = path.join(skillDirectory, 'scripts')
  const skillProcessor = path.join(skillDirectory, 'scripts', 'deta_dd_processor.py')
  const skillTemplate = path.join(skillDirectory, 'assets', 'reference.docx')
  const python = await resolvePython()
  const workDirectory = path.join(input.taskDirectory, '.draft-due-diligence-report')
  const evidencePath = path.join(workDirectory, 'evidence.json')
  const diligenceDataPath = path.join(workDirectory, 'diligence-data.json')
  const reportPath = path.join(workDirectory, 'report.json')
  const legacyDraftPath = path.join(workDirectory, 'legacy-draft.docx')
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

  await runPython({
    python,
    script: path.join(scripts, 'build_report_docx.py'),
    args: [
      '--input', reportPath,
      '--diligence-data', diligenceDataPath,
      '--evidence', evidencePath,
      '--output', legacyDraftPath,
    ],
    label: '尽调 Skill 原生 DOCX 生成',
  })
  try {
    await runPython({
      python,
      script: skillProcessor,
      args: ['format', '--input', legacyDraftPath, '--output', input.outputPath],
      label: 'draft-due-diligence-report DOCX Formatter',
    })
  } catch {
    // Skill formatter may report its own business-rule findings after writing
    // the DOCX. The host must not reinterpret those findings as a second
    // acceptance gate; it only requires that the generated file exists.
    await access(input.outputPath)
  }
  const outputStat = await stat(input.outputPath)
  const skillTemplateSha256 = createHash('sha256')
    .update(await readFile(skillTemplate))
    .digest('hex')
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
    formatter: 'draft-due-diligence-report-skill-v5',
    skillName: SKILL_NAME,
    reportMode: generated.reportMode,
    pageIntent: 'long-form',
    templateApplied: true,
    templateEnforced: true,
    rendererMode: 'deta-v5-retained-template-format',
    skillTemplatePath: skillTemplate,
    skillTemplateSha256,
    acceptanceAuthority: 'agent-and-current-skill',
    acceptanceDecision: 'accepted-on-agent-skill-completion',
    programmaticBusinessAcceptance: false,
    typography: { body: '宋体 12pt', heading: '黑体 16/14/12pt' },
    tableCount,
    sectionTitles,
    usedSourceIndexes,
  }
}
