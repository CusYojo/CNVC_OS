import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { analyzeAiCustomTemplateBuffer } from '../services/aiCustomTemplateService.js'
import {
  AI_TEMPLATE_DRIVEN_SKILL_NAME,
  loadAiSkill,
} from '../services/aiSkillService.js'
import {
  generateBusinessDocx,
  generateBusinessPptx,
} from '../services/aiBusinessDocumentService.js'
import {
  finalizeCustomTemplateContent,
  type BusinessContent,
  type EvidenceSource,
} from '../services/aiBusinessContentService.js'
import type { AiTemplateDefinition } from '../services/aiTemplateCatalog.js'

type Check = { name: string; passed: boolean; detail: string }
const checks: Check[] = []

function assert(name: string, condition: boolean, detail: string) {
  checks.push({ name, passed: condition, detail })
  if (!condition) throw new Error(`${name}：${detail}`)
}

const project = {
  name: '模板验收项目',
  companyName: '模板验收科技有限公司',
  industry: '企业服务',
  stage: '尽调',
  summary: '面向企业客户提供数据分析服务。',
}

const sources: EvidenceSource[] = [{
  sourceType: 'project_record',
  sourceId: 'acceptance-project',
  sourceName: '项目档案',
  chunkIndex: 0,
  versionOrDate: '2026-07-27',
  content: '模板验收科技有限公司面向企业客户提供数据分析服务。',
}]

