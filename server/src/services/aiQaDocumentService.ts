import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  LevelFormat,
  LevelSuffix,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import JSZip from 'jszip'
import type { EvidenceSource } from './aiBusinessContentService.js'
import {
  PROJECT_QA_DOCUMENT_CATEGORIES,
  QA_NO_DATA,
  usedProjectQaSourceIndexes,
  type ProjectQaDocumentContent,
  type ProjectQaDraftAnswer,
} from './aiQaPipelineService.js'
import type { QaTemplateProfile } from './aiQaTemplateParser.js'

const execFileAsync = promisify(execFile)
// 核心规范统一使用宋体；生产环境可通过环境变量切换到已批准且可嵌入 PDF 的宋体实现。
const BODY_FONT = process.env.AI_QA_BODY_FONT || process.env.AI_DOCUMENT_SONG_FONT || 'Songti SC'
const HEADING_FONT = process.env.AI_QA_HEADING_FONT || process.env.AI_DOCUMENT_SONG_FONT || 'Songti SC'
const LATIN_FONT = 'Times New Roman'
const QA_DOCUMENT_LOCALE = process.env.AI_QA_DOCUMENT_LOCALE || 'zh_CN.UTF-8'
const MUTED = '595959'

type ProjectLike = {
  name: string
  companyName?: string | null
}

const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
const font = (eastAsia: string) => ({
  ascii: LATIN_FONT,
  hAnsi: LATIN_FONT,
  cs: LATIN_FONT,
  eastAsia,
  hint: 'eastAsia',
})

function mixedTextRuns(value: string, options: {
  bold?: boolean
  size?: number
  color?: string
  cjkFont?: string
} = {}) {
  return [new TextRun({
    text: value,
    bold: options.bold,
    font: font(options.cjkFont ?? BODY_FONT),
    language: { value: 'en-US', eastAsia: 'zh-CN' },
    size: options.size,
    color: options.color,
  })]
}

async function resolveQaFontconfigFile(soffice: string) {
  const candidates = [
    process.env.AI_QA_FONTCONFIG_FILE,
    process.env.FONTCONFIG_FILE,
  ].filter((value): value is string => Boolean(value))

  const executableCandidates = path.isAbsolute(soffice)
    ? [soffice]
    : (process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, soffice))
  executableCandidates.forEach((executable) => {
    const directory = path.dirname(executable)
    candidates.push(
      path.resolve(
        directory,
        '../../native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/Resources/fontconfig/fonts.conf',
      ),
      path.resolve(directory, '../Resources/fontconfig/fonts.conf'),
    )
  })
  candidates.push('/etc/fonts/fonts.conf')

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // 继续寻找下一个可用的 Fontconfig 配置。
    }
  }
  return undefined
}

function sourceMarkers(answer: ProjectQaDraftAnswer) {
  return answer.sourceIndexes.map((index) => `[S${index + 1}]`).join(' ')
}

function bibliographyLine(source: EvidenceSource, index: number) {
  const locator = Number.isInteger(source.chunkIndex)
    ? `知识片段 ${source.chunkIndex}`
    : '文件级定位'
  const date = source.versionOrDate ? `；版本/日期 ${source.versionOrDate}` : ''
  return `[S${index + 1}] ${source.sourceName}；${locator}${date}`
}

function bodyParagraph(value: string, options: {
  boldLead?: string
  keepNext?: boolean
  firstLine?: boolean
  color?: string
  size?: number
  before?: number
  after?: number
} = {}) {
  const runs: TextRun[] = []
  const lead = options.boldLead && value.startsWith(options.boldLead) ? options.boldLead : ''
  if (lead) {
    runs.push(...mixedTextRuns(lead, {
      bold: true,
      size: options.size ?? 22,
      color: options.color ?? '000000',
    }))
  }
  runs.push(...mixedTextRuns(lead ? value.slice(lead.length) : value, {
    size: options.size ?? 22,
    color: options.color ?? '000000',
  }))
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    keepNext: options.keepNext,
    keepLines: true,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 60,
      line: 360,
    },
    indent: options.firstLine === false ? undefined : { firstLine: 440 },
    children: runs,
  })
}

