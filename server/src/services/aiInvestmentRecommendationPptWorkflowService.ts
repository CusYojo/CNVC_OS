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
  replacerSkill: LoadedAiSkill
  replacementPolicy: {
    schemaVersion: '1.3'
    defaultOperation: 'KEEP'
    protectedElementPolicy: 'keep-unless-whitelisted'
    missingOptionalGroupPolicy: 'delete-entire-group'
    evidencePolicy: 'semantic-key-with-evidence-ids'
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
    throw new Error('投资建议书内容替换阶段必须接收可编辑 PPTX 模板')
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
      throw new Error('PDF 转换模板未通过水印、可编辑性或内容替换交接门槛')
    }
    const declaredSha256 = handoffPptxSha256(handoff)
    if (declaredSha256 && declaredSha256.toLowerCase() !== templateSha256) {
      throw new Error('PDF 转换交接证书与当前 PPTX 模板摘要不一致')
    }
  }

  const skills = workflowSkills.map((item): WorkflowSkillAudit => {
    const isConverter = item.name === 'pdf-to-editable-ppt'
    const applied = !isConverter || sourceMode === 'pdf-converted'
    return {
      name: item.name,
      role: item.role,
      version: item.skill.version,
      sha256: item.skill.sha256,
      applied,
      status: applied ? 'applied' : 'not-required',
      ...(applied
        ? {}
        : { reason: '模板为原生可编辑 PPTX，无需执行 PDF 转换' }),
    }
  })
  const replacerSkill = workflowSkills.find((item) =>
    item.name === 'editable-ppt-content-replacer')?.skill
  if (!replacerSkill) throw new Error('缺少 editable-ppt-content-replacer Skill')

  return {
    sourceMode,
    templateSha256,
    templateFileName: path.basename(template.referencePath),
    skills,
    replacerSkill,
    replacementPolicy: {
      schemaVersion: '1.3',
      defaultOperation: 'KEEP',
      protectedElementPolicy: 'keep-unless-whitelisted',
      missingOptionalGroupPolicy: 'delete-entire-group',
      evidencePolicy: 'semantic-key-with-evidence-ids',
    },
  }
}