function contentForSections(sectionTitles: string[]): BusinessContent {
  return {
    title: '模板验收项目分析报告',
    executiveSummary: '**【AI推断】** 阶段与推进建议：继续跟踪。判断依据：本文件依据项目档案形成，用于验证模板分析数据与文档渲染链路。',
    executiveSummarySourceIndexes: [0],
    sections: sectionTitles.map((title) => ({
      title,
      summary: `${title}按照上传模板的识别规则组织。`,
      summarySourceIndexes: [0],
      findings: [{
        text: '**【资料记载】** 项目资料显示公司面向企业客户提供数据分析服务，其他事项仍需补充证据。',
        status: '资料记载',
        sourceIndexes: [0],
      }],
      tables: [],
    })),
    highlights: ['已完成模板分析数据链路验证'],
    risks: ['真实生成结果仍须业务负责人审核'],
    missing: ['客户合同及财务底稿待补充'],
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'ai-custom-template-acceptance-'))
  try {
    const docxPath = path.resolve(
      process.cwd(),
      'docs',
      '合规性说明',
      '关于德塔智能项目投资合规性的说明_20260701.docx',
    )
    const pptxPath = path.resolve(
      process.cwd(),
      'docs',
      'agent',
      '投资建议书',
      '佳量脑科学_投资建议书6月.pptx',
    )
    const [docxAnalysis, pptxAnalysis, fixedSkill] = await Promise.all([
      analyzeAiCustomTemplateBuffer(await readFile(docxPath), path.basename(docxPath)),
      analyzeAiCustomTemplateBuffer(await readFile(pptxPath), path.basename(pptxPath)),
      loadAiSkill(AI_TEMPLATE_DRIVEN_SKILL_NAME),
    ])
    assert(
      'DOCX 格式画像完整',
      docxAnalysis.outputFormat === 'docx'
        && docxAnalysis.analysis.formatProfile.bodySizePt !== null
        && docxAnalysis.analysis.formatProfile.pageSize.includes('cm')
        && docxAnalysis.analysis.structures.length >= 4,
      `${docxAnalysis.analysis.structures.length} 个结构`,
    )
    assert(
      'PPTX 格式画像完整',
      pptxAnalysis.outputFormat === 'pptx'
        && pptxAnalysis.analysis.formatProfile.pageSize.includes('in')
        && pptxAnalysis.analysis.structures.length >= 3,
      `${pptxAnalysis.analysis.structures.length} 页结构`,
    )
    assert(
      '模板分析数据已版本化',
      docxAnalysis.analysis.schemaVersion === '1.0'
        && pptxAnalysis.analysis.schemaVersion === '1.0'
        && /^sha256-[a-f0-9]{12}$/.test(docxAnalysis.analysis.analysisVersion ?? '')
        && /^sha256-[a-f0-9]{12}$/.test(pptxAnalysis.analysis.analysisVersion ?? '')
        && docxAnalysis.analysis.analysisVersion !== pptxAnalysis.analysis.analysisVersion,
      `${docxAnalysis.analysis.analysisVersion} / ${pptxAnalysis.analysis.analysisVersion}`,
    )
    assert(
      '固定中文 Skill 可加载并包含资深投资经理角色、项目分析与输出规范',
      fixedSkill.name === AI_TEMPLATE_DRIVEN_SKILL_NAME
        && fixedSkill.referenceNames.includes('references/template-analysis-schema.md')
        && fixedSkill.referenceNames.includes('references/evidence-workflow.md')
        && fixedSkill.referenceNames.includes('references/output-contract.md')
        && /不得为单个模板创建新的 Skill/.test(fixedSkill.instructions)
        && [
          '投资中台的资深投资经理',
          '当前会话绑定',
          '线索池',
          '推进、继续观察、暂缓或归档方向',
          '不得为了命中固定词表硬造结论',
          '证据不足时可以明确暂不形成阶段建议',
          '泛泛的行业研究报告',
          '可核验来源',
          '本地项目资料库优先',
          'Flue',
          'LLM Gateway',
          '候选 URL',
          '页面核验',
          '搜索摘要',
          '核验结果缓存复用',
          '只联网搜索',
          '不得跳过本地项目资料库',
        ].every((term) =>
          `${fixedSkill.instructions}\n${fixedSkill.referenceInstructions}`.includes(term))
        && /[\u3400-\u9fff]/.test(fixedSkill.instructions)
        && /^sha256-[a-f0-9]{12}$/.test(fixedSkill.version),
      fixedSkill.version,
    )
    const aiTaskServiceSource = await readFile(
      path.resolve(process.cwd(), 'server', 'src', 'services', 'aiTaskService.ts'),
      'utf8',
    )
    const sharedNetworkBlock = aiTaskServiceSource.match(
      /if \(\[\s*'investment_proposal',[\s\S]+?if \(await cancelIfRequested\(taskId\)\) return/,
    )?.[0] ?? ''
    assert(
      '上传模板复用其他投资快捷任务的大模型联网检索与页面核验链路',
      sharedNetworkBlock.includes("'custom_template_document'")
        && sharedNetworkBlock.includes('fetchDueDiligenceNetworkEvidence')
        && sharedNetworkBlock.includes('fetchVerifiedProjectWebEvidence')
        && sharedNetworkBlock.includes('nativeModelSearch: true')
        && sharedNetworkBlock.includes('cacheProjectNetworkEvidence')
        && aiTaskServiceSource.includes('基于项目资料与已核验联网证据重建标题和正文'),
      '联网检索 Agent 发现候选来源 → LLM Gateway 原生模型搜索及页面核验 → 缓存写回 → 生成正文',
    )

    const docxSections = docxAnalysis.analysis.structures
      .filter((item) => !/^(?:封面|目录|议程|文档标题)$/.test(item.title))
      .slice(0, 8)
      .map((item) => item.title)
    const docxTemplate: AiTemplateDefinition = {
      type: 'custom_template_document',
      skillName: fixedSkill.name,
      label: '验收 Word 模板',
      description: '验收',
      outputFormat: 'docx',
      templateVersion: `${fixedSkill.version}+${docxAnalysis.analysis.analysisVersion}`,
      referencePath: docxPath,
      editableLevel: 'text-and-structure',
      sections: docxSections.length ? docxSections : ['正文'],
      requiredParameters: ['projectId', 'sourceCutoffDate', 'customTemplateId'],
      disclaimer: 'AI 辅助生成，仅供验收。',
      customAnalysis: docxAnalysis.analysis,
    }
    const generatedDocx = path.join(tempRoot, 'custom-template-output.docx')
    const freshDocxContent = finalizeCustomTemplateContent(
      contentForSections(docxTemplate.sections),
      docxTemplate,
      project,
    )
    await generateBusinessDocx({
      outputPath: generatedDocx,
      template: docxTemplate,
      project,
      content: freshDocxContent,
      sources,
      sourceCutoffDate: '2026-07-27',
    })
    const generatedDocxZip = await JSZip.loadAsync(await readFile(generatedDocx))
    const generatedDocxXml = await generatedDocxZip.file('word/document.xml')?.async('string') ?? ''
    assert(
      '固定 Skill 按分析数据生成可编辑 DOCX',
      generatedDocxXml.includes('<w:t')
        && generatedDocxXml.includes('引用资料与责任声明')
        && generatedDocxXml.includes('项目档案')
        && generatedDocxXml.includes('模板验收科技有限公司')
        && generatedDocxXml.includes('项目投资分析报告')
        && generatedDocxXml.includes('综合当前项目阶段与可核验事实，建议继续跟踪')
        && !generatedDocxXml.includes('阶段与推进建议：')
        && !generatedDocxXml.includes('判断依据：')
        && !generatedDocxXml.includes('【资料记载】')
        && !generatedDocxXml.includes('【AI推断】')
        && !generatedDocxXml.includes('【待核验】')
        && !generatedDocxXml.includes('**')
        && !generatedDocxXml.includes('资料缺口')
        && !generatedDocxXml.includes('德塔智能'),
      `${generatedDocxXml.length} 字节 XML`,
    )

    const pptxSections = pptxAnalysis.analysis.structures
      .filter((item) => !/^(?:封面|目录|议程|文档标题)$/.test(item.title))
      .slice(0, 6)
      .map((item) => item.title)
    const pptxTemplate: AiTemplateDefinition = {
      type: 'custom_template_document',
      skillName: fixedSkill.name,
      label: '验收 PPT 模板',
      description: '验收',
      outputFormat: 'pptx',
      templateVersion: `${fixedSkill.version}+${pptxAnalysis.analysis.analysisVersion}`,
      referencePath: pptxPath,
      editableLevel: 'core-elements',
      sections: pptxSections.length ? pptxSections : ['项目概览'],
      requiredParameters: ['projectId', 'sourceCutoffDate', 'customTemplateId'],
      disclaimer: 'AI 辅助生成，仅供验收。',
      customAnalysis: pptxAnalysis.analysis,
    }
    const generatedPptx = path.join(tempRoot, 'custom-template-output.pptx')
    const freshPptxContent = finalizeCustomTemplateContent(
      contentForSections(pptxTemplate.sections),
      pptxTemplate,
      project,
    )
    await generateBusinessPptx({
      outputPath: generatedPptx,
      template: pptxTemplate,
      project,
      content: freshPptxContent,
      sources,
      sourceCutoffDate: '2026-07-27',
      pageCount: '10',
    })
    const generatedPptxZip = await JSZip.loadAsync(await readFile(generatedPptx))
    const slideNames = Object.keys(generatedPptxZip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    const finalSlide = await generatedPptxZip
      .file(`ppt/slides/slide${slideNames.length}.xml`)
      ?.async('string') ?? ''
    const allSlidesXml = (await Promise.all(slideNames.map((slideName) =>
      generatedPptxZip.file(slideName)?.async('string') ?? ''))).join('\n')
    assert(
      '固定 Skill 按分析数据生成可编辑 PPTX',
      slideNames.length >= 3
        && finalSlide.includes('引用资料与责任声明')
        && finalSlide.includes('<a:t>')
        && allSlidesXml.includes('模板验收科技有限公司')
        && allSlidesXml.includes('项目投资分析报告')
        && allSlidesXml.includes('综合当前项目阶段与可核验事实，建议继续跟踪')
        && !allSlidesXml.includes('阶段与推进建议：')
        && !allSlidesXml.includes('判断依据：')
        && !allSlidesXml.includes('【资料记载】')
        && !allSlidesXml.includes('【AI推断】')
        && !allSlidesXml.includes('【待核验】')
        && !allSlidesXml.includes('**')
        && !allSlidesXml.includes('资料缺口')
        && !allSlidesXml.includes('佳量脑科学'),
      `${slideNames.length} 页`,
    )

    console.log(JSON.stringify({ ok: true, checks }, null, 2))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, message: (error as Error).message, checks }, null, 2))
  process.exitCode = 1
})
