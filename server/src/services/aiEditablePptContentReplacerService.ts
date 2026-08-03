import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
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

type TemplateMapObject = {
  shapeId: number
  name?: string
  kind: string
  bbox?: number[]
  text?: string
  textStyle?: unknown
  media?: string | null
}

type TemplateMapSlide = {
  number: number
  title?: string
  objects: TemplateMapObject[]
}

type TemplateMap = {
  sha256: string
  slideCount: number
  layoutCount?: number
  mediaIds?: string[]
  slides: TemplateMapSlide[]
}

type ManifestSource = {
  sourceId: string
  sourceType:
    | 'user_material'
    | 'company_official'
    | 'regulatory_filing'
    | 'government'
    | 'academic'
    | 'industry_report'
    | 'reputable_media'
    | 'other'
  title: string
  publisher: string
  accessedDate: string
  publishedDate?: string
  locator?: string
  url?: string
}

type ReplacementCandidate = {
  text: string
  sourceIndexes: number[]
}

type ReplacementProgress = (
  update: { stage: string; progress: number },
) => void | Promise<void>

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function validIsoDate(value: string | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
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

function artifactToolCandidates() {
  return [
    process.env.ARTIFACT_TOOL_DIR,
    path.resolve(process.cwd(), 'node_modules', '@oai', 'artifact-tool'),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'node_modules',
      '@oai',
      'artifact-tool',
    ),
    path.resolve(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules',
      '@oai',
      'artifact-tool',
    ),
  ].filter((value): value is string => Boolean(value))
}

function resolveArtifactToolDir() {
  const result = artifactToolCandidates().find((candidate) =>
    existsSync(path.join(candidate, 'dist', 'artifact_tool.mjs')))
  // Linux-OpenXML 路线不强制要求 @oai/artifact-tool
  // 若不可用，脚本使用 Python zipfile + Open XML 直接操作 PPTX
  if (!result && process.env.ARTIFACT_TOOL_REQUIRED !== '1') {
    return ''
  }
  if (!result) {
    throw Object.assign(
      new Error('内容替换环境缺少 @oai/artifact-tool'),
      { code: 'EDITABLE_PPT_ARTIFACT_TOOL_UNAVAILABLE' },
    )
  }
  return result
}

function findExecutable(name: string) {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name))
    .find((candidate) => existsSync(candidate))
}

async function runCommand(
  executable: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) {
  try {
    return await execFileAsync(executable, args, {
      timeout: options.timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
      env: options.env ?? process.env,
    })
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const detail = [failure.stderr, failure.stdout, failure.message]
      .filter(Boolean)
      .join('\n')
      .slice(-12_000)
    throw Object.assign(
      new Error(`editable-ppt-content-replacer 执行失败：${detail}`),
      { code: 'EDITABLE_PPT_REPLACER_FAILED' },
    )
  }
}

async function reportProgress(
  callback: ReplacementProgress | undefined,
  stage: string,
  progress: number,
) {
  try {
    await callback?.({ stage, progress })
  } catch (error) {
    console.warn('[editable-ppt-content-replacer] 进度更新失败:', (error as Error).message)
  }
}

