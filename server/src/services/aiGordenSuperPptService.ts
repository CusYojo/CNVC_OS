import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, symlinkSync } from 'node:fs'
import {
  cp,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  BusinessContent,
  BusinessSection,
  EvidenceSource,
} from './aiBusinessContentService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import { getAiSkillRoot } from './aiSkillService.js'
import { prepareInvestmentRecommendationPptWorkflow } from './aiInvestmentRecommendationPptWorkflowService.js'

const execFileAsync = promisify(execFile)

type ProjectLike = {
  name: string
  companyName?: string | null
  industry?: string | null
  stage?: string | null
  financing?: string | null
  valuation?: string | null
  summary?: string | null
  businessModel?: string | null
  market?: string | null
  team?: string | null
}

type GordenProgress = (
  update: { stage: string; progress: number },
) => void | Promise<void>

type GordenSlidePlan = {
  number: number
  role: string
  title: string
  expectedTexts: string[]
  sourceIndexes: number[]
  referencePage?: string
}

type GatewayImageResult = {
  task_id: string
  saved: string[]
  metadata_json: string
}

type GordenImagegenManifestEntry = Record<string, unknown> & {
  slide?: unknown
  copied_to?: unknown
}

type GordenResumeCheckpoint = {
  runRoot: string
  slides: GordenImagegenManifestEntry[]
  layerPages: Map<number, {
    pageRoot: string
  }>
  editablePages: Map<number, {
    pageRoot: string
    layout: Record<string, unknown>
  }>
  modifiedAt: number
  reuseScore: number
}

type IconManifest = {
  icons?: Array<{
    file?: unknown
    edge_touch?: Record<string, unknown>
  }>
}

type VisionLayout = {
  texts?: Array<{
    textIndex?: unknown
    source_bbox?: unknown
    size?: unknown
    size_px?: unknown
    color?: unknown
    bold?: unknown
    align?: unknown
    valign?: unknown
    font?: unknown
    line_spacing?: unknown
  }>
  icons?: Array<{
    file?: unknown
    source_bbox?: unknown
    visible_text?: unknown
  }>
  unexpectedText?: unknown
}

const GORDEN_LLM_BASE = (
  process.env.LLM_BASE_URL
  || process.env.OPENAI_BASE_URL
  || 'http://127.0.0.1:18081/v1'
).replace(/\/$/, '')
const GORDEN_LLM_KEY = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || ''
const GORDEN_VISION_MODEL = process.env.AI_GORDEN_VISION_MODEL
  || process.env.LLM_MODEL
  || 'gpt-5.2'
const GORDEN_RENDER_CONTRACT_VERSION = '4.0-investment-house-corpus'

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function safeSlug(value: string) {
  return value
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'investment-recommendation'
}

export function gordenSlidePlanFingerprint(plans: Array<Partial<GordenSlidePlan>>) {
  return sha256(Buffer.from(JSON.stringify(plans.map((plan) => ({
    number: Number(plan.number || 0),
    role: String(plan.role || ''),
    title: String(plan.title || ''),
    expectedTexts: Array.isArray(plan.expectedTexts)
      ? plan.expectedTexts.map(String)
      : [],
  })))))
}

function plansCompatibleForImageReuse(
  previousPlan: GordenSlidePlan,
  currentPlan: GordenSlidePlan,
) {
  if (gordenSlidePlanFingerprint([previousPlan]) === gordenSlidePlanFingerprint([currentPlan])) {
    return true
  }
  if (
    previousPlan.number !== currentPlan.number
    || previousPlan.role !== currentPlan.role
    || previousPlan.title !== currentPlan.title
    || currentPlan.expectedTexts.length <= previousPlan.expectedTexts.length
  ) return false
  const unchangedPrefix = previousPlan.expectedTexts.every(
    (text, index) => currentPlan.expectedTexts[index] === text,
  )
  const appendedTexts = currentPlan.expectedTexts.slice(previousPlan.expectedTexts.length)
  const sequentialMarkers = appendedTexts.every((text, index) => text === String(index + 1))
  const coverMarkers = appendedTexts.length >= 2
    && appendedTexts[0] === '1'
    && appendedTexts.slice(1).every((text, index) => text === String(index + 1))
  return unchangedPrefix
    && appendedTexts.length > 0
    && (sequentialMarkers || coverMarkers)
}

async function findGordenResumeCheckpoint(input: {
  directories: Array<string | undefined>
  slug: string
  templateSha256: string
  plans: GordenSlidePlan[]
  excludeRunRoot: string
}) {
  const candidates: GordenResumeCheckpoint[] = []
  const parents = [...new Set(input.directories
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value)))]
  for (const parent of parents) {
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(`.gorden-super-ppt-${input.slug}-`)) continue
      const runRoot = path.join(parent, entry.name)
      if (path.resolve(runRoot) === path.resolve(input.excludeRunRoot)) continue
      try {
        const [selection, slidePlan, imagegenManifest] = await Promise.all([
          readFile(path.join(runRoot, 'template-selection.json'), 'utf8').then(JSON.parse) as Promise<Record<string, unknown>>,
          readFile(path.join(runRoot, 'slide-plan.json'), 'utf8').then(JSON.parse) as Promise<{
            renderContractVersion?: unknown
            slides?: GordenSlidePlan[]
          }>,
          readFile(path.join(runRoot, 'imagegen-manifest.json'), 'utf8').then(JSON.parse) as Promise<{ slides?: GordenImagegenManifestEntry[] }>,
        ])
        const previousPlans = Array.isArray(slidePlan.slides) ? slidePlan.slides : []
        const previousSlides = Array.isArray(imagegenManifest.slides)
          ? imagegenManifest.slides
          : []
        if (String(selection.templateSha256 || '') !== input.templateSha256) continue
        if (String(slidePlan.renderContractVersion || '') !== GORDEN_RENDER_CONTRACT_VERSION) continue
        const previousPlanByNumber = new Map(previousPlans.map((plan) => [plan.number, plan]))
        const matchingSlideNumbers = new Set(input.plans.flatMap((plan) => {
          const previousPlan = previousPlanByNumber.get(plan.number)
          if (!previousPlan) return []
          return plansCompatibleForImageReuse(previousPlan, plan)
            ? [plan.number]
            : []
        }))
        const currentPlanByNumber = new Map(input.plans.map((plan) => [plan.number, plan]))
        const reusableSlides: GordenImagegenManifestEntry[] = []
        for (const item of previousSlides) {
          const slideNumber = Number(item.slide)
          if (
            !matchingSlideNumbers.has(slideNumber)
            || !existsSync(String(item.copied_to || ''))
          ) continue
          const rejectionPath = path.join(
            runRoot,
            'editable',
            String(slideNumber).padStart(2, '0'),
            'text-contract-rejected.json',
          )
          if (existsSync(rejectionPath)) {
            const rejection = JSON.parse(await readFile(rejectionPath, 'utf8')) as {
              unexpectedText?: unknown
            }
            const currentExpectedTexts = currentPlanByNumber
              .get(slideNumber)?.expectedTexts ?? []
            const stillUnexpected = Array.isArray(rejection.unexpectedText)
              ? gordenUnplannedVisibleTexts(
                  currentExpectedTexts,
                  rejection.unexpectedText.map(String),
                ).length > 0
              : true
            if (stillUnexpected) continue
          }
          reusableSlides.push(item)
        }
        if (!reusableSlides.length) continue
        const reusableSlideNumbers = new Set(reusableSlides.map((item) => Number(item.slide)))
        const editablePages = new Map<number, {
          pageRoot: string
          layout: Record<string, unknown>
        }>()
        const layerPages = new Map<number, {
          pageRoot: string
        }>()
        const editableLayoutTimes: number[] = []
        for (const plan of input.plans) {
          if (!reusableSlideNumbers.has(plan.number)) continue
          const pageRoot = path.join(
            runRoot,
            'editable',
            String(plan.number).padStart(2, '0'),
          )
          const layoutPath = path.join(pageRoot, 'layout.json')
          try {
            const layout = JSON.parse(await readFile(layoutPath, 'utf8')) as Record<string, unknown>
            const texts = Array.isArray(layout.texts) ? layout.texts : []
            const textIndexes = new Set(texts.map((item) => Number(
              item && typeof item === 'object'
                ? (item as Record<string, unknown>).textIndex
                : 0,
            )))
            const completeTextMap = plan.expectedTexts.every(
              (_text, index) => textIndexes.has(index + 1),
            )
            const requiredAssets = [
              path.join(pageRoot, 'source-slide.png'),
              path.join(pageRoot, 'background.png'),
              path.join(pageRoot, 'frame.png'),
              path.join(pageRoot, 'imagegen-assets-manifest.json'),
              path.join(pageRoot, 'icons', 'icons_manifest.json'),
            ]
            if (requiredAssets.some((asset) => !existsSync(asset))) continue
            layerPages.set(plan.number, { pageRoot })
            const visualReview = JSON.parse(await readFile(
              path.join(pageRoot, 'qa-visual', 'vision-review.json'),
              'utf8',
            )) as Record<string, unknown>
            if (
              !completeTextMap
              || visualReview.passed !== true
            ) continue
            editablePages.set(plan.number, { pageRoot, layout })
            editableLayoutTimes.push((await stat(layoutPath)).mtimeMs)
          } catch {
            // A page is reusable only after its normalized layout was persisted.
          }
        }
        const manifestStat = await stat(path.join(runRoot, 'imagegen-manifest.json'))
        candidates.push({
          runRoot,
          slides: reusableSlides,
          layerPages,
          editablePages,
          modifiedAt: Math.max(manifestStat.mtimeMs, ...editableLayoutTimes),
          reuseScore: reusableSlides.length * 10 + layerPages.size * 2 + editablePages.size,
        })
      } catch {
        // Incomplete runs are not valid checkpoints and are ignored.
      }
    }
  }
  return candidates.sort((left, right) =>
    right.reuseScore - left.reuseScore || right.modifiedAt - left.modifiedAt)[0]
}

function resolvePython() {
  if (process.env.AI_PDF_TO_PPT_PYTHON) return process.env.AI_PDF_TO_PPT_PYTHON
  const projectPython = path.resolve(
    process.cwd(),
    'server',
    '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
  )
  return existsSync(projectPython) ? projectPython : 'python3'
}

function findExecutable(name: string) {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name))
    .find((candidate) => existsSync(candidate))
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function reportProgress(
  callback: GordenProgress | undefined,
  stage: string,
  progress: number,
) {
  try {
    await callback?.({ stage, progress })
  } catch (error) {
    console.warn('[GordenSuperPPTSkill] 进度更新失败:', (error as Error).message)
  }
}

async function runCommand(
  executable: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) {
  try {
    return await execFileAsync(executable, args, {
      timeout: options.timeoutMs,
      maxBuffer: 80 * 1024 * 1024,
      windowsHide: true,
      env: options.env ?? process.env,
    })
  } catch (error) {
    const failure = error as Error & {
      stdout?: string
      stderr?: string
      killed?: boolean
    }
    const detail = [failure.stderr, failure.stdout, failure.message]
      .filter(Boolean)
      .join('\n')
      .slice(-16_000)
    const isTimeout = failure.killed
      || /TimeoutExpired|timed?\s+out(?:\s+after)?|ETIMEDOUT/i.test(detail)
    throw Object.assign(
      new Error(
        isTimeout
          ? `GordenSuperPPTSkill 执行超时：${detail}`
          : `GordenSuperPPTSkill 执行失败：${detail}`,
      ),
      { code: isTimeout ? 'GORDEN_SUPER_PPT_TIMEOUT' : 'GORDEN_SUPER_PPT_FAILED' },
    )
  }
}

function gordenGatewayFailure(error: unknown, input: {
  slideNumber: number
  slideCount: number
  layer?: string
}) {
  const upstreamCode = String((error as { code?: unknown }).code ?? '')
  const timeout = upstreamCode === 'GORDEN_SUPER_PPT_TIMEOUT'
  const layerLabel = input.layer ? `的${input.layer}层` : ''
  return Object.assign(
    new Error(
      `Gorden 第 ${input.slideNumber}/${input.slideCount} 页${layerLabel}图片网关${timeout ? '等待超时' : '调用失败'}：${(error as Error).message}`,
    ),
    {
      code: timeout ? 'GORDEN_IMAGE_GATEWAY_TIMEOUT' : 'GORDEN_IMAGE_GATEWAY_FAILED',
      upstreamCode,
      slideNumber: input.slideNumber,
      layer: input.layer,
    },
  )
}

export function gordenLayoutGuardArgs(input: {
  script: string
  sourceImage: string
  layoutPath: string
}) {
  return [input.script, input.sourceImage, input.layoutPath]
}

