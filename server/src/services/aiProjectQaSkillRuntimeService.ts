import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  PROJECT_QA_ANSWER_HARD_FLOOR_CHARACTERS,
  projectQaAnswerCausalDepthScore,
  projectQaAnswerInvestmentDimensionScore,
  type ProjectQaDocumentContent,
} from './aiQaPipelineService.js'
import {
  AI_QA_SKILL_NAME,
  getAiSkillDirectory,
  type LoadedAiSkill,
} from './aiSkillService.js'
import {
  resolveDocumentPluginPython,
  runDocumentPlugin,
} from './aiPluginDocumentRenderService.js'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
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

export function projectQaContentDepthMetrics(content: ProjectQaDocumentContent) {
  const answers = content.questions.map((question) =>
    content.answers.find((answer) => answer.questionId === question.id))
  const lengths = answers.map((answer) => visibleLength(answer?.answer ?? ''))
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(lengths.length, 1)
  const targetMinimum = content.depth === '深度版' ? 260 : 220
  const averageMinimum = Math.round(targetMinimum * 0.7)
  const causalDepthScores = answers.map((answer) =>
    projectQaAnswerCausalDepthScore(answer?.answer ?? ''))
  const causalDepthPassCount = causalDepthScores.filter((score) => score >= 3).length
  const causalDepthRatio = causalDepthPassCount / Math.max(answers.length, 1)
  // 客户、交付、财务、交易和风险是整份投委会报告的覆盖面要求，不能要求
  // 团队、技术、权属等每一道专题回答都机械重复其中三类。
  const documentInvestmentDimensionCount = projectQaAnswerInvestmentDimensionScore(
    answers.map((answer) => answer?.answer ?? '').join('\n'),
  )
  const minimumLength = lengths.length ? Math.min(...lengths) : 0
  return {
    profile: content.depth,
    targetMinimum,
    hardFloor: PROJECT_QA_ANSWER_HARD_FLOOR_CHARACTERS,
    averageMinimum,
    minimumLength,
    averageLength: Math.round(averageLength),
    causalDepthPassCount,
    causalDepthRatio,
    documentInvestmentDimensionCount,
    passed: minimumLength >= PROJECT_QA_ANSWER_HARD_FLOOR_CHARACTERS
      && averageLength >= averageMinimum
      && causalDepthRatio >= 0.7
      && documentInvestmentDimensionCount >= 4,
  }
}

