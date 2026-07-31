import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import JSZip from 'jszip'
import type { EvidenceSource } from './aiBusinessContentService.js'
import {
  PROJECT_QA_DOCUMENT_CATEGORIES,
  type ProjectQaDocumentContent,
  type ProjectQaDraftAnswer,
} from './aiQaPipelineService.js'
import type { QaTemplateProfile } from './aiQaTemplateParser.js'
import { sanitizeClientVisibleEvidenceWording } from './aiClientVisibleTextService.js'

// 核心规范统一使用宋体；生产环境可通过环境变量切换到已批准的宋体实现。
const BODY_FONT = process.env.AI_QA_BODY_FONT || process.env.AI_DOCUMENT_SONG_FONT || 'Songti SC'
const HEADING_FONT = process.env.AI_QA_HEADING_FONT || process.env.AI_DOCUMENT_SONG_FONT || 'Songti SC'
const LATIN_FONT = 'Times New Roman'
const MUTED = '595959'
const ANSWER_HEADING_PATTERN =
  '(?:已确认事实|判断依据|分析判断|证据边界|下一步核验|升级与失效条件|下一步动作|OA\\s*流转边界)'
const STAGE_ANSWER_SECTION_ORDER = [
  '判断依据',
  '升级与失效条件',
  '下一步动作',
  'OA 流转边界',
] as const
const STANDARD_ANSWER_SECTION_ORDER = [
  '已确认事实',
  '分析判断',
  '证据边界',
  '下一步核验',
] as const
const ANSWER_SECTION_ORDERS = [
  STAGE_ANSWER_SECTION_ORDER,
  STANDARD_ANSWER_SECTION_ORDER,
] as const

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

function bodyParagraph(value: string, options: {
  keepNext?: boolean
  firstLine?: boolean
  color?: string
  size?: number
  before?: number
  after?: number
} = {}) {
  const runs = mixedTextRuns(value, {
    size: options.size ?? 22,
    color: options.color ?? '000000',
  })
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    keepNext: options.keepNext,
    keepLines: false,
    spacing: {
      before: options.before ?? 0,
      after: options.after ?? 60,
      line: 360,
    },
    indent: options.firstLine === false ? undefined : { firstLine: 440 },
    children: runs,
  })
}

function questionParagraph(index: number, question: string, pageBreakBefore = false) {
  const visibleQuestion = sanitizeClientVisibleEvidenceWording(question)
  return new Paragraph({
    pageBreakBefore,
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
      ...mixedTextRuns(visibleQuestion, {
        bold: true,
        size: 28,
        color: '000000',
        cjkFont: HEADING_FONT,
      }),
    ],
  })
}

