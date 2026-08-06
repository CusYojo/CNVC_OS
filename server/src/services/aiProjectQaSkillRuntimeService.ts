import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  PROJECT_QA_ANSWER_TARGET_MIN_CHARACTERS,
  type ProjectQaDocumentContent,
} from './aiQaPipelineService.js'
import {
  AI_QA_SKILL_NAME,
  getAiSkillDirectory,
  type LoadedAiSkill,
} from './aiSkillService.js'

const execFileAsync = promisify(execFile)
const REQUIRED_SKILL_NAME = 'generate-project-qa-report'
const COMMAND_TIMEOUT_MS = 120_000

type RuntimeValidationFinding = {
  level: 'error' | 'warning'
  code: string
  message: string
}

type RuntimeValidationResult = {
  report: string
  errors: number
  warnings: number
  findings: RuntimeValidationFinding[]
}

function visibleLength(value: string) {
  return value.replace(/\s+/g, '').length
}

function cleanMarkdownText(value: string) {
  return value
    .replace(/\r/g, '')
    .replace(/^(?:答复|回答|结论(?:如下)?)\s*[：:]\s*/gm, '')
    .replace(/\*\*|__|```/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

export function buildProjectQaSkillMarkdown(input: {
  projectName: string
  content: ProjectQaDocumentContent
}) {
  const titleProjectName = input.projectName
    .replace(/\s*Q&A(?:\s*报告)?\s*$/i, '')
    .trim()
  if (!titleProjectName) throw new Error('generate-project-qa-report 缺少项目名称')
  const sections = input.content.questions.map((question, index) => {
    const answer = input.content.answers.find((item) => item.questionId === question.id)
    if (!answer?.answer.trim()) {
      throw new Error(`generate-project-qa-report 第 ${index + 1} 题缺少回答`)
    }
    const visibleQuestion = cleanMarkdownText(question.question)
      .replace(/[？?]+$/, '')
      .trim()
    const visibleAnswer = cleanMarkdownText(answer.answer)
    return `## Q${index + 1}：${visibleQuestion}？\n\n${visibleAnswer}`
  })
  return `# ${titleProjectName}Q&A 报告\n\n${sections.join('\n\n')}`
}

function assertSkillContentReady(content: ProjectQaDocumentContent) {
  if (content.questions.length < 8 || content.questions.length > 12) {
    throw new Error(
      `generate-project-qa-report 标准问答数量必须为 8—12 题，实际 ${content.questions.length} 题`,
    )
  }
  if (!Object.values(content.review.checks).every(Boolean)) {
    throw new Error('generate-project-qa-report Reviewer 未通过事实与引用一致性检查')
  }
  const answers = content.questions.map((question) =>
    content.answers.find((answer) => answer.questionId === question.id))
  if (answers.some((answer) => !answer)) {
    throw new Error('generate-project-qa-report 问题与回答未完整对应')
  }
  const lengths = answers.map((answer) => visibleLength(answer?.answer ?? ''))
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(lengths.length, 1)
  const thinIndex = lengths.findIndex((length) => length < 260)
  if (thinIndex >= 0 || averageLength < PROJECT_QA_ANSWER_TARGET_MIN_CHARACTERS) {
    throw new Error(
      `generate-project-qa-report 回答深度不足：第 ${thinIndex >= 0 ? thinIndex + 1 : 1} 题最短 ${Math.min(...lengths)} 字，平均 ${Math.round(averageLength)} 字`,
    )
  }
  const visibleText = answers.map((answer) => answer?.answer ?? '').join('\n')
  const noise = visibleText.match(
    /(?:展开[。.]?|首页|登录|小程序|公众号|ICP备|公网安备|All Rights Reserved|公司地址[：:]|联系方式[：:]|对于广大.{0,20}(?:而言|来说)|推动整个.{0,20}(?:行业|产业).{0,12}(?:发展|创新)|公开(?:信息|材料|资料|披露|报道|记录|检索|来源)|项目资料|会议纪要|访谈纪要)/i,
  )?.[0]
  if (noise) {
    throw new Error(`generate-project-qa-report 正文含网页或资料加工痕迹：${noise}`)
  }
  if (!/(?:风险|边界|失效|反方|不确定|尚不能|不能确认)/.test(visibleText)) {
    throw new Error('generate-project-qa-report 正文缺少风险、反方观点或证据边界')
  }
  const lastQuestion = content.questions.at(-1)
  if (!lastQuestion || !/(?:风险|失效|里程碑|判断|条件|决策)/.test(lastQuestion.question)) {
    throw new Error('generate-project-qa-report 最后一题未形成风险、里程碑与决策收束')
  }
}

