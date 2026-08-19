import { createHash } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
import type { BusinessContent, EvidenceSource } from './aiBusinessContentService.js'
import { getAiSkillDirectory } from './aiSkillService.js'

const COMMAND_TIMEOUT_MS = 240_000

async function commandWorks(command: string) {
  try {
    await execFileAsync(command, ['-c', 'import docx, lxml'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

export async function resolveDocumentPluginPython() {
  const candidates = [
    process.env.AI_DOCUMENT_PLUGIN_PYTHON,
    process.env.AI_QA_SKILL_PYTHON,
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python'),
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python3'),
    'python3',
  ].filter((value): value is string => Boolean(value))
  for (const candidate of [...new Set(candidates)]) {
    if (await commandWorks(candidate)) return candidate
  }
  throw new Error('文档插件缺少 python-docx/lxml 运行环境')
}

function parseJsonOutput(stdout: string) {
  const lines = stdout.trim().split(/\r?\n/).reverse()
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Keep looking for the last JSON line emitted by the plugin.
    }
  }
  throw new Error('文档插件未返回合法 JSON 结果')
}

export async function runDocumentPlugin(input: {
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
      env: input.env,
    })
    return parseJsonOutput(result.stdout)
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const details = [failure.stderr, failure.stdout, failure.message]
      .filter(Boolean)
      .join('\n')
      .trim()
    throw Object.assign(new Error(`${input.label}失败${details ? `：${details.slice(-6000)}` : ''}`), {
      code: 'DOCUMENT_PLUGIN_RENDER_FAILED',
    })
  }
}

export async function renderInvestmentProposalWithPlugin(input: {
  outputPath: string
  payload: Record<string, unknown>
}) {
  const skillDirectory = getAiSkillDirectory('draft-investment-proposal')
  const pluginDirectory = path.resolve(skillDirectory, '..', '..')
  const processor = path.join(pluginDirectory, 'scripts', 'deta_ic_processor.py')
  const template = path.join(pluginDirectory, 'assets', '德塔式精简工商字段投资提案_固定模板V7.docx')
  const workDirectory = path.join(path.dirname(input.outputPath), '.investment-proposal-plugin-render')
  const payloadPath = path.join(workDirectory, 'proposal.json')
  const manifestPath = path.join(workDirectory, 'render-manifest.json')
  const bridge = path.resolve(process.cwd(), 'server', 'scripts', 'plugin_document_bridge.py')
  await mkdir(workDirectory, { recursive: true })
  await writeFile(payloadPath, JSON.stringify(input.payload, null, 2), 'utf8')
  const python = await resolveDocumentPluginPython()
  const manifest = await runDocumentPlugin({
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
    label: '投资提案插件 V7 模板渲染',
  })
  await assertFile(input.outputPath)
  const output = await readFile(input.outputPath)
  return {
    bytes: output.length,
    pageIntent: 'brief',
    templateApplied: true,
    templateEnforced: manifest.template_enforced === true,
    rendererMode: manifest.renderer_mode,
    formatter: 'sbl-investment-proposal-plugin-v7',
    pluginTemplatePath: template,
    pluginTemplateSha256: manifest.template_sha256,
    documentSha256: manifest.docx_sha256,
    pluginManifestPath: manifestPath,
    pluginManifest: manifest,
    typography: { body: '宋体 10.5pt', heading: '黑体 14/12pt' },
  }
}