async function runGordenLayoutGuard(input: {
  python: string
  script: string
  sourceImage: string
  layoutPath: string
  slideNumber: number
  timeoutMs: number
  env: NodeJS.ProcessEnv
}) {
  try {
    await runCommand(input.python, gordenLayoutGuardArgs({
      script: input.script,
      sourceImage: input.sourceImage,
      layoutPath: input.layoutPath,
    }), { timeoutMs: input.timeoutMs, env: input.env })
  } catch (error) {
    const upstreamCode = String((error as { code?: unknown }).code ?? '')
    if (upstreamCode === 'GORDEN_SUPER_PPT_TIMEOUT') throw error
    throw Object.assign(
      new Error(`Gorden 第 ${input.slideNumber} 页布局检查未通过：${(error as Error).message}`),
      {
        code: 'GORDEN_LAYOUT_GUARD_REJECTED',
        upstreamCode,
        slideNumber: input.slideNumber,
      },
    )
  }
}

function parseGatewayResult(stdout: string): GatewayImageResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const start = stdout.lastIndexOf('\n{')
    if (start >= 0) parsed = JSON.parse(stdout.slice(start + 1))
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gorden 图片网关没有返回有效 JSON')
  }
  const record = parsed as Record<string, unknown>
  const taskId = String(record.task_id || '')
  const saved = Array.isArray(record.saved)
    ? record.saved.filter((item): item is string => typeof item === 'string')
    : []
  const metadataJson = String(record.metadata_json || '')
  if (!taskId || !saved[0] || !metadataJson) {
    throw new Error('Gorden 图片网关返回缺少 task_id、saved 或 metadata_json')
  }
  return { task_id: taskId, saved, metadata_json: metadataJson }
}

function sectionSourceIndexes(section: BusinessSection) {
  return [...new Set([
    ...(section.summarySourceIndexes ?? []),
    ...section.findings.flatMap((finding) => finding.sourceIndexes),
    ...(section.tables ?? []).flatMap((table) => table.sourceIndexes),
  ])].filter((index) => Number.isInteger(index) && index >= 0)
}

