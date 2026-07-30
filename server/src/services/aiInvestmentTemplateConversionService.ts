import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { getAiSkillRoot } from './aiSkillService.js'

const execFileAsync = promisify(execFile)

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

function conversionFailureMessage(error: unknown) {
  const failure = error as Error & { stdout?: string; stderr?: string; killed?: boolean }
  const detail = `${failure.stderr || ''}\n${failure.stdout || ''}\n${failure.message || ''}`
  if (/PyMuPDF|No module named ['"]?fitz|No module named ['"]?PIL/i.test(detail)) {
    return 'PDF 模板转换环境缺少 PyMuPDF 或 Pillow，请配置转换运行时后重试'
  }
  if (/Fontconfig.*(?:not writable|cannot load)|No writable cache directories/i.test(detail)) {
    return 'PDF 模板转换的字体缓存目录不可写，请检查 Poppler 运行时配置'
  }
  if (/(?:pdftoppm|Poppler).*(?:not found|No such file|不存在|缺少)/i.test(detail)) {
    return 'PDF 模板转换环境缺少 Poppler，请配置 pdftoppm 后重试'
  }
  if (/artifact-tool|Presentations 技能|Presentation/i.test(detail)) {
    return 'PDF 模板转换环境缺少 Presentations 技能或 LibreOffice 渲染管线'
  }
  if (
    /水印交接验收失败|最终渲染图中仍识别到目标水印|PPTX 包内仍包含目标水印/i.test(detail)
  ) {
    return 'PDF 模板转换后仍检测到目标水印，未通过严格交接验收'
  }
  if (/OCR|Tesseract|Vision/i.test(detail)) {
    return 'PDF 模板需要 OCR 元素化，但当前 OCR 环境未通过检查'
  }
  if (failure.killed || /timed?\s*out|timeout/i.test(detail)) {
    return 'PDF 模板转换超时，请精简模板或改为上传原生 PPTX'
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
  const fontconfigFile = process.env.AI_PDF_TO_PPT_FONTCONFIG_FILE
    || process.env.FONTCONFIG_FILE
    || inferBundledFontconfigFile(pdftoppm)
  const conversionEnv = {
    ...process.env,
    XDG_CACHE_HOME: runtimeCacheDir,
    ...(fontconfigFile ? { FONTCONFIG_FILE: fontconfigFile } : {}),
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
  if (!existsSync(rasterReviewScript)) {
    throw typedError(
      '缺少 PDF 大面积图片槽位复核脚本',
      503,
      'PDF_RASTER_REVIEW_UNAVAILABLE',
    )
  }
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
    throw typedError(
      rasterReviewFailureMessage(error),
      422,
      'PDF_RASTER_SLOT_REVIEW_FAILED',
    )
  }
  await reportConversionProgress(
    input.onProgress,
    '页面预检完成，正在构建可编辑 PPTX',
    35,
  )
  const rasterReview = JSON.parse(
    await readFile(rasterReviewReportPath, 'utf8'),
  ) as { pageCount?: unknown }
  const pageCount = Number(rasterReview.pageCount) || 0
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
    rasterOverridesPath,
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
    throw typedError(
      conversionFailureMessage(error),
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