function sourceIds(indexes: number[], sources: EvidenceSource[]) {
  return [...new Set(indexes.map((index) => {
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

function findingText(section: BusinessContent['sections'][number] | undefined) {
  return (section?.findings ?? [])
    .map((finding) => cleanVisibleText(finding.text))
    .filter(Boolean)
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
  const cleaned = cleanVisibleText(value)
    .split(/(?:但|仍需|取决于|适宜设置为|交割前应|需进一步)/, 1)[0]
    .replace(/[，,；;：:]\s*$/, '')
    .trim()
  return cleaned.length >= 12
    ? (/[。！？]$/.test(cleaned) ? cleaned : `${cleaned}。`)
    : '该项理由尚无足够的已确认事实支持，本次不作正向扩展。'
}

function numberedBlocks(
  texts: string[],
  sources: EvidenceSource[],
  findings: BusinessContent['sections'][number]['findings'],
  minimum: number,
) {
  return texts.slice(0, Math.max(minimum, texts.length)).map((text, index) => {
    const finding = findings[index]
    return {
      type: 'numbered',
      label: String(index + 1),
      text,
      source_ids: sourceIds(finding?.sourceIndexes ?? [], sources),
      status: finding?.status === '资料记载' ? 'verified' : 'pending',
    }
  })
}

export function buildCompliancePluginContent(input: {
  projectName: string
  content: BusinessContent
  sources: EvidenceSource[]
  company: string
  generatedAt: Date
}) {
  const companyIntro = sectionExact(input.content, '公司简介')
    ?? sectionMatch(input.content, /公司简介|基本情况/)
  const team = sectionMatch(input.content, /核心团队|团队/)
  const product = sectionMatch(input.content, /产品|技术/)
  const reasons = sectionMatch(input.content, /投资理由/)
  const plan = sectionMatch(input.content, /投资计划|交易方案|投资方案/)
  const analysis = sectionMatch(input.content, /投资情形分析|合规分析/)
  const conclusion = sectionMatch(input.content, /结论/)
  const reasonTexts = findingText(reasons).map(cleanComplianceReason)
  const analysisTexts = findingText(analysis)
  const fallback = '现有资料未形成可直接支持该项判断的完整口径，作为必要尽调核验事项处理。'
  while (reasonTexts.length < 5) reasonTexts.push(fallback)
  while (analysisTexts.length < 7) analysisTexts.push(fallback)
  const paragraphBlocks = (section: BusinessContent['sections'][number] | undefined) =>
    findingText(section).map((text, index) => ({
      type: 'paragraph',
      text,
      source_ids: sourceIds(section?.findings[index]?.sourceIndexes ?? [], input.sources),
      status: section?.findings[index]?.status === '资料记载' ? 'verified' : 'pending',
    }))
  const companyIntroBlocks = paragraphBlocks(companyIntro)
    .map((block) => ({ ...block, text: cleanComplianceCompanyIntro(block.text) }))
    .filter((block) => block.text)
  const date = input.generatedAt
  return {
    title: `关于${input.projectName.replace(/项目$/, '')}项目投资合规性的说明`,
    sections: [
      {
        heading: '公司情况介绍',
        blocks: [
          { type: 'subheading', text: '公司简介' },
          ...companyIntroBlocks,
          { type: 'subheading', text: '核心团队' },
          ...paragraphBlocks(team),
          { type: 'subheading', text: '产品及技术' },
          ...paragraphBlocks(product),
        ],
      },
      {
        heading: '投资理由',
        blocks: numberedBlocks(reasonTexts, input.sources, reasons?.findings ?? [], 5).slice(0, 5),
      },
      {
        heading: '投资计划',
        blocks: paragraphBlocks(plan).length
          ? paragraphBlocks(plan)
          : [{ type: 'paragraph', text: input.content.executiveSummary, source_ids: [], status: 'pending' }],
      },
      {
        heading: '投资情形分析',
        blocks: [
          ...numberedBlocks(analysisTexts, input.sources, analysis?.findings ?? [], 7).slice(0, 7),
          {
            type: 'conclusion',
            text: cleanVisibleText(conclusion?.findings[0]?.text || input.content.executiveSummary),
            source_ids: sourceIds(conclusion?.findings[0]?.sourceIndexes ?? [], input.sources),
            status: conclusion?.findings[0]?.status === '资料记载' ? 'verified' : 'pending',
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

export async function renderComplianceStatementWithPlugin(input: {
  outputPath: string
  taskProjectName: string
  content: BusinessContent
  sources: EvidenceSource[]
  company: string
  generatedAt: Date
}) {
  const skillDirectory = getAiSkillDirectory('generate-compliance-statement')
  const processor = path.join(skillDirectory, 'scripts', 'compliance_processor.py')
  const template = path.resolve(skillDirectory, '..', 'artifact-template-deta-3', 'assets', 'reference.docx')
  const workDirectory = path.join(path.dirname(input.outputPath), '.compliance-plugin-render')
  const contentPath = path.join(workDirectory, 'content.json')
  const verifyPath = path.join(workDirectory, 'qa.json')
  await mkdir(workDirectory, { recursive: true })
  const payload = buildCompliancePluginContent({
    projectName: input.taskProjectName,
    content: input.content,
    sources: input.sources,
    company: input.company,
    generatedAt: input.generatedAt,
  })
  await writeFile(contentPath, JSON.stringify(payload, null, 2), 'utf8')
  const python = await resolveDocumentPluginPython()
  const build = await runDocumentPlugin({
    python,
    args: [processor, 'build', '--content', contentPath, '--output', input.outputPath, '--template', template],
    label: '合规性说明插件模板渲染',
  })
  await runDocumentPlugin({
    python,
    args: [processor, 'verify', '--content', contentPath, '--docx', input.outputPath, '--out', verifyPath, '--template', template],
    label: '合规性说明插件模板校验',
  })
  const verify = JSON.parse(await readFile(verifyPath, 'utf8')) as Record<string, unknown>
  if (verify.status !== 'pass' && verify.pass !== true) {
    throw new Error('合规性说明未通过插件模板校验')
  }
  const output = await readFile(input.outputPath)
  const templateBuffer = await readFile(template)
  return {
    bytes: output.length,
    pageIntent: 'brief',
    templateApplied: true,
    templateEnforced: true,
    rendererMode: 'clone-retained-docx',
    formatter: 'sbl-investment-compliance-plugin-v1',
    pluginTemplatePath: template,
    pluginTemplateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    templateSha256: createHash('sha256').update(templateBuffer).digest('hex'),
    templateCorpus: [{
      fileName: path.basename(template),
      sha256: createHash('sha256').update(templateBuffer).digest('hex'),
    }],
    templateParts: ['word/document.xml', 'word/styles.xml', 'word/numbering.xml'],
    documentSha256: createHash('sha256').update(output).digest('hex'),
    pluginVerifyPassed: true,
    pluginVerify: verify,
    pluginBuild: build,
    typography: { body: '宋体', heading: '宋体/黑体' },
  }
}

export async function assertFile(pathname: string) {
  await access(pathname)
  const result = await stat(pathname)
  if (!result.isFile() || result.size < 1000) throw new Error(`插件未生成有效文件：${pathname}`)
  return result
}