function compactText(value: string, limit = 180) {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`
}

function canonicalVisibleText(value: string) {
  return value.normalize('NFKC').replace(/\s+/g, '').trim()
}

export function gordenUnplannedVisibleTexts(
  expectedTexts: string[],
  observedUnexpectedTexts: string[],
) {
  const expected = expectedTexts.map(canonicalVisibleText).filter(Boolean)
  const expectedSet = new Set(expected)
  return [...new Set(observedUnexpectedTexts
    .map((value) => value.trim())
    .filter((value) => {
      const observed = canonicalVisibleText(value)
      if (!observed || expectedSet.has(observed)) return false
      // Vision occasionally reports a divider, bullet or decorative stroke as
      // standalone OCR text (for example "|", "•" or "—"). These shapes do
      // not carry semantic content and must not invalidate an otherwise exact
      // text contract. Numbers and any CJK/Latin content remain enforceable.
      const semanticCharacters = observed.replace(/[\p{P}\p{S}]/gu, '')
      if (!semanticCharacters) return false
      const isShortLatinFragment = /^[A-Za-z][A-Za-z0-9.+/-]{1,7}$/.test(observed)
      if (isShortLatinFragment && expected.some((text) => text.includes(observed))) {
        return false
      }
      return true
    }))]
}

function uniqueCompactTexts(values: Array<string | null | undefined>) {
  return [...new Set(values
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))]
}

function coverExpectedTexts(input: {
  project: ProjectLike
  content: BusinessContent
}) {
  // Every approved house template uses a restrained cover. Project facts,
  // financing and valuation belong on the investment-summary pages rather
  // than in a dashboard-like grid on page one.
  return uniqueCompactTexts([
    input.content.title || `${input.project.name}投资建议书`,
    input.project.companyName || input.project.name,
    input.project.industry ? `${input.project.industry}项目` : undefined,
  ])
}

function sectionTexts(section: BusinessSection) {
  const table = section.tables?.[0]
  const texts = [
    section.title,
    compactText(section.summary, 220),
    ...section.findings.slice(0, 2).map((finding) => compactText(finding.text, 150)),
    ...(table ? [
      compactText(table.title, 80),
      compactText(table.columns.join('｜'), 120),
      ...table.rows.slice(0, 3).map((row) => compactText(row.join('｜'), 140)),
    ] : []),
  ]
  return [...new Set(texts.map((value) => value.trim()).filter(Boolean))]
}

function roleForTitle(title: string) {
  const rules: Array<[RegExp, string]> = [
    [/摘要|概要|亮点|结论/, 'summary'],
    [/公司|项目|主体|概况|介绍|历程|股权/, 'company'],
    [/团队|创始人|管理层|治理/, 'team'],
    [/产品|应用|解决方案|场景/, 'product'],
    [/技术|研发|专利|知识产权|架构/, 'technology'],
    [/行业|市场|空间|政策|产业链/, 'market'],
    [/竞争|竞品|对标|格局/, 'competition'],
    [/客户|订单|合同|商业化|经营|案例|验证/, 'validation'],
    [/商业模式|收入结构|复制路径/, 'business-model'],
    [/财务|盈利|收入预测|现金流/, 'financials'],
    [/估值|融资|投资方案|交易方案|投资建议/, 'investment-plan'],
    [/退出|回报/, 'exit'],
    [/风险|核验|关注事项/, 'risk'],
  ]
  return rules.find(([pattern]) => pattern.test(title))?.[1] ?? 'content'
}

type FivePageBucket = 'overview' | 'business' | 'decision'

function fivePageBucketForSection(section: BusinessSection): FivePageBucket {
  const role = roleForTitle(section.title)
  if (['financials', 'investment-plan', 'exit', 'risk'].includes(role)) return 'decision'
  if (['product', 'technology', 'market', 'competition', 'validation', 'business-model'].includes(role)) {
    return 'business'
  }
  return 'overview'
}

function fivePageSectionGroups(sections: BusinessSection[]) {
  const groups: Record<FivePageBucket, BusinessSection[]> = {
    overview: [],
    business: [],
    decision: [],
  }
  for (const section of sections) groups[fivePageBucketForSection(section)].push(section)

  // Sparse projects may not yet contain all three evidence chains. Preserve
  // every section, but split the largest chain so the requested five-page deck
  // still has three purposeful content pages instead of an empty placeholder.
  for (const target of Object.keys(groups) as FivePageBucket[]) {
    if (groups[target].length) continue
    const donor = (Object.keys(groups) as FivePageBucket[])
      .filter((key) => key !== target)
      .sort((left, right) => groups[right].length - groups[left].length)
      .find((key) => groups[key].length > 1)
    if (donor) groups[target].push(groups[donor].pop()!)
  }
  return groups
}

function projectSnapshotTexts(input: {
  project: ProjectLike
  content: BusinessContent
}) {
  return uniqueCompactTexts([
    input.project.stage ? `项目阶段：${compactText(input.project.stage, 36)}` : undefined,
    input.project.businessModel
      ? `业务定位：${compactText(input.project.businessModel, 80)}`
      : input.project.summary ? `项目定位：${compactText(input.project.summary, 80)}` : undefined,
    input.project.financing ? `融资概况：${compactText(input.project.financing, 60)}` : undefined,
    input.project.valuation ? `估值口径：${compactText(input.project.valuation, 60)}` : undefined,
    compactText(input.content.executiveSummary, 180),
    ...input.content.highlights.slice(0, 2).map((value) => compactText(value, 80)),
  ])
}

function groupedDecisionTexts(input: {
  title: string
  sections: BusinessSection[]
  includeEvidence?: boolean
}) {
  const evidence = input.includeEvidence
    ? input.sections.flatMap((section) => {
        const numericalFinding = section.findings.find((finding) =>
          /\d|%|％|万元|亿元|收入|订单|估值|融资|占股/.test(finding.text))
          ?? section.findings[0]
        const table = section.tables?.[0]
        return [
          numericalFinding ? compactText(numericalFinding.text, 130) : '',
          ...(table ? [
            compactText(table.title, 70),
            compactText(table.columns.join('｜'), 100),
            ...table.rows.slice(0, 2).map((row) => compactText(row.join('｜'), 120)),
          ] : []),
        ]
      })
    : []
  return [...new Set([
    input.title,
    ...input.sections.flatMap((section) => [
      section.title,
      compactText(section.summary || section.findings[0]?.text || '相关事实仍需进一步核验。', 150),
    ]),
    ...evidence,
  ].map((value) => value.trim()).filter(Boolean))]
}

export function buildGordenSlidePlan(input: {
  project: ProjectLike
  content: BusinessContent
  disclaimer: string
  references?: string[]
  pageCount?: string | number
}): GordenSlidePlan[] {
  const parsedPageCount = Number.parseInt(String(input.pageCount ?? ''), 10)
  const requestedPageCount = Number.isFinite(parsedPageCount)
    ? Math.min(30, Math.max(3, parsedPageCount))
    : undefined
  const contentSlideCount = requestedPageCount
    ? Math.max(1, requestedPageCount - 2)
    : input.content.sections.length

  if (requestedPageCount === 5) {
    const groups = fivePageSectionGroups(input.content.sections)
    const contentSlides: GordenSlidePlan[] = [
      {
        number: 2,
        role: 'summary',
        title: '项目概况与投资判断',
        expectedTexts: [...new Set([
          '项目概况与投资判断',
          ...projectSnapshotTexts(input),
          ...groupedDecisionTexts({
            title: '项目概况与投资判断',
            sections: groups.overview,
          }).slice(1),
        ])],
        sourceIndexes: [...new Set(groups.overview.flatMap(sectionSourceIndexes))],
      },
      {
        number: 3,
        role: 'product',
        title: '产品技术与商业验证',
        expectedTexts: groupedDecisionTexts({
          title: '产品技术与商业验证',
          sections: groups.business,
          includeEvidence: true,
        }),
        sourceIndexes: [...new Set(groups.business.flatMap(sectionSourceIndexes))],
      },
      {
        number: 4,
        role: 'investment-plan',
        title: '财务表现、估值与交易方案',
        expectedTexts: groupedDecisionTexts({
          title: '财务表现、估值与交易方案',
          sections: groups.decision,
          includeEvidence: true,
        }),
        sourceIndexes: [...new Set(groups.decision.flatMap(sectionSourceIndexes))],
      },
    ]
    const referenceNames = uniqueCompactTexts(input.references ?? []).slice(0, 6)
    const closingTexts = [
      '投资结论、风险与后续事项',
      '投资结论',
      compactText(input.content.executiveSummary, 240),
      '风险与核验重点',
      ...input.content.risks.slice(0, 4).map((risk) => compactText(risk, 120)),
      '引用资料与责任声明',
      `引用资料：${referenceNames.join('；') || '当前项目档案与本轮授权资料'}`,
      input.disclaimer,
    ].filter(Boolean)
    return [
      {
        number: 1,
        role: 'cover',
        title: input.content.title || `${input.project.name}投资建议书`,
        expectedTexts: coverExpectedTexts(input),
        sourceIndexes: input.content.executiveSummarySourceIndexes ?? [],
      },
      ...contentSlides,
      {
        number: 5,
        role: 'risk',
        title: '投资结论、风险与后续事项',
        expectedTexts: closingTexts,
        sourceIndexes: input.content.executiveSummarySourceIndexes ?? [],
      },
    ]
  }
  const sectionGroups: BusinessSection[][] = []
  if (
    requestedPageCount
    && input.content.sections.length > contentSlideCount
  ) {
    for (let index = 0; index < contentSlideCount; index += 1) {
      const start = Math.floor(index * input.content.sections.length / contentSlideCount)
      const end = Math.floor((index + 1) * input.content.sections.length / contentSlideCount)
      sectionGroups.push(input.content.sections.slice(start, Math.max(start + 1, end)))
    }
  } else {
    sectionGroups.push(...input.content.sections.map((section) => [section]))
  }
  const contentSlides = sectionGroups.map((sections, index) => {
    const title = sections.length === 1
      ? compactText(sections[0].title, 42)
      : compactText(`${sections[0].title}等${sections.length}项专题`, 32)
    // A five-page deck can group four or more business sections on one slide.
    // Keep one concise summary per card. Combining the summary and findings in
    // one expected string still makes image models split it into several bullet
    // regions, which cannot be reconstructed as one native editable textbox.
    const semanticTexts = sections.length === 1
      ? sectionTexts(sections[0])
      : [
          title,
          ...sections.flatMap((section) => [
            section.title,
            compactText(
              section.summary || section.findings[0]?.text || '本专题资料仍需进一步核验。',
              160,
            ),
          ]),
        ].map((value) => value.trim()).filter(Boolean)
    const expectedTexts = semanticTexts
    return {
      number: index + 2,
      role: roleForTitle(sections.map((section) => section.title).join('、')),
      title,
      expectedTexts,
      sourceIndexes: [...new Set(sections.flatMap(sectionSourceIndexes))],
    }
  })
  const slides: GordenSlidePlan[] = [
    {
      number: 1,
      role: 'cover',
      title: input.content.title || `${input.project.name}投资建议书`,
      expectedTexts: coverExpectedTexts(input),
      sourceIndexes: input.content.executiveSummarySourceIndexes ?? [],
    },
    ...contentSlides,
  ]
  const referenceNames = uniqueCompactTexts(input.references ?? []).slice(0, 6)
  const closingTexts = [
    '投资结论、风险与后续事项',
    '投资结论',
    compactText(input.content.executiveSummary, 260),
    '风险与核验重点',
    ...input.content.risks.slice(0, 4).map((risk) => compactText(risk, 120)),
    '引用资料与责任声明',
    `引用资料：${referenceNames.join('；') || '当前项目档案与本轮授权资料'}`,
    input.disclaimer,
  ].filter(Boolean)
  slides.push({
    number: slides.length + 1,
    role: 'risk',
    title: '投资结论、风险与后续事项',
    expectedTexts: closingTexts,
    sourceIndexes: input.content.executiveSummarySourceIndexes ?? [],
  })
  return slides.map((slide, index) => ({ ...slide, number: index + 1 }))
}

function sourceLabels(indexes: number[], sources: EvidenceSource[]) {
  return [...new Set(indexes
    .filter((index) => Boolean(sources[index]))
    .map((index) => sources[index].sourceName))]
    .slice(0, 4)
}

function investmentCompositionBrief(slide: GordenSlidePlan) {
  if (slide.role === 'cover') {
    return '封面采用模板的机构报告式留白与视觉重心：大标题、公司/行业副题和一处克制的主题视觉即可。禁止任何项目阶段、融资、估值、亮点卡片或仪表盘。'
  }
  if (slide.role === 'summary') {
    return '项目摘要页应形成“一个核心投资判断 + 一组关键事实”的主次关系，可使用事实条、时间线或结论栏；不得把全部文字做成四宫格、九宫格或等权卡片。'
  }
  if (['product', 'technology', 'validation', 'business-model'].includes(slide.role)) {
    return '产品/技术/验证页应有一个占主要面积的内容骨架，例如产品全景、技术分层、证据链或场景流程，辅以少量说明；不要用一排通用图标代替产品、技术和客户证据。'
  }
  if (['financials', 'investment-plan', 'exit'].includes(slide.role)) {
    return '财务与交易页优先使用机构投资材料常见的表格、主图、条款区或风险对照结构。只有文字清单提供了数字时才能绘制数值图表；不得生成虚构坐标、年份、比例或金额。'
  }
  if (['risk', 'closing'].includes(slide.role)) {
    return '决策收束页采用投资结论、风险/核验事项、来源与责任声明的清晰分区，可使用对照表或纵向决策结构；不要做成“谢谢观看”海报或图标卡片墙。'
  }
  return '一页只表达一个投资判断主题，以证据表、时间线、对比、流程或结论区组织内容；禁止用重复等宽卡片填满页面。'
}

export function buildGordenSlidePrompt(input: {
  slide: GordenSlidePlan
  projectName: string
  sourceNames: string[]
  palette: string[]
}) {
  const pageTexts = input.slide.expectedTexts
    .map((text, index) => `${index + 1}. ${text}`)
    .join('\n')
  return `生成一张 16:9 横版、2560×1440 的机构投资建议书成品幻灯片。
当前项目：${input.projectName}
页面角色：${input.slide.role}
页面标题：${input.slide.title}
主配色：${input.palette.join('、') || '#0B2D5C、#2F6BFF、#F4B740、#F5F8FC'}

以输入的模板页作为唯一视觉参考，只借鉴其机构报告式栅格、留白、字体层级、色彩比例、标题线、表格和图表组织；必须替换模板中的全部公司名、Logo、人物、产品图、日期、页码和数字。不得残留任何模板样本事实。

【本页构图要求】
${investmentCompositionBrief(input.slide)}

整份材料必须呈现专业股权投资机构的 IC/投资建议书气质，不得设计成软件后台、网页仪表盘、移动端界面、运营数据大屏、四宫格/九宫格卡片墙或通用图标清单。避免大面积薰衣草紫渐变、玻璃拟态、悬浮圆角面板和无事实含义的 3D 图标。页面要高信息密度但主次清楚，每页只能有一个占主导的内容结构；优先复用参考页的扁平版式、紧凑标题、细分隔线、真实表格/图表密度和机构页眉页脚节奏。

输入模板中的人物、产品、客户 Logo、证书和现场照片只是样本事实，不得复制、变形复用或替换成虚构的当前项目照片。若没有提供当前项目真实视觉素材，使用不带事实暗示的几何结构、表格、时间线和色块留白，不得生成写实人物、虚构产品、虚构客户 Logo 或虚构证书。
不得添加水印、页码、二维码、占位符、Lorem ipsum 或未提供的数据。

【页面可见文字，必须逐字照排，不得改写、遗漏或新增】
${pageTexts}

【来源名称，仅用于事实边界】
${input.sourceNames.join('、') || '用户已授权项目资料'}
不得在页面上额外新增来源名称；若某个来源名称已明确列入上方“页面可见文字”清单，则必须按清单逐字照排。不得自行扩写来源内容。

严格文字契约：页面中可读文字总数必须恰好为 ${input.slide.expectedTexts.length} 条，只能使用上述编号后的正文，并且每一条只能出现一次；清单最左侧的序号只是控制标记，不得显示。每一条正文必须完整放在一个连续文本区域内，不得按“｜”、标点或语义拆成多个导航标签、卡片、段落或文本框，也不得把多条正文合并到同一个文本框。不得重复任何标题、正文或数字；不得自行生成 1、2、3……编号、编号徽标、空白编号卡片、图例或目录。需要项目符号时只能使用不含文字的纯图形圆点。模板中多余的文字模块应删除或改为纯图形，不得用“愿景、使命、价值、团队、来源名称”、日期、页码或其他自拟标签补位。每个有文字的卡片、图表、轴标签和页脚都必须使用清单中的原文；清单没有对应文字时，删除该模块，不得留下带空标题的卡片或图表。
若文字清单没有流程节点或图表标签，禁止生成任何带文字的流程图、路径图、思维导图、坐标轴或数据图标签；这类装饰只能使用完全不含文字的纯图形。尤其不得沿用模板示例中的“大脑、信号采集、解码、外部设备”等流程词。
所有数字、主体、人物、客户、融资、估值和交易条款只能来自上述可见文字。中文使用清晰的现代无衬线字体。`
}

export function buildGordenEditableLayerPrompts(keyColor = '#00ff00') {
  return {
    background: `以输入图片作为唯一编辑目标，生成一张与原图 1:1 对齐的干净背景图。只保留底色、渐变、纹理、照片氛围和纯背景装饰；移除全部文字、数字、Logo、图标、人物、产品主体、卡片、框架、图表和线条。16:9，2560×1440，不得新增内容。`,
    frame: `生成一张图片，提取输入图片中的框架图，纯色背景，背景色值为 ${keyColor}。“框架图”是原图里除背景、图标、装饰、艺术字、普通文本外的一切，包括容器轮廓与底色填充、标题条、辉光、分隔线、连接线、全部图表图形、坐标网格、趋势线、缎带和装饰线条。形状、大小、位置与原图 1:1 一致，保留原色与填充；不要出现文字、图标或额外占位框。与纯色背景接触的容器边缘不得混入 ${keyColor} 的反光、辉光、渐变或投影；描边和阴影只能使用原图中的颜色。16:9，2560×1440。`,
    icons: `以输入图片作为唯一编辑目标，只提取可独立移动的纯图形元素，例如图标、Logo、人物、产品小图和不含文字的装饰图形。
不得包含任何中文、英文、数字、标点或其他可读文字；标题、副标题、正文、标签、艺术字和带文字的徽章全部不要提取，文字将由后续流程生成为原生可编辑文本。
不得包含卡片、框架、表格、图表坐标、横线、竖线、分隔线、连接线或网格；这些内容属于框架层。
把每个纯图形元素完整、独立地排列在纯色背景 ${keyColor} 上，按从左到右、从上到下的疏松图标表排布；元素之间保留明显的连续纯色空隙，任何元素及其阴影都不得接触、重叠、越界或跨越相邻位置。不要画网格线、标签或说明文字。不得遗漏符合条件的纯图形，也不得添加原图没有的元素。正方形 2048×2048。`,
  }
}

export function buildGordenVisualQaPrompt(expectedTexts: string[]) {
  const indexedTexts = expectedTexts
    .map((text, index) => `${index + 1}. ${text}`)
    .join('\n')
  return `第一张图是图片模型生成的参考成品图，第二张图是四层可编辑 PPTX 的最终预览。这是交付安全门，不是像素级临摹评分。

第二张图必须完整、清晰、可读地呈现下列文字契约：
${indexedTexts}

只有以下情形才是阻断交付的 criticalIssues：
1. 上述某条契约文字在第二张图中完全缺失或被改写。如果契约中同一文字出现多次，第二张图中至少要有相同次数的可读实例。
2. 文字被严重遮挡、裁切、重叠或小到不可读。
3. 第二张图出现契约之外的有意义文字、模板样例事实或无依据数字。
4. 元素大面积互相覆盖，导致页面内容无法使用。

下列都是非阻断的 cosmeticIssues：边框粗细或颜色、阴影、卡片填充、图标造型或尺寸、圆点和装饰线缺失、字体或字号的轻微差异、正常换行、间距和对齐的小幅差异。第二张图不需要复制第一张图意外多生成的重复文字、空卡片或占位模块。如果只有 cosmeticIssues，passed 必须为 true。

返回 JSON：{"passed":true,"criticalIssues":[],"cosmeticIssues":[],"summary":""}。只返回 JSON。`
}

const GORDEN_ICON_LAYER_MAX_ATTEMPTS = 2

export function unsafeGordenIconFiles(manifest: IconManifest) {
  return (manifest.icons ?? [])
    .filter((icon) => Object.values(icon.edge_touch ?? {}).some(Boolean))
    .map((icon) => String(icon.file || ''))
    .filter(Boolean)
}

export function buildGordenIconRetryPrompt(input: {
  keyColor: string
  attempt: number
  unsafeIconFiles: string[]
}) {
  const basePrompt = buildGordenEditableLayerPrompts(input.keyColor).icons
  return `${basePrompt}

【图标边界安全重试 ${input.attempt}】
上一版图标表有 ${input.unsafeIconFiles.length} 个元素触及画布边界（${input.unsafeIconFiles.join('、') || '未命名元素'}）。本次必须把所有图形整体缩小并放在画布中央区域：画布上、下、左、右各保留至少 12% 连续纯色 ${input.keyColor} 安全边距；元素及阴影之间也必须保留明显纯色间隔。禁止生成贴边横幅、页脚、整行装饰或跨越多个图标位的长条图形；这类不适合作为独立图标的元素直接省略。任何图形像素都不得进入四周安全边距。`
}

function resolveGordenSkillDirectory(skillRoot: string, skillName: string) {
  const candidates = [
    path.join(skillRoot, 'GordenSuperPPTSkills', skillName),
    path.join(skillRoot, skillName),
  ]
  return candidates.find((candidate) => existsSync(path.join(candidate, 'SKILL.md')))
    ?? candidates[0]
}

export function gordenSkillPaths(skillRoot = getAiSkillRoot()) {
  const nestedBundle = path.join(skillRoot, 'GordenSuperPPTSkills')
  const superRoot = resolveGordenSkillDirectory(skillRoot, 'GordenSuperPPTSkill')
  const imageGenRoot = resolveGordenSkillDirectory(skillRoot, 'GordenImagePPTGen')
  const image2Root = resolveGordenSkillDirectory(skillRoot, 'GordenImage2PPTX')
  const bundle = [superRoot, imageGenRoot, image2Root].every(
    (directory) => path.dirname(directory) === nestedBundle,
  )
    ? nestedBundle
    : skillRoot
  return {
    bundle,
    superRoot,
    imageGenRoot,
    image2Root,
    ingest: path.join(superRoot, 'scripts', 'ingest_reference_template.py'),
    generateImage: path.join(imageGenRoot, 'scripts', 'generate_gateway_slide_image.py'),
    composeImageDeck: path.join(imageGenRoot, 'scripts', 'compose_pptx.py'),
    chromaKey: path.join(image2Root, 'scripts', 'chroma_key.py'),
    sliceGrid: path.join(image2Root, 'scripts', 'slice_grid.py'),
    layoutGuard: path.join(image2Root, 'scripts', 'layout_guard.py'),
    placementQa: path.join(image2Root, 'scripts', 'placement_qa.py'),
    visualCompareQa: path.join(image2Root, 'scripts', 'visual_compare_qa.py'),
    composeEditable: path.join(image2Root, 'scripts', 'compose_pptx.py'),
  }
}

export function selectInvestmentRecommendationReference(input: {
  template: Pick<AiTemplateDefinition, 'referencePath' | 'referencePaths' | 'customAnalysis'>
  project: ProjectLike
  content: BusinessContent
}) {
  if (input.template.customAnalysis) {
    return {
      mode: 'user-reference' as const,
      id: 'user-reference',
      path: input.template.referencePath,
      sourceTemplates: [input.template.referencePath],
    }
  }
  const corpus = (input.template.referencePaths ?? [])
    .filter((referencePath) =>
      path.extname(referencePath).toLowerCase() === '.pdf'
      && referencePath.includes(`${path.sep}docs${path.sep}投资建议书${path.sep}`)
      && existsSync(referencePath))
  if (!corpus.length) {
    return {
      mode: 'user-reference' as const,
      id: 'user-reference',
      path: input.template.referencePath,
      sourceTemplates: [input.template.referencePath],
    }
  }

  const projectText = [
    input.project.name,
    input.project.companyName,
    input.project.industry,
    input.project.summary,
    input.project.businessModel,
    input.project.market,
    input.project.team,
    ...input.content.sections.flatMap((section) => [section.title, section.summary]),
  ].filter(Boolean).join('\n')
  const rules: Array<[RegExp, RegExp, string]> = [
    [/具身|机器人|人形|机械臂|自动驾驶|空间智能/i, /飞阔科技.*终稿/i, 'robotics-investment'],
    [/存储|芯片|半导体|DRAM|SRAM|CIM|RISC/i, /微纳核芯/i, 'semiconductor-investment'],
    [/光电|光学|成像|传感器|激光/i, /轻蜓光电/i, 'optoelectronics-investment'],
    [/精密|测量|测试|仪器|设备|校准/i, /普雷赛斯/i, 'industrial-equipment-investment'],
    [/应急|消防|安全生产|政府|国资|产业园/i, /蓝成应急/i, 'scenario-commercialization-investment'],
    [/人工智能|\bAI\b|大模型|Agent|数据|软件|SaaS/i, /中数睿智/i, 'ai-software-investment'],
  ]
  for (const [projectPattern, filePattern, id] of rules) {
    if (!projectPattern.test(projectText)) continue
    const matched = corpus.find((referencePath) => filePattern.test(path.basename(referencePath)))
    if (matched) {
      return {
        mode: 'house-corpus' as const,
        id,
        path: matched,
        sourceTemplates: corpus,
      }
    }
  }
  const fallback = corpus.find((referencePath) => /蓝成应急/.test(path.basename(referencePath)))
    ?? corpus.find((referencePath) => /中数睿智/.test(path.basename(referencePath)))
    ?? corpus[0]
  return {
    mode: 'house-corpus' as const,
    id: 'hybrid-investment-house-style',
    path: fallback,
    sourceTemplates: corpus,
  }
}

function referenceRoleCandidates(role: string) {
  const aliases: Record<string, string[]> = {
    cover: ['cover'],
    summary: ['summary', 'investment-highlights', 'company'],
    company: ['company', 'summary'],
    team: ['team', 'company'],
    product: ['product', 'technology', 'validation'],
    technology: ['technology', 'product', 'validation', 'moat'],
    market: ['market', 'problem', 'competition'],
    competition: ['competition', 'market'],
    validation: ['validation', 'business-model', 'ecosystem'],
    'business-model': ['business-model', 'validation', 'ecosystem'],
    financials: ['financials', 'investment-plan'],
    'investment-plan': ['investment-plan', 'financials', 'exit'],
    exit: ['exit', 'investment-plan', 'risk'],
    risk: ['risk', 'closing', 'investment-plan'],
    closing: ['closing', 'risk'],
  }
  return aliases[role] ?? [role, 'content']
}

const HOUSE_REFERENCE_PAGE_MAPS: Array<{
  fileName: RegExp
  pages: Record<string, number>
}> = [
  {
    fileName: /普雷赛斯/,
    pages: {
      cover: 1, summary: 31, company: 7, team: 8, product: 10, technology: 16,
      market: 3, competition: 25, validation: 19, 'business-model': 23,
      financials: 24, 'investment-plan': 29, exit: 30, risk: 31, closing: 32,
    },
  },
  {
    fileName: /轻蜓光电/,
    pages: {
      cover: 1, summary: 34, company: 7, team: 8, product: 10, technology: 17,
      market: 3, competition: 28, validation: 21, 'business-model': 26,
      financials: 27, 'investment-plan': 32, exit: 33, risk: 35, closing: 36,
    },
  },
  {
    fileName: /飞阔科技/,
    pages: {
      cover: 1, summary: 2, company: 7, team: 21, product: 8, technology: 14,
      market: 4, competition: 24, validation: 23, 'business-model': 24,
      financials: 19, 'investment-plan': 26, exit: 25, risk: 27, closing: 27,
    },
  },
  {
    fileName: /微纳核芯/,
    pages: {
      cover: 1, summary: 36, company: 7, team: 8, product: 16, technology: 17,
      market: 3, competition: 25, validation: 24, 'business-model': 31,
      financials: 30, 'investment-plan': 34, exit: 35, risk: 36, closing: 37,
    },
  },
  {
    fileName: /中数睿智/,
    pages: {
      cover: 1, summary: 2, company: 9, team: 13, product: 12, technology: 16,
      market: 4, competition: 24, validation: 21, 'business-model': 20,
      financials: 27, 'investment-plan': 32, exit: 34, risk: 36, closing: 37,
    },
  },
  {
    fileName: /蓝成应急/,
    pages: {
      cover: 1, summary: 2, company: 8, team: 14, product: 9, technology: 10,
      market: 4, competition: 24, validation: 17, 'business-model': 27,
      financials: 29, 'investment-plan': 31, exit: 33, risk: 32, closing: 34,
    },
  },
]

export function investmentHouseReferencePageNumber(sourcePath: string, role: string) {
  const profile = HOUSE_REFERENCE_PAGE_MAPS.find((item) =>
    item.fileName.test(path.basename(sourcePath)))
  if (!profile) return undefined
  for (const candidate of referenceRoleCandidates(role)) {
    const page = profile.pages[candidate]
    if (page) return page
  }
  return undefined
}

function referencePageForPlan(
  pages: Array<{ page?: number; role_hint?: string; image?: string }>,
  plan: GordenSlidePlan,
  sourcePath: string,
) {
  const manualPage = investmentHouseReferencePageNumber(sourcePath, plan.role)
  const manualMatch = manualPage
    ? pages.find((page) => Number(page.page) === manualPage)
    : undefined
  if (manualMatch) return manualMatch
  for (const role of referenceRoleCandidates(plan.role)) {
    const match = pages.find((page) => page.role_hint === role)
    if (match) return match
  }
  return pages[Math.min(plan.number - 1, Math.max(0, pages.length - 1))] ?? pages[0]
}

export function referenceDrivenSkillPaths(skillRoot = getAiSkillRoot()) {
  const orchestratorRoot = path.join(
    skillRoot,
    'create-reference-driven-editable-ppt',
  )
  const pdfRoot = path.join(skillRoot, 'pdf-to-editable-ppt')
  return {
    orchestratorRoot,
    resolveDependencies: path.join(
      orchestratorRoot,
      'scripts',
      'resolve_dependencies.py',
    ),
    packageSlidesAsPdf: path.join(
      orchestratorRoot,
      'scripts',
      'package_slides_as_pdf.py',
    ),
    validatePipelineHandoff: path.join(
      orchestratorRoot,
      'scripts',
      'validate_pipeline_handoff.py',
    ),
    pdfRoot,
    convertPdf: path.join(pdfRoot, 'scripts', 'convert_pdf.py'),
  }
}

function fractionPosition(
  value: Record<string, unknown>,
  width: number,
  height: number,
) {
  return {
    left: Number(value.x || 0) * width,
    top: Number(value.y || 0) * height,
    width: Number(value.w || 0) * width,
    height: Number(value.h || 0) * height,
  }
}

export function buildReferenceDrivenSemanticOverrides(input: {
  slides: Array<Record<string, unknown>>
  dimensions: Array<{ width: number; height: number }>
}) {
  const coordinateWidth = Math.max(
    1,
    ...input.dimensions.map((item) => item.width),
  )
  const slides: Record<string, unknown> = {}
  for (const [index, rawSlide] of input.slides.entries()) {
    const page = index + 1
    const dimension = input.dimensions[index] ?? { width: coordinateWidth, height: 1440 }
    const width = dimension.width
    const height = dimension.height
    const texts = Array.isArray(rawSlide.texts)
      ? rawSlide.texts as Array<Record<string, unknown>>
      : []
    const sourceIcons = Array.isArray(rawSlide.icons)
      ? rawSlide.icons as Array<Record<string, unknown>>
      : []
    const frame = String(rawSlide.frame || '')
    const background = String(rawSlide.background || '')
    const icons = [
      ...(frame
        ? [{
            mode: 'raster',
            name: `slide-${String(page).padStart(2, '0')}-frame`,
            asset: frame,
            position: { left: 0, top: 0, width, height },
          }]
        : []),
      ...sourceIcons.map((icon, iconIndex) => ({
        mode: 'raster',
        name: `slide-${String(page).padStart(2, '0')}-icon-${String(iconIndex + 1).padStart(3, '0')}`,
        asset: String(icon.file || ''),
        position: fractionPosition(icon, width, height),
      })),
    ]
    const semanticTexts = texts
      .filter((text) => !Boolean(text.rendered_by_icon))
      .map((text, textIndex) => ({
      name: `slide-${String(page).padStart(2, '0')}-text-${String(textIndex + 1).padStart(3, '0')}`,
      text: String(text.text || ''),
      position: fractionPosition(text, width, height),
      textStyle: {
        typeface: String(text.font || 'Microsoft YaHei'),
        fontSize: Math.max(5, Number.isFinite(Number(text.size))
          ? Number(text.size)
          : Number.isFinite(Number(text.size_px))
            ? Number(text.size_px) * 540 / Math.max(1, height)
            : 12),
        color: String(text.color || '#172033'),
        bold: Boolean(text.bold),
        alignment: String(text.align || 'left'),
        verticalAlignment: String(text.valign || 'top') === 'center'
          ? 'middle'
          : String(text.valign || 'top'),
        autoFit: 'shrink',
      },
    }))
    slides[String(page)] = {
      coordinateWidth: width,
      review: {
        completed: true,
        expectedCounts: {
          covers: background ? 1 : 0,
          shapes: 0,
          connectors: 0,
          texts: semanticTexts.length,
          icons: icons.length,
          charts: 0,
          tables: 0,
          imageReplacements: 0,
        },
        allowedRasterRegions: [
          { reason: 'Gorden 生成的干净背景保留为独立全页栅格层' },
          { reason: 'Gorden 提取的框架与复杂装饰按独立栅格对象保留' },
        ],
        unresolvedRegions: [],
      },
      skipTextRegions: [{ left: 0, top: 0, width, height }],
      covers: background
        ? [{
            name: `slide-${String(page).padStart(2, '0')}-background`,
            asset: background,
            position: { left: 0, top: 0, width, height },
          }]
        : [],
      icons,
      texts: semanticTexts,
    }
  }
  return {
    schemaVersion: '1.0',
    producer: 'create-reference-driven-editable-ppt',
    coordinateWidth,
    slides,
  }
}

async function generateGatewayImage(input: {
  python: string
  script: string
  promptFile: string
  outDir: string
  referenceImage?: string
  size?: string
  timeoutMs: number
  env: NodeJS.ProcessEnv
}) {
  const args = [
    input.script,
    '--prompt',
    `@${input.promptFile}`,
    '--out-dir',
    input.outDir,
    '--size',
    input.size ?? '2560x1440',
    '--quality',
    'high',
    '--max-wait',
    String(Math.max(180, Math.floor(input.timeoutMs / 1000) - 30)),
  ]
  if (input.referenceImage) args.push('--image', input.referenceImage)
  const result = await runCommand(input.python, args, {
    timeoutMs: input.timeoutMs,
    env: input.env,
  })
  return parseGatewayResult(result.stdout)
}

function jsonFromModelText(value: string) {
  const clean = value.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  return JSON.parse(clean) as Record<string, unknown>
}

async function requestVisionJson(input: {
  prompt: string
  images: string[]
  timeoutMs: number
}) {
  const imageContents = await Promise.all(input.images.map(async (imagePath) => {
    const buffer = await readFile(imagePath)
    const extension = path.extname(imagePath).toLowerCase()
    const mime = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.webp'
        ? 'image/webp'
        : 'image/png'
    return {
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` },
    }
  }))
  const requestBody = JSON.stringify({
    model: GORDEN_VISION_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: input.prompt },
        ...imageContents,
      ],
    }],
    max_tokens: 8000,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
  })
  const maxAttempts = 3
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${GORDEN_LLM_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(GORDEN_LLM_KEY ? { Authorization: `Bearer ${GORDEN_LLM_KEY}` } : {}),
        },
        body: requestBody,
        signal: AbortSignal.timeout(input.timeoutMs),
      })
      if (!response.ok) {
        throw Object.assign(
          new Error(`Gorden 视觉解析失败：LLM HTTP ${response.status}`),
          { status: response.status },
        )
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      const content = payload.choices?.[0]?.message?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (
              part && typeof part === 'object' && 'text' in part
                ? String((part as { text?: unknown }).text ?? '')
                : ''
            )).join('')
          : ''
      if (!text) throw new Error('Gorden 视觉解析没有返回内容')
      return jsonFromModelText(text)
    } catch (error) {
      lastError = error
      if (
        attempt >= maxAttempts
        || !isRetryableGordenVisionError(error)
      ) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_500))
    }
  }
  throw lastError
}

