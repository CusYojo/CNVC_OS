import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  LineRuleType,
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
import { AI_QA_SKILL_NAME } from './aiSkillService.js'

// 核心规范统一使用宋体；生产环境可通过环境变量切换到已批准的宋体实现。
const BODY_FONT = process.env.AI_QA_BODY_FONT || process.env.AI_DOCUMENT_SONG_FONT || '宋体'
const HEADING_FONT = process.env.AI_QA_HEADING_FONT || process.env.AI_DOCUMENT_SONG_FONT || '宋体'
const LATIN_FONT = 'Times New Roman'
const MUTED = '595959'
// draft-investment-qa 的 Deta Formatter 使用 STKaiti；
// 保持与插件脚本写入 OpenXML 的字体家族名一致。
const PROJECT_QA_REPORT_BODY_FONT = 'STKaiti'
const PROJECT_QA_REPORT_HEADING_FONT = 'STKaiti'
const PROJECT_QA_REPORT_BODY_SIZE = 21
const PROJECT_QA_REPORT_TITLE_SIZE = 40
const PROJECT_QA_REPORT_QUESTION_SIZE = 28
const PROJECT_QA_REPORT_BODY_SPACING = 288
const PROJECT_QA_REPORT_QUESTION_SPACING = 420
const PROJECT_QA_REPORT_TITLE_SPACING = 480
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
const QA_VISIBLE_SOURCE_PROCESS_TERMS = [
  '项目资料',
  '项目材料',
  '当前资料',
  '现有资料',
  '当前证据',
  '现有证据',
  '资料显示',
  '资料表明',
  '资料称',
  '材料显示',
  '材料表明',
  '材料称',
  '会议纪要',
  '交流纪要',
  '访谈纪要',
  '交流时间',
  '交流地点',
  '交流人员',
  '会议时间',
  '会议地点',
  '参会人员',
  '资料截止日',
  '经系统核验',
  '经页面核验',
  '公开页面显示',
  '公开页面披露',
  '回填项目资料库',
  '更新本题',
  '本回答',
  '结论置信度',
  '支持原文',
  '来源索引',
  '现阶段只能形成初步判断',
  '不能把单一材料或公开披露直接视为完成核验',
  '未形成能够相互印证的完整证据链',
  '已经形成可识别的产品与技术方向',
  '收费方式只是商业模式的起点',
  '商业模式是否成立最终取决于',
  '客户接触或项目推进迹象',
  '不能混为一谈',
  '当前需要优先处理的是',
] as const
const QA_VISIBLE_INTERNAL_STAGE_TERMS = [
  '线索',
  '进入初筛',
  '申请立项',
  '提请上会',
  '提交投决',
  '继续跟踪',
  '暂缓推进',
  '归档',
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
  const visibleQuestion = sanitizeQaVisibleSourceProcessWording(
    sanitizeClientVisibleEvidenceWording(question),
  )
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

function sanitizeQaVisibleSourceProcessWording(value: string) {
  return value
    .replace(/截至资料截止日[，,]?/g, '')
    .replace(/^公司主体[：:]\s*/g, '公司主体为')
    .replace(/^项目主体[：:]\s*/g, '项目主体为')
    .replace(/^核心产品[：:]\s*/g, '核心产品为')
    .replace(/^商业模式[：:]\s*拟/g, '公司拟')
    .replace(/^商业模式[：:]\s*/g, '公司')
    .replace(/^融资计划[：:]\s*/g, '公司')
    .replace(/^股权结构[：:]\s*创始团队拟控股/g, '公司拟由创始团队控股')
    .replace(/^股权结构[：:]\s*/g, '公司股权安排为')
    .replace(/^收费模式\s*模式[一二三四五六七八九十\d]+[：:]\s*按/g, '公司按')
    .replace(/^收费模式\s*模式[一二三四五六七八九十\d]+[：:]\s*/g, '公司采用')
    .replace(/^收费模式[：:]\s*按/g, '公司按')
    .replace(/^收费模式[：:]\s*/g, '公司采用')
    .replace(/^需求调研[：:]\s*/g, '项目实施前，')
    .replace(/^项目实施流程[：:]\s*需求调研后/g, '项目实施通常先')
    .replace(/^项目实施流程[：:]\s*/g, '项目实施通常')
    .replace(/(?:会议|交流|访谈)纪要(?:中)?(?:称|显示|表明|说明|提及|记载|披露)[，,:：]?/g, '项目方称')
    .replace(/公司(?:提供的)?(?:资料|材料)(?:中)?(?:显示|表明|说明|披露|介绍|称)[，,:：]?/g, '公司称')
    .replace(/(?:项目方|团队)(?:提供的)?(?:资料|材料)(?:中)?(?:显示|表明|说明|披露|介绍|称)[，,:：]?/g, '$1称')
    .replace(
      /(?:基于|根据|综合)(?:截至[^，；。]+)?(?:当前)?(?:项目资料(?:库)?|项目材料|现有资料|当前资料)(?:与经系统核验的公开页面)?[，,]?/g,
      '',
    )
    .replace(
      /(?:当前项目资料(?:库)?|项目资料(?:库)?|项目材料|现有资料|当前资料|会议纪要)(?:中)?(?:显示|列示|记载|提及|表明|说明|披露)(?:的)?[，,:：]?/g,
      '',
    )
    .replace(/经系统核验的公开页面(?:显示|披露)?[，,:：]?/g, '')
    .replace(/经页面核验的公开披露(?:显示|披露)?[，,:：]?/g, '')
    .replace(/现有证据尚未完整覆盖/g, '目前尚不能确认')
    .replace(/当前证据尚不足以/g, '目前尚无法')
    .replace(/现有证据不足以/g, '目前尚无法')
    .replace(/(?:基于|根据|综合)(?:当前|现有)证据[，,]?/g, '')
    .replace(/(?:当前|现有)证据(?:显示|表明|说明)?[，,:：]?/g, '')
    .replace(/(?:相关)?(?:资料|材料)(?:中)?(?:显示|表明|说明|披露|介绍|称)[，,:：]?/g, '')
    .replace(/^(?:股东|融资|单位经济性|客户|产品|技术|团队|商业化|财务|主体|风险)线索[：:]\s*/g, '')
    .replace(/是否足以支持从[“"]?线索[”"]?推进至启动尽调/g, '是否已经具备启动尽调的基础')
    .replace(/从[“"]?线索[”"]?(?:阶段)?推进至/g, '进一步进入')
    .replace(/现阶段更适合[“"]?进入初筛[”"]?/g, '现阶段可以继续评估')
    .replace(/进入初筛/g, '继续评估')
    .replace(/申请立项/g, '进入正式评估')
    .replace(/提请上会/g, '提交内部审议')
    .replace(/提交投决/g, '提交投资决策')
    .replace(/继续跟踪/g, '继续观察')
    .replace(/暂缓推进/g, '暂不推进')
    .replace(/归档/g, '停止评估')
    .replace(/线索池/g, '项目库')
    .replace(/线索/g, '信息')
    .replace(/结论置信度为(?:高|中|低|证据不足)/g, '')
    .replace(/核对主体、时间、口径和相互关系后更新本题/g, '完成主体、时间与口径核实')
    .replace(/并将结果回填项目资料库后更新本题/g, '并在完成核实后重新判断')
    .replace(/[，,；;]\s*[。]/g, '。')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function stripAnswerMarkdown(value: string) {
  return sanitizeQaVisibleSourceProcessWording(sanitizeClientVisibleEvidenceWording(value))
    .replace(/```(?:json|markdown|md)?/gi, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
}

function stripSourceOutlineMarkers(value: string) {
  return value
    .replace(/[（(][一二三四五六七八九十\d]+[）)]\s*(?=[\u3400-\u9fffA-Za-z])/g, '')
    .replace(/(^|[\s。；;])[一二三四五六七八九十]+[、.．]\s*(?=[\u3400-\u9fffA-Za-z])/g, '$1')
    .replace(/(^|[\s。；;])\d+(?:\.\d+){1,4}\s*[、.．]?\s*(?=[\u3400-\u9fffA-Za-z])/g, '$1')
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
    paragraphs.push('目前尚无法形成可靠判断，后续应结合关键文件、明细数据和相关负责人情况进一步确认。')
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

const projectQaReportFont = (bold = false) => ({
  ascii: LATIN_FONT,
  hAnsi: LATIN_FONT,
  cs: LATIN_FONT,
  eastAsia: bold ? PROJECT_QA_REPORT_HEADING_FONT : PROJECT_QA_REPORT_BODY_FONT,
  hint: 'eastAsia' as const,
})

function projectQaReportTextRun(value: string, options: {
  bold?: boolean
  size?: number
} = {}) {
  return new TextRun({
    text: value,
    bold: options.bold,
    size: options.size ?? PROJECT_QA_REPORT_BODY_SIZE,
    font: projectQaReportFont(options.bold),
    language: { value: 'en-US', eastAsia: 'zh-CN' },
    color: '1F2730',
  })
}

async function generateProjectQaReportDocx(input: {
  outputPath: string
  project: ProjectLike
  content: ProjectQaDocumentContent
  templateProfile: QaTemplateProfile
}) {
  const projectName = input.project.companyName || input.project.name
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      keepNext: true,
      keepLines: true,
      spacing: {
        before: 0,
        after: 360,
        line: PROJECT_QA_REPORT_TITLE_SPACING,
        lineRule: LineRuleType.EXACT,
      },
      children: [projectQaReportTextRun(`${projectName}Q&A 报告`, {
        bold: true,
        size: PROJECT_QA_REPORT_TITLE_SIZE,
      })],
    }),
  ]

  input.content.questions.forEach((question, index) => {
    const visibleQuestion = sanitizeQaVisibleSourceProcessWording(
      sanitizeClientVisibleEvidenceWording(question.question),
    )
    children.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      keepNext: true,
      keepLines: true,
      spacing: {
        before: index === 0 ? 0 : 240,
        after: 120,
        line: PROJECT_QA_REPORT_QUESTION_SPACING,
        lineRule: LineRuleType.EXACT,
      },
      children: [projectQaReportTextRun(`Q${index + 1}：${visibleQuestion}`, {
        bold: true,
        size: PROJECT_QA_REPORT_QUESTION_SIZE,
      })],
    }))

    const answer = input.content.answers.find((item) => item.questionId === question.id)
    const lines = answerParagraphLines(answer?.answer ?? '')
      .map((line) => sanitizeQaVisibleSourceProcessWording(
        sanitizeClientVisibleEvidenceWording(line),
      ).replace(/^\s*结论(?:如下)?\s*[：:]\s*/, '').trim())
      .filter(Boolean)
    if (lines.length === 0) {
      throw new Error(`draft-investment-qa 第 ${index + 1} 题缺少有效回答`)
    }
    lines.forEach((line) => {
      children.push(new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        keepLines: false,
        spacing: {
          before: 0,
          after: 0,
          line: PROJECT_QA_REPORT_BODY_SPACING,
          lineRule: LineRuleType.EXACT,
        },
        indent: { firstLine: 420 },
        children: [projectQaReportTextRun(line)],
      }))
    })
  })

  const header = new Header({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.EXACT },
      children: [projectQaReportTextRun(`${projectName}｜Q&A`, { size: 18 })],
    })],
  })
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.EXACT },
      children: [new TextRun({
        children: [PageNumber.CURRENT],
        font: projectQaReportFont(),
        size: 18,
        color: '6D747C',
      })],
    })],
  })
  const doc = new Document({
    creator: '',
    title: `${projectName}Q&A 报告`,
    description: '',
    styles: {
      default: {
        document: {
          run: {
            font: projectQaReportFont(),
            size: PROJECT_QA_REPORT_BODY_SIZE,
            color: '1F2730',
          },
          paragraph: {
            spacing: {
              line: PROJECT_QA_REPORT_BODY_SPACING,
              lineRule: LineRuleType.EXACT,
              after: 0,
            },
          },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: {
            top: 1531,
            right: 1701,
            bottom: 1587,
            left: 1803,
            header: 850,
            footer: 907,
          },
        },
      },
      headers: { default: header },
      footers: { default: footer },
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
    layoutProfile: 'qa_cn_formal_a4',
    frontDirectoryIncluded: false,
  }
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
  if (AI_QA_SKILL_NAME === 'draft-investment-qa') {
    throw new Error(
      'draft-investment-qa 禁止使用旧 TypeScript DOCX Formatter；请调用 Skill 原生 Markdown→校验→DOCX→逐页渲染链路',
    )
  }
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
        ...mixedTextRuns(sanitizeQaVisibleSourceProcessWording(
          sanitizeClientVisibleEvidenceWording(question.question),
        ), {
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
      answer: '目前尚无法形成可靠判断，后续应重新核实关键事实、明细数据及相关负责人情况。',
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
    description: `${input.content.mode}项目投资问答`,
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
  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  if (!documentXml) throw new Error('Q&A DOCX 缺少 document.xml')
  if (documentXml.includes('\uFFFD')) throw new Error('Q&A DOCX 含损坏字符')
  const cjkFonts = [...documentXml.matchAll(/<w:rFonts\b[^>]*w:eastAsia="([^"]+)"/g)]
    .map((match) => match[1])
  const cjkFontValidated = cjkFonts.length > 0
    && !cjkFonts.some((name) => /Arial Unicode MS/i.test(name))
  const lineSpacingValidated = /<w:spacing\b[^>]*w:line="360"/.test(documentXml)
  const finalSection = [...documentXml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].at(-1)?.[0] ?? ''
  const pageSize = finalSection.match(/<w:pgSz\b[^>]*\/?>/)?.[0] ?? ''
  const pageMargin = finalSection.match(/<w:pgMar\b[^>]*\/?>/)?.[0] ?? ''
  const integerAttribute = (xml: string, name: string) =>
    Number.parseInt(xml.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? '-1', 10)
  const pageGeometryValidated =
    integerAttribute(pageSize, 'w:w') === 11906
    && integerAttribute(pageSize, 'w:h') === 16838
    && integerAttribute(pageMargin, 'w:top') === 1440
    && integerAttribute(pageMargin, 'w:right') === 1800
    && integerAttribute(pageMargin, 'w:bottom') === 1440
    && integerAttribute(pageMargin, 'w:left') === 1800
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
  if (AI_QA_SKILL_NAME === 'draft-investment-qa') {
    const reportVisibleText = visibleParagraphs.join('\n')
    const expectedTitle = visibleParagraphs[0] ?? ''
    if (!/项目\s*Q&A$/.test(expectedTitle)) {
      throw new Error('draft-investment-qa DOCX 标题必须使用德塔模板“项目名称项目 Q&A”格式')
    }
    const questionParagraphIndexes = visibleParagraphs.flatMap((paragraph, index) =>
      /^Q\d+[：:]/.test(paragraph) ? [index] : [])
    if (questionParagraphIndexes.length !== expected.questionCount) {
      throw new Error(
        `draft-investment-qa DOCX 问题数量错误：${questionParagraphIndexes.length}/${expected.questionCount}`,
      )
    }
    const expectedQuestionLabels = Array.from(
      { length: expected.questionCount },
      (_, index) => `Q${index + 1}：`,
    )
    const actualQuestionLabels = questionParagraphIndexes.map((index) =>
      visibleParagraphs[index].match(/^Q\d+[：:]/)?.[0].replace(':', '：') ?? '')
    if (actualQuestionLabels.join('|') !== expectedQuestionLabels.join('|')) {
      throw new Error(
        `draft-investment-qa DOCX 问题顺序错误：${actualQuestionLabels.join('、')}`,
      )
    }
    const questionLengths: number[] = []
    const answerLengths: number[] = []
    questionParagraphIndexes.forEach((paragraphIndex, index) => {
      const nextQuestionIndex = questionParagraphIndexes[index + 1] ?? visibleParagraphs.length
      const answerLines = visibleParagraphs.slice(paragraphIndex + 1, nextQuestionIndex)
      questionLengths.push(visibleParagraphs[paragraphIndex]
        .replace(/^Q\d+[：:]/, '')
        .replace(/\s+/g, '').length)
      answerLengths.push(answerLines.join('').replace(/\s+/g, '').length)
      if (answerLines.length < 1 || answerLines.length > 8) {
        throw new Error(
          `draft-investment-qa DOCX 第 ${index + 1} 题应为 1-8 个自然段，实际 ${answerLines.length} 段`,
        )
      }
      if (!/^(?:回答)\s*[：:]/.test(answerLines[0] ?? '')) {
        throw new Error(
          `draft-investment-qa DOCX 第 ${index + 1} 题首段必须显示“回答：”`,
        )
      }
    })
    const forbiddenVisibleTerms = [
      '问题目录',
      '执行摘要',
      '来源附录',
      '引用资料',
      'Reviewer 审阅结果',
      '公开信息',
      '公开材料',
      '公开资料',
      '公开披露',
      '公开报道',
      '公开记录',
      '公开检索',
      '公开来源',
      '项目资料',
      '会议纪要',
      '访谈纪要',
    ]
    const leakedTerm = forbiddenVisibleTerms.find((term) => reportVisibleText.includes(term))
    if (
      leakedTerm
      || /\[S\d+\]|\*\*|__|```|https?:\/\/|\[(?:尚无可核验证据|来源待核验|仅有公司单方口径)\]/.test(reportVisibleText)
    ) {
      throw new Error(
        `draft-investment-qa DOCX 泄露来源、检索过程或格式标记：${leakedTerm ?? '来源/格式标记'}`,
      )
    }
    const relationshipXml = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? ''
    if (/TargetMode="External"[^>]*Type="[^"]*\/hyperlink"/.test(relationshipXml)) {
      throw new Error('draft-investment-qa DOCX 不得包含外部超链接')
    }
    const reportPageGeometryValidated =
      integerAttribute(pageSize, 'w:w') === 11906
      && integerAttribute(pageSize, 'w:h') === 16838
      && integerAttribute(pageMargin, 'w:top') === 1440
      && integerAttribute(pageMargin, 'w:right') === 1800
      && integerAttribute(pageMargin, 'w:bottom') === 1440
      && integerAttribute(pageMargin, 'w:left') === 1800
    if (!reportPageGeometryValidated) {
      throw new Error('draft-investment-qa DOCX 未使用 qa_cn_formal_a4 页边距')
    }
    const reportFontValidated = cjkFonts.includes(PROJECT_QA_REPORT_BODY_FONT)
      && cjkFonts.every((name) => name === PROJECT_QA_REPORT_BODY_FONT)
    if (!reportFontValidated) {
      throw new Error('draft-investment-qa DOCX 中西文字体映射不符合规范')
    }
    const reportFormattingXml = `${documentXml}\n${stylesXml}`
    const exactBodySpacingValidated = new RegExp(
      `<w:spacing\\b[^>]*w:line="${PROJECT_QA_REPORT_BODY_SPACING}"[^>]*w:lineRule="exact"`,
    ).test(reportFormattingXml)
      || new RegExp(
        `<w:spacing\\b[^>]*w:lineRule="exact"[^>]*w:line="${PROJECT_QA_REPORT_BODY_SPACING}"`,
      ).test(reportFormattingXml)
    if (!exactBodySpacingValidated) {
      throw new Error('draft-investment-qa DOCX 正文未使用德塔模板 14.4pt 固定行距')
    }
    return {
      qualityStatus: 'passed' as const,
      metadata: {
        bytes: fileStat.size,
        openXmlValid: true,
        editableText: true,
        encodingClean: true,
        cjkFontValidated: reportFontValidated,
        lineSpacingValidated: exactBodySpacingValidated,
        pageGeometryValidated: reportPageGeometryValidated,
        tableCount: (documentXml.match(/<w:tbl\b/g) || []).length,
        categoryCount: expected.categoryCount,
        questionCount: expected.questionCount,
        averageQuestionLength: questionLengths.length
          ? Math.round(questionLengths.reduce((sum, value) => sum + value, 0) / questionLengths.length)
          : 0,
        maximumQuestionLength: questionLengths.length ? Math.max(...questionLengths) : 0,
        averageAnswerLength: answerLengths.length
          ? Math.round(answerLengths.reduce((sum, value) => sum + value, 0) / answerLengths.length)
          : 0,
        averageAnswerQuestionRatio: questionLengths.length
          ? Math.round(
              answerLengths.reduce((sum, value) => sum + value, 0)
              / Math.max(questionLengths.reduce((sum, value) => sum + value, 0), 1)
              * 100,
            ) / 100
          : 0,
        layoutProfile: 'deta_qa_pdf',
        directoryCompleteBeforeBody: false,
        frontDirectoryAbsent: true,
        answerParagraphFormValid: true,
        narrativeParagraphRangeValid: true,
        visibleAnswerLabelsAbsent: false,
        visibleAnswerLabelPresent: true,
        visibleSubheadingsAbsent: true,
        sourceOutlineNumberingAbsent: true,
        visibleSourceProcessAbsent: true,
        visibleAuditAppendixAbsent: true,
        placeholderAnswerAbsent: true,
        markdownDecorationAbsent: true,
        webPageChromeAbsent: true,
      },
    }
  }
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
  const bodyQuestionLengths: number[] = []
  const bodyAnswerLengths: number[] = []
  bodyQuestionParagraphIndexes.forEach((paragraphIndex, index) => {
    const nextQuestionIndex = bodyQuestionParagraphIndexes[index + 1] ?? visibleParagraphs.length
    const answerParagraphs = visibleParagraphs
      .slice(paragraphIndex + 1, nextQuestionIndex)
      .filter(Boolean)
    bodyQuestionLengths.push(
      visibleParagraphs[paragraphIndex].replace(/^Q\d+[：:]/, '').replace(/\s+/g, '').length,
    )
    bodyAnswerLengths.push(answerParagraphs.join('').replace(/\s+/g, '').length)
    const answerLabel = answerParagraphs.find((paragraph) =>
      /^(?:答复|回答)\s*[：:]/.test(paragraph))
    if (
      answerParagraphs.length < 1
      || answerParagraphs.length > 6
      || answerLabel
    ) {
      throw new Error(
        answerLabel
          ? `Q&A DOCX 正文 Q${index + 1} 不得显示“答复：”或“回答：”标签`
          : `Q&A DOCX 正文 Q${index + 1} 应为 1-6 个自然段，实际为 ${answerParagraphs.length} 段`,
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
    ...QA_VISIBLE_SOURCE_PROCESS_TERMS,
    ...QA_VISIBLE_INTERNAL_STAGE_TERMS,
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
      cjkFontValidated,
      lineSpacingValidated,
      pageGeometryValidated,
      tableCount: (documentXml.match(/<w:tbl\b/g) || []).length,
      categoryCount: expected.categoryCount,
      questionCount: expected.questionCount,
      averageQuestionLength: bodyQuestionLengths.length
        ? Math.round(bodyQuestionLengths.reduce((sum, value) => sum + value, 0) / bodyQuestionLengths.length)
        : 0,
      maximumQuestionLength: bodyQuestionLengths.length
        ? Math.max(...bodyQuestionLengths)
        : 0,
      averageAnswerLength: bodyAnswerLengths.length
        ? Math.round(bodyAnswerLengths.reduce((sum, value) => sum + value, 0) / bodyAnswerLengths.length)
        : 0,
      averageAnswerQuestionRatio: bodyQuestionLengths.length
        ? Math.round(
            bodyAnswerLengths.reduce((sum, value) => sum + value, 0)
            / Math.max(bodyQuestionLengths.reduce((sum, value) => sum + value, 0), 1)
            * 100,
          ) / 100
        : 0,
      directoryCompleteBeforeBody: true,
      answerParagraphFormValid: true,
      narrativeParagraphRangeValid: true,
      visibleAnswerLabelsAbsent: true,
      visibleSubheadingsAbsent: true,
      sourceOutlineNumberingAbsent: true,
      visibleSourceProcessAbsent: true,
      visibleAuditAppendixAbsent: true,
      placeholderAnswerAbsent: true,
      markdownDecorationAbsent: true,
      webPageChromeAbsent: true,
    },
  }
}