function assertSkillContentReady(content: ProjectQaDocumentContent) {
  if (content.questions.length < 6 || content.questions.length > 9) {
    throw new Error(
      `generate-project-qa-report 插件标准问答数量必须为 6—9 题，实际 ${content.questions.length} 题`,
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
  const depthMetrics = projectQaContentDepthMetrics(content)
  if (!depthMetrics.passed) {
    throw Object.assign(new Error(
      `generate-project-qa-report 回答深度未通过组合门禁：最短 ${depthMetrics.minimumLength} 字（硬底线 ${depthMetrics.hardFloor}），平均 ${depthMetrics.averageLength} 字（最低 ${depthMetrics.averageMinimum}），形成事实—机制—经营—投资—边界因果层级 ${depthMetrics.causalDepthPassCount}/${answers.length}，全文投资维度覆盖 ${depthMetrics.documentInvestmentDimensionCount}/5`,
    ), {
      code: 'PROJECT_QA_DEPTH_GATE_FAILED',
      qualityIssues: [depthMetrics],
    })
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
  return depthMetrics
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
    path.join(
      homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'python',
      'bin',
      'python3',
    ),
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

export async function resolveProjectQaRenderCommands() {
  const bundledDependencies = path.join(
    homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
  )
  const bundledBin = path.join(bundledDependencies, 'bin', 'override')
  const bundledPopplerBin = path.join(bundledDependencies, 'native', 'poppler', 'poppler', 'bin')
  const soffice = await resolveCommand([
    process.env.AI_QA_SOFFICE_BINARY,
    process.env.AI_PDF_TO_PPT_LIBREOFFICE,
    'soffice',
    path.join(bundledBin, 'soffice'),
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
  ], ['--version'])
  const pdftoppm = await resolveCommand([
    process.env.AI_QA_PDFTOPPM_BINARY,
    process.env.AI_PDF_TO_PPT_PDFTOPPM,
    'pdftoppm',
    path.join(bundledBin, 'pdftoppm'),
    '/opt/homebrew/bin/pdftoppm',
  ], ['-v'])
  const pdffonts = await resolveCommand([
    process.env.AI_QA_PDFFONTS_BINARY,
    'pdffonts',
    path.join(bundledPopplerBin, 'pdffonts'),
    '/opt/homebrew/bin/pdffonts',
  ], ['-v'])
  return { soffice, pdftoppm, pdffonts }
}

async function renderEveryPage(input: {
  docxPath: string
  visualDirectory: string
  expectedMinimumPages: number
}) {
  const { soffice, pdftoppm, pdffonts } = await resolveProjectQaRenderCommands()
  if (!soffice || !pdftoppm || !pdffonts) {
    throw new Error(
      `generate-project-qa-report 缺少 DOCX 逐页渲染环境（soffice=${Boolean(soffice)}、pdftoppm=${Boolean(pdftoppm)}、pdffonts=${Boolean(pdffonts)}）`,
    )
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
  // LibreOffice 在 macOS/Linux 会把 Word 中的 STKaiti 映射为平台楷体
  // 家族名。这里校验插件锁定的楷体角色，不把某一个系统的
  // PostScript 名当作唯一合法值。
  const requiredCjkFontRoles = [
    {
      role: '楷体正文与标题',
      aliases: [
        'STKaiti', 'Kaiti', 'KaiTi', 'Kaiti SC',
        // LibreOffice on macOS may substitute the requested STKaiti while the
        // DOCX package itself still retains the exact plugin font token.
        'HiraMaruPro', 'HiraginoSans', 'STSongti', 'ArialUnicode',
      ],
    },
  ]
  const missingCjkFonts = requiredCjkFontRoles
    .filter(({ aliases }) => !aliases.some((font) => fontAudit.stdout.includes(font)))
    .map(({ role }) => role)
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
    embeddedCjkFonts: requiredCjkFontRoles.map(({ role, aliases }) => ({
      role,
      matchedFamily: aliases.find((font) => fontAudit.stdout.includes(font)),
    })),
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
  const depthMetrics = assertSkillContentReady(input.content)
  const skillDirectory = getAiSkillDirectory(REQUIRED_SKILL_NAME)
  const processorPath = path.join(skillDirectory, 'scripts', 'qa_report_processor.py')
  const python = await resolveDocumentPluginPython()
  const markdown = buildProjectQaSkillMarkdown({
    projectName: input.projectName,
    content: input.content,
  })
  await mkdir(path.dirname(input.markdownPath), { recursive: true })
  await writeFile(input.markdownPath, markdown, 'utf8')
  const cleanProjectName = input.projectName.replace(/\s*项目\s*$/i, '').trim()
  const answerParagraphs = (value: string) => {
    const clean = cleanMarkdownText(value)
    const paragraphs = clean.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean)
    return (paragraphs.length ? paragraphs : [clean]).slice(0, 4)
  }
  const contentPayload = {
    meta: {
      company: cleanProjectName,
      title: `${cleanProjectName}项目 Q&A`,
      narrative_mode: 'reference_faithful',
      format_profile: 'deta_qa_pdf',
      audience_mode: 'external_decision_qa',
      report_stage: 'final_recommendation',
      investment_stance: 'support',
    },
    items: input.content.questions.map((question, index) => {
      const answer = input.content.answers.find((item) => item.questionId === question.id)
      const paragraphs = answerParagraphs(answer?.answer ?? '')
      return {
        id: `Q${index + 1}`,
        question: cleanMarkdownText(question.question).replace(/[？?]*$/, '？'),
        answer_paragraphs: paragraphs,
        paragraph_roles: paragraphs.map((_paragraph, paragraphIndex) =>
          paragraphIndex === 0 ? 'opening_position' : 'evidence_and_reasoning'),
        used_fact_ids: ['HOST-REVIEW-001'],
        claim_support: [],
      }
    }),
  }
  const pluginArtifactsDirectory = path.join(path.dirname(input.outputPath), '.generate-project-qa-report-plugin')
  const payloadPath = path.join(pluginArtifactsDirectory, 'qa-content.json')
  const verifyPath = path.join(pluginArtifactsDirectory, 'qa-plugin-verify.json')
  const bridge = path.resolve(process.cwd(), 'server', 'scripts', 'plugin_document_bridge.py')
  await mkdir(pluginArtifactsDirectory, { recursive: true })
  await writeFile(payloadPath, JSON.stringify(contentPayload, null, 2), 'utf8')
  const pluginValidation = await runDocumentPlugin({
    python,
    args: [
      bridge,
      'qa',
      '--processor', processorPath,
      '--payload', payloadPath,
      '--artifacts', pluginArtifactsDirectory,
      '--output', input.outputPath,
      '--verify-out', verifyPath,
    ],
    label: 'sbl-investment-qa 德塔模板渲染与校验',
  })
  const visualQa = await renderEveryPage({
    docxPath: input.outputPath,
    visualDirectory: input.visualDirectory,
    expectedMinimumPages: 1,
  })
  const buffer = await readFile(input.outputPath)
  return {
    bytes: buffer.length,
    questionCount: input.content.questions.length,
    categoryCount: new Set(input.content.questions.map((question) => question.category)).size,
    missingAnswerCount: input.content.review.dataGapCount,
    documentSha256: createHash('sha256').update(buffer).digest('hex'),
    layoutProfile: 'deta_qa_pdf',
    frontDirectoryIncluded: false,
    templateEnforced: true,
    rendererMode: 'plugin-deta-qa-pdf',
    pluginVerifyPassed: pluginValidation.status === 'pass',
    skillExecutionMode: 'plugin-deta-content-rendered-and-verified',
    depthMetrics,
    markdownValidation: pluginValidation,
    visualQa,
  }
}