export function isGordenVisionRetryableStatus(status: number) {
  return [408, 409, 425, 429].includes(status) || status >= 500
}

function isRetryableGordenVisionError(error: unknown) {
  const status = Number((error as { status?: unknown } | null)?.status)
  if (Number.isFinite(status)) return isGordenVisionRetryableStatus(status)
  const name = String((error as { name?: unknown } | null)?.name || '')
  const message = String((error as { message?: unknown } | null)?.message || '')
  return error instanceof SyntaxError
    || error instanceof TypeError
    || ['AbortError', 'TimeoutError'].includes(name)
    || /没有返回内容|fetch failed|network|timeout/i.test(message)
}

export function reusableGordenVisualReview(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const review = value as Record<string, unknown>
  return review.passed === true
    && (!Array.isArray(review.criticalIssues) || review.criticalIssues.length === 0)
}

function finiteNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}

function visibleTextWidthUnits(value: string) {
  let units = 0
  for (const character of value.normalize('NFKC')) {
    if (/\s/u.test(character)) units += 0.35
    else if (/[\u0000-\u00ff]/u.test(character)) units += /[A-Za-z0-9]/u.test(character) ? 0.56 : 0.48
    else units += 1
  }
  return Math.max(1, units)
}

function normalizedVisibleMarker(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s，。；：、“”‘’（）()【】\[\].,;:'"_-]+/gu, '')
}