function sourceUrl(source: EvidenceSource) {
  const candidates = [source.locator, source.content.match(/https?:\/\/[^\s)\]}>"']+/)?.[0]]
  return candidates.find((value): value is string =>
    Boolean(value && /^https?:\/\//i.test(value)))
}

function manifestSourceType(source: EvidenceSource, url: string | undefined) {
  const type = source.sourceType.toLowerCase()
  if (/company|official|官网/.test(type)) return 'company_official' as const
  if (/regulat|filing|监管|公告/.test(type)) return 'regulatory_filing' as const
  if (/government|政府/.test(type)) return 'government' as const
  if (/academic|paper|论文|学术/.test(type)) return 'academic' as const
  if (/industry|research|行业/.test(type)) return 'industry_report' as const
  if (/media|news|媒体/.test(type)) return 'reputable_media' as const
  return url ? 'other' as const : 'user_material' as const
}

function buildManifestSources(
  sources: EvidenceSource[],
  accessedDate: string,
): ManifestSource[] {
  return sources.map((source, index) => {
    const url = sourceUrl(source)
    const sourceType = manifestSourceType(source, url)
    const publishedDate = validIsoDate(source.versionOrDate)
      ? source.versionOrDate
      : undefined
    return {
      sourceId: `src-${index + 1}`,
      sourceType,
      title: source.sourceName || `项目资料 ${index + 1}`,
      publisher: source.sourceName || '用户提供',
      accessedDate,
      ...(publishedDate ? { publishedDate } : {}),
      ...(sourceType === 'user_material'
        ? {
            locator: source.locator
              || (Number.isInteger(source.chunkIndex)
                ? `${source.sourceName}，知识片段 ${source.chunkIndex}`
                : `${source.sourceName}，文件级定位`),
          }
        : { url }),
    }
  })
}

function sectionSourceIndexes(section: BusinessSection | undefined) {
  if (!section) return []
  return [...new Set([
    ...(section.summarySourceIndexes ?? []),
    ...section.findings.flatMap((finding) => finding.sourceIndexes),
    ...(section.tables ?? []).flatMap((table) => table.sourceIndexes),
  ])].filter((value) => Number.isInteger(value) && value >= 0)
}

function textCandidates(
  section: BusinessSection | undefined,
  project: ProjectLike,
  content: BusinessContent,
): ReplacementCandidate[] {
  const sectionIndexes = sectionSourceIndexes(section)
  const values: ReplacementCandidate[] = [
    ...(section?.summary
      ? [{
          text: section.summary,
          sourceIndexes: section.summarySourceIndexes ?? sectionIndexes,
        }]
      : []),
    ...(section?.findings ?? []).map((finding) => ({
      text: finding.text,
      sourceIndexes: finding.sourceIndexes,
    })),
    ...(section?.tables ?? []).flatMap((table) => [
      {
        text: table.title,
        sourceIndexes: table.sourceIndexes,
      },
      ...table.rows.flatMap((row) => row.map((cell) => ({
        text: cell,
        sourceIndexes: table.sourceIndexes,
      }))),
    ]),
    ...content.highlights.map((text) => ({
      text,
      sourceIndexes: content.executiveSummarySourceIndexes ?? [],
    })),
    ...content.risks.map((text) => ({
      text,
      sourceIndexes: content.executiveSummarySourceIndexes ?? [],
    })),
  ]
  const seen = new Set<string>()
  return values
    .map((item) => ({
      ...item,
      text: item.text
        .replace(/\s+/g, ' ')
        .replace(/^[•·\-—]\s*/, '')
        .trim(),
    }))
    .filter((item) => item.text && !seen.has(item.text) && seen.add(item.text))
}

function shortTextSegments(text: string) {
  return text
    .split(/[，。；：、,;:（）()\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function compactForSlot(text: string, originalLength: number, isTitle: boolean) {
  const clean = text.replace(/\s+/g, ' ').trim()
  const maxChars = isTitle
    ? Math.max(6, Math.ceil(originalLength * 1.15))
    : Math.max(4, Math.ceil(originalLength * 1.08))
  if (clean.length <= maxChars) return clean
  const segment = clean
    .split(/[。；!?！？]/)
    .map((value) => value.trim())
    .find((value) => value.length >= Math.min(4, maxChars))
  const candidate = segment || clean
  if (candidate.length <= maxChars) return candidate
  return candidate.slice(0, Math.max(1, maxChars - 1)).replace(/[，,；;：:\s]+$/g, '')
}

function slideSection(
  slideNumber: number,
  template: AiTemplateDefinition,
  content: BusinessContent,
) {
  const structureTitle = template.customAnalysis?.structures[slideNumber - 1]?.title || ''
  const exact = content.sections.find((section) =>
    section.title === structureTitle
    || section.title.includes(structureTitle)
    || structureTitle.includes(section.title))
  if (exact) return exact
  if (!content.sections.length) return undefined
  return content.sections[Math.max(0, slideNumber - 2) % content.sections.length]
}

function genericSlideRole(title: string) {
  const rules: Array<[RegExp, string]> = [
    [/公司|企业|项目概况|基本情况|成立|定位/, '公司概况'],
    [/团队|创始人|管理层|治理/, '核心团队'],
    [/产品|应用|解决方案|场景/, '产品与应用'],
    [/技术|研发|专利|知识产权/, '技术与研发'],
    [/行业|市场|空间|产业链/, '行业与市场'],
    [/竞争|竞品|对比|格局/, '竞争分析'],
    [/客户|订单|合同|商业化|经营|收入/, '商业化进展'],
    [/财务|估值|融资|回报/, '财务与估值'],
    [/投资|亮点|判断|建议/, '投资判断'],
    [/风险|核验|关注|问题/, '风险与核验'],
  ]
  return rules.find(([pattern]) => pattern.test(title))?.[1] || '项目分析'
}

function currentProjectSlideTitle(
  projectName: string,
  structureTitle: string,
  originalLength: number,
) {
  const role = genericSlideRole(structureTitle)
  if (originalLength <= Math.max(8, projectName.length + 2)) return projectName
  return `${projectName}｜${role}`
}

function protectedTextObject(object: TemplateMapObject) {
  const text = String(object.text || '').trim()
  const bbox = object.bbox || []
  const top = Number(bbox[1] || 0)
  if (!text) return true
  if (/(?:浙江赛智伯乐|赛智伯乐|CYBERNAUT)/i.test(text)) return true
  if (text.length <= 2) return true
  if (/^\d{1,2}[.、]$/.test(text)) return true
  if (/^\d{1,3}$/.test(text) && top >= 650) return true
  if (/^[|｜·•—–\-_/\\]+$/.test(text)) return true
  return false
}

function evidenceForIndexes(
  indexes: number[],
  manifestSources: ManifestSource[],
) {
  const selected = [...new Set(indexes)]
    .filter((index) => Boolean(manifestSources[index]))
    .map((index) => manifestSources[index])
  const userMaterial = selected.filter((source) => source.sourceType === 'user_material')
  if (userMaterial.length) {
    return {
      valueType: 'user-provided',
      status: 'verified',
      confidence: 'high',
      sourceIds: userMaterial.map((source) => source.sourceId),
    }
  }
  const primary = selected.filter((source) =>
    ['company_official', 'regulatory_filing', 'government', 'academic']
      .includes(source.sourceType))
  if (primary.length) {
    return {
      valueType: 'official-fact',
      status: 'verified',
      confidence: 'high',
      sourceIds: primary.map((source) => source.sourceId),
    }
  }
  const publishers = new Set(selected.map((source) => source.publisher.toLowerCase()))
  if (publishers.size >= 2) {
    return {
      valueType: 'corroborated-fact',
      status: 'verified',
      confidence: 'medium',
      sourceIds: selected.map((source) => source.sourceId),
    }
  }
  return {
    valueType: 'unavailable',
    status: 'not-found',
    confidence: 'low',
    sourceIds: [] as string[],
  }
}

function buildReplacementManifest(input: {
  template: AiTemplateDefinition
  templateMap: TemplateMap
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
}) {
  const accessedDate = validIsoDate(input.sourceCutoffDate)
    ? input.sourceCutoffDate
    : new Date().toISOString().slice(0, 10)
  const manifestSources = buildManifestSources(input.sources, accessedDate)
  const protectedObjects: Array<Record<string, unknown>> = []
  const slotAssignments: Array<Record<string, unknown>> = []
  const operations: Array<Record<string, unknown>> = []
  const evidenceRegistry: Array<Record<string, unknown>> = []

  for (const slide of input.templateMap.slides) {
    const textObjects = slide.objects.filter((object) =>
      object.kind.startsWith('shape:')
      && String(object.text || '').trim()
      && !protectedTextObject(object))
    const titleTarget = slide.number === 1
      ? textObjects[0]
      : [...textObjects].sort((left, right) => {
          const leftTop = Number(left.bbox?.[1] || 0)
          const rightTop = Number(right.bbox?.[1] || 0)
          const leftTopBand = leftTop <= 180 ? 1 : 0
          const rightTopBand = rightTop <= 180 ? 1 : 0
          const leftFont = Number(
            (left.textStyle as { run?: { fontSize?: number } } | undefined)
              ?.run?.fontSize || 0,
          )
          const rightFont = Number(
            (right.textStyle as { run?: { fontSize?: number } } | undefined)
              ?.run?.fontSize || 0,
          )
          return rightTopBand - leftTopBand
            || rightFont - leftFont
            || leftTop - rightTop
        })[0]
    const firstLastSlideBodyTarget = slide.number === input.templateMap.slideCount
      ? textObjects.find((object) => object.shapeId !== titleTarget?.shapeId)
      : undefined
    const section = slideSection(slide.number, input.template, input.content)
    const candidates = textCandidates(section, input.project, input.content)
    let candidateIndex = 0
    const semanticKeys: string[] = []
    const pendingOperations: Array<Record<string, unknown>> = []
    let evidenceIndexes = sectionSourceIndexes(section)

    for (const [targetIndex, object] of textObjects.entries()) {
      const original = String(object.text || '').trim()
      const isTitle = object.shapeId === titleTarget?.shapeId
      let candidate: ReplacementCandidate
      if (slide.number === 1 && isTitle) {
        candidate = {
          text: input.content.title || `${input.project.name}投资建议书`,
          sourceIndexes: input.content.executiveSummarySourceIndexes ?? [],
        }
      } else if (slide.number === input.templateMap.slideCount && isTitle) {
        candidate = {
          text: '引用资料与责任声明',
          sourceIndexes: sectionSourceIndexes(section),
        }
      } else if (
        slide.number === input.templateMap.slideCount
        && object.shapeId === firstLastSlideBodyTarget?.shapeId
      ) {
        candidate = {
          text: input.template.disclaimer,
          sourceIndexes: sectionSourceIndexes(section),
        }
      } else if (isTitle) {
        const structureTitle =
          input.template.customAnalysis?.structures[slide.number - 1]?.title
          || section?.title
          || ''
        candidate = {
          text: currentProjectSlideTitle(
            input.project.name,
            structureTitle,
            original.length,
          ),
          sourceIndexes: section?.summarySourceIndexes ?? sectionSourceIndexes(section),
        }
      } else {
        const pool = candidates.length
          ? candidates
          : [{
              text: '待核实',
              sourceIndexes: [],
            }]
        const preferred = pool[candidateIndex % pool.length]
        const segments = shortTextSegments(preferred.text)
        const shortSegment = segments.find((value) =>
          value.length >= Math.min(3, original.length)
          && value.length <= Math.max(4, Math.ceil(original.length * 1.08)))
        candidate = {
          text: shortSegment || preferred.text,
          sourceIndexes: preferred.sourceIndexes,
        }
        candidateIndex += 1
      }
      const evidence = evidenceForIndexes(candidate.sourceIndexes, manifestSources)
      const forceExactText =
        slide.number === input.templateMap.slideCount
        && (
          object.shapeId === titleTarget?.shapeId
          || object.shapeId === firstLastSlideBodyTarget?.shapeId
        )
      let replacement = forceExactText
        ? candidate.text
        : compactForSlot(candidate.text, original.length, isTitle)
      if (!replacement) replacement = '待核实'
      const semanticKey = `slide.${slide.number}.shape.${object.shapeId}`
      semanticKeys.push(semanticKey)
      evidenceIndexes = [...new Set([...evidenceIndexes, ...candidate.sourceIndexes])]
      const assignmentId = `assignment-${slide.number}-${object.shapeId}`
      slotAssignments.push({
        assignmentId,
        slide: slide.number,
        semanticKey,
        semanticRole: isTitle ? '页面标题' : '页面内容',
        requirement: 'required',
        disposition: 'replace',
        shapeIds: [object.shapeId],
        expectedContentShapeIds: [object.shapeId],
        sourceNote: evidence.sourceIds.length
          ? evidence.sourceIds.join('、')
          : '公开信息未检索到',
      })
      pendingOperations.push({
        slide: slide.number,
        shapeId: object.shapeId,
        semanticKey,
        role: isTitle ? '页面标题' : `页面内容对象 ${object.shapeId}`,
        action: 'replace_text',
        text: replacement,
        reason: '使用当前项目内容原位替换模板样本内容',
        sourceNote: evidence.sourceIds.length
          ? evidence.sourceIds.join('、')
          : '公开信息未检索到',
        fitPolicy: 'preserve',
        styleLock: 'exact',
        allowLineCountChange: replacement.includes('\n'),
      })
    }

    const evidence = evidenceForIndexes(evidenceIndexes, manifestSources)
    const evidenceId = `ev-slide-${slide.number}`
    if (semanticKeys.length) {
      evidenceRegistry.push({
        evidenceId,
        claim: evidence.valueType === 'unavailable'
          ? `第 ${slide.number} 页对应信息未能从当前资料或公开来源证实`
          : `第 ${slide.number} 页写入内容来自已登记的当前项目证据`,
        valueType: evidence.valueType,
        materiality: 'basic',
        status: evidence.status,
        semanticKeys,
        sourceIds: evidence.sourceIds,
        confidence: evidence.confidence,
        asOfDate: accessedDate,
      })
      operations.push(...pendingOperations.map((operation) => ({
        ...operation,
        evidenceIds: [evidenceId],
        ...(evidence.valueType === 'unavailable'
          ? { text: '待核实' }
          : {}),
      })))
    }

    const targetIds = new Set(textObjects.map((object) => object.shapeId))
    for (const object of slide.objects) {
      if (targetIds.has(object.shapeId)) continue
      protectedObjects.push({
        slide: slide.number,
        shapeId: object.shapeId,
        classification: object.kind === 'picture'
          ? 'fixed_visual'
          : object.kind.startsWith('shape:') && String(object.text || '').trim()
            ? 'template_brand'
            : 'generic_decoration',
        reason: '未列入内容替换白名单，保持原模板对象不变',
      })
    }
  }

  return {
    schemaVersion: '1.3',
    sourceMode: input.template.templateSourceMode ?? 'native-pptx',
    ...(input.template.conversionHandoffPath
      ? { conversionHandoff: path.resolve(input.template.conversionHandoffPath) }
      : {}),
    templatePptx: path.resolve(input.template.referencePath),
    templateSha256: input.templateMap.sha256,
    projectName: input.project.name,
    defaultAction: 'KEEP',
    researchPolicy: {
      enabled: true,
      asOfDate: accessedDate,
      minimumIndependentSources: 2,
      unresolvedPolicy: 'mark-not-disclosed-or-delete-optional',
    },
    sources: manifestSources,
    evidenceRegistry,
    protectedObjects,
    slotGroups: [],
    entityBindings: [],
    slotAssignments,
    operations,
  }
}

export async function generateInvestmentRecommendationPptFromTemplate(input: {
  outputPath: string
  template: AiTemplateDefinition
  project: ProjectLike
  content: BusinessContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  onProgress?: ReplacementProgress
}) {
  const workflow = await prepareInvestmentRecommendationPptWorkflow(input.template)
  const skillRoot = path.join(getAiSkillRoot(), 'editable-ppt-content-replacer')
  const pdfSkillRoot = path.join(getAiSkillRoot(), 'pdf-to-editable-ppt')
  const scripts = {
    analyze: path.join(skillRoot, 'scripts', 'analyze_template_openxml.py'),
    validateManifest: path.join(skillRoot, 'scripts', 'validate_replacement_manifest.py'),
    generatePlan: path.join(skillRoot, 'scripts', 'generate_apply_plan.py'),
    apply: path.join(skillRoot, 'scripts', 'apply_template_plan_openxml.py'),
    validateResult: path.join(skillRoot, 'scripts', 'validate_template_result_openxml.py'),
    finalContent: path.join(skillRoot, 'scripts', 'validate_final_content.py'),
    watermark: path.join(pdfSkillRoot, 'scripts', 'validate_watermark_handoff.py'),
  }
  for (const [name, script] of Object.entries(scripts)) {
    if (!existsSync(script)) {
      throw new Error(`editable-ppt-content-replacer 缺少 ${name} 脚本：${script}`)
    }
  }

  const env = { ...process.env }
  // Linux-OpenXML 路线不强制要求 Artifact Tool；若可用仍会传递给兼容脚本
  const artifactToolDir = resolveArtifactToolDir()
  if (artifactToolDir) {
    env.ARTIFACT_TOOL_DIR = artifactToolDir
  }
  const python = resolvePython()
  const pdftoppm = process.env.AI_PDF_TO_PPT_PDFTOPPM
    || findExecutable(process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm')
  const libreoffice = process.env.AI_PDF_TO_PPT_LIBREOFFICE
    || findExecutable(process.platform === 'win32' ? 'soffice.exe' : 'libreoffice')
    || findExecutable(process.platform === 'win32' ? 'soffice.exe' : 'soffice')
  if (!pdftoppm || !libreoffice) {
    throw Object.assign(
      new Error('内容替换环境缺少 LibreOffice 或 Poppler 无头渲染运行时'),
      { code: 'EDITABLE_PPT_PUBLIC_RUNTIME_UNAVAILABLE' },
    )
  }
  const timeoutMs = Math.max(
    120_000,
    Number(process.env.AI_EDITABLE_PPT_REPLACER_TIMEOUT_MS || 30 * 60_000),
  )
  const workDir = path.join(
    path.dirname(input.outputPath),
    `.editable-ppt-replacer-${path.basename(input.outputPath, '.pptx')}`,
  )
  await mkdir(workDir, { recursive: true })
  const templateMapPath = path.join(workDir, 'template-map.json')
  const manifestPath = path.join(workDir, 'replacement-manifest.json')
  const manifestValidationPath = path.join(workDir, 'manifest-validation.json')
  const contentPlanPath = path.join(workDir, 'content-plan.json')
  const structuralPlanPath = path.join(workDir, 'structural-operations.json')
  const nativePlanPath = path.join(workDir, 'native-operations.json')
  const applyReportPath = path.join(workDir, 'content-apply-report.json')
  const renderDir = path.join(workDir, 'final-renders')
  const fidelityPath = path.join(workDir, 'fidelity-report.json')
  const finalMapPath = path.join(workDir, 'final-template-map.json')
  const finalWatermarkPath = path.join(workDir, 'final-watermark-qa.json')
  const finalCoveragePath = path.join(workDir, 'final-content-coverage-report.json')

  await reportProgress(
    input.onProgress,
    '校验 PDF 转换交接完成，正在建立原模板对象地图',
    70,
  )
  await runCommand(python, [
    scripts.analyze,
    '--input',
    input.template.referencePath,
    '--output',
    templateMapPath,
  ], { timeoutMs, env })
  const templateMap = JSON.parse(await readFile(templateMapPath, 'utf8')) as TemplateMap
  if (templateMap.sha256 !== workflow.templateSha256) {
    throw new Error('replacer 对象地图与 PDF 转换交接模板摘要不一致')
  }

  await reportProgress(
    input.onProgress,
    '正在生成 1.3 版内容槽位白名单与证据绑定',
    72,
  )
  const manifest = buildReplacementManifest({
    template: input.template,
    templateMap,
    project: input.project,
    content: input.content,
    sources: input.sources,
    sourceCutoffDate: input.sourceCutoffDate,
  })
  if (!manifest.operations.length) {
    throw new Error('上传模板没有识别到可安全原位替换的文字槽位')
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  await reportProgress(
    input.onProgress,
    '正在校验白名单、保护对象、槽位覆盖与来源证据',
    74,
  )
  await runCommand(python, [
    scripts.validateManifest,
    '--manifest',
    manifestPath,
    '--template-map',
    templateMapPath,
    '--report',
    manifestValidationPath,
  ], { timeoutMs, env })
  await runCommand(python, [
    scripts.generatePlan,
    '--manifest',
    manifestPath,
    '--template-map',
    templateMapPath,
    '--output',
    contentPlanPath,
    '--structural-output',
    structuralPlanPath,
    '--native-output',
    nativePlanPath,
  ], { timeoutMs, env })

  await reportProgress(
    input.onProgress,
    '正在原模板对象中逐项替换内容并保留图片、版式和母版',
    76,
  )
  await runCommand(python, [
    scripts.apply,
    '--template',
    input.template.referencePath,
    '--plan',
    contentPlanPath,
    '--output',
    input.outputPath,
    '--render-dir',
    renderDir,
    '--report',
    applyReportPath,
    ...(libreoffice ? ['--libreoffice', libreoffice] : []),
    ...(pdftoppm ? ['--pdftoppm', pdftoppm] : []),
    '--timeout-seconds',
    String(Math.ceil(timeoutMs / 1000)),
  ], { timeoutMs, env })

  await reportProgress(
    input.onProgress,
    '内容替换完成，正在执行页面、对象、样式与媒体保真校验',
    80,
  )
  await runCommand(process.execPath, [
    scripts.validateResult,
    '--template',
    input.template.referencePath,
    '--result',
    input.outputPath,
    '--plan',
    contentPlanPath,
    '--output',
    fidelityPath,
  ], { timeoutMs, env })
  await runCommand(python, [
    scripts.analyze,
    '--input',
    input.outputPath,
    '--output',
    finalMapPath,
  ], { timeoutMs, env })

  await reportProgress(
    input.onProgress,
    workflow.sourceMode === 'pdf-converted'
      ? '正在对最终 PPTX 逐页执行水印复检'
      : '正在完成最终内容槽位覆盖校验',
    83,
  )
  if (workflow.sourceMode === 'pdf-converted') {
    const handoffDir = path.dirname(input.template.conversionHandoffPath as string)
    const watermarkReport = path.join(handoffDir, 'watermark-report.json')
    if (!existsSync(watermarkReport)) {
      throw new Error('PDF 转换交接目录缺少 watermark-report.json')
    }
    const tesseract = process.env.AI_PDF_TO_PPT_TESSERACT
      || findExecutable(process.platform === 'win32' ? 'tesseract.exe' : 'tesseract')
    const watermarkArgs = [
      scripts.watermark,
      '--pptx',
      input.outputPath,
      '--render-dir',
      renderDir,
      '--watermark-report',
      watermarkReport,
      '--output',
      finalWatermarkPath,
      '--mode',
      'strict',
      '--ocr-engine',
      tesseract ? 'tesseract' : 'auto',
    ]
    if (tesseract) watermarkArgs.push('--tesseract', tesseract)
    await runCommand(python, watermarkArgs, { timeoutMs, env })
  } else {
    await writeFile(
      finalWatermarkPath,
      `${JSON.stringify({
        passed: true,
        mode: 'not-required-native-pptx',
        renderCount: templateMap.slideCount,
        errors: [],
        warnings: [],
      }, null, 2)}\n`,
      'utf8',
    )
  }
  await runCommand(python, [
    scripts.finalContent,
    '--manifest',
    manifestPath,
    '--template-map',
    templateMapPath,
    '--result-map',
    finalMapPath,
    '--watermark-qa-report',
    finalWatermarkPath,
    '--output',
    finalCoveragePath,
  ], { timeoutMs, env })

  const [outputBuffer, fidelity, coverage, validation] = await Promise.all([
    readFile(input.outputPath),
    readFile(fidelityPath, 'utf8').then(JSON.parse),
    readFile(finalCoveragePath, 'utf8').then(JSON.parse),
    readFile(manifestValidationPath, 'utf8').then(JSON.parse),
  ])
  await reportProgress(
    input.onProgress,
    '模板原位替换与严格保真验收全部通过',
    86,
  )
  return {
    slideCount: templateMap.slideCount,
    editableLevel: 'core-elements',
    templateApplied: true,
    templateSha256: workflow.templateSha256,
    outputSha256: sha256(outputBuffer),
    inheritedCompanyAssets: templateMap.mediaIds?.length ?? 0,
    cjkFont: input.template.customAnalysis?.formatProfile.primaryFont || '微软雅黑',
    cjkLanguage: 'zh-CN',
    replacementSkill: 'editable-ppt-content-replacer',
    replacementSchemaVersion: '1.3',
    replacementOperationCount: manifest.operations.length,
    protectedObjectCount: manifest.protectedObjects.length,
    fidelity,
    finalCoverage: coverage.metrics,
    manifestValidation: validation.metrics,
    workflowAudit: {
      sourceMode: workflow.sourceMode,
      skills: workflow.skills,
      strictSequence: [
        ...(workflow.sourceMode === 'pdf-converted'
          ? ['pdf-to-editable-ppt']
          : []),
        'editable-ppt-content-replacer',
      ],
    },
  }
}