async function commandWorks(command: string, args: string[]) {
  try {
    await execFileAsync(command, args, { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

async function resolvePython() {
  const candidates = [
    process.env.AI_QA_SKILL_PYTHON,
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python'),
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python3'),
    'python3',
    '/Users/lh/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',
  ].filter((value): value is string => Boolean(value))
  for (const candidate of [...new Set(candidates)]) {
    if (await commandWorks(candidate, ['-c', 'import docx'])) return candidate
  }
  throw new Error(
    'generate-project-qa-report 缺少 python-docx 运行环境；请执行 npm run setup:qa-skill-runtime',
  )
}

async function resolveCommand(candidates: Array<string | undefined>, versionArgs: string[]) {
  for (const candidate of [...new Set(candidates.filter((value): value is string => Boolean(value)))]) {
    if (await commandWorks(candidate, versionArgs)) return candidate
  }
  return undefined
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function availableFontDirectories() {
  const configured = (process.env.AI_QA_FONT_DIRS ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  const candidates = [
    ...configured,
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/1821952872c81043711aab6910052b65da8edf2c.asset/AssetData',
    '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/eb257c12d1a51c8c661b89f30eec56cacf9b8987.asset/AssetData',
    '/usr/share/fonts',
    '/usr/local/share/fonts',
  ]
  const available: string[] = []
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate)
      available.push(candidate)
    } catch {
      // 不存在的跨平台字体目录不纳入本次 Fontconfig。
    }
  }
  return available
}

function parseValidation(stdout: string): RuntimeValidationResult {
  try {
    return JSON.parse(stdout) as RuntimeValidationResult
  } catch {
    throw new Error('generate-project-qa-report Markdown 校验器未返回合法 JSON')
  }
}

async function runMarkdownValidation(input: {
  python: string
  validatorPath: string
  markdownPath: string
}) {
  try {
    const result = await execFileAsync(input.python, [
      input.validatorPath,
      input.markdownPath,
      '--json',
    ], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    return parseValidation(result.stdout)
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout
    const parsed = stdout ? parseValidation(stdout) : undefined
    const details = parsed?.findings.map((finding) => finding.message).join('；')
    throw new Error(`generate-project-qa-report Markdown 校验失败${details ? `：${details}` : ''}`)
  }
}

async function renderEveryPage(input: {
  docxPath: string
  visualDirectory: string
  expectedMinimumPages: number
}) {
  const bundledBin = '/Users/lh/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override'
  const soffice = await resolveCommand([
    process.env.AI_QA_SOFFICE_BINARY,
    'soffice',
    path.join(bundledBin, 'soffice'),
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
  ], ['--version'])
  const pdftoppm = await resolveCommand([
    process.env.AI_QA_PDFTOPPM_BINARY,
    'pdftoppm',
    path.join(bundledBin, 'pdftoppm'),
    '/opt/homebrew/bin/pdftoppm',
  ], ['-v'])
  const pdffonts = await resolveCommand([
    process.env.AI_QA_PDFFONTS_BINARY,
    'pdffonts',
    '/Users/lh/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdffonts',
    '/opt/homebrew/bin/pdffonts',
  ], ['-v'])
  if (!soffice || !pdftoppm || !pdffonts) {
    throw new Error('generate-project-qa-report 缺少 DOCX 逐页渲染环境（soffice/pdftoppm/pdffonts）')
  }
  await mkdir(input.visualDirectory, { recursive: true })
  const libreOfficeProfile = path.join(input.visualDirectory, 'libreoffice-profile')
  await mkdir(libreOfficeProfile, { recursive: true })
  const libreOfficeProfileUri = `file://${encodeURI(libreOfficeProfile)}`
  const fontDirectories = await availableFontDirectories()
  const fontConfigPath = path.join(input.visualDirectory, 'fonts.conf')
  const fontCacheDirectory = path.join(input.visualDirectory, 'fontconfig-cache')
  await mkdir(fontCacheDirectory, { recursive: true })
  await writeFile(fontConfigPath, [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
    '<fontconfig>',
    ...fontDirectories.map((directory) => `  <dir>${xmlEscape(directory)}</dir>`),
    `  <cachedir>${xmlEscape(fontCacheDirectory)}</cachedir>`,
    '</fontconfig>',
  ].join('\n'), 'utf8')
  await execFileAsync(soffice, [
    '--headless',
    `-env:UserInstallation=${libreOfficeProfileUri}`,
    '--convert-to',
    'pdf',
    '--outdir',
    input.visualDirectory,
    input.docxPath,
  ], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, FONTCONFIG_FILE: fontConfigPath },
  })
  const pdfPath = path.join(
    input.visualDirectory,
    `${path.basename(input.docxPath, path.extname(input.docxPath))}.pdf`,
  )
  await access(pdfPath)
  const fontAudit = await execFileAsync(pdffonts, [pdfPath], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  })
  const requiredCjkFonts = ['STFangsong', 'STHeiti']
  const missingCjkFonts = requiredCjkFonts.filter((font) => !fontAudit.stdout.includes(font))
  if (missingCjkFonts.length > 0) {
    throw new Error(
      `generate-project-qa-report 渲染缺少中文字体：${missingCjkFonts.join('、')}`,
    )
  }
  const pagePrefix = path.join(input.visualDirectory, 'page')
  await execFileAsync(pdftoppm, [
    '-png',
    '-r',
    '120',
    pdfPath,
    pagePrefix,
  ], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
  const pages = (await readdir(input.visualDirectory))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort()
  if (pages.length < input.expectedMinimumPages) {
    throw new Error(
      `generate-project-qa-report 逐页渲染不完整：${pages.length}/${input.expectedMinimumPages} 页`,
    )
  }
  return {
    renderer: path.basename(soffice),
    rasterizer: path.basename(pdftoppm),
    fontAudit: path.basename(pdffonts),
    embeddedCjkFonts: requiredCjkFonts,
    pageCount: pages.length,
    renderedEveryPage: true,
    pageFiles: pages,
  }
}

export async function generateProjectQaWithSkill(input: {
  outputPath: string
  markdownPath: string
  visualDirectory: string
  projectName: string
  content: ProjectQaDocumentContent
  skill: LoadedAiSkill
}) {
  if (AI_QA_SKILL_NAME !== REQUIRED_SKILL_NAME || input.skill.name !== REQUIRED_SKILL_NAME) {
    throw new Error(
      `快捷任务 Q&A 必须使用 ${REQUIRED_SKILL_NAME}，实际为 ${input.skill.name}`,
    )
  }
  assertSkillContentReady(input.content)
  const skillDirectory = getAiSkillDirectory(REQUIRED_SKILL_NAME)
  const validatorPath = path.join(skillDirectory, 'scripts', 'validate_qa_report.py')
  const rendererPath = path.join(skillDirectory, 'scripts', 'render_qa_docx.py')
  const runtimeCheckPath = path.join(skillDirectory, 'scripts', 'check_runtime.py')
  const python = await resolvePython()
  await execFileAsync(python, [runtimeCheckPath, '--strict'], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  })
  const markdown = buildProjectQaSkillMarkdown({
    projectName: input.projectName,
    content: input.content,
  })
  await mkdir(path.dirname(input.markdownPath), { recursive: true })
  await writeFile(input.markdownPath, markdown, 'utf8')
  const validation = await runMarkdownValidation({
    python,
    validatorPath,
    markdownPath: input.markdownPath,
  })
  const blockingWarnings = validation.findings.filter((finding) =>
    finding.level === 'warning' && finding.code === 'thin_answer')
  if (validation.errors > 0 || blockingWarnings.length > 0) {
    throw new Error(
      `generate-project-qa-report Markdown 未通过交付门禁：${[
        ...validation.findings.filter((finding) => finding.level === 'error'),
        ...blockingWarnings,
      ].map((finding) => finding.message).join('；')}`,
    )
  }
  await execFileAsync(python, [rendererPath, input.markdownPath, input.outputPath], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  })
  const visualQa = await renderEveryPage({
    docxPath: input.outputPath,
    visualDirectory: input.visualDirectory,
    expectedMinimumPages: input.content.questions.length,
  })
  const buffer = await readFile(input.outputPath)
  return {
    bytes: buffer.length,
    questionCount: input.content.questions.length,
    categoryCount: new Set(input.content.questions.map((question) => question.category)).size,
    missingAnswerCount: input.content.review.dataGapCount,
    documentSha256: createHash('sha256').update(buffer).digest('hex'),
    layoutProfile: 'qa_cn_formal_a4',
    frontDirectoryIncluded: false,
    skillExecutionMode: 'native-markdown-validated-docx-rendered',
    markdownValidation: validation,
    visualQa,
  }
}
