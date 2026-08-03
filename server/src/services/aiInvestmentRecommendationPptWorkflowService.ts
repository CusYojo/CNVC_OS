import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type {
  BusinessContent,
  EvidenceSource,
} from './aiBusinessContentService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import {
  loadAiPptWorkflowSkills,
  type LoadedAiSkill,
} from './aiSkillService.js'

type WorkflowSkillAudit = {
  name: string
  role: string
  version: string
  sha256: string
  applied: boolean
  status: 'applied' | 'not-required'
  reason?: string
}

export type InvestmentRecommendationPptWorkflow = {
  sourceMode: 'native-pptx' | 'pdf-converted'
  templateSha256: string
  templateFileName: string
  skills: WorkflowSkillAudit[]
  orchestratorSkill: LoadedAiSkill
  gordenSkill: LoadedAiSkill
  converterSkill: LoadedAiSkill
  generationPolicy: {
    schemaVersion: '1.0'
    templateReuse: 'structure-and-style'
    factPolicy: 'project-facts-only'
    imageGenerationPolicy: 'gateway-imagegen-evidence-required'
    editableLayerPolicy: 'background-frame-icons-text'
    bridgePolicy: 'gorden-images-to-flattened-pdf-to-semantic-pptx'
  }
}

type ConversionHandoff = {
  watermarkQaPassed?: unknown
  editabilityReviewPassed?: unknown
  readyForContentReplacement?: unknown
  outputSha256?: unknown
  pptxSha256?: unknown
  editablePptxSha256?: unknown
  artifactSha256?: unknown
}

