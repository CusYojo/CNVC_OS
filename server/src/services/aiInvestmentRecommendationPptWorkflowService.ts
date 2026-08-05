import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type {
  BusinessContent,
  EvidenceSource,
} from './aiBusinessContentService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import {
  loadAiSkill,
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
  sourceMode: 'gorden-native'
  skills: WorkflowSkillAudit[]
  gordenSkill: LoadedAiSkill
  generationPolicy: {
    schemaVersion: '1.0'
    templateReuse: 'none'
    factPolicy: 'project-facts-only'
    imageGenerationPolicy: 'gateway-imagegen-evidence-required'
    editableLayerPolicy: 'background-frame-icons-text'
    bridgePolicy: 'gorden-image-to-four-layer-pptx'
  }
}

export async function prepareInvestmentRecommendationPptWorkflow(
  template: AiTemplateDefinition,
): Promise<InvestmentRecommendationPptWorkflow> {
  if (template.type !== 'investment_recommendation_ppt') {
    throw new Error('投资建议书 PPT 工作流只能用于 investment_recommendation_ppt')
  }
  const gordenSkill = await loadAiSkill('GordenSuperPPTSkill')
  const skills: WorkflowSkillAudit[] = [{
    name: gordenSkill.name,
    role: 'generation',
    version: gordenSkill.version,
    sha256: gordenSkill.sha256,
    applied: true,
    status: 'applied',
    reason: 'GordenSkills 原生图片生成与四层可编辑还原；外部模板读取已禁用',
  }]

  return {
    sourceMode: 'gorden-native',
    skills,
    gordenSkill,
    generationPolicy: {
      schemaVersion: '1.0',
      templateReuse: 'none',
      factPolicy: 'project-facts-only',
      imageGenerationPolicy: 'gateway-imagegen-evidence-required',
      editableLayerPolicy: 'background-frame-icons-text',
      bridgePolicy: 'gorden-image-to-four-layer-pptx',
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
      templateUsage: 'disabled',
      gordenSkillSha256: input.workflow.gordenSkill.sha256,
      generationPolicy: input.workflow.generationPolicy,
      outputMetrics,
    },
  }
}
