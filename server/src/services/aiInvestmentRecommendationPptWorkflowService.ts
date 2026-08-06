import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import type {
  BusinessContent,
  EvidenceSource,
} from './aiBusinessContentService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'
import {
  getAiSkillRoot,
  loadAiSkill,
  loadAiSkillFromDirectory,
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
  orchestratorSkill: LoadedAiSkill
  gordenSkill: LoadedAiSkill
  pdfSkill: LoadedAiSkill
  gordenPackage: {
    imageGenerationSkill: LoadedAiSkill
    imageToEditableSkill: LoadedAiSkill
    packageSha256: string
    corePromptContract: string
    designTemplates: string
    palette: string[]
  }
  generationPolicy: {
    schemaVersion: '1.0'
    templateReuse: 'none'
    factPolicy: 'project-facts-only'
    imageGenerationPolicy: 'gateway-imagegen-evidence-required'
    editableLayerPolicy: 'background-frame-icons-text'
    bridgePolicy: 'image-deck-to-pdf-to-editable-pptx'
  }
}

function resolveGordenPackageSkillDirectory(root: string, name: string) {
  const candidates = [
    path.join(root, 'GordenSuperPPTSkills', name),
    path.join(root, name),
  ]
  return candidates.find((candidate) => existsSync(path.join(candidate, 'SKILL.md')))
    ?? candidates[0]
}

function markdownSection(source: string, start: RegExp, next: RegExp) {
  const match = start.exec(source)
  if (!match) return ''
  const tail = source.slice(match.index)
  const nextMatch = next.exec(tail.slice(match[0].length))
  return nextMatch
    ? tail.slice(0, match[0].length + nextMatch.index).trim()
    : tail.trim()
}

async function loadGordenPackageSkill(
  root: string,
  name: 'GordenImagePPTGen' | 'GordenImage2PPTX',
) {
  return loadAiSkillFromDirectory({
    name,
    directory: resolveGordenPackageSkillDirectory(root, name),
    allowedRoot: root,
  })
}

async function readGordenImageGenReference(root: string, fileName: string) {
  const directory = resolveGordenPackageSkillDirectory(root, 'GordenImagePPTGen')
  const referencePath = path.resolve(directory, 'references', fileName)
  if (!referencePath.startsWith(`${directory}${path.sep}`)) {
    throw new Error(`GordenImagePPTGen 引用路径越界：${fileName}`)
  }
  return readFile(referencePath, 'utf8')
}