export function buildInvestmentRecommendationGenerationAudit(input: {
  workflow: InvestmentRecommendationPptWorkflow
  content: BusinessContent
  sources: EvidenceSource[]
}) {
  const operations = input.content.sections.flatMap((section, sectionIndex) => [
    {
      semanticKey: `section.${sectionIndex + 1}.summary`,
      operation: 'REPLACE_TEXT',
      evidenceIds: [...new Set(section.summarySourceIndexes ?? [])]
        .filter((index) => Boolean(input.sources[index]))
        .map((index) => `S${index + 1}`),
    },
    ...section.findings.map((finding, findingIndex) => ({
      semanticKey: `section.${sectionIndex + 1}.finding.${findingIndex + 1}`,
      operation: finding.text.trim() ? 'REPLACE_TEXT' : 'DELETE',
      evidenceIds: [...new Set(finding.sourceIndexes)]
        .filter((index) => Boolean(input.sources[index]))
        .map((index) => `S${index + 1}`),
    })),
  ])
  return {
    schemaVersion: input.workflow.replacementPolicy.schemaVersion,
    defaultOperation: input.workflow.replacementPolicy.defaultOperation,
    sourceMode: input.workflow.sourceMode,
    protectedElementPolicy: input.workflow.replacementPolicy.protectedElementPolicy,
    missingOptionalGroupPolicy: input.workflow.replacementPolicy.missingOptionalGroupPolicy,
    operationCount: operations.length,
    evidenceBoundOperationCount: operations.filter((item) => item.evidenceIds.length > 0).length,
    operations,
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
  const [zip, templateZip] = await Promise.all([
    JSZip.loadAsync(await readFile(input.outputPath)),
    JSZip.loadAsync(await readFile(input.template.referencePath)),
  ])
  const packageMetrics = async (archive: JSZip) => {
    const names = Object.keys(archive.files)
    const mediaNames = names.filter((name) =>
      /^ppt\/media\/[^/]+$/.test(name) && !name.endsWith('/'))
    const slideNames = names.filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name))
    const slideBodies = await Promise.all(slideNames.map((name) =>
      archive.file(name)?.async('string') ?? ''))
    const mediaHashes = [...new Set(await Promise.all(mediaNames.map(async (name) =>
      createHash('sha256')
        .update(await archive.file(name)!.async('nodebuffer'))
        .digest('hex'))))].sort()
    return {
      slideCount: slideNames.length,
      masterCount: names.filter((name) =>
        /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)).length,
      layoutCount: names.filter((name) =>
        /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)).length,
      mediaCount: mediaNames.length,
      uniqueMediaCount: mediaHashes.length,
      mediaContentSha256: createHash('sha256')
        .update(mediaHashes.join('\n'))
        .digest('hex'),
      objectCount: slideBodies.reduce((sum, xml) =>
        sum + [...xml.matchAll(/<p:(?:sp|pic|grpSp|graphicFrame|cxnSp)\b/g)].length, 0),
      pictureCount: slideBodies.reduce((sum, xml) =>
        sum + [...xml.matchAll(/<p:pic\b/g)].length, 0),
    }
  }
  const [templateMetrics, outputMetrics] = await Promise.all([
    packageMetrics(templateZip),
    packageMetrics(zip),
  ])
  const slideParts = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) =>
      Number(left.match(/(\d+)/)?.[1] ?? 0) - Number(right.match(/(\d+)/)?.[1] ?? 0))
  const noteParts = Object.keys(zip.files)
    .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
  const slideXml = (await Promise.all(slideParts.map((name) =>
    zip.file(name)?.async('string') ?? ''))).join('\n')
  const notesXml = (await Promise.all(noteParts.map((name) =>
    zip.file(name)?.async('string') ?? ''))).join('\n')
  const semanticObjectNames = [...slideXml.matchAll(
    /\bname="(slot\.[^"]+|section\.[^"]+|cover\.[^"]+|closing\.[^"]+|references\.[^"]+)"/g,
  )].map((match) => match[1])
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
    openXmlValid: Boolean(zip.file('ppt/presentation.xml')) && slideParts.length > 0,
    targetProjectPresent: slideXml.includes(input.projectName),
    disclaimerPresent: slideXml.includes(input.disclaimer),
    referenceSlidePresent: slideXml.includes('引用资料与责任声明'),
    semanticObjectsPresent: outputMetrics.objectCount > 0,
    sourceNotesPresent: notesXml.includes('[Sources]'),
    sampleContentRemoved: leakedSampleTerms.length === 0,
    unrelatedCachedWebAbsent: leakedUnrelatedWebTerms.length === 0,
    templateSlideCountPreserved:
      outputMetrics.slideCount === templateMetrics.slideCount,
    templateMasterCountPreserved:
      outputMetrics.masterCount === templateMetrics.masterCount,
    templateLayoutCountPreserved:
      outputMetrics.layoutCount === templateMetrics.layoutCount,
    templateObjectCountPreserved:
      outputMetrics.objectCount === templateMetrics.objectCount,
    templatePictureCountPreserved:
      outputMetrics.pictureCount === templateMetrics.pictureCount,
    templateMediaContentPreserved:
      outputMetrics.mediaContentSha256 === templateMetrics.mediaContentSha256,
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
      notesSlideCount: noteParts.length,
      semanticObjectCount: semanticObjectNames.length,
      sourceNotesPresent: checks.sourceNotesPresent,
      leakedSampleTerms,
      leakedUnrelatedWebTerms,
      checks,
      workflowSkills: input.workflow.skills,
      templateSourceMode: input.workflow.sourceMode,
      templateSha256: input.workflow.templateSha256,
      replacementPolicy: input.workflow.replacementPolicy,
      templateMetrics,
      outputMetrics,
    },
  }
}