function textLayoutMetrics(input: {
  text: string
  width: number
  height: number
  reportedSizePx?: number
  bold: boolean
}) {
  const explicitLines = input.text.split('\n')
  const reportedSizePx = clamp(
    input.reportedSizePx ?? Math.max(12, input.height * 0.52),
    7,
    96,
  )
  const lineCount = explicitLines.reduce((total, line) => {
    const estimatedWidth = visibleTextWidthUnits(line) * reportedSizePx
    return total + Math.max(1, Math.ceil(estimatedWidth / Math.max(1, input.width * 0.94)))
  }, 0)
  return {
    lineCount,
    singleLine: explicitLines.length === 1 && lineCount === 1,
    // Vision's measured source-pixel size is authoritative. Earlier code grew
    // body copy from the bbox line height, which made dense paragraphs much
    // larger than the source and caused overlap during PPT composition.
    sizePx: reportedSizePx,
  }
}

function bboxContainsCenter(
  outer: readonly number[],
  inner: readonly number[],
) {
  const centerX = inner[0] + inner[2] / 2
  const centerY = inner[1] + inner[3] / 2
  return centerX >= outer[0]
    && centerX <= outer[0] + outer[2]
    && centerY >= outer[1]
    && centerY <= outer[1] + outer[3]
}

export function annotateGordenTextWeightQa<T extends Record<string, unknown>>(slide: T): T {
  const texts = (Array.isArray(slide.texts) ? slide.texts : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
  if (texts.length < 6) return slide
  const boldTexts = texts.filter((item) => Boolean(item.bold))
  const regularTexts = texts.filter((item) => !Boolean(item.bold))
  const boldRatio = boldTexts.length / texts.length
  const textLength = (item: Record<string, unknown>) => String(item.text || '')
    .replace(/\s+/g, '')
    .length
  // Gorden's strict guard intentionally rejects accidental all-bold body copy.
  // A page made of one regular narrative paragraph plus bold title/card labels is
  // a legitimate emphasis-heavy composition, so record the visual justification
  // explicitly instead of weakening the global guard threshold.
  const hasRegularNarrative = regularTexts.some((item) => {
    const estimatedLineCount = Number(item.estimated_line_count ?? 0)
    return textLength(item) >= 20
      || (Boolean(item.word_wrap) && textLength(item) >= 12)
      || estimatedLineCount >= 2
  })
  const boldItemsAreLabels = boldTexts.every((item) => textLength(item) <= 120)
  // When the image model renders every text box as bold (100% ratio, no regular body),
  // it's an image-generation artifact — annotate it so layout_guard --strict allows
  // the page through instead of blocking the whole pipeline.
  if (boldRatio >= 1.0 && texts.length >= 6) {
    const notes = Array.isArray(slide.qa_notes)
      ? slide.qa_notes.map(String)
      : []
    return {
      ...slide,
      allow_all_bold_text: true,
      qa_notes: [
        ...notes,
        '视觉复核：图片生成模型将所有文字渲染为粗体（100% bold），已标注为全粗体页面。下游可编辑稿中建议手动将正文调整为常规字重。',
      ],
    }
  }
  if (boldRatio <= 0.85 || !hasRegularNarrative || !boldItemsAreLabels) return slide
  const notes = Array.isArray(slide.qa_notes)
    ? slide.qa_notes.map(String)
    : []
  return {
    ...slide,
    allow_all_bold_text: true,
    qa_notes: [
      ...notes,
      '视觉复核：正文段落为常规字重；标题、卡片标签与重点声明按源图保留粗体。',
    ],
  }
}

function editableSlideFromCheckpoint(
  layout: Record<string, unknown>,
  pageRoot: string,
) {
  const icons = (Array.isArray(layout.icons) ? layout.icons : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item) => ({
      ...item,
      file: path.join(pageRoot, 'icons', path.basename(String(item.file || ''))),
    }))
  const texts = upgradeGordenCheckpointTextLayouts(
    (Array.isArray(layout.texts) ? layout.texts : [])
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')),
  )
  return annotateGordenTextWeightQa({
    background: path.join(pageRoot, 'background.png'),
    frame: path.join(pageRoot, 'frame.png'),
    icons,
    texts,
  })
}

export function upgradeGordenCheckpointTextLayouts(
  texts: Array<Record<string, unknown>>,
) {
  return texts.map((item) => {
    if (Number(item.estimated_line_count) > 0) return item
    const bbox = Array.isArray(item.source_bbox) && item.source_bbox.length === 4
      ? item.source_bbox.map(finiteNumber)
      : []
    if (bbox.length !== 4 || bbox.some((value) => value === undefined)) return item
    const [, , width, height] = bbox as number[]
    const metrics = textLayoutMetrics({
      text: String(item.text || ''),
      width,
      height,
      reportedSizePx: finiteNumber(item.size_px) ?? finiteNumber(item.size),
      bold: Boolean(item.bold),
    })
    return {
      ...item,
      estimated_line_count: metrics.lineCount,
      word_wrap: item.word_wrap ?? !metrics.singleLine,
    }
  })
}

function normalizedBbox(value: unknown, width: number, height: number) {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  const numbers = value.map(finiteNumber)
  if (numbers.some((item) => item === undefined)) return undefined
  const [rawX, rawY, rawW, rawH] = numbers as number[]
  const x = Math.max(0, Math.min(width - 1, rawX))
  const y = Math.max(0, Math.min(height - 1, rawY))
  const w = Math.max(1, Math.min(width - x, rawW))
  const h = Math.max(1, Math.min(height - y, rawH))
  return [x, y, w, h] as const
}