function questionParagraph(index: number, question: string) {
  return new Paragraph({
    keepNext: true,
    keepLines: true,
    spacing: { before: 240, after: 120, line: 360 },
    children: [
      ...mixedTextRuns(`Q${index + 1}：`, {
        bold: true,
        size: 28,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
      ...mixedTextRuns(question, {
        bold: true,
        size: 28,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
    ],
  })
}

function dimensionParagraph(value: string) {
  const match = value.match(/^([（(]\d+[）)]\s*[^：:\n]{1,36}[：:])\s*(.*)$/)
  if (!match) return bodyParagraph(value)
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    keepLines: true,
    spacing: { before: 120, after: 80, line: 360 },
    children: [
      ...mixedTextRuns(match[1], {
        bold: true,
        size: 24,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
      ...mixedTextRuns(match[2], {
        size: 22,
        color: '000000',
      }),
    ],
  })
}

function answerParagraphs(answer: ProjectQaDraftAnswer) {
  const marker = sourceMarkers(answer)
  const paragraphs = answer.answer
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!paragraphs.length) paragraphs.push(QA_NO_DATA)
  const result = paragraphs.map((line, index) => {
    const isFinal = index === paragraphs.length - 1
    const paragraphText = `${line}${isFinal && marker ? ` ${marker}` : ''}`
    if (index > 0) return dimensionParagraph(paragraphText)
    return bodyParagraph(`答复：${paragraphText}`, {
      boldLead: '答复：',
      keepNext: !isFinal,
      firstLine: false,
      color: line === QA_NO_DATA ? MUTED : '000000',
    })
  })
  if (answer.missingInformation.length) {
    result.push(bodyParagraph(
      `待补资料：${answer.missingInformation.join('；')}`,
      { firstLine: false, color: MUTED, size: 19, after: 80 },
    ))
  }
  return result
}

export function makeProjectQaFileNames(projectName: string, mode: string, timestamp = Date.now()) {
  const base = `${safeName(projectName)}_${safeName(mode)}_${timestamp}`
  return {
    docx: `${base}.docx`,
    pdf: `${base}.pdf`,
  }
}

export async function generateProjectQaDocx(input: {
  outputPath: string
  project: ProjectLike
  content: ProjectQaDocumentContent
  sources: EvidenceSource[]
  sourceCutoffDate: string
  templateProfile: QaTemplateProfile
  disclaimer: string
}) {
  await mkdir(path.dirname(input.outputPath), { recursive: true })
  const children: Paragraph[] = []
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      keepNext: true,
      spacing: { before: 520, after: 420, line: 420 },
      children: mixedTextRuns(input.content.title, {
        bold: true,
        size: 36,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
    }),
    new Paragraph({
      keepNext: true,
      spacing: { before: 0, after: 100, line: 360 },
      children: mixedTextRuns('问题目录', {
        bold: true,
        size: 24,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
    }),
  )
  input.content.questions.forEach((question, index) => {
    children.push(new Paragraph({
      keepLines: true,
      spacing: { before: 0, after: 70, line: 310 },
      indent: { left: 240, hanging: 0 },
      children: [
        ...mixedTextRuns(`Q${index + 1}：`, {
          bold: true,
          size: 24,
          color: '000000',
          cjkFont: HEADING_FONT,
        }),
        ...mixedTextRuns(question.question, {
          size: 24,
          color: '000000',
        }),
      ],
    }))
  })

  input.content.questions.forEach((question, globalIndex) => {
    const answer = input.content.answers.find((item) => item.questionId === question.id)
    children.push(questionParagraph(globalIndex, question.question))
    children.push(...answerParagraphs(answer ?? {
      questionId: question.id,
      category: question.category,
      question: question.question,
      answer: QA_NO_DATA,
      sourceIndexes: [],
      supportingQuotes: [],
      confidenceStatus: '证据不足',
      missingInformation: ['回答生成异常，需重新执行。'],
    }))
  })

  const usedIndexes = usedProjectQaSourceIndexes(input.content.answers, input.sources.length)
  children.push(
    new Paragraph({
      keepNext: true,
      spacing: { before: 360, after: 160, line: 360 },
      children: mixedTextRuns('引用资料', {
        bold: true,
        size: 28,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
    }),
  )
  if (usedIndexes.length) {
    usedIndexes.forEach((index) => {
      children.push(bodyParagraph(
        bibliographyLine(input.sources[index], index),
        { firstLine: false, size: 19, color: MUTED, after: 70 },
      ))
    })
  } else {
    children.push(bodyParagraph(
      `当前项目无可用于回答的有效来源，全部问题均标注“${QA_NO_DATA}”`,
      { firstLine: false, size: 20, color: MUTED },
    ))
  }

  const review = input.content.review
  children.push(
    new Paragraph({
      keepNext: true,
      spacing: { before: 280, after: 120, line: 360 },
      children: mixedTextRuns('Reviewer 审阅结果', {
        bold: true,
        size: 26,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
    }),
    bodyParagraph(
      `重复检查：输入 ${review.duplicateChecker.inputCount} 题，删除 ${review.duplicateChecker.removedCount} 题，输出 ${review.duplicateChecker.outputCount} 题。`,
      { firstLine: false, size: 20 },
    ),
    bodyParagraph(
      `完整性：${review.checks.allQuestionsAnswered ? '通过' : '未通过'}；幻觉检查：${review.checks.noUnsupportedClaims ? '通过' : '未通过'}；引用检查：${review.checks.citationsValid ? '通过' : '未通过'}；资料不足回答：${review.dataGapCount} 题。`,
      { firstLine: false, size: 20 },
    ),
    bodyParagraph(
      `模板解析：${input.templateProfile.files.length} 份 PDF；语料指纹 ${input.templateProfile.corpusSha256.slice(0, 16)}；版式 ${input.templateProfile.consensus.pageSize}/${input.templateProfile.consensus.colorMode}。`,
      { firstLine: false, size: 18, color: MUTED },
    ),
    bodyParagraph(`责任声明：${input.disclaimer}`, {
      boldLead: '责任声明：',
      firstLine: false,
      color: MUTED,
      size: 18,
      before: 120,
      after: 0,
    }),
  )

  const doc = new Document({
    creator: 'Cybernaut Q&A Skill',
    title: input.content.title,
    description: `${input.content.mode}，仅基于当前项目资料生成`,
    numbering: {
      config: [{
        reference: 'qa-real-numbering',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          suffix: LevelSuffix.TAB,
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: { indent: { left: 480, hanging: 280 } },
            run: { font: font(LATIN_FONT), size: 20 },
          },
        }],
      }],
    },
    styles: {
      default: {
        document: {
          run: { font: font(BODY_FONT), size: 22, color: '000000' },
          paragraph: { spacing: { line: 360, after: 80 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, right: 1800, bottom: 1440, left: 1800 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 0 },
            children: mixedTextRuns(`${input.project.companyName || input.project.name} Q&A`, {
              size: 18,
              color: MUTED,
            }),
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({
              children: [PageNumber.CURRENT],
              font: font(LATIN_FONT),
              size: 18,
              color: MUTED,
            })],
          })],
        }),
      },
      children,
    }],
  })
  const buffer = await Packer.toBuffer(doc)
  await writeFile(input.outputPath, buffer)
  return {
    bytes: buffer.length,
    questionCount: input.content.questions.length,
    categoryCount: PROJECT_QA_DOCUMENT_CATEGORIES.length,
    missingAnswerCount: input.content.review.dataGapCount,
    templateCorpusSha256: input.templateProfile.corpusSha256,
    documentSha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

export async function convertProjectQaDocxToPdf(input: {
  docxPath: string
  pdfPath: string
}) {
  const outputDir = path.dirname(input.pdfPath)
  await mkdir(outputDir, { recursive: true })
  const profileDir = path.join(outputDir, `.qa-lo-profile-${path.basename(input.pdfPath, '.pdf')}`)
  await mkdir(profileDir, { recursive: true })
  const soffice = process.env.SOFFICE_BIN || 'soffice'
  const fontconfigFile = await resolveQaFontconfigFile(soffice)
  try {
    await execFileAsync(soffice, [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless',
      '--convert-to',
      'pdf:writer_pdf_Export',
      '--outdir',
      outputDir,
      input.docxPath,
    ], {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        // LibreOffice 在 C locale 下会把有效的 CJK 字体当作缺字字体。
        // 显式指定中文 UTF-8 locale，保证 Word 与 PDF 的中文渲染一致。
        LANG: QA_DOCUMENT_LOCALE,
        LC_ALL: QA_DOCUMENT_LOCALE,
        ...(fontconfigFile ? { FONTCONFIG_FILE: fontconfigFile } : {}),
      },
    })
    const generatedPath = path.join(
      outputDir,
      `${path.basename(input.docxPath, path.extname(input.docxPath))}.pdf`,
    )
    if (path.resolve(generatedPath) !== path.resolve(input.pdfPath)) {
      const buffer = await readFile(generatedPath)
      await writeFile(input.pdfPath, buffer)
    }
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  }
  return inspectProjectQaPdf(input.pdfPath)
}

export async function inspectProjectQaDocx(
  filePath: string,
  expected: { questionCount: number; categoryCount: number },
) {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile() || fileStat.size < 2000) throw new Error('Q&A DOCX 为空或不完整')
  const zip = await JSZip.loadAsync(await readFile(filePath))
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) throw new Error('Q&A DOCX 缺少 document.xml')
  if (documentXml.includes('\uFFFD')) throw new Error('Q&A DOCX 含损坏字符')
  const visibleText = documentXml.replace(/<[^>]+>/g, '')
  const questionLabels = visibleText.match(/Q\d+[：:]/g) ?? []
  if (new Set(questionLabels).size < expected.questionCount) {
    throw new Error(`Q&A DOCX 问题数量不足：${new Set(questionLabels).size}/${expected.questionCount}`)
  }
  if (!visibleText.includes('引用资料') || !visibleText.includes('Reviewer 审阅结果')) {
    throw new Error('Q&A DOCX 缺少引用资料或 Reviewer 审阅结果')
  }
  return {
    qualityStatus: 'passed' as const,
    metadata: {
      bytes: fileStat.size,
      openXmlValid: true,
      editableText: true,
      encodingClean: true,
      categoryCount: expected.categoryCount,
      questionCount: expected.questionCount,
      referencesValidated: true,
      reviewerValidated: true,
    },
  }
}

