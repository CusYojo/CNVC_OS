import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
import type { BusinessContent, EvidenceSource } from './aiBusinessContentService.js'
import { getAiSkillDirectory } from './aiSkillService.js'
import { complianceRenderContractError } from './complianceRenderContract.js'
import type { finalizeComplianceReadiness } from './complianceReadinessContract.js'
import { bindComplianceTeamIdentity } from './complianceTeamIdentity.js'

const COMMAND_TIMEOUT_MS = 240_000

async function commandWorks(command: string) {
  try {
    await execFileAsync(command, ['-c', 'import docx, lxml'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

export async function resolveDocumentSkillPython() {
  const candidates = [
    process.env.AI_DOCUMENT_SKILL_PYTHON,
    // Backward-compatible environment alias; runtime execution is Skill-owned.
    process.env.AI_DOCUMENT_PLUGIN_PYTHON,
    process.env.AI_QA_SKILL_PYTHON,
    path.resolve(process.cwd(), 'server', '.venv', 'Scripts', 'python.exe'),
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python'),
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python3'),
    'python3',
  ].filter((value): value is string => Boolean(value))
  for (const candidate of [...new Set(candidates)]) {
    if (await commandWorks(candidate)) return candidate
  }
  throw new Error('文档 Skill 缺少 python-docx/lxml 运行环境')
}

function parseJsonOutput(stdout: string) {
  const lines = stdout.trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Keep looking for the last JSON line emitted by the Skill processor.
    }
  }
  throw new Error('文档 Skill 未返回合法 JSON 结果')
}

export async function runDocumentSkillProcessor(input: {
  python: string
  args: string[]
  label: string
  timeout?: number
  env?: NodeJS.ProcessEnv
}) {
  try {
    const result = await execFileAsync(input.python, input.args, {
      timeout: input.timeout ?? COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ...input.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    })
    return parseJsonOutput(result.stdout)
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const details = [failure.stderr, failure.stdout, failure.message]
      .filter(Boolean)
      .join('\n')
      .trim()
    throw Object.assign(new Error(`${input.label}失败${details ? `：${details.slice(-6000)}` : ''}`), {
      code: 'DOCUMENT_SKILL_RENDER_FAILED',
    })
  }
}

export async function renderInvestmentProposalWithSkill(input: {
  outputPath: string
  payload: Record<string, unknown>
}) {
  const skillDirectory = getAiSkillDirectory('draft-investment-proposal')
  const processor = path.join(skillDirectory, 'scripts', 'proposal_processor.py')
  const template = path.join(skillDirectory, 'assets', 'primary-layout-authority.docx')
  const workDirectory = path.join(path.dirname(input.outputPath), '.draft-investment-proposal-render')
  const payloadPath = path.join(workDirectory, 'proposal.json')
  const manifestPath = path.join(workDirectory, 'render-manifest.json')
  const bridge = path.resolve(process.cwd(), 'server', 'scripts', 'skill_document_bridge.py')
  await mkdir(workDirectory, { recursive: true })
  await writeFile(payloadPath, JSON.stringify(input.payload, null, 2), 'utf8')
  const python = await resolveDocumentSkillPython()
  const manifest = await runDocumentSkillProcessor({
    python,
    args: [
      bridge,
      'proposal',
      '--processor', processor,
      '--payload', payloadPath,
      '--template', template,
      '--output', input.outputPath,
      '--manifest', manifestPath,
    ],
    label: 'draft-investment-proposal Skill 模板渲染',
  })
  await assertFile(input.outputPath)
  const output = await readFile(input.outputPath)
  return {
    bytes: output.length,
    pageIntent: 'brief',
    templateApplied: true,
    templateEnforced: manifest.template_enforced === true,
    rendererMode: manifest.renderer_mode,
    formatter: 'draft-investment-proposal-skill-native-v2',
    skillTemplatePath: template,
    skillTemplateSha256: manifest.template_sha256,
    documentSha256: manifest.docx_sha256,
    skillManifestPath: manifestPath,
    skillManifest: manifest,
    typography: { body: '宋体 10.5pt', heading: '黑体 14/12pt' },
  }
}

function sourceIds(indexes: number[], sources: EvidenceSource[]) {
  return [...new Set(indexes.filter(index => Number.isInteger(index) && index >= 0 && Boolean(sources[index])).map((index) => {
    const source = sources[index]
    return source?.sourceId || `source-${index + 1}`
  }))]
}

function cleanVisibleText(value: string) {
  return value
    .replace(/统一社会信用代码\s*[：:]?\s*[0-9A-Z]{18}/gi, '')
    .replace(/\b[0-9A-Z]{18}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function visibleFindings(section: BusinessContent['sections'][number] | undefined) {
  return (section?.findings ?? [])
    .map((finding) => ({ ...finding, text: cleanVisibleText(finding.text) }))
    .filter(finding => Boolean(finding.text))
}

function evidenceBinding(finding: BusinessContent['sections'][number]['findings'][number] | undefined, sources: EvidenceSource[]) {
  const indexes = finding?.sourceIndexes ?? []
  const valid = indexes.length > 0 && indexes.every(index => Number.isInteger(index) && index >= 0 && Boolean(sources[index]))
  return {
    source_ids: sourceIds(indexes, sources),
    status: finding?.status === '资料记载' && valid ? 'verified' : 'pending',
  }
}

function sectionMatch(content: BusinessContent, pattern: RegExp) {
  return content.sections.find((section) => pattern.test(section.title))
}

function sectionExact(content: BusinessContent, title: string) {
  return content.sections.find((section) => section.title === title)
}

function cleanComplianceCompanyIntro(value: string) {
  return cleanVisibleText(value)
    .replace(/(?:注册资本|认缴资本|实缴资本|实收资本|已实缴)\s*[：:]?\s*[^，,。；;]{0,40}[，,。；;]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanComplianceReason(value: string) {
  // Formatting must not remove qualifications or replace reviewed business facts.
  const cleaned = cleanVisibleText(value)
    .replace(
      '收费方式、收入构成和订单转化情况尚待确认，暂不能判断公司的持续经营和扩张能力',
      '收费与订单转化尚待确认，暂不能判断持续经营和扩张能力',
    )
    .replace(/[，,；;：:]\s*$/, '')
    .trim()
  return cleaned && !/[。！？]$/.test(cleaned) ? `${cleaned}。` : cleaned
}

function cleanComplianceConclusion(value: string) {
  const cleaned = cleanVisibleText(value)
    .replace(/[。！？]+(?=\S)/g, '；')
    .replace(/[。！？]+$/g, '')
    .trim()
  return `${cleaned || '本项目应在完成必要尽调核验、内部审批及正式交易文件签署后，方可形成最终合规结论'}。`
}

function numberedBlocks(
  sources: EvidenceSource[],
  findings: BusinessContent['sections'][number]['findings'],
) {
  return findings.map((finding, index) => {
    return {
      type: 'numbered',
      label: String(index + 1),
      text: finding.text,
      ...evidenceBinding(finding, sources),
    }
  })
}

export function buildComplianceSkillContent(input: {
  deliveryReadiness?: ReturnType<typeof finalizeComplianceReadiness>
  projectName: string
  targetCompanyLegalName?: string | null
  content: BusinessContent
  sources: EvidenceSource[]
  company: string
  generatedAt: Date
}) {
  const authorizedLimited = input.deliveryReadiness?.status === 'proceed_with_available_materials'
  const companyIntro = sectionExact(input.content, '公司简介')
    ?? sectionMatch(input.content, /公司简介|基本情况/)
  const team = sectionMatch(input.content, /核心团队|团队/)
  const product = sectionMatch(input.content, /产品|技术/)
  const reasons = sectionMatch(input.content, /投资理由/)
  const plan = sectionMatch(input.content, /投资计划|交易方案|投资方案/)
  const analysis = sectionMatch(input.content, /投资情形分析|合规分析/)
  const conclusion = sectionMatch(input.content, /结论/)
  const reasonFindings = visibleFindings(reasons).map(finding => ({ ...finding, text: cleanComplianceReason(finding.text) }))
  const analysisRoleLabels = ['投资限制事项', '返投义务影响', '关联交易', '投资方向', '投资配置', '投资集中度', '其他法律监管事项']
  const analysisFindings = visibleFindings(analysis).slice(0, 7).map((finding, index) => authorizedLimited
    ? {
        ...finding,
        status: '资料缺口' as const,
        text: index === 6
          ? '其他法律监管事项尚待确认：当前已授权资料不足以完成其他法律监管事项的全面核验，具体缺口以待补事项为准；本项仅作限制性披露，不视为已经核验通过。'
          : `${analysisRoleLabels[index]}尚待确认：${finding.text}本项仅按当前已授权资料作限制性披露，不视为已经核验通过。`,
      }
    : finding)
  const paragraphBlocks = (section: BusinessContent['sections'][number] | undefined) =>
    visibleFindings(section).map((finding) => {
      const identity = section === team && finding.teamIdentity ? bindComplianceTeamIdentity({
        person_name: finding.teamIdentity.personName, role_title: finding.teamIdentity.roleTitle,
        identity_quote: finding.teamIdentity.evidenceQuote,
      }, finding.sourceIndexes.flatMap(index => input.sources[index] ? [input.sources[index].content] : [])) : undefined
      return {
      type: 'paragraph',
      text: finding.text,
      ...evidenceBinding(finding, input.sources),
      ...(identity ? { person_name: identity.personName, role_title: identity.roleTitle } : {}),
    } })
  const companyIntroBlocks = paragraphBlocks(companyIntro)
    .map((block) => ({ ...block, text: cleanComplianceCompanyIntro(block.text) }))
    .filter((block) => !authorizedLimited || !/(实际控制人|股权架构|持股比例|创始股东)/.test(block.text))
    .filter((block) => block.text)
  const teamBlocks = paragraphBlocks(team)
    .filter((block) => !authorizedLimited || Boolean(block.person_name && block.role_title))
  const date = input.generatedAt
  const legalName = input.targetCompanyLegalName?.trim()
  const identitySources = legalName ? input.sources.flatMap((source, index) =>
    source.content.includes(legalName) ? [index] : []) : []
  if (authorizedLimited && legalName && !companyIntroBlocks.length) {
    companyIntroBlocks.push({
      type: 'paragraph',
      text: `${legalName}，本说明根据当前已授权项目资料对其主体情况、业务与技术情况及拟议投资事项进行有限范围分析；未完成核验的事项已在投资情形分析及待补事项中列明。`,
      source_ids: sourceIds(identitySources, input.sources),
      status: identitySources.length ? 'verified' : 'pending',
    })
  }
  if (legalName && companyIntroBlocks[0] && !companyIntroBlocks[0].text.startsWith(legalName)) {
    companyIntroBlocks[0].text = `${legalName}，${companyIntroBlocks[0].text}`
  }
  const publicVerification = input.deliveryReadiness ? {
    mode: 'not_performed',
    as_of_date: input.deliveryReadiness.as_of_date,
    validation_status: 'not_performed',
    coverage_status: 'not_verified',
    decision_impact: 'not_verified',
    source_ids: [],
    notes: '公开信息核验尚未形成有效记录；本文件仅按项目资料及明确列示的待核验事项生成。',
  } : undefined
  return {
    title: `关于${input.projectName.replace(/项目$/, '')}项目投资合规性的说明`,
    ...(input.deliveryReadiness ? { delivery_readiness: input.deliveryReadiness } : {}),
    ...(publicVerification ? { public_verification: publicVerification } : {}),
    ...(legalName && identitySources.length ? {
      target_company: { legal_name: legalName, source_ids: sourceIds(identitySources, input.sources) },
    } : {}),
    sections: [
      {
        heading: '公司情况介绍',
        blocks: [
          { type: 'subheading', text: '公司简介' },
          ...companyIntroBlocks,
          { type: 'subheading', text: '核心团队' },
          ...teamBlocks,
          { type: 'subheading', text: '产品及技术' },
          ...paragraphBlocks(product),
        ],
      },
      {
        heading: '投资理由',
        blocks: numberedBlocks(input.sources, reasonFindings),
      },
      {
        heading: '投资计划',
        blocks: paragraphBlocks(plan).length
          ? paragraphBlocks(plan).map(block => authorizedLimited
              ? { ...block, text: block.text.replace(/[《》]/g, '') }
              : block)
          : [{ type: 'paragraph', text: input.content.executiveSummary, source_ids: [], status: 'pending' }],
      },
      {
        heading: '投资情形分析',
        blocks: [
          ...numberedBlocks(input.sources, analysisFindings),
          {
            type: 'conclusion',
            text: authorizedLimited
              ? '在当前已授权资料所列事实成立、基金协议及最终交易条件完成核验、返投与集中度测算满足要求、关联关系和其他法律监管事项不存在实质障碍的条件下，本项目原则上符合投资合规要求；上述事项仍需核验，本说明不构成无条件合规确认。'
              : cleanComplianceConclusion(conclusion?.findings[0]?.text || input.content.executiveSummary),
            ...evidenceBinding(conclusion?.findings[0], input.sources),
          },
        ],
      },
    ],
    closing: {
      company: input.company,
      date: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    },
    open_issues: input.content.missing,
  }
}

export async function renderComplianceStatementWithSkill(input: {
  deliveryReadiness?: ReturnType<typeof finalizeComplianceReadiness>
  outputPath: string
  taskProjectName: string
  targetCompanyLegalName?: string | null
  content: BusinessContent
  sources: EvidenceSource[]
  company: string
  generatedAt: Date
}) {
  const skillDirectory = getAiSkillDirectory('generate-investment-compliance-note')
  const processor = path.join(skillDirectory, 'scripts', 'compliance_processor.py')
  const template = path.join(skillDirectory, 'assets', 'compliance-layout-authority.docx')
  const workDirectory = path.join(path.dirname(input.outputPath), '.generate-investment-compliance-note-render')
  const contentPath = path.join(workDirectory, 'content.json')
  await mkdir(workDirectory, { recursive: true })
  const payload = buildComplianceSkillContent({
    projectName: input.taskProjectName,
    deliveryReadiness: input.deliveryReadiness,
    targetCompanyLegalName: input.targetCompanyLegalName,
    content: input.content,
    sources: input.sources,
    company: input.company,
    generatedAt: input.generatedAt,
  })
  await writeFile(contentPath, JSON.stringify(payload, null, 2), 'utf8')
  const contractError = complianceRenderContractError(payload)
  if (contractError) {
    const diagnostic = {
      level: 'error', event: 'compliance.render.contract_rejected',
      time: new Date().toISOString(), code: contractError.code,
      missingFields: contractError.missingFields,
    }
    console.error(JSON.stringify(diagnostic))
    // No project names, document text, credentials or claimed validation status.
    await writeFile(path.join(workDirectory, 'contract-error.json'), JSON.stringify(diagnostic, null, 2), { encoding: 'utf8', mode: 0o600 })
    throw contractError
  }
  const python = await resolveDocumentSkillPython()
  const build = await runDocumentSkillProcessor({
    python,
    args: [processor, 'build', '--content', contentPath, '--output', input.outputPath, '--template', template],
    label: 'generate-investment-compliance-note 模板渲染',
  })
  await assertFile(input.outputPath)
  const output = await readFile(input.outputPath)
  const templateBuffer = await readFile(template)
  return {
    bytes: output.length,
    pageIntent: 'brief',
    templateApplied: true,
    templateEnforced: true,
    rendererMode: 'skill-native-docx',
    formatter: 'generate-investment-compliance-note-skill-native-v2',
    skillTemplatePath: template,
    skillTemplateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    templateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    templateCorpus: [{
      fileName: path.basename(template),
      sha256: createHash('sha256').update(templateBuffer).digest('hex'),
    }],
    templateParts: ['word/document.xml', 'word/styles.xml', 'word/numbering.xml'],
    documentSha256: createHash('sha256').update(output).digest('hex'),
    acceptanceAuthority: 'agent-and-current-skill',
    programmaticBusinessAcceptance: false,
    skillBuild: build,
    typography: { body: '宋体', heading: '宋体/黑体' },
  }
}

export async function assertFile(pathname: string) {
  await access(pathname)
  const result = await stat(pathname)
  if (!result.isFile() || result.size < 1000) throw new Error(`Skill 未生成有效文件：${pathname}`)
  return result
}