async function loadGordenPackageContract(superSkill: LoadedAiSkill) {
  const root = getAiSkillRoot()
  const [imageGenerationSkill, imageToEditableSkill, promptGuide, designTemplates, storytelling, caseStudies, contentFrameworks, colorPalettes] = await Promise.all([
    loadGordenPackageSkill(root, 'GordenImagePPTGen'),
    loadGordenPackageSkill(root, 'GordenImage2PPTX'),
    readGordenImageGenReference(root, 'image-prompt-guide.md'),
    readGordenImageGenReference(root, 'design-templates.md'),
    readGordenImageGenReference(root, 'storytelling-guide.md'),
    readGordenImageGenReference(root, 'bp-case-studies.md'),
    readGordenImageGenReference(root, 'content-frameworks.md'),
    readGordenImageGenReference(root, 'color-palettes.md'),
  ])
  const selectedPaletteContract = markdownSection(
    colorPalettes,
    /^## C4 暖金商务/m,
    /^## C5/m,
  )
  const palette = [...new Set(
    [...selectedPaletteContract.matchAll(/#[0-9A-Fa-f]{6}/g)].map((match) => match[0].toUpperCase()),
  )]
  if (palette.length < 5) {
    throw new Error('GordenImagePPTGen 内置配色规范不完整')
  }
  const corePromptContract = [
    markdownSection(superSkill.instructions, /^## 编排流程（逐项打勾）/m, /^## 关键约束/m),
    markdownSection(superSkill.instructions, /^## 关键约束/m, /^## 输出目录结构/m),
    markdownSection(imageGenerationSkill.instructions, /^## 全局铁律/m, /^## 默认风格与复杂度/m),
    markdownSection(imageGenerationSkill.instructions, /^## 默认风格与复杂度/m, /^## 工作流/m),
    markdownSection(promptGuide, /^## 0\. 内容优先/m, /^## 1\./m),
    markdownSection(promptGuide, /^## 1\.5 复杂度强制清单/m, /^## 1\.6/m),
    markdownSection(promptGuide, /^## 1\.7 豪华信息图设计准则/m, /^## 1\.8/m),
    markdownSection(promptGuide, /^## 1\.8 高密度成品配方/m, /^## 2\./m),
    markdownSection(promptGuide, /^## 3\. 设计规则/m, /^## 4\./m),
    markdownSection(storytelling, /^### N1 倒金字塔/m, /^### N2/m),
    markdownSection(storytelling, /^## 文案铁律/m, /$(?![\s\S])/),
    markdownSection(caseStudies, /^## 通用蒸馏/m, /^## BP 文案铁律/m),
    markdownSection(caseStudies, /^## BP 文案铁律/m, /$(?![\s\S])/),
    markdownSection(contentFrameworks, /^## T1 融资路演/m, /^## T2/m),
    selectedPaletteContract,
  ].filter(Boolean).join('\n\n')
  const packageSha256 = createHash('sha256')
    .update(superSkill.sha256)
    .update(imageGenerationSkill.sha256)
    .update(imageToEditableSkill.sha256)
    .update(corePromptContract)
    .update(designTemplates)
    .update(palette.join(','))
    .digest('hex')
  return {
    imageGenerationSkill,
    imageToEditableSkill,
    packageSha256,
    corePromptContract,
    designTemplates,
    palette,
  }
}

const GORDEN_PAGE_LAYOUT_BY_ROLE: Readonly<Record<string, number>> = {
  cover: 1,
  summary: 10,
  company: 13,
  team: 11,
  product: 7,
  technology: 6,
  market: 3,
  competition: 9,
  validation: 14,
  'business-model': 12,
  financials: 15,
  'investment-plan': 16,
  exit: 17,
  risk: 17,
  closing: 17,
  content: 5,
}

export function gordenPackageSlidePromptContract(
  workflow: InvestmentRecommendationPptWorkflow,
  role: string,
) {
  const layoutNumber = GORDEN_PAGE_LAYOUT_BY_ROLE[role] ?? 5
  const layout = markdownSection(
    workflow.gordenPackage.designTemplates,
    new RegExp(`^## M${layoutNumber}\\s`, 'm'),
    /^## M\d+\s/m,
  )
  return [
    `GordenSuperPPTSkills 包版本：${workflow.gordenPackage.packageSha256.slice(0, 16)}`,
    '以下规范直接来自 GordenSuperPPTSkill、GordenImagePPTGen 及其内置 references，是本页唯一设计依据。外部模板、历史 PPT、服务层自定义主题或其他 PPT 技能均不得参与。',
    workflow.gordenPackage.corePromptContract,
    layout,
    '内置参考中的公司名、示例数字、示例日期、Logo、KPI 和样例文案只解释构图，绝不能出现在成品中。成品事实和可见文字只能取自本页文字契约。',
  ].filter(Boolean).join('\n\n')
}

export async function prepareInvestmentRecommendationPptWorkflow(
  template: AiTemplateDefinition,
): Promise<InvestmentRecommendationPptWorkflow> {
  if (template.type !== 'investment_recommendation_ppt') {
    throw new Error('投资建议书 PPT 工作流只能用于 investment_recommendation_ppt')
  }
  const [orchestratorSkill, gordenSkill, pdfSkill] = await Promise.all([
    loadAiSkill('create-reference-driven-editable-ppt'),
    loadAiSkill('GordenSuperPPTSkill'),
    loadAiSkill('pdf-to-editable-ppt'),
  ])
  const gordenPackage = await loadGordenPackageContract(gordenSkill)
  const skills: WorkflowSkillAudit[] = [
    {
      name: orchestratorSkill.name,
      role: 'orchestration-and-handoff',
      version: orchestratorSkill.version,
      sha256: orchestratorSkill.sha256,
      applied: true,
      status: 'applied',
      reason: '统一编排图片高保真版、PDF 桥接和元素级可编辑版的分阶段交付',
    },
    {
      name: gordenSkill.name,
      role: 'generation',
      version: gordenSkill.version,
      sha256: gordenSkill.sha256,
      applied: true,
      status: 'applied',
      reason: '负责页面策划、网关出图和四层语义资产生成',
    },
    {
      name: pdfSkill.name,
      role: 'final-editable-conversion-and-qa',
      version: pdfSkill.version,
      sha256: pdfSkill.sha256,
      applied: true,
      status: 'applied',
      reason: '负责图片桥接 PDF 的元素级可编辑转换与交接校验',
    },
  ]

  return {
    sourceMode: 'gorden-native',
    skills,
    orchestratorSkill,
    gordenSkill,
    pdfSkill,
    gordenPackage,
    generationPolicy: {
      schemaVersion: '1.0',
      templateReuse: 'none',
      factPolicy: 'project-facts-only',
      imageGenerationPolicy: 'gateway-imagegen-evidence-required',
      editableLayerPolicy: 'background-frame-icons-text',
      bridgePolicy: 'image-deck-to-pdf-to-editable-pptx',
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
      gordenPackageSha256: input.workflow.gordenPackage.packageSha256,
      gordenPackageComponents: [
        input.workflow.gordenSkill.name,
        input.workflow.gordenPackage.imageGenerationSkill.name,
        input.workflow.gordenPackage.imageToEditableSkill.name,
      ],
      generationPolicy: input.workflow.generationPolicy,
      outputMetrics,
    },
  }
}