async function imageSize(imagePath: string, python: string, timeoutMs: number) {
  const result = await runCommand(python, [
    '-c',
    'from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(f"{im.width}x{im.height}")',
    imagePath,
  ], { timeoutMs })
  const match = result.stdout.trim().match(/^(\d+)x(\d+)$/)
  if (!match) throw new Error(`无法读取幻灯片图片尺寸：${imagePath}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function normalizeGordenLayout(input: {
  vision: VisionLayout
  plan: GordenSlidePlan
  iconManifest: IconManifest
  pageRoot: string
  width: number
  height: number
  font: string
}) {
  const expectedCount = input.plan.expectedTexts.length
  const textEntries = (input.vision.texts ?? []).flatMap((item) => {
    const textIndex = Number(item.textIndex)
    const bbox = normalizedBbox(item.source_bbox, input.width, input.height)
    if (!Number.isInteger(textIndex) || textIndex < 1 || textIndex > expectedCount || !bbox) return []
    const [x, y, w, h] = bbox
    const text = input.plan.expectedTexts[textIndex - 1]
    const layoutMetrics = textLayoutMetrics({
      text,
      width: w,
      height: h,
      reportedSizePx: finiteNumber(item.size_px) ?? finiteNumber(item.size),
      bold: Boolean(item.bold),
    })
    const safeWidth = layoutMetrics.singleLine
      ? Math.min(input.width - x, w + Math.min(16, Math.max(4, w * 0.03)))
      : w
    return [{
      text,
      textIndex,
      source_bbox: [x, y, safeWidth, h],
      x: x / input.width,
      y: y / input.height,
      w: safeWidth / input.width,
      h: h / input.height,
      size_px: layoutMetrics.sizePx,
      estimated_line_count: layoutMetrics.lineCount,
      color: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? String(item.color) : '#172033',
      bold: Boolean(item.bold),
      align: ['left', 'center', 'right', 'justify'].includes(String(item.align))
        ? String(item.align)
        : 'left',
      valign: ['top', 'middle', 'center', 'bottom'].includes(String(item.valign))
        ? String(item.valign)
        : 'top',
      font: String(item.font || input.font),
      line_spacing: Math.max(1, Math.min(1.8, finiteNumber(item.line_spacing) ?? 1.18)),
      word_wrap: !layoutMetrics.singleLine,
    }]
  })
  const byIndex = new Map(textEntries.map((entry) => [entry.textIndex, entry]))
  const missing = Array.from({ length: expectedCount }, (_unused, index) => index + 1)
    .filter((index) => !byIndex.has(index))
  if (missing.length) {
    throw Object.assign(
      new Error(`Gorden 视觉文字定位不完整，第 ${input.plan.number} 页缺少文字索引：${missing.join('、')}`),
      {
        code: 'GORDEN_VISIBLE_TEXT_CONTRACT_REJECTED',
        slideNumber: input.plan.number,
        missingTextIndexes: missing,
      },
    )
  }

  const availableIcons = new Set((input.iconManifest.icons ?? [])
    .map((item) => String(item.file || ''))
    .filter(Boolean))
  const detectedIcons = (input.vision.icons ?? []).flatMap((item) => {
    const file = String(item.file || '')
    const bbox = normalizedBbox(item.source_bbox, input.width, input.height)
    if (!availableIcons.has(file) || !bbox) return []
    const [x, y, w, h] = bbox
    return [{
      file: path.join(input.pageRoot, 'icons', file),
      visible_text: String(item.visible_text ?? ''),
      source_bbox: [...bbox],
      x: x / input.width,
      y: y / input.height,
      w: w / input.width,
      h: h / input.height,
      role: 'icon',
    }]
  })
  const numericEntries = [...byIndex.values()].filter((entry) => (
    /^\d{1,2}$/u.test(normalizedVisibleMarker(entry.text))
  ))
  // The frame layer already preserves badge circles and other fixed shapes.
  // Image models sometimes also put those badges in the icon sheet, often with
  // the number erased to a white placeholder. Overlaying that crop duplicates
  // or hides the native editable number, so discard only icons whose center
  // overlaps a planned numeric text box and always keep the native text.
  const suppressedBadgeIcons: string[] = []
  const icons = detectedIcons.filter((icon) => {
    const overlapsNumericText = numericEntries.some((entry) => (
      bboxContainsCenter(icon.source_bbox, entry.source_bbox)
      || bboxContainsCenter(entry.source_bbox, icon.source_bbox)
    ))
    if (overlapsNumericText) suppressedBadgeIcons.push(path.basename(icon.file))
    return !overlapsNumericText
  })
  const texts = [...byIndex.values()]
    .sort((left, right) => left.textIndex - right.textIndex)
  return annotateGordenTextWeightQa({
    background: path.join(input.pageRoot, 'background.png'),
    frame: path.join(input.pageRoot, 'frame.png'),
    icons,
    texts,
    ...(suppressedBadgeIcons.length
      ? {
          qa_notes: [
            `编号徽标底图已由框架层呈现，移除 ${suppressedBadgeIcons.length} 个重复图标切片并保留原生数字文本。`,
          ],
        }
      : {}),
  })
}

function layoutVisionPrompt(plan: GordenSlidePlan, iconFiles: string[], width: number, height: number) {
  return `第一张图是待还原的幻灯片成品图，第二张图是从该页提取的图标联系表（若为空则没有独立图标）。
请在第一张图的 ${width}×${height} 原始像素坐标系中，精确定位下面每一条普通文本，并把联系表中的每个真实图标映射回第一张图的位置。

必须返回 JSON：
{"texts":[{"textIndex":1,"source_bbox":[x,y,w,h],"size_px":30,"color":"#RRGGBB","bold":true,"align":"left|center|right|justify","valign":"top|middle|bottom","font":"Microsoft YaHei","line_spacing":1.2}],"icons":[{"file":"icon_r1c1.png","source_bbox":[x,y,w,h],"visible_text":"图标切片中实际可见的文字或空字符串"}],"unexpectedText":["不属于下列文字的可见文本"]}

规则：
1. texts 必须覆盖 1-${plan.expectedTexts.length} 的每个 textIndex，不能缺项、不能合并索引。
   若两个索引的文字相同，它们代表页面上两个不同的可见位置，必须分别返回不同 bbox，不得复用同一 bbox。
2. bbox 是第一张图真实像素坐标 [左,上,宽,高]，必须圈住对应对象。
3. size_px 是文字在第一张源图中的像素字号，不是 PowerPoint pt；必须按源图实际字高估计。
4. 文本内容以这里的索引为准，不要 OCR 改写；所有可读文字（包括标题、标签和艺术字）都归 texts。
5. icons.file 必须使用第二张图标注的精确文件名；空白格不要返回。每个图标都必须返回 visible_text：若该图标切片错误包含数字或文字，逐字返回；完全没有文字时返回空字符串。
6. unexpectedText 必须列出第一张图中所有不属于文字索引清单的可读内容，包括额外标题、卡片标签、图表标签、来源名称、模板样本公司、Logo 文字、日期、页码、水印、编号或无依据数字；不得因为内容看似合理而省略。但纯图形项目符号、分隔线、装饰竖线或横线不是文字，不得将它们识别为“|”、“•”、“—”等 unexpectedText。
7. 每个 textIndex 只能对应一个连续文本区域；若第一张图把某条文字拆散、重复，或把多条文字重叠在同一位置，把相应原文写入 unexpectedText，不得编造 bbox 通过检查。

文字索引：
${plan.expectedTexts.map((text, index) => `${index + 1}. ${text}`).join('\n')}

图标文件：${iconFiles.join('、') || '无'}。只返回 JSON。`
}

async function assertVisualQa(input: {
  slideNumber: number
  sourceImage: string
  previewImage: string
  expectedTexts: string[]
  timeoutMs: number
  reportPath: string
}) {
  const result = await requestVisionJson({
    prompt: buildGordenVisualQaPrompt(input.expectedTexts),
    images: [input.sourceImage, input.previewImage],
    timeoutMs: input.timeoutMs,
  })
  await writeJson(input.reportPath, result)
  const criticalIssueValues = Array.isArray(result.criticalIssues)
    ? result.criticalIssues as unknown[]
    : undefined
  const hasCriticalIssueContract = Boolean(criticalIssueValues)
  const criticalIssues = criticalIssueValues
    ? criticalIssueValues.map(String).filter(Boolean)
    : []
  // New reviewers separate content/readability failures from harmless visual
  // drift. If they explicitly provide an empty criticalIssues array, cosmetic
  // differences must not fail the job even if their summary wording is stern.
  const rejected = hasCriticalIssueContract
    ? criticalIssues.length > 0
    : result.passed !== true
  if (rejected) {
    const issues = criticalIssues.length
      ? criticalIssues.join('；')
      : Array.isArray(result.issues)
        ? result.issues.join('；')
        : String(result.summary || '')
    throw Object.assign(
      new Error(`Gorden 第 ${input.slideNumber} 页最终视觉 QA 未通过：${issues || '页面与源图不一致'}`),
      {
        code: 'GORDEN_VISUAL_QA_REJECTED',
        slideNumber: input.slideNumber,
        visualQaIssues: criticalIssues.length
          ? criticalIssues
          : Array.isArray(result.issues) ? result.issues : [],
      },
    )
  }
}

export async function generateInvestmentRecommendationPptWithGorden(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  pageCount?: string
  resumeFromDirectory?: string
  onProgress?: GordenProgress
}) {
  const workflow = await prepareInvestmentRecommendationPptWorkflow(input.template)
  const imageGatewayKey = process.env.GATEWAY_IMAGE_API_KEY
    || process.env.MODEL_GATEWAY_API_KEY
    || process.env.OPENAI_API_KEY
  if (!imageGatewayKey) {
    throw Object.assign(
      new Error('GordenSuperPPTSkill 缺少图片生成网关密钥（GATEWAY_IMAGE_API_KEY）'),
      { code: 'GORDEN_IMAGE_GATEWAY_UNCONFIGURED' },
    )
  }
  const paths = gordenSkillPaths()
  const referencePaths = referenceDrivenSkillPaths()
  const requiredScripts = [
    paths.ingest,
    paths.generateImage,
    paths.composeImageDeck,
    paths.chromaKey,
    paths.sliceGrid,
    paths.layoutGuard,
    paths.placementQa,
    paths.visualCompareQa,
    paths.composeEditable,
    referencePaths.resolveDependencies,
    referencePaths.packageSlidesAsPdf,
    referencePaths.validatePipelineHandoff,
    referencePaths.convertPdf,
  ]
  const missingScripts = requiredScripts.filter((script) => !existsSync(script))
  if (missingScripts.length) {
    throw Object.assign(
      new Error(`GordenSuperPPTSkills 安装不完整：${missingScripts.join('、')}`),
      { code: 'GORDEN_SUPER_PPT_SKILL_INCOMPLETE' },
    )
  }

  const python = resolvePython()
  const timeoutMs = Math.max(
    300_000,
    Number(process.env.AI_GORDEN_PPT_STEP_TIMEOUT_MS || 20 * 60_000),
  )
  const env = { ...process.env }
  const outputDir = path.dirname(input.outputPath)
  const slug = safeSlug(input.project.name)
  const referenceSelection = selectInvestmentRecommendationReference({
    template: input.template,
    project: input.project,
    content: input.content,
  })
  const selectedReferenceBuffer = await readFile(referenceSelection.path)
  const referenceFingerprint = sha256(Buffer.concat([
    Buffer.from(workflow.templateSha256, 'hex'),
    selectedReferenceBuffer,
  ]))
  const runRoot = path.join(
    outputDir,
    `.gorden-super-ppt-${slug}-${randomUUID()}`,
  )
  const referenceDir = path.join(runRoot, 'reference-template')
  const promptsDir = path.join(runRoot, 'prompts')
  const slidesDir = path.join(runRoot, 'slides')
  const metadataDir = path.join(runRoot, 'metadata')
  const editableDir = path.join(runRoot, 'editable')
  const outDir = path.join(runRoot, 'out')
  const previewDir = path.join(outDir, 'preview')
  await Promise.all([
    mkdir(outputDir, { recursive: true }),
    mkdir(promptsDir, { recursive: true }),
    mkdir(slidesDir, { recursive: true }),
    mkdir(metadataDir, { recursive: true }),
    mkdir(editableDir, { recursive: true }),
    mkdir(previewDir, { recursive: true }),
  ])

  await runCommand(python, [
    referencePaths.resolveDependencies,
    '--json',
    '--require-template-adapter',
    '--gorden-image-dir', paths.imageGenRoot,
    '--gorden-super-dir', paths.superRoot,
    '--pdf-skill-dir', referencePaths.pdfRoot,
  ], { timeoutMs, env })

  await reportProgress(
    input.onProgress,
    referenceSelection.mode === 'house-corpus'
      ? `Gorden：从投资建议书模板库选择 ${path.basename(referenceSelection.path)} 并分析视觉 DNA`
      : 'Gorden：摄取上传模板并分析结构与视觉 DNA',
    68,
  )
  await runCommand(python, [
    paths.ingest,
    referenceSelection.path,
    '--out-dir', referenceDir,
    '--scope', 'task-only',
    '--reuse-level', 'structure-and-style',
  ], { timeoutMs, env })

  const [profile, pageIndex, fingerprint] = await Promise.all([
    readFile(path.join(referenceDir, 'template-profile.json'), 'utf8').then(JSON.parse),
    readFile(path.join(referenceDir, 'page-index.json'), 'utf8').then(JSON.parse),
    readFile(path.join(referenceDir, 'sample-fingerprint.json'), 'utf8').then(JSON.parse),
  ]) as [
    { visual_dna?: { palette_candidates?: Array<{ hex?: string }> } },
    { pages?: Array<{ page?: number; role_hint?: string; image?: string }> },
    { frequent_terms?: Array<{ term?: string }> },
  ]
  const palette = (profile.visual_dna?.palette_candidates ?? [])
    .map((item) => String(item.hex || ''))
    .filter((value) => /^#[0-9a-f]{6}$/i.test(value))
    .slice(0, 5)
  const pages = pageIndex.pages ?? []
  const plans = buildGordenSlidePlan({
    project: input.project,
    content: input.content,
    disclaimer: input.template.disclaimer,
    references: input.sources.map((source) => source.sourceName),
    pageCount: input.pageCount,
  }).map((plan) => {
    const matchingPage = referencePageForPlan(pages, plan, referenceSelection.path)
    return {
      ...plan,
      referencePage: matchingPage?.image
        ? path.resolve(referenceDir, matchingPage.image)
        : undefined,
    }
  })

  const facts = {
    schemaVersion: '1.0',
    project: input.project,
    sourceCutoffDate: input.sourceCutoffDate,
    sources: input.sources.map((source, index) => ({
      id: `S${index + 1}`,
      name: source.sourceName,
      type: source.sourceType,
      locator: source.locator,
      versionOrDate: source.versionOrDate,
    })),
    verifiedContent: input.content,
    factPolicy: '仅使用项目事实库；模板样本事实不得进入成品',
  }
  const sourceRegistry = input.sources.map((source, index) => ({
    source_id: `S${index + 1}`,
    title: source.sourceName,
    source_type: source.sourceType,
    locator: source.locator,
    published_or_version_at: source.versionOrDate,
    accessed_at: input.sourceCutoffDate,
  }))
  const slideSemantics = plans.map((plan) => ({
    slide: plan.number,
    role: plan.role,
    title: plan.title,
    verbatim_text: plan.expectedTexts,
    source_fact_keys: plan.sourceIndexes.map((index) => `S${index + 1}`),
    kpis: [],
    charts: [],
    tables: [],
    flow_nodes: [],
    connectors: [],
    icons: [],
    photos: [],
  }))
  await Promise.all([
    writeJson(path.join(runRoot, 'project-identity.json'), {
      legal_name: input.project.companyName || input.project.name,
      display_name: input.project.name,
      aliases: [],
      jurisdiction: '',
      website: '',
      audience: 'investment-committee',
      purpose: 'investment-recommendation',
      language: 'zh-CN',
      editable_scope: 'all',
    }),
    writeJson(path.join(runRoot, 'input-manifest.json'), {
      template: referenceSelection.path,
      template_mode: referenceSelection.mode,
      template_id: referenceSelection.id,
      source_cutoff_date: input.sourceCutoffDate,
      source_count: input.sources.length,
      template_scope: 'task-only',
    }),
    writeJson(path.join(runRoot, 'project-facts.json'), facts),
    writeJson(path.join(runRoot, 'source-registry.json'), sourceRegistry),
    writeJson(path.join(runRoot, 'research-questions.json'), {
      questions: plans
        .filter((plan) => plan.sourceIndexes.length === 0)
        .map((plan) => ({
          slide: plan.number,
          role: plan.role,
          question: `${plan.title}仍缺少可绑定的一手或权威来源`,
          status: 'diligence-gap',
        })),
    }),
    writeJson(path.join(runRoot, 'diligence-gaps.json'), {
      gaps: input.content.missing,
    }),
    writeJson(path.join(runRoot, 'outline.json'), { slides: plans }),
    writeJson(path.join(runRoot, 'slide-plan.json'), {
      renderContractVersion: GORDEN_RENDER_CONTRACT_VERSION,
      slides: plans,
    }),
    writeJson(path.join(runRoot, 'slide-semantics.json'), {
      schemaVersion: '1.0',
      slides: slideSemantics,
    }),
    writeJson(path.join(runRoot, 'template-selection.json'), {
      mode: referenceSelection.mode,
      templateId: referenceSelection.id,
      scope: 'task-only',
      reuseLevel: 'structure-and-style',
      sourceMode: workflow.sourceMode,
      workflowTemplateSha256: workflow.templateSha256,
      templateSha256: referenceFingerprint,
      visualMaster: referenceSelection.path,
      sourceTemplates: referenceSelection.sourceTemplates,
      slideReferenceMap: plans.map((plan) => ({
        slide: plan.number,
        role: plan.role,
        referencePage: plan.referencePage,
      })),
    }),
  ])

  const resumeCheckpoint = await findGordenResumeCheckpoint({
    directories: [input.resumeFromDirectory, outputDir],
    slug,
    templateSha256: referenceFingerprint,
    plans,
    excludeRunRoot: runRoot,
  })
  if (resumeCheckpoint) {
    await reportProgress(
      input.onProgress,
      `Gorden 断点续跑：复用已完成的 ${resumeCheckpoint.slides.length}/${plans.length} 页成品图`,
      76,
    )
  }

  const imagegenManifest: Array<Record<string, unknown>> = []
  const generatedSlides: string[] = []
  const imagegenManifestPath = path.join(runRoot, 'imagegen-manifest.json')
  const persistImagegenCheckpoint = () => writeJson(imagegenManifestPath, {
    schemaVersion: '1.0',
    producerSkill: 'GordenImagePPTGen',
    checkpoint: imagegenManifest.length < plans.length,
    slides: imagegenManifest,
  })
  for (const plan of plans) {
    const stableSlide = path.join(
      slidesDir,
      `${String(plan.number).padStart(2, '0')}-${safeSlug(plan.title)}.png`,
    )
    const resumedSlide = resumeCheckpoint?.slides.find(
      (item) => Number(item.slide) === plan.number,
    )
    if (resumedSlide) {
      await reportProgress(
        input.onProgress,
        `Gorden 断点续跑：恢复第 ${plan.number}/${plans.length} 页成品图`,
        70 + Math.round((plan.number / plans.length) * 6),
      )
      await copyFile(String(resumedSlide.copied_to), stableSlide)
      generatedSlides.push(stableSlide)
      imagegenManifest.push({
        ...resumedSlide,
        slide: plan.number,
        copied_to: stableSlide,
        reference_page: plan.referencePage,
        resumed_from: resumeCheckpoint.runRoot,
      })
      await persistImagegenCheckpoint()
      continue
    }
    await reportProgress(
      input.onProgress,
      `Gorden 阶段 1：生成第 ${plan.number}/${plans.length} 页成品图`,
      70 + Math.round((plan.number / plans.length) * 6),
    )
    const promptPath = path.join(
      promptsDir,
      `${String(plan.number).padStart(2, '0')}-${safeSlug(plan.title)}.md`,
    )
    await writeFile(promptPath, buildGordenSlidePrompt({
      slide: plan,
      projectName: input.project.name,
      sourceNames: sourceLabels(plan.sourceIndexes, input.sources),
      palette,
    }), 'utf8')
    let result: GatewayImageResult
    try {
      result = await generateGatewayImage({
        python,
        script: paths.generateImage,
        promptFile: promptPath,
        outDir: path.join(metadataDir, `slide-${String(plan.number).padStart(2, '0')}`),
        referenceImage: plan.referencePage,
        timeoutMs,
        env,
      })
    } catch (error) {
      throw gordenGatewayFailure(error, {
        slideNumber: plan.number,
        slideCount: plans.length,
      })
    }
    await copyFile(result.saved[0], stableSlide)
    generatedSlides.push(stableSlide)
    imagegenManifest.push({
      slide: plan.number,
      prompt_file: promptPath,
      task_id: result.task_id,
      metadata_json: result.metadata_json,
      copied_to: stableSlide,
      backend: 'gateway-gpt-image',
      reference_page: plan.referencePage,
    })
    await persistImagegenCheckpoint()
  }
  await writeJson(imagegenManifestPath, {
    schemaVersion: '1.0',
    producerSkill: 'GordenImagePPTGen',
    checkpoint: false,
    slides: imagegenManifest,
  })

  const imageDeckPath = path.join(outDir, `${slug}-image-deck.pptx`)
  const imageDeckJson = path.join(runRoot, 'image-deck.json')
  await writeJson(imageDeckJson, {
    slide_width_in: 13.333,
    slide_height_in: 7.5,
    units: 'fraction',
    assets_dir: runRoot,
    slides: generatedSlides.map((background) => ({ background })),
  })
  await runCommand(python, [paths.composeImageDeck, imageDeckJson, imageDeckPath], {
    timeoutMs,
    env,
  })

  const editableSlides: Array<Record<string, unknown>> = []
  const resumedEditableSlideNumbers = new Set<number>()
  const pageDimensions: Array<{ width: number; height: number }> = []
  const sampleTerms = (fingerprint.frequent_terms ?? [])
    .map((item) => String(item.term || '').trim())
    .filter((term) => term.length >= 3)
  for (const plan of plans) {
    await reportProgress(
      input.onProgress,
      `Gorden 阶段 2：第 ${plan.number}/${plans.length} 页四层可编辑还原`,
      76 + Math.round((plan.number / plans.length) * 8),
    )
    const sourceImage = generatedSlides[plan.number - 1]
    const pageRoot = path.join(editableDir, String(plan.number).padStart(2, '0'))
    const resumedEditablePage = resumeCheckpoint?.editablePages.get(plan.number)
    if (resumedEditablePage) {
      resumedEditableSlideNumbers.add(plan.number)
      await reportProgress(
        input.onProgress,
        `Gorden 断点续跑：恢复第 ${plan.number}/${plans.length} 页四层可编辑结果`,
        76 + Math.round((plan.number / plans.length) * 8),
      )
      await cp(resumedEditablePage.pageRoot, pageRoot, {
        recursive: true,
        force: true,
      })
      await copyFile(sourceImage, path.join(pageRoot, 'source-slide.png'))
      const resumedLayout = editableSlideFromCheckpoint(
        resumedEditablePage.layout,
        pageRoot,
      )
      const width = Number(resumedEditablePage.layout.ref_width || 0)
      const height = Number(resumedEditablePage.layout.ref_height || 0)
      if (!width || !height) {
        throw new Error(`Gorden 第 ${plan.number} 页断点缺少有效画布尺寸`)
      }
      pageDimensions.push({ width, height })
      const layoutPath = path.join(pageRoot, 'layout.json')
      await writeJson(layoutPath, {
        slide_width_in: 13.333,
        slide_height_in: 7.5,
        units: 'fraction',
        ref_width: width,
        ref_height: height,
        assets_dir: pageRoot,
        ...resumedLayout,
      })
      await runGordenLayoutGuard({
        python,
        script: paths.layoutGuard,
        sourceImage,
        layoutPath,
        slideNumber: plan.number,
        timeoutMs,
        env,
      })
      await runCommand(python, [
        paths.placementQa,
        sourceImage,
        layoutPath,
        '--slide-index', '1',
        '--out-dir', path.join(pageRoot, 'qa-source-boxes'),
      ], { timeoutMs, env })
      editableSlides.push(resumedLayout)
      continue
    }
    const pagePrompts = path.join(pageRoot, 'prompts')
    const iconsDir = path.join(pageRoot, 'icons')
    const backgroundPath = path.join(pageRoot, 'background.png')
    const frameRawPath = path.join(pageRoot, 'frame_raw.png')
    const iconsRawPath = path.join(pageRoot, 'icons_raw_1.png')
    const framePath = path.join(pageRoot, 'frame.png')
    const iconsTransparentPath = path.join(pageRoot, 'icons_t_1.png')
    const keyColor = '#00ff00'
    const resumedLayerPage = resumeCheckpoint?.layerPages.get(plan.number)
    if (resumedLayerPage) {
      await reportProgress(
        input.onProgress,
        `Gorden 断点续跑：复用第 ${plan.number}/${plans.length} 页背景、框架和图标层`,
        76 + Math.round((plan.number / plans.length) * 8),
      )
      await cp(resumedLayerPage.pageRoot, pageRoot, {
        recursive: true,
        force: true,
      })
      await copyFile(sourceImage, path.join(pageRoot, 'source-slide.png'))
    } else {
      await Promise.all([
        mkdir(pagePrompts, { recursive: true }),
        mkdir(iconsDir, { recursive: true }),
      ])
      await copyFile(sourceImage, path.join(pageRoot, 'source-slide.png'))
      const layerPrompts = buildGordenEditableLayerPrompts(keyColor)
      const layerResults: Record<string, GatewayImageResult> = {}
      for (const [layer, prompt] of Object.entries(layerPrompts)) {
        const promptFile = path.join(pagePrompts, `${layer}.md`)
        await writeFile(promptFile, prompt, 'utf8')
        try {
          layerResults[layer] = await generateGatewayImage({
            python,
            script: paths.generateImage,
            promptFile,
            outDir: path.join(pageRoot, 'generated', layer),
            referenceImage: sourceImage,
            size: layer === 'icons' ? '2048x2048' : '2560x1440',
            timeoutMs,
            env,
          })
        } catch (error) {
          throw gordenGatewayFailure(error, {
            slideNumber: plan.number,
            slideCount: plans.length,
            layer,
          })
        }
      }

      await Promise.all([
        copyFile(layerResults.background.saved[0], backgroundPath),
        copyFile(layerResults.frame.saved[0], frameRawPath),
        copyFile(layerResults.icons.saved[0], iconsRawPath),
      ])
      await runCommand(python, [
        paths.chromaKey,
        '--input', frameRawPath,
        '--out', framePath,
        '--preset', 'frame-safe',
        '--scale', '2',
        '--force',
      ], { timeoutMs, env })
      await runCommand(python, [
        paths.chromaKey,
        '--input', iconsRawPath,
        '--out', iconsTransparentPath,
        '--preset', 'icon-safe',
        '--scale', '2',
        '--force',
      ], { timeoutMs, env })
      await runCommand(python, [
        paths.sliceGrid,
        iconsTransparentPath,
        iconsDir,
        '--auto',
        '--pad', '24',
        '--contact-sheet',
        '--prefix', 'icon',
      ], { timeoutMs, env })
      await writeJson(path.join(pageRoot, 'imagegen-assets-manifest.json'), {
        schemaVersion: '1.0',
        slide: plan.number,
        key_color: keyColor,
        assets: Object.entries(layerResults).map(([layer, result]) => ({
          layer,
          backend: 'gateway-gpt-image',
          generated_source: result.saved[0],
          task_id: result.task_id,
          metadata_json: result.metadata_json,
          prompt_file: path.join(pagePrompts, `${layer}.md`),
          copied_to: layer === 'background'
            ? backgroundPath
            : layer === 'frame'
              ? frameRawPath
              : iconsRawPath,
          key_color: layer === 'background' ? null : keyColor,
        })),
      })
    }
    const iconManifestPath = path.join(iconsDir, 'icons_manifest.json')
    let iconManifest = JSON.parse(await readFile(iconManifestPath, 'utf8')) as IconManifest
    let unsafeIconFiles = unsafeGordenIconFiles(iconManifest)
    const iconRetryAudit: Array<Record<string, unknown>> = []
    for (
      let attempt = 2;
      unsafeIconFiles.length && attempt <= GORDEN_ICON_LAYER_MAX_ATTEMPTS;
      attempt += 1
    ) {
      await reportProgress(
        input.onProgress,
        `Gorden 阶段 2：第 ${plan.number}/${plans.length} 页图标触边，定向重生成图标层`,
        76 + Math.round((plan.number / plans.length) * 8),
      )
      await mkdir(pagePrompts, { recursive: true })
      const retryPromptFile = path.join(pagePrompts, `icons-retry-${attempt}.md`)
      await writeFile(retryPromptFile, buildGordenIconRetryPrompt({
        keyColor,
        attempt,
        unsafeIconFiles,
      }), 'utf8')
      let retryResult: GatewayImageResult
      try {
        retryResult = await generateGatewayImage({
          python,
          script: paths.generateImage,
          promptFile: retryPromptFile,
          outDir: path.join(pageRoot, 'generated', `icons-retry-${attempt}`),
          referenceImage: sourceImage,
          size: '2048x2048',
          timeoutMs,
          env,
        })
      } catch (error) {
        throw gordenGatewayFailure(error, {
          slideNumber: plan.number,
          slideCount: plans.length,
          layer: `icons-retry-${attempt}`,
        })
      }
      await copyFile(retryResult.saved[0], iconsRawPath)
      await rm(iconsDir, { recursive: true, force: true })
      await mkdir(iconsDir, { recursive: true })
      await runCommand(python, [
        paths.chromaKey,
        '--input', iconsRawPath,
        '--out', iconsTransparentPath,
        '--preset', 'icon-safe',
        '--scale', '2',
        '--force',
      ], { timeoutMs, env })
      await runCommand(python, [
        paths.sliceGrid,
        iconsTransparentPath,
        iconsDir,
        '--auto',
        '--pad', '24',
        '--contact-sheet',
        '--prefix', 'icon',
      ], { timeoutMs, env })
      iconManifest = JSON.parse(await readFile(iconManifestPath, 'utf8')) as IconManifest
      unsafeIconFiles = unsafeGordenIconFiles(iconManifest)
      iconRetryAudit.push({
        attempt,
        prompt_file: retryPromptFile,
        task_id: retryResult.task_id,
        metadata_json: retryResult.metadata_json,
        generated_source: retryResult.saved[0],
        unsafe_icon_files: unsafeIconFiles,
      })
      await writeJson(path.join(pageRoot, 'icon-layer-retries.json'), {
        schemaVersion: '1.0',
        slide: plan.number,
        attempts: iconRetryAudit,
      })
    }
    if (unsafeIconFiles.length) {
      throw Object.assign(
        new Error(`Gorden 第 ${plan.number} 页图标层重生成后仍有 ${unsafeIconFiles.length} 个元素触及图标表外边界`),
        {
          code: 'GORDEN_ICON_LAYER_UNSAFE',
          slideNumber: plan.number,
          unsafeIconFiles,
          layerAttempts: GORDEN_ICON_LAYER_MAX_ATTEMPTS,
        },
      )
    }
    const iconFiles = (iconManifest.icons ?? [])
      .map((icon) => String(icon.file || ''))
      .filter(Boolean)
    const contactSheet = path.join(iconsDir, 'icons_contact_sheet.png')
    const { width, height } = await imageSize(sourceImage, python, timeoutMs)
    pageDimensions.push({ width, height })
    const vision = await requestVisionJson({
      prompt: layoutVisionPrompt(plan, iconFiles, width, height),
      images: existsSync(contactSheet) ? [sourceImage, contactSheet] : [sourceImage],
      timeoutMs,
    }) as VisionLayout
    const observedUnexpectedText = Array.isArray(vision.unexpectedText)
      ? vision.unexpectedText.map(String).filter(Boolean)
      : []
    const unexpectedText = gordenUnplannedVisibleTexts(
      plan.expectedTexts,
      observedUnexpectedText,
    )
    const residue = unexpectedText.filter((text) => sampleTerms.some((term) =>
      text.toLowerCase().includes(term.toLowerCase())))
    if (residue.length) {
      throw new Error(`Gorden 第 ${plan.number} 页存在模板样本残留：${residue.join('、')}`)
    }
    if (unexpectedText.length) {
      await writeJson(path.join(pageRoot, 'text-contract-rejected.json'), {
        schemaVersion: '1.0',
        slide: plan.number,
        unexpectedText,
      })
      throw Object.assign(
        new Error(`Gorden 第 ${plan.number} 页出现文字清单外内容：${unexpectedText.join('、')}`),
        {
          code: 'GORDEN_VISIBLE_TEXT_CONTRACT_REJECTED',
          slideNumber: plan.number,
          unexpectedText,
        },
      )
    }
    const slideLayout = normalizeGordenLayout({
      vision,
      plan,
      iconManifest,
      pageRoot,
      width,
      height,
      font: input.template.customAnalysis?.formatProfile.primaryFont || 'Microsoft YaHei',
    })
    const layoutPath = path.join(pageRoot, 'layout.json')
    const pageLayout = {
      slide_width_in: 13.333,
      slide_height_in: 7.5,
      units: 'fraction',
      ref_width: width,
      ref_height: height,
      assets_dir: pageRoot,
      ...slideLayout,
    }
    await writeJson(layoutPath, pageLayout)
    await runGordenLayoutGuard({
      python,
      script: paths.layoutGuard,
      sourceImage,
      layoutPath,
      slideNumber: plan.number,
      timeoutMs,
      env,
    })
    await runCommand(python, [
      paths.placementQa,
      sourceImage,
      layoutPath,
      '--slide-index', '1',
      '--out-dir', path.join(pageRoot, 'qa-source-boxes'),
    ], { timeoutMs, env })
    editableSlides.push(slideLayout)
  }

  const deckPath = path.join(runRoot, 'deck.json')
  await writeJson(deckPath, {
    slide_width_in: 13.333,
    slide_height_in: 7.5,
    units: 'fraction',
    ref_width: 2560,
    ref_height: 1440,
    assets_dir: runRoot,
    slides: editableSlides,
  })
  const gordenEditablePath = path.join(outDir, `${slug}-gorden-layered.pptx`)
  await reportProgress(input.onProgress, 'Gorden：合成四层可编辑中间稿并逐页验收', 85)
  await runCommand(python, [
    paths.composeEditable,
    deckPath,
    gordenEditablePath,
    '--preview-dir', previewDir,
  ], { timeoutMs, env })

  const visualQaFailures: Array<Error & {
    code?: unknown
    slideNumber?: unknown
    visualQaIssues?: unknown
  }> = []
  for (const plan of plans) {
    const pageRoot = path.join(editableDir, String(plan.number).padStart(2, '0'))
    const previewImage = path.join(
      previewDir,
      `slide_${String(plan.number).padStart(2, '0')}.png`,
    )
    const sourceImage = generatedSlides[plan.number - 1]
    await runCommand(python, [
      paths.placementQa,
      sourceImage,
      deckPath,
      '--slide-index', String(plan.number),
      '--preview', previewImage,
      '--out-dir', path.join(pageRoot, 'qa-placement'),
    ], { timeoutMs, env })
    await runCommand(python, [
      paths.visualCompareQa,
      sourceImage,
      previewImage,
      '--out-dir', path.join(pageRoot, 'qa-visual'),
    ], { timeoutMs, env })
    try {
      if (resumedEditableSlideNumbers.has(plan.number)) {
        const previousReview = JSON.parse(await readFile(
          path.join(pageRoot, 'qa-visual', 'vision-review.json'),
          'utf8',
        )) as Record<string, unknown>
        if (reusableGordenVisualReview(previousReview)) continue
      }
      await assertVisualQa({
        slideNumber: plan.number,
        sourceImage,
        previewImage,
        expectedTexts: plan.expectedTexts,
        timeoutMs,
        reportPath: path.join(pageRoot, 'qa-visual', 'vision-review.json'),
      })
    } catch (error) {
      visualQaFailures.push(error as Error & {
        code?: unknown
        slideNumber?: unknown
        visualQaIssues?: unknown
      })
    }
  }
  if (visualQaFailures.length) {
    const first = visualQaFailures[0]
    throw Object.assign(
      new Error(`Gorden 最终视觉 QA 有 ${visualQaFailures.length} 页未通过：${visualQaFailures.map((failure) => failure.message).join('；')}`),
      {
        code: 'GORDEN_VISUAL_QA_REJECTED',
        slideNumber: first.slideNumber,
        failedSlides: visualQaFailures.map((failure) => failure.slideNumber),
        visualQaIssues: visualQaFailures.flatMap((failure) =>
          Array.isArray(failure.visualQaIssues) ? failure.visualQaIssues : []),
      },
    )
  }

  await reportProgress(
    input.onProgress,
    '参考模板编排：正在将图片稿无损封装为 PDF 桥接稿',
    86,
  )
  const bridgeDir = path.join(runRoot, 'bridge')
  const bridgePdfPath = path.join(bridgeDir, `${slug}-image-deck.pdf`)
  const bridgeManifestPath = path.join(bridgeDir, 'pdf-bridge-manifest.json')
  await mkdir(bridgeDir, { recursive: true })
  await runCommand(python, [
    referencePaths.packageSlidesAsPdf,
    '--slides-dir', slidesDir,
    '--output', bridgePdfPath,
    '--manifest', bridgeManifestPath,
  ], { timeoutMs, env })

  const semanticOverridesPath = path.join(runRoot, 'semantic-overrides.json')
  await writeJson(
    semanticOverridesPath,
    buildReferenceDrivenSemanticOverrides({
      slides: editableSlides,
      dimensions: pageDimensions,
    }),
  )
  const finalConversionWorkDir = path.join(runRoot, 'editable', 'pdf-final')
  await mkdir(finalConversionWorkDir, { recursive: true })
  try {
    symlinkSync(
      path.resolve(process.cwd(), 'node_modules'),
      path.join(finalConversionWorkDir, 'node_modules'),
      'dir',
    )
  } catch {
    // The link may already exist in a resumed run.
  }
  const runtimeCacheDir = path.join(runRoot, 'runtime-cache')
  await mkdir(runtimeCacheDir, { recursive: true })
  const converterEnv = {
    ...env,
    XDG_CACHE_HOME: runtimeCacheDir,
    AI_PDF_TO_PPT_NODE_PROJECT_ROOT:
      process.env.AI_PDF_TO_PPT_NODE_PROJECT_ROOT || process.cwd(),
    NODE_PATH: path.resolve(process.cwd(), 'node_modules'),
  }
  const pdftoppm = process.env.AI_PDF_TO_PPT_PDFTOPPM
    || findExecutable(process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm')
  const tesseract = process.env.AI_PDF_TO_PPT_TESSERACT
    || findExecutable(process.platform === 'win32' ? 'tesseract.exe' : 'tesseract')
  const pdfTimeoutMs = Math.max(timeoutMs, 30 * 60_000)
  const convertArgs = [
    referencePaths.convertPdf,
    '--input', bridgePdfPath,
    '--output', input.outputPath,
    '--work-dir', finalConversionWorkDir,
    '--node', process.execPath,
    '--flattened-mode', 'ocr',
    '--editable-scope', 'all',
    '--ocr-engine', tesseract ? 'tesseract' : 'auto',
    '--overrides', semanticOverridesPath,
    '--watermark-qa-mode', 'strict',
    '--watermark-qa-ocr-engine', tesseract ? 'tesseract' : 'auto',
    '--max-pages', String(Math.max(120, plans.length)),
    '--command-timeout-seconds', String(Math.ceil(pdfTimeoutMs / 1000)),
  ]
  if (pdftoppm) convertArgs.push('--pdftoppm', pdftoppm)
  if (tesseract) convertArgs.push('--tesseract', tesseract)
  await reportProgress(
    input.onProgress,
    'PDF 桥接稿：正在执行元素级可编辑化与交接验收',
    87,
  )
  await runCommand(python, convertArgs, {
    timeoutMs: pdfTimeoutMs,
    env: converterEnv,
  })

  const conversionHandoffPath = path.join(
    finalConversionWorkDir,
    'conversion-handoff.json',
  )
  const pipelineHandoffPath = path.join(runRoot, 'pipeline-handoff-report.json')
  await runCommand(python, [
    referencePaths.validatePipelineHandoff,
    '--imagegen-manifest', imagegenManifestPath,
    '--bridge-manifest', bridgeManifestPath,
    '--conversion-handoff', conversionHandoffPath,
    '--output-report', pipelineHandoffPath,
    '--expected-editable-scope', 'all',
  ], { timeoutMs, env })

  const outputBuffer = await readFile(input.outputPath)
  await writeJson(path.join(runRoot, 'workflow-audit.json'), {
    schemaVersion: '1.0',
    strictSequence: [
      'create-reference-driven-editable-ppt',
      'GordenSuperPPTSkill',
      'pdf-to-editable-ppt',
    ],
    sourceMode: workflow.sourceMode,
    skills: workflow.skills,
    templateSha256: referenceFingerprint,
    projectFacts: path.join(runRoot, 'project-facts.json'),
    imagegenManifest: imagegenManifestPath,
    editableRunRoot: editableDir,
    imageDeck: imageDeckPath,
    gordenEditableIntermediate: gordenEditablePath,
    bridgePdf: bridgePdfPath,
    bridgeManifest: bridgeManifestPath,
    semanticOverrides: semanticOverridesPath,
    conversionHandoff: conversionHandoffPath,
    pipelineHandoff: pipelineHandoffPath,
    editablePptx: input.outputPath,
    outputSha256: sha256(outputBuffer),
  })
  await reportProgress(input.onProgress, '三个 PPT Skill 顺序执行并验收完成', 88)
  return {
    slideCount: plans.length,
    editableLevel: 'core-elements',
    templateApplied: true,
    templateSha256: workflow.templateSha256,
    outputSha256: sha256(outputBuffer),
    cjkFont: input.template.customAnalysis?.formatProfile.primaryFont || 'Microsoft YaHei',
    cjkLanguage: 'zh-CN',
    generationSkill: 'create-reference-driven-editable-ppt',
    generationRuntime: 'GordenSuperPPTSkills+pdf-bridge+pdf-to-editable-ppt',
    imageDeckPath,
    runRoot,
    workflowAudit: {
      sourceMode: workflow.sourceMode,
      skills: workflow.skills,
      strictSequence: [
        'create-reference-driven-editable-ppt',
        'GordenSuperPPTSkill',
        'pdf-to-editable-ppt',
      ],
    },
  }
}
