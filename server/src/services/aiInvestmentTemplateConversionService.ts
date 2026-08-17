import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, symlinkSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getAiSkillRoot } from './aiSkillService.js'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'

type ConversionHandoff = {
  watermarkQaPassed?: unknown
  editabilityReviewPassed?: unknown
  readyForContentReplacement?: unknown
  templateSha256?: unknown
  outputSha256?: unknown
  pptxSha256?: unknown
  editablePptxSha256?: unknown
  artifactSha256?: unknown
}

export type InvestmentTemplateConversionProgress = {
  stage: string
  progress: number
}

async function reportConversionProgress(
  callback: ((
    update: InvestmentTemplateConversionProgress,
  ) => void | Promise<void>) | undefined,
  stage: string,
  progress: number,
) {
  try {
    await callback?.({ stage, progress })
  } catch (error) {
    console.warn('[pdf-to-ppt] 进度更新失败:', (error as Error).message)
  }
}

function typedError(message: string, status: number, code: string) {
  return Object.assign(new Error(message), { status, code })
}

type CommandFailure = Error & {
  stdout?: string | Buffer
  stderr?: string | Buffer
  killed?: boolean
  code?: string | number
  signal?: string
  cmd?: string
}

function commandFailureDetail(error: unknown) {
  const failure = error as CommandFailure
  return `${String(failure.stderr || '')}\n${String(failure.stdout || '')}\n${failure.message || ''}`
}