function stripAnswerMarkdown(value: string) {
  return sanitizeClientVisibleEvidenceWording(value)
    .replace(/```(?:json|markdown|md)?/gi, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
}

function stripSourceOutlineMarkers(value: string) {
  return value
    .replace(/[（(][一二三四五六七八九十\d]+[）)]\s*(?=[\u3400-\u9fffA-Za-z])/g, '')
    .replace(/(^|[\s。；;])\d+[、.．]\s*(?=[\u3400-\u9fffA-Za-z])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function parseLegacyAnswerSection(value: string) {
  const heading = new RegExp(
    `^\\s*(?:[（(]?\\s*([1-4])\\s*[）)）]?\\s*[、.．]?)?\\s*(${ANSWER_HEADING_PATTERN})\\s*[：:]\\s*`,
    'i',
  )
  const match = value.match(heading)
  if (!match) return null
  const title = match[2].replace(/\s+/g, ' ').replace(/^oa /i, 'OA ')
  return {
    title,
    body: stripSourceOutlineMarkers(value.slice(match[0].length)),
  }
}

function convertAnswerLinesToParagraphs(lines: string[]) {
  const parsed = lines.map((line) => ({
    line,
    section: parseLegacyAnswerSection(line),
  }))
  const titles = parsed.flatMap((item) => item.section ? [item.section.title] : [])
  const scheme = ANSWER_SECTION_ORDERS.find((candidate) =>
    candidate.length === titles.length
    && candidate.every((title) => titles.filter((item) => item === title).length === 1))
  if (!scheme) {
    return parsed
      .map((item) => stripSourceOutlineMarkers(item.section?.body ?? item.line))
      .filter(Boolean)
  }

  const leading: string[] = []
  const sections = new Map<string, string>()
  let currentTitle = ''
  parsed.forEach(({ line, section }) => {
    if (section) {
      currentTitle = section.title
      sections.set(currentTitle, section.body)
      return
    }
    if (currentTitle) {
      const current = sections.get(currentTitle) ?? ''
      const separator = /[。！？；;：:]$/.test(current) ? '' : '；'
      sections.set(currentTitle, `${current}${separator}${line}`)
    } else {
      leading.push(line)
    }
  })
  return [
    leading.join(''),
    ...scheme.map((title) => sections.get(title) ?? ''),
  ]
    .filter(Boolean)
}

function answerParagraphLines(value: string) {
  const withoutMarkdown = stripAnswerMarkdown(value)
    .replace(/^\s*(?:答复|回答)\s*[：:]\s*/i, '')
    .replace(
      new RegExp(`\\s+(?=(?:[（(]?\\s*[1-4]\\s*[）)）]?\\s*[、.．]?)?\\s*${ANSWER_HEADING_PATTERN}\\s*[：:])`, 'gi'),
      '\n',
    )
  return convertAnswerLinesToParagraphs(withoutMarkdown
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean))
}

function answerParagraphs(answer: ProjectQaDraftAnswer) {
  const paragraphs = answerParagraphLines(answer.answer)
  if (!paragraphs.length) {
    paragraphs.push('现有证据不足以形成确定结论，需取得对应原件、明细数据或相关责任人访谈后判断。')
  }
  const result = paragraphs.map((line, index) =>
    bodyParagraph(line, {
      firstLine: true,
      before: index === 0 ? 0 : 80,
      after: 80,
      color: '000000',
    }))
  return result
}

export function makeProjectQaFileNames(projectName: string, mode: string, timestamp = Date.now()) {
  const base = `${safeName(projectName)}_${safeName(mode)}_${timestamp}`
  return {
    docx: `${base}.docx`,
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
        ...mixedTextRuns(sanitizeClientVisibleEvidenceWording(question.question), {
          size: 24,
          color: '000000',
        }),
      ],
    }))
  })
  input.content.questions.forEach((question, globalIndex) => {
    const answer = input.content.answers.find((item) => item.questionId === question.id)
    // 目录必须完整结束后再进入正文；不在目录中间人为拆页，也不重复标题。
    children.push(questionParagraph(globalIndex, question.question, globalIndex === 0))
    children.push(...answerParagraphs(answer ?? {
      questionId: question.id,
      category: question.category,
      question: question.question,
      answer: '本题回答生成异常，现阶段无法形成确定结论；需重新核验项目材料并将结果补充入项目资料库。',
      sourceIndexes: [],
      supportingQuotes: [],
      confidenceStatus: '证据不足',
      missingInformation: ['回答生成异常，需重新执行。'],
    }))
  })

  const makeHeader = () => new Header({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0 },
      children: mixedTextRuns(`${input.project.companyName || input.project.name} Q&A`, {
        size: 18,
        color: MUTED,
      }),
    })],
  })
  const makeFooter = () => new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        children: [PageNumber.CURRENT],
        font: font(LATIN_FONT),
        size: 18,
        color: MUTED,
      })],
    })],
  })
  const page = {
    size: { width: 11906, height: 16838 },
    margin: { top: 1440, right: 1800, bottom: 1440, left: 1800 },
  }
  const doc = new Document({
    creator: 'Cybernaut Early-stage Lead Q&A Skill',
    title: input.content.title,
    description: `${input.content.mode}内部项目投资问答，基于当前会话绑定项目的资料库生成`,
    styles: {
      default: {
        document: {
          run: { font: font(BODY_FONT), size: 22, color: '000000' },
          paragraph: { spacing: { line: 360, after: 80 } },
        },
      },
    },
    sections: [{
      properties: { page },
      headers: {
        default: makeHeader(),
      },
      footers: {
        default: makeFooter(),
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
  const decodeXmlText = (value: string) => value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
  const visibleParagraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((paragraphMatch) =>
      decodeXmlText(
        [...paragraphMatch[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
          .map((textMatch) => textMatch[1])
          .join(''),
      ).trim())
    .filter(Boolean)
  const questionLabels = visibleText.match(/Q\d+[：:]/g) ?? []
  if (new Set(questionLabels).size < expected.questionCount) {
    throw new Error(`Q&A DOCX 问题数量不足：${new Set(questionLabels).size}/${expected.questionCount}`)
  }
  if (visibleText.includes('问题目录（续）')) {
    throw new Error('Q&A DOCX 不得在固定题号处拆分目录或重复目录标题')
  }
  const expectedLabels = Array.from(
    { length: expected.questionCount },
    (_, index) => `Q${index + 1}：`,
  )
  const secondQ1Index = questionLabels.findIndex((label, index) => index > 0 && label === 'Q1：')
  const directoryLabels = secondQ1Index > 0 ? questionLabels.slice(0, secondQ1Index) : []
  const bodyLabels = secondQ1Index > 0
    ? questionLabels.slice(secondQ1Index, secondQ1Index + expected.questionCount)
    : []
  if (
    directoryLabels.join('|') !== expectedLabels.join('|')
    || bodyLabels.join('|') !== expectedLabels.join('|')
  ) {
    throw new Error('Q&A DOCX 目录或正文题目顺序错误')
  }
  const labelMatches = [...visibleText.matchAll(/Q\d+[：:]/g)]
  const bodyStartMatchIndex = labelMatches.findIndex((match, index) =>
    index > 0 && match[0] === 'Q1：')
  const bodyMatches = bodyStartMatchIndex >= 0
    ? labelMatches.slice(bodyStartMatchIndex, bodyStartMatchIndex + expected.questionCount)
    : []
  bodyMatches.forEach((match, index) => {
    const start = match.index ?? 0
    const end = bodyMatches[index + 1]?.index ?? visibleText.length
    const answerText = visibleText.slice(start, end)
    const visibleSubheading = answerText.match(
      new RegExp(
        `(?:[（(]?\\s*[1-4]\\s*[）)）]?\\s*[、.．]?)?\\s*(${ANSWER_HEADING_PATTERN})\\s*[：:]`,
        'i',
      ),
    )
    if (visibleSubheading) {
      throw new Error(
        `Q&A DOCX 正文 Q${index + 1} 不得显示编号或小标题：${visibleSubheading[0].trim()}`,
      )
    }
    const sourceOutlineMarker = answerText.match(
      /(?:[（(][一二三四五六七八九十\d]+[）)]|\d+[、.．])\s*(?=[\u3400-\u9fffA-Za-z])/,
    )
    if (sourceOutlineMarker) {
      throw new Error(
        `Q&A DOCX 正文 Q${index + 1} 含来源材料章节编号：${sourceOutlineMarker[0].trim()}`,
      )
    }
  })
  const questionParagraphIndexes = visibleParagraphs.flatMap((paragraph, index) =>
    /^Q\d+[：:]/.test(paragraph) ? [index] : [])
  const bodyQ1ParagraphIndexPosition = questionParagraphIndexes.findIndex((paragraphIndex, index) =>
    index > 0 && /^Q1[：:]/.test(visibleParagraphs[paragraphIndex]))
  const bodyQuestionParagraphIndexes = bodyQ1ParagraphIndexPosition >= 0
    ? questionParagraphIndexes.slice(
        bodyQ1ParagraphIndexPosition,
        bodyQ1ParagraphIndexPosition + expected.questionCount,
      )
    : []
  bodyQuestionParagraphIndexes.forEach((paragraphIndex, index) => {
    const nextQuestionIndex = bodyQuestionParagraphIndexes[index + 1] ?? visibleParagraphs.length
    const answerParagraphs = visibleParagraphs
      .slice(paragraphIndex + 1, nextQuestionIndex)
      .filter(Boolean)
    const answerLabel = answerParagraphs.find((paragraph) =>
      /^(?:答复|回答)\s*[：:]/.test(paragraph))
    if (
      answerParagraphs.length !== 5
      || answerLabel
    ) {
      throw new Error(
        answerLabel
          ? `Q&A DOCX 正文 Q${index + 1} 不得显示“答复：”或“回答：”标签`
          : `Q&A DOCX 正文 Q${index + 1} 应为五个连续自然段，实际为 ${answerParagraphs.length} 段`,
      )
    }
  })
  const forbiddenVisibleTerms = [
    '待核验',
    '暂无相关资料',
    '引用资料',
    'Reviewer 审阅结果',
    '模板解析',
    '语料指纹',
    '检索式：',
    'Q&A 分类：',
    '公开检索记录',
    '京ICP备',
    '公网安备',
    'All Rights Reserved',
    '英诺嘿呀助手微信号',
  ]
  const leakedTerm = forbiddenVisibleTerms.find((term) => visibleText.includes(term))
  const leakedSourceIndex = /\[S\d+\]/.test(visibleText)
  const leakedMarkdown = /\*\*|__|```/.test(visibleText)
  if (leakedTerm || leakedSourceIndex || leakedMarkdown) {
    throw new Error(
      `Q&A 正文泄露禁止展示的审计、页面框架或格式标记：${
        leakedTerm ?? (leakedSourceIndex ? '来源编号' : 'Markdown 标记')
      }`,
    )
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
      directoryCompleteBeforeBody: true,
      answerParagraphFormValid: true,
      visibleAnswerLabelsAbsent: true,
      visibleSubheadingsAbsent: true,
      sourceOutlineNumberingAbsent: true,
      visibleAuditAppendixAbsent: true,
      placeholderAnswerAbsent: true,
      markdownDecorationAbsent: true,
      webPageChromeAbsent: true,
    },
  }
}