function handoffPptxSha256(handoff: ConversionHandoff) {
  return [
    handoff.outputSha256,
    handoff.pptxSha256,
    handoff.editablePptxSha256,
    handoff.artifactSha256,
  ].find((value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
}

export async function prepareInvestmentRecommendationPptWorkflow(
  template: AiTemplateDefinition,
): Promise<InvestmentRecommendationPptWorkflow> {
  if (template.type !== 'investment_recommendation_ppt') {
    throw new Error('投资建议书 PPT 工作流只能用于 investment_recommendation_ppt')
  }
  const sourceMode = template.templateSourceMode ?? 'native-pptx'
  if (path.extname(template.referencePath).toLowerCase() !== '.pptx') {
    throw new Error('投资建议书 Gorden 生成阶段必须接收可编辑 PPTX 模板')
  }
  const templateBuffer = await readFile(template.referencePath)
  const templateSha256 = createHash('sha256').update(templateBuffer).digest('hex')
  const configuredNames = template.workflowSkillNames ?? []
  const registeredWorkflowSkills = await loadAiPptWorkflowSkills()
  for (const configuredName of configuredNames) {
    if (!registeredWorkflowSkills.some((item) => item.name === configuredName)) {
      throw new Error(`投资建议书工作流 Skill 未注册：${configuredName}`)
    }
  }
  const workflowSkills = registeredWorkflowSkills.filter((item) =>
    configuredNames.includes(item.name))

  if (sourceMode === 'pdf-converted') {
    if (!template.conversionHandoffPath) {
      throw new Error('PDF 转换模板缺少 conversion-handoff.json')
    }
    const handoff = JSON.parse(
      await readFile(template.conversionHandoffPath, 'utf8'),
    ) as ConversionHandoff
    if (
      handoff.watermarkQaPassed !== true
      || handoff.editabilityReviewPassed !== true
      || handoff.readyForContentReplacement !== true
    ) {
      throw new Error('PDF 转换模板未通过水印、可编辑性或 Gorden 交接门槛')
    }
    const declaredSha256 = handoffPptxSha256(handoff)
    if (declaredSha256 && declaredSha256.toLowerCase() !== templateSha256) {
      throw new Error('PDF 转换交接证书与当前 PPTX 模板摘要不一致')
    }
  }

  const skills = workflowSkills.map((item): WorkflowSkillAudit => ({
      name: item.name,
      role: item.role,
      version: item.skill.version,
      sha256: item.skill.sha256,
      applied: true,
      status: 'applied',
      ...(item.name === 'pdf-to-editable-ppt'
        ? {
            reason: sourceMode === 'pdf-converted'
              ? '先完成上传 PDF 模板预处理，并在成稿阶段再次执行桥接 PDF 元素级可编辑化'
              : '上传模板为原生 PPTX；在成稿阶段执行桥接 PDF 元素级可编辑化',
          }
        : {}),
    }))
  const orchestratorSkill = workflowSkills.find((item) =>
    item.name === 'create-reference-driven-editable-ppt')?.skill
  const gordenSkill = workflowSkills.find((item) =>
    item.name === 'GordenSuperPPTSkill')?.skill
  const converterSkill = workflowSkills.find((item) =>
    item.name === 'pdf-to-editable-ppt')?.skill
  if (!orchestratorSkill) throw new Error('缺少 create-reference-driven-editable-ppt Skill')
  if (!gordenSkill) throw new Error('缺少 GordenSuperPPTSkill Skill')
  if (!converterSkill) throw new Error('缺少 pdf-to-editable-ppt Skill')

  return {
    sourceMode,
    templateSha256,
    templateFileName: path.basename(template.referencePath),
    skills,
    orchestratorSkill,
    gordenSkill,
    converterSkill,
    generationPolicy: {
      schemaVersion: '1.0',
      templateReuse: 'structure-and-style',
      factPolicy: 'project-facts-only',
      imageGenerationPolicy: 'gateway-imagegen-evidence-required',
      editableLayerPolicy: 'background-frame-icons-text',
      bridgePolicy: 'gorden-images-to-flattened-pdf-to-semantic-pptx',
    },
  }
}

export function buildInvestmentRecommendationGenerationAudit(input: {
  workflow: InvestmentRecommendationPptWorkflow
  content: BusinessContent
  sources: EvidenceSource[]
}) {
  const slides = input.content.sections.flatMap((section, sectionIndex) => [
    {
      slideRole: section.title,
      contentKey: `section.${sectionIndex + 1}.summary`,
      evidenceIds: [...new Set(section.summarySourceIndexes ?? [])]
        .filter((index) => Boolean(input.sources[index]))
        .map((index) => `S${index + 1}`),
    },
    ...section.findings.map((finding, findingIndex) => ({
      slideRole: section.title,
      contentKey: `section.${sectionIndex + 1}.finding.${findingIndex + 1}`,
      evidenceIds: [...new Set(finding.sourceIndexes)]
        .filter((index) => Boolean(input.sources[index]))
        .map((index) => `S${index + 1}`),
    })),
  ])
  return {
    schemaVersion: input.workflow.generationPolicy.schemaVersion,
    sourceMode: input.workflow.sourceMode,
    templateReuse: input.workflow.generationPolicy.templateReuse,
    factPolicy: input.workflow.generationPolicy.factPolicy,
    editableLayerPolicy: input.workflow.generationPolicy.editableLayerPolicy,
    contentBindingCount: slides.length,
    evidenceBoundContentCount: slides.filter((item) => item.evidenceIds.length > 0).length,
    slides,
  }
}

function templateSampleSubject(template: AiTemplateDefinition) {
  const sourceName = template.customAnalysis?.fileName || path.basename(template.referencePath)
  const baseName = path.basename(sourceName, path.extname(sourceName))
  return (baseName.match(
    /(?:^|[\s._-])([^._\s-][^._-]{1,30}?)(?:项目)?投资建议书/i,
  )?.[1] ?? '')
    .replace(/^\d+\s*[.、_-]?\s*/, '')
    .replace(/[_\s]+$/g, '')
    .trim()
}

export function investmentRecommendationTemplateLeakTerms(
  template: AiTemplateDefinition,
  projectName: string,
) {
  const genericTitle = /^(?:封面|目录|议程|公司介绍|项目概况|核心团队|产品介绍|核心技术|市场分析|竞争分析|财务分析|融资计划|投资方案|投资亮点|风险分析|引用资料|责任声明|结束页|谢谢)$/i
  const sampleSubject = templateSampleSubject(template)
  return [...new Set([
    sampleSubject,
    ...(template.customAnalysis?.structures ?? [])
      .map((structure) => structure.title.trim())
      .filter((title) =>
        title.length >= 6
        && !genericTitle.test(title)
        && !title.includes(projectName)),
  ].filter((value) =>
    value.length >= 3
    && !projectName.includes(value)))]
}

export async function reviewInvestmentRecommendationPpt(input: {
  outputPath: string
  projectName: string
  disclaimer: string
  workflow: InvestmentRecommendationPptWorkflow
  template: AiTemplateDefinition
}) {
  const fileStat = await stat(input.outputPath)
  const zip = await JSZip.loadAsync(await readFile(input.outputPath))
  const slideParts = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) =>
      Number(left.match(/(\d+)/)?.[1] ?? 0) - Number(right.match(/(\d+)/)?.[1] ?? 0))
  const slideBodies = await Promise.all(slideParts.map((name) =>
    zip.file(name)?.async('string') ?? ''))
  const slideXml = slideBodies.join('\n')
  const outputMetrics = {
    slideCount: slideParts.length,
    objectCount: slideBodies.reduce((sum, xml) =>
      sum + [...xml.matchAll(/<p:(?:sp|pic|grpSp|graphicFrame|cxnSp)\b/g)].length, 0),
    pictureCount: slideBodies.reduce((sum, xml) =>
      sum + [...xml.matchAll(/<p:pic\b/g)].length, 0),
    editableTextRunCount: slideBodies.reduce((sum, xml) =>
      sum + [...xml.matchAll(/<a:t(?:\s|>)/g)].length, 0),
    slidesWithEditableText: slideBodies.filter((xml) => /<a:t(?:\s|>)/.test(xml)).length,
    slidesWithBackgroundAndFrame: slideBodies.filter((xml) =>
      [...xml.matchAll(/<p:pic\b/g)].length >= 2).length,
  }
  const sampleTerms = [
    '佳量脑科学',
    'Epilcure',
    '曹鹏',
    ...investmentRecommendationTemplateLeakTerms(input.template, input.projectName),
  ].filter((term) => !input.projectName.includes(term))
  const leakedSampleTerms = sampleTerms.filter((term) => slideXml.includes(term))
  const unrelatedCachedWebTerms = ['腾讯视频', '哔哩哔哩', '豆瓣', '百度百科']
  const leakedUnrelatedWebTerms = unrelatedCachedWebTerms
    .filter((term) => slideXml.includes(term))
  const checks = {
    openXmlValid:
      fileStat.size > 10_000
      && Boolean(zip.file('ppt/presentation.xml'))
      && slideParts.length > 0,
    targetProjectPresent: slideXml.includes(input.projectName),
    disclaimerPresent: slideXml.includes(input.disclaimer),
    everySlideHasEditableText:
      outputMetrics.slidesWithEditableText === outputMetrics.slideCount,
    everySlideHasBackgroundAndFrame:
      outputMetrics.slidesWithBackgroundAndFrame === outputMetrics.slideCount,
    layeredEditableObjectsPresent:
      outputMetrics.objectCount >= outputMetrics.slideCount * 3,
    sampleContentRemoved: leakedSampleTerms.length === 0,
    unrelatedCachedWebAbsent: leakedUnrelatedWebTerms.length === 0,
    watermarkTextAbsent: !/(仅供项目评审使用|仅限内部分享，严格保密|CONFIDENTIAL\s+DRAFT)/i.test(
      slideXml,
    ),
  }
  const issueCodes = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)
  return {
    passed: issueCodes.length === 0,
    issueCodes,
    metadata: {
      bytes: fileStat.size,
      slideCount: slideParts.length,
      leakedSampleTerms,
      leakedUnrelatedWebTerms,
      checks,
      workflowSkills: input.workflow.skills,
      templateSourceMode: input.workflow.sourceMode,
      templateSha256: input.workflow.templateSha256,
      generationPolicy: input.workflow.generationPolicy,
      outputMetrics,
    },
  }
}