function truncated(value: unknown, maxLength = 40_000) {
  const text = String(value || '')
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}\n…[内容已截断]`
    : text
}

async function readDiagnosticJson(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function persistConversionFailure(
  input: {
    sourcePdfPath: string
    workDir: string
  },
  stage: 'raster-review' | 'convert-and-validate',
  error: unknown,
) {
  const failure = error as CommandFailure
  const diagnosticId = randomUUID()
  const diagnosticRoot = path.resolve(
    process.cwd(),
    '.runtime',
    'pdf-to-ppt-diagnostics',
  )
  const diagnosticPath = path.join(diagnosticRoot, `${diagnosticId}.json`)
  const artifacts = {
    routeReport: await readDiagnosticJson(
      path.join(input.workDir, 'route-report.json'),
    ),
    editabilityReport: await readDiagnosticJson(
      path.join(input.workDir, 'editability-report.json'),
    ),
    watermarkReport: await readDiagnosticJson(
      path.join(input.workDir, 'watermark-report.json'),
    ),
    watermarkHandoffReport: await readDiagnosticJson(
      path.join(input.workDir, 'watermark-handoff-report.json'),
    ),
    semanticBuildReport: await readDiagnosticJson(
      path.join(input.workDir, 'semantic-build-report.json'),
    ),
    buildManifest: await readDiagnosticJson(
      path.join(input.workDir, 'build-manifest.json'),
    ),
    rasterSlotOverrides: await readDiagnosticJson(
      path.join(input.workDir, 'raster-slot-overrides.json'),
    ),
    rasterSlotReview: await readDiagnosticJson(
      path.join(input.workDir, 'raster-slot-review.json'),
    ),
  }
  try {
    await mkdir(diagnosticRoot, { recursive: true })
    await writeFile(
      diagnosticPath,
      `${JSON.stringify({
        diagnosticId,
        createdAt: new Date().toISOString(),
        stage,
        sourceFileName: path.basename(input.sourcePdfPath),
        failure: {
          name: failure.name,
          message: failure.message,
          code: failure.code,
          signal: failure.signal,
          killed: failure.killed,
          command: truncated(failure.cmd, 8_000),
          stdout: truncated(failure.stdout),
          stderr: truncated(failure.stderr),
        },
        artifacts,
      }, null, 2)}\n`,
      'utf8',
    )
  } catch (persistError) {
    console.error(
      `[pdf-to-ppt] 无法保存转换诊断 diagnosticId=${diagnosticId}`,
      persistError,
    )
  }
  console.error(
    `[pdf-to-ppt] ${stage} 失败 diagnosticId=${diagnosticId} diagnosticPath=${diagnosticPath}`,
    error,
  )
  return diagnosticId
}

function withDiagnosticId(message: string, diagnosticId: string) {
  return `${message}（诊断编号：${diagnosticId}）`
}

function declaredPptxSha256(handoff: ConversionHandoff) {
  return [
    handoff.templateSha256,
    handoff.outputSha256,
    handoff.pptxSha256,
    handoff.editablePptxSha256,
    handoff.artifactSha256,
  ].find((value): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
}

export function conversionFailureMessage(error: unknown) {
  const failure = error as CommandFailure
  const detail = commandFailureDetail(error)
  if (/PyMuPDF|No module named ['"]?fitz|No module named ['"]?PIL/i.test(detail)) {
    return 'PDF 模板转换环境缺少 PyMuPDF 或 Pillow，请配置转换运行时后重试'
  }
  if (/Fontconfig.*(?:not writable|cannot load)|No writable cache directories/i.test(detail)) {
    return 'PDF 模板转换的字体缓存目录不可写，请检查 Poppler 运行时配置'
  }
  if (/(?:pdftoppm|Poppler).*(?:not found|No such file|不存在|缺少)/i.test(detail)) {
    return 'PDF 模板转换环境缺少 Poppler，请配置 pdftoppm 后重试'
  }
  if (
    /PPTXGENJS_MODULE_NOT_FOUND|Cannot find (?:package|module)[^\n]*pptxgenjs|ERR_MODULE_NOT_FOUND[^\n]*pptxgenjs|无法加载 pptxgenjs/i.test(detail)
  ) {
    return 'PDF 模板转换环境无法加载 pptxgenjs，请检查项目依赖解析路径'
  }
  if (
    /artifact-tool|缺少 Presentations 技能|LibreOffice[^\n]*(?:not found|No such file|不存在|缺少)/i.test(detail)
  ) {
    return 'PDF 模板转换环境缺少 Presentations 技能或 LibreOffice 渲染管线'
  }
  if (/检测到 \d+ 个对象越出画布|canvas-overflow-report\.json/i.test(detail)) {
    return 'PDF 模板转换后的对象越出幻灯片画布，未通过版式边界检查'
  }
  if (
    /语义构建验证失败|semantic-object-missing-name|semantic-build-report\.json/i.test(detail)
  ) {
    return 'PDF 模板已完成页面转换，但可编辑对象语义校验未通过'
  }
  if (
    failure.killed
    || /(?:subprocess\.)?TimeoutExpired|timed?\s+out(?:\s+after)?|ETIMEDOUT|ERR_[A-Z_]*TIMEOUT|Command execution timed out/i.test(detail)
  ) {
    return 'PDF 模板转换超时，请精简模板或改为上传原生 PPTX'
  }
  if (
    /FileNotFoundError:[^\n]*(?:artifact-renders|slide-\d+\.(?:png|jpe?g))|ENOENT[^\n]*(?:artifact-renders|slide-\d+\.(?:png|jpe?g))/i.test(detail)
  ) {
    return 'PDF 模板逐页验收的渲染文件不完整，请重新转换'
  }
  if (
    /水印交接验收失败|最终渲染图中仍识别到目标水印|PPTX 包内仍包含目标水印/i.test(detail)
  ) {
    return 'PDF 模板转换后仍检测到目标水印，未通过严格交接验收'
  }
  if (/混合型 PDF 的选择性 OCR 尚不能|扁平化页面为 [^\n]+转换器已停止/i.test(detail)) {
    return '该 PDF 同时包含对象页和扁平图片页，当前严格可编辑流程无法安全合并这些页面'
  }
  if (
    /Tesseract 缺少 OCR 语言包|无法读取 Tesseract 语言列表|严格水印验收缺少 Apple Vision 或 Tesseract OCR|(?:tesseract|swiftc).*(?:not found|No such file|不存在|缺少)/i.test(detail)
  ) {
    return 'PDF 模板转换环境缺少可用的 OCR 引擎或中英文语言包'
  }
  if (
    /OCR 命令执行失败|Tesseract OCR 运行失败|Apple Vision OCR 只能|Vision OCR/i.test(detail)
  ) {
    return 'PDF 模板的 OCR 元素化或水印验收执行失败'
  }
  return 'PDF 模板未能转换为可编辑 PPTX，请检查文件后重试'
}

function rasterReviewFailureMessage(error: unknown) {
  const failure = error as Error & { stdout?: string; stderr?: string; killed?: boolean }
  const detail = `${failure.stderr || ''}\n${failure.stdout || ''}\n${failure.message || ''}`
  if (/PyMuPDF|No module named ['"]?fitz|No module named ['"]?PIL/i.test(detail)) {
    return 'PDF 模板图片槽位复核环境缺少 PyMuPDF 或 Pillow'
  }
  if (/(?:pdftoppm|Poppler).*(?:not found|No such file|不存在|缺少)/i.test(detail)) {
    return 'PDF 模板图片槽位复核环境缺少 Poppler'
  }
  if (/超过资源保护上限/i.test(detail)) {
    return detail.match(/PDF 共 [^\n]+超过资源保护上限[^\n]*/i)?.[0]
      || 'PDF 模板页数超过资源保护上限'
  }
  if (failure.killed || /timed?\s*out|timeout/i.test(detail)) {
    return 'PDF 模板图片槽位复核超时'
  }
  return 'PDF 模板中的大面积图片未能完成槽位复核'
}

function resolveConversionPython() {
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
  const candidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, name))
  return candidates.find((candidate) => existsSync(candidate))
}

function inferBundledFontconfigFile(pdftoppmPath: string | undefined) {
  if (!pdftoppmPath) return undefined
  const candidate = path.resolve(
    path.dirname(pdftoppmPath),
    '..',
    '..',
    'native',
    'poppler',
    'poppler',
    'etc',
    'fonts',
    'fonts.conf',
  )
  return existsSync(candidate) ? candidate : undefined
}

export async function convertUploadedInvestmentPdfTemplate(input: {
  sourcePdfPath: string
  outputPptxPath: string
  workDir: string
  /**
   * Pre-reviewed semantic overrides supplied by an upstream orchestrator.
   * When present, the generic raster-slot detector must not replace them.
   */
  semanticOverridesPath?: string
  expectedPageCount?: number
  onProgress?: (
    update: InvestmentTemplateConversionProgress,
  ) => void | Promise<void>
}) {
  const skillRoot = path.join(getAiSkillRoot(), 'pdf-to-editable-ppt')
  const converterPath = path.join(skillRoot, 'scripts', 'convert_pdf.py')
  if (!existsSync(converterPath)) {
    throw typedError(
      '缺少 pdf-to-editable-ppt 转换脚本',
      503,
      'PDF_TO_PPT_SKILL_UNAVAILABLE',
    )
  }
  await reportConversionProgress(
    input.onProgress,
    '正在检查 PDF 转换、OCR 和演示文稿运行环境',
    20,
  )

  const python = resolveConversionPython()
  const timeoutMs = Math.max(
    60_000,
    Number(process.env.AI_PDF_TO_PPT_TIMEOUT_MS || 30 * 60_000),
  )
  const maxPages = Math.max(1, Number(process.env.AI_PDF_TO_PPT_MAX_PAGES || 120))
  const tesseract = process.env.AI_PDF_TO_PPT_TESSERACT
    || findExecutable(process.platform === 'win32' ? 'tesseract.exe' : 'tesseract')
  const ocrEngine = tesseract ? 'tesseract' : 'auto'
  const pdftoppm = process.env.AI_PDF_TO_PPT_PDFTOPPM
    || findExecutable(process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm')
  const runtimeCacheDir = path.resolve(
    process.cwd(),
    '.runtime',
    'pdf-to-ppt-cache',
  )
  await Promise.all([
    mkdir(runtimeCacheDir, { recursive: true }),
    mkdir(input.workDir, { recursive: true }),
  ])
  // ESM 模块在临时 workDir 中无法解析 ppxtgenjs（NODE_PATH 对 ESM 无效，Node.js v24），
  // 用符号链接让 Node 子进程在当前及父目录中都能找到 node_modules。
  const projectNodeModules = path.resolve(process.cwd(), 'node_modules')
  try { symlinkSync(projectNodeModules, path.join(input.workDir, 'node_modules'), 'dir') } catch { /* 已存在或不可写则忽略 */ }
  const fontconfigFile = process.env.AI_PDF_TO_PPT_FONTCONFIG_FILE
    || process.env.FONTCONFIG_FILE
    || inferBundledFontconfigFile(pdftoppm)
  const conversionEnv = {
    ...process.env,
    XDG_CACHE_HOME: runtimeCacheDir,
    AI_PDF_TO_PPT_NODE_PROJECT_ROOT:
      process.env.AI_PDF_TO_PPT_NODE_PROJECT_ROOT || process.cwd(),
    ...(fontconfigFile ? { FONTCONFIG_FILE: fontconfigFile } : {}),
    NODE_PATH: path.resolve(process.cwd(), 'node_modules'),
  }
  const rasterReviewScript = path.resolve(
    process.cwd(),
    'server',
    'scripts',
    'build-pdf-raster-slot-overrides.py',
  )
  const rasterReviewWorkDir = path.join(input.workDir, 'raster-slot-review')
  const rasterOverridesPath = path.join(input.workDir, 'raster-slot-overrides.json')
  const rasterReviewReportPath = path.join(input.workDir, 'raster-slot-review.json')
  if (!pdftoppm) {
    throw typedError(
      'PDF 模板转换环境缺少 Poppler，请配置 pdftoppm 后重试',
      503,
      'PDF_TO_PPT_POPPLER_UNAVAILABLE',
    )
  }
  if (!input.semanticOverridesPath && !existsSync(rasterReviewScript)) {
    throw typedError(
      '缺少 PDF 大面积图片槽位复核脚本',
      503,
      'PDF_RASTER_REVIEW_UNAVAILABLE',
    )
  }
  const semanticOverridesPath = input.semanticOverridesPath
    ? path.resolve(input.semanticOverridesPath)
    : rasterOverridesPath
  if (input.semanticOverridesPath) {
    if (!existsSync(semanticOverridesPath)) {
      throw typedError(
        '上游编排器提供的语义覆盖清单不存在',
        422,
        'PDF_SEMANTIC_OVERRIDES_MISSING',
      )
    }
    await reportConversionProgress(
      input.onProgress,
      '已接收图片生成阶段的语义清单，正在预检可编辑对象',
      24,
    )
  } else {
    await reportConversionProgress(
      input.onProgress,
      '正在预检 PDF 页面、图片和可编辑对象',
      24,
    )
    try {
      await execFileAsync(python, [
        rasterReviewScript,
        '--input',
        input.sourcePdfPath,
        '--work-dir',
        rasterReviewWorkDir,
        '--conversion-work-dir',
        input.workDir,
        '--skill-root',
        skillRoot,
        '--pdftoppm',
        pdftoppm,
        '--output-overrides',
        rasterOverridesPath,
        '--output-report',
        rasterReviewReportPath,
        '--max-pages',
        String(maxPages),
        '--timeout-seconds',
        String(Math.ceil(timeoutMs / 1000)),
      ], {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env: conversionEnv,
      })
    } catch (error) {
      const diagnosticId = await persistConversionFailure(
        input,
        'raster-review',
        error,
      )
      throw typedError(
        withDiagnosticId(rasterReviewFailureMessage(error), diagnosticId),
        422,
        'PDF_RASTER_SLOT_REVIEW_FAILED',
      )
    }
  }
  await reportConversionProgress(
    input.onProgress,
    '页面预检完成，正在构建可编辑 PPTX',
    35,
  )
  const rasterReview = input.semanticOverridesPath
    ? undefined
    : JSON.parse(
        await readFile(rasterReviewReportPath, 'utf8'),
      ) as { pageCount?: unknown }
  const pageCount = input.semanticOverridesPath
    ? Math.max(0, Number(input.expectedPageCount) || 0)
    : Number(rasterReview?.pageCount) || 0
  const args = [
    converterPath,
    '--input',
    input.sourcePdfPath,
    '--output',
    input.outputPptxPath,
    '--work-dir',
    input.workDir,
    '--node',
    process.execPath,
    '--flattened-mode',
    'ocr',
    '--editable-scope',
    'all',
    '--ocr-engine',
    ocrEngine,
    '--watermark-qa-mode',
    'strict',
    '--watermark-qa-ocr-engine',
    ocrEngine,
    '--max-pages',
    String(maxPages),
    '--command-timeout-seconds',
    String(Math.ceil(timeoutMs / 1000)),
    '--overrides',
    semanticOverridesPath,
  ]
  if (tesseract) args.push('--tesseract', tesseract)
  args.push('--pdftoppm', pdftoppm)
  if (process.env.ARTIFACT_TOOL_DIR) {
    args.push('--artifact-tool-dir', process.env.ARTIFACT_TOOL_DIR)
  }

  const conversionStartedAt = Date.now()
  let observedProgress = 36
  let heartbeatRunning = false
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    void (async () => {
      try {
        const elapsedSeconds = Math.floor(
          (Date.now() - conversionStartedAt) / 1000,
        )
        const renderDir = path.join(input.workDir, 'artifact-renders')
        const modelPath = path.join(input.workDir, 'pdf-model.json')
        let nextProgress = Math.min(44, 36 + Math.floor(elapsedSeconds / 8))
        let stage = '正在提取 PDF 页面中的文字、图片和矢量对象'
        if (existsSync(modelPath)) {
          nextProgress = Math.max(
            nextProgress,
            Math.min(58, 46 + Math.floor(elapsedSeconds / 12)),
          )
          stage = '页面元素提取完成，正在生成并校验可编辑 PPTX'
        }
        if (existsSync(input.outputPptxPath)) {
          nextProgress = Math.max(nextProgress, 59)
          stage = '可编辑 PPTX 已生成，正在执行页面渲染检查'
        }
        if (existsSync(renderDir)) {
          const renderCount = readdirSync(renderDir)
            .filter((name) => /^slide-\d+\.png$/i.test(name))
            .length
          if (pageCount > 0 && renderCount < pageCount) {
            nextProgress = Math.max(
              nextProgress,
              62 + Math.floor(renderCount / pageCount * 8),
            )
            stage = `正在渲染页面质量检查（${renderCount}/${pageCount}）`
          } else if (renderCount > 0) {
            nextProgress = Math.max(
              nextProgress,
              Math.min(92, 72 + Math.floor(elapsedSeconds / 20)),
            )
            stage = pageCount > 0
              ? `正在逐页检查水印、可编辑性和页面结构（${pageCount} 页）`
              : '正在逐页检查水印、可编辑性和页面结构'
          }
        }
        if (nextProgress > observedProgress) {
          observedProgress = nextProgress
          await reportConversionProgress(
            input.onProgress,
            stage,
            observedProgress,
          )
        }
      } finally {
        heartbeatRunning = false
      }
    })()
  }, 2_000)
  heartbeat.unref?.()
  try {
    await execFileAsync(python, args, {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      env: conversionEnv,
    })
  } catch (error) {
    const diagnosticId = await persistConversionFailure(
      input,
      'convert-and-validate',
      error,
    )
    throw typedError(
      withDiagnosticId(conversionFailureMessage(error), diagnosticId),
      422,
      'PDF_TEMPLATE_CONVERSION_FAILED',
    )
  } finally {
    clearInterval(heartbeat)
  }
  await reportConversionProgress(
    input.onProgress,
    'PPTX 转换完成，正在核对交接证书',
    93,
  )

  const handoffPath = path.join(input.workDir, 'conversion-handoff.json')
  const handoff = JSON.parse(
    await readFile(handoffPath, 'utf8').catch(() => {
      throw typedError(
        'PDF 模板转换未生成交接证书',
        422,
        'PDF_TEMPLATE_HANDOFF_MISSING',
      )
    }),
  ) as ConversionHandoff
  if (
    handoff.watermarkQaPassed !== true
    || handoff.editabilityReviewPassed !== true
    || handoff.readyForContentReplacement !== true
  ) {
    throw typedError(
      'PDF 模板未通过水印、可编辑性或内容替换交接检查，请改为上传原生 PPTX',
      422,
      'PDF_TEMPLATE_NOT_REPLACEABLE',
    )
  }
  await reportConversionProgress(
    input.onProgress,
    '水印与可编辑性检查通过，正在完成模板交接',
    96,
  )

  const outputBuffer = await readFile(input.outputPptxPath)
  const outputSha256 = createHash('sha256').update(outputBuffer).digest('hex')
  const declaredSha256 = declaredPptxSha256(handoff)
  if (declaredSha256 && declaredSha256.toLowerCase() !== outputSha256) {
    throw typedError(
      'PDF 转换交接证书与输出 PPTX 摘要不一致',
      422,
      'PDF_TEMPLATE_HANDOFF_MISMATCH',
    )
  }
  return {
    outputBuffer,
    outputSha256,
    handoffPath,
  }
}