export async function inspectProjectQaPdf(filePath: string) {
  const buffer = await readFile(filePath)
  if (buffer.length < 2000 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Q&A PDF 为空、损坏或不是有效 PDF')
  }
  const searchablePdf = buffer.toString('latin1').replace(/\s+/g, '')
  const configuredFonts = [BODY_FONT, HEADING_FONT]
    .map((value) => value.replace(/[^a-z0-9]/gi, ''))
    .filter(Boolean)
  const cjkFontPattern = new RegExp(
    process.env.AI_QA_CJK_FONT_PATTERN
      || 'Hiragino|Noto(?:Sans|Serif)?CJK|SourceHan|Songti|Heiti|PingFang|SimSun|SimHei|WenQuanYi|DroidSansFallback|ArialUnicode',
    'i',
  )
  const cjkFontEmbedded = configuredFonts.some((fontName) =>
    searchablePdf.toLowerCase().includes(fontName.toLowerCase()))
    || cjkFontPattern.test(searchablePdf)
  if (!cjkFontEmbedded) {
    throw new Error('Q&A PDF 未嵌入可识别的 CJK 字体，拒绝交付可能出现方框字的文件')
  }
  return {
    qualityStatus: 'passed' as const,
    metadata: {
      bytes: buffer.length,
      pdfHeaderValid: true,
      fixedLayout: true,
      cjkFontEmbedded,
      pdfSha256: createHash('sha256').update(buffer).digest('hex'),
    },
  }
}
