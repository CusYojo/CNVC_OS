import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFParse } from 'pdf-parse'
import type { LoadedAiSkill } from './aiSkillService.js'

export type QaTemplateFileProfile = {
  fileName: string
  sha256: string
  pageCount: number
  pageWidth: number
  pageHeight: number
  questionCount: number
  hasQuestionIndex: boolean
  questionLabel: 'Q' | '数字序号' | '混合'
  answerLabels: string[]
  usesDimensionBreakdown: boolean
}

export type QaTemplateProfile = {
  parserVersion: string
  corpusSha256: string
  files: QaTemplateFileProfile[]
  consensus: {
    pageSize: 'A4'
    colorMode: string
    titlePattern: string
    openingPattern: string
    bodyPattern: string
    questionNumbering: string
    answerLead: string
    typography: string
    paragraphStyle: string
    footer: string
  }
}

const cache = new Map<string, Promise<QaTemplateProfile>>()

function rounded(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0
}

function questionMatches(value: string) {
  const frontMatter = value.split(/\n--\s*1\s+of\s+\d+\s*--/i)[0] ?? value
  const qQuestions = [...frontMatter.matchAll(/^\s*Q\s*\d+\s*[：:]\s*(.+)$/gim)]
  const numberedQuestions = [...frontMatter.matchAll(/^\s*\d+\s*[、.．]\s*(.+[？?])\s*$/gm)]
  return { qQuestions, numberedQuestions }
}

async function parseTemplateFile(referencePath: string): Promise<QaTemplateFileProfile> {
  const buffer = await readFile(referencePath)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const parser = new PDFParse({ data: buffer })
  try {
    // pdf.js 的同一 parser 实例不能并发传输文档对象；顺序读取避免 DataCloneError。
    const info = await parser.getInfo({ parsePageInfo: true })
    const textResult = await parser.getText()
    const text = textResult.text
    const { qQuestions, numberedQuestions } = questionMatches(text)
    const questionCount = Math.max(qQuestions.length, numberedQuestions.length)
    const answerLabels = [
      /(?:^|\n)\s*回答\s*[：:]/.test(text) ? '回答：' : '',
      /(?:^|\n)\s*答复\s*[：:]/.test(text) ? '答复：' : '',
    ].filter(Boolean)
    const firstPage = info.pages?.[0]
    return {
      fileName: path.basename(referencePath),
      sha256,
      pageCount: info.total,
      pageWidth: rounded(firstPage?.width),
      pageHeight: rounded(firstPage?.height),
      questionCount,
      hasQuestionIndex: questionCount >= 2,
      questionLabel: qQuestions.length && numberedQuestions.length
        ? '混合'
        : qQuestions.length
          ? 'Q'
          : '数字序号',
      answerLabels,
      usesDimensionBreakdown:
        /(?:^|\n)\s*[（(]\s*[一二三四五六七八九十\d]+\s*[）)]/.test(text)
        || /分维度|第一[，,]|第二[，,]|第三[，,]/.test(text),
    }
  } finally {
    await parser.destroy()
  }
}

export async function parseQaTemplateCorpus(referencePaths: readonly string[]) {
  const cacheKey = [...referencePaths].sort().join('\n')
  const existing = cache.get(cacheKey)
  if (existing) return existing
  const pending = (async (): Promise<QaTemplateProfile> => {
    const files = await Promise.all(referencePaths.map(parseTemplateFile))
    const corpusSha256 = createHash('sha256')
      .update(files
        .map((file) => `${file.fileName}:${file.sha256}`)
        .sort()
        .join('\n'))
      .digest('hex')
    const profile: QaTemplateProfile = {
      parserVersion: 'qa-template-parser-v1',
      corpusSha256,
      files,
      consensus: {
        pageSize: 'A4',
        colorMode: '黑白公文',
        titlePattern: '项目名称 + Q&A',
        openingPattern: '首页问题目录',
        bodyPattern: '问题—答复—分维度论证',
        questionNumbering: 'Q1/Q2 或 1、2',
        answerLead: '回答：或答复：',
        typography: '黑色中文宋体正文，标题与问题加粗',
        paragraphStyle: '两端对齐、首行缩进、1.5 倍行距',
        footer: '页码',
      },
    }
    assertQaTemplateProfile(profile)
    return profile
  })()
  cache.set(cacheKey, pending)
  try {
    return await pending
  } catch (error) {
    cache.delete(cacheKey)
    throw error
  }
}

export function assertQaTemplateProfile(profile: QaTemplateProfile) {
  if (profile.files.length < 1) throw new Error('Q&A 模板目录没有可解析的 PDF')
  const nonA4 = profile.files.filter((file) =>
    Math.abs(file.pageWidth - 595.3) > 2 || Math.abs(file.pageHeight - 841.9) > 2)
  if (nonA4.length) {
    throw new Error(`Q&A 模板存在非 A4 页面：${nonA4.map((file) => file.fileName).join('、')}`)
  }
  const withoutQuestions = profile.files.filter((file) => file.questionCount < 1)
  if (withoutQuestions.length) {
    throw new Error(`Q&A 模板未识别到问题目录：${withoutQuestions.map((file) => file.fileName).join('、')}`)
  }
  if (!profile.files.some((file) => file.usesDimensionBreakdown)) {
    throw new Error('Q&A 模板未识别到分维度论证结构')
  }
  if (!profile.files.some((file) => file.answerLabels.length > 0)) {
    throw new Error('Q&A 模板未识别到“回答/答复”标签')
  }
}

export function createProjectQaSkillProfile(skill: LoadedAiSkill): QaTemplateProfile {
  if (skill.name !== 'draft-investment-qa') {
    throw new Error(`无法为非标准 Q&A Skill 创建版式画像：${skill.name}`)
  }
  return {
    parserVersion: 'draft-investment-qa-profile-v1',
    corpusSha256: skill.sha256,
    files: [{
      fileName: 'draft-investment-qa/SKILL.md',
      sha256: skill.sha256,
      pageCount: 1,
      pageWidth: 595.3,
      pageHeight: 841.9,
      questionCount: 8,
      hasQuestionIndex: false,
      questionLabel: 'Q',
      answerLabels: [],
      usesDimensionBreakdown: false,
    }],
    consensus: {
      pageSize: 'A4',
      colorMode: '中性正式商务文档',
      titlePattern: '项目名称Q&A 报告',
      openingPattern: '标题后直接进入 Q1',
      bodyPattern: '问题—连续自然段分析—判断边界与决策含义',
      questionNumbering: 'Q1/Q2 连续编号',
      answerLead: '直接进入分析，不显示答复或结论标签',
      typography: 'STFangsong 正文、STHeiti 标题、Times New Roman 西文',
      paragraphStyle: '两端对齐、首行缩进 2 字符、20pt 固定行距',
      footer: '右对齐页码',
    },
  }
}
