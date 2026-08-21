import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { AiCustomTemplateAnalysis } from '../repositories/aiTaskRepository.js'
import {
  AI_DUE_DILIGENCE_SKILL_NAME,
  AI_QA_SKILL_NAME,
  AI_TEMPLATE_DRIVEN_SKILL_NAME,
  type AiQaSkillName,
  type AiPptWorkflowSkillName,
} from './aiSkillService.js'
import { INVESTMENT_PROPOSAL_SECTION_TITLES } from './aiInvestmentProposalBlueprintService.js'

export const AI_TASK_TYPES = [
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
] as const

export type AiBusinessTaskType = typeof AI_TASK_TYPES[number]
export type AiExecutableTaskType = AiBusinessTaskType | 'custom_template_document'

export type AiTemplateDefinition = {
  type: AiExecutableTaskType
  skillName: string
  label: string
  description: string
  outputFormat: 'docx' | 'pptx' | 'pdf'
  companionFormats?: Array<'pdf' | 'png' | 'md'>
  additionalOutputFormats?: Array<'pdf'>
  templateVersion: string
  referencePath: string
  referencePaths?: string[]
  coreRulesPath?: string
  workflowSkillNames?: AiPptWorkflowSkillName[]
  templateSourceMode?: 'native-pptx' | 'pdf-converted'
  conversionHandoffPath?: string
  editableLevel: 'text-and-structure' | 'core-elements' | 'all'
  sections: string[]
  requiredParameters: string[]
  disclaimer: string
  customAnalysis?: AiCustomTemplateAnalysis
}

const docsPath = (...segments: string[]) => path.resolve(process.cwd(), 'docs', ...segments)
const skillPath = (skillName: string, ...segments: string[]) => path.resolve(
  process.cwd(),
  'server',
  'workspace',
  '.agents',
  'skills',
  skillName,
  ...segments,
)
const qaSkillPath = (...segments: string[]) => skillPath('draft-investment-qa', ...segments)

function docsTemplatePaths(directoryName: string) {
  const directoryPath = docsPath(directoryName)
  if (!existsSync(directoryPath)) return []
  return readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:docx|pdf)$/i.test(entry.name))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'zh-CN'))
}

export type AiQaTemplateDefinition = {
  type: 'project_qa'
  skillName: AiQaSkillName
  label: string
  templateVersion: string
  templateDirectory: string
  coreRulesPath: string
  referencePaths: string[]
  categories: string[]
  outputMode: 'document-task'
  downloadableArtifact: true
  outputFormats: ['docx']
}

export const AI_TEMPLATE_CATALOG: Record<AiBusinessTaskType, AiTemplateDefinition> = {
  compliance_statement: {
    type: 'compliance_statement',
    skillName: 'generate-investment-compliance-note',
    label: '合规性说明',
    description: '依据项目资料及基金投资约束生成合规性说明初稿',
    outputFormat: 'docx',
    templateVersion: 'generate-investment-compliance-note-20260820-v2-skill-native',
    referencePath: skillPath(
      'generate-investment-compliance-note',
      'assets',
      'compliance-layout-authority.docx',
    ),
    referencePaths: [
      skillPath(
        'generate-investment-compliance-note',
        'assets',
        'compliance-layout-authority.docx',
      ),
    ],
    editableLevel: 'text-and-structure',
    sections: ['公司情况介绍', '公司简介', '核心团队', '产品及技术', '投资理由', '投资计划', '投资情形分析', '结论'],
    requiredParameters: ['projectId', 'sourceCutoffDate'],
    disclaimer: '本文件由 AI 基于已授权资料生成，仅供内部合规初审，不构成正式法律意见；须经法务或风控人员审核后方可作为正式材料。',
  },
  investment_proposal: {
    type: 'investment_proposal',
    skillName: 'draft-investment-proposal',
    label: '投资提案',
    description: '由资深投资经理研读当前项目资料并按公司标准模板生成内部投资提案',
    outputFormat: 'docx',
    templateVersion: 'draft-investment-proposal-20260820-v2-skill-native',
    referencePath: skillPath(
      'draft-investment-proposal',
      'assets',
      'primary-layout-authority.docx',
    ),
    referencePaths: [
      skillPath('draft-investment-proposal', 'assets', 'primary-layout-authority.docx'),
      skillPath('draft-investment-proposal', 'assets', 'secondary-layout-authority.docx'),
    ],
    coreRulesPath: skillPath('draft-investment-proposal', 'references', 'core-standard.md'),
    editableLevel: 'text-and-structure',
    sections: INVESTMENT_PROPOSAL_SECTION_TITLES,
    requiredParameters: ['projectId', 'sourceCutoffDate', 'audience', 'length'],
    disclaimer: '本文件为 AI 辅助生成的内部投资提案初稿，不替代投资建议书、尽职调查报告或投资决策文件。',
  },
  investment_recommendation_ppt: {
    type: 'investment_recommendation_ppt',
    skillName: 'investment-committee-ppt',
    label: '投资建议书（PPT）',
    description: '由隔离 PPT Agent 直接调用 investment-committee-ppt Skill 生成可编辑投资建议书',
    outputFormat: 'pptx',
    templateVersion: 'investment-committee-ppt-20260821-v1-skill-native',
    referencePath: skillPath('investment-committee-ppt', 'SKILL.md'),
    referencePaths: [],
    editableLevel: 'all',
    sections: [
      '投资摘要',
      '公司概况与发展历程',
      '股权结构与核心团队',
      '产品与核心技术',
      '商业模式与客户验证',
      '行业与市场空间',
      '竞争格局与差异化',
      '财务分析',
      '融资与估值',
      '投资方案',
      '投资亮点',
      '风险与后续核验',
    ],
    requiredParameters: ['projectId', 'sourceCutoffDate', 'language', 'structureMode'],
    disclaimer: '本演示文稿仅供内部审议，不构成最终投资决策。',
  },
  due_diligence_report: {
    type: 'due_diligence_report',
    skillName: AI_DUE_DILIGENCE_SKILL_NAME,
    label: '尽调报告',
    description: '由资深投资经理先研读项目资料，再综合公司尽调模板语料库生成内部尽调报告',
    outputFormat: 'docx',
    templateVersion: 'dd-corpus-202608-v15-human-prose-no-meta-summaries',
    referencePath: docsPath('尽调报告', '尽调报告统一生成规范.md'),
    referencePaths: docsTemplatePaths('尽调报告'),
    coreRulesPath: docsPath('尽调报告', '尽调报告统一生成规范.md'),
    editableLevel: 'text-and-structure',
    sections: [
      '公司情况', '交易要点', '行业概况', '商业模式和经营管理', '投资价值与风险',
      '公司基本信息', '历史沿革', '公司股东情况及实际控制人情况', '核心团队介绍',
      '组织架构', '关联公司及关联交易', '资质、荣誉及法律合规情况',
      '产品概念总览', '核心技术路线', '产品矩阵', '场景应用', '核心技术沿革',
      '知识产权及数据权属', '商业模式与销售策略', '客户验证情况',
      '供应商、采购与成本情况', '行业趋势与痛点', '市场分析', '业务拓展规划',
      '财务情况', '投资亮点', '公司估值与投资方式', '退出方案',
      '风险提示与对策', '投资结论及建议',
    ],
    requiredParameters: ['projectId', 'sourceCutoffDate', 'diligenceScope'],
    disclaimer: '',
  },
  project_qa: {
    type: 'project_qa',
    skillName: AI_QA_SKILL_NAME,
    label: '项目 Q&A',
    description: '使用 draft-investment-qa 生成直接式、可交付的项目 Q&A 报告',
    outputFormat: 'docx',
    templateVersion: 'draft-investment-qa-20260820-v1',
    referencePath: qaSkillPath('assets', 'qa-report-template.md'),
    coreRulesPath: qaSkillPath('SKILL.md'),
    referencePaths: [
      qaSkillPath('assets', 'qa-report-template.md'),
      qaSkillPath('references', 'structure-blueprint.md'),
      qaSkillPath('references', 'section-writing-guide.md'),
      qaSkillPath('references', 'evidence-and-quality-rules.md'),
      qaSkillPath('references', 'format-guidelines.md'),
    ],
    editableLevel: 'text-and-structure',
    sections: [
      '阶段与推进建议',
      '项目主体',
      '股权与治理',
      '创始人与团队',
      '产品与技术',
      '知识产权',
      '商业模式',
      '客户与商业化',
      '市场与应用场景',
      '竞争格局',
      '财务与现金流',
      '融资与估值',
      '交易方案',
      '合规与权属',
      '风险与核验',
    ],
    requiredParameters: ['projectId', 'sourceCutoffDate'],
    disclaimer: '',
  },
}

// 快捷任务 Q&A 的结构、写作和版式统一由 draft-investment-qa 控制。
export const AI_QA_TEMPLATE: AiQaTemplateDefinition = {
  type: 'project_qa',
  skillName: AI_QA_SKILL_NAME,
  label: '项目 Q&A',
  templateVersion: AI_TEMPLATE_CATALOG.project_qa.templateVersion,
  templateDirectory: qaSkillPath(),
  coreRulesPath: AI_TEMPLATE_CATALOG.project_qa.coreRulesPath
    ?? qaSkillPath('SKILL.md'),
  referencePaths: AI_TEMPLATE_CATALOG.project_qa.referencePaths ?? [],
  categories: AI_TEMPLATE_CATALOG.project_qa.sections,
  outputMode: 'document-task',
  downloadableArtifact: true,
  outputFormats: ['docx'],
}

export function assertAiTemplateReferences(
  template:
    | Pick<AiTemplateDefinition, 'referencePath' | 'referencePaths' | 'coreRulesPath'>
    | Pick<AiQaTemplateDefinition, 'coreRulesPath' | 'referencePaths'>,
) {
  const paths = 'referencePath' in template
    ? [...new Set([
      template.referencePath,
      ...(template.referencePaths ?? []),
      ...(template.coreRulesPath ? [template.coreRulesPath] : []),
    ])]
    : [...new Set([template.coreRulesPath, ...template.referencePaths])]
  const missing = paths.filter((referencePath) => !existsSync(referencePath))
  if (missing.length > 0) {
    throw Object.assign(new Error(`AI 业务模板不存在：${missing.map((item) => path.basename(item)).join('、')}`), {
      status: 503,
      code: 'AI_TEMPLATE_NOT_AVAILABLE',
    })
  }
}

export function listAiTaskTypes() {
  return [
    ...AI_TASK_TYPES.map((type) => {
    const item = AI_TEMPLATE_CATALOG[type]
    return {
      type: item.type,
      label: item.label,
      description: item.description,
      outputFormat: item.outputFormat,
      companionFormats: item.companionFormats ?? [],
      skillName: item.skillName,
      workflowSkillNames: item.workflowSkillNames ?? [],
      templateSourceMode: item.templateSourceMode,
      templateVersion: item.templateVersion,
      requiredParameters: item.requiredParameters,
      outputFormats: [...new Set([
        item.outputFormat,
        ...(item.companionFormats ?? []),
        ...(item.additionalOutputFormats ?? []),
      ])],
    }
    }),
    {
      type: 'custom_template_document',
      label: '上传模板生成',
      description: '分析上传模板的结构和内容要求，为当前项目生成内部投资分析材料',
      outputFormat: 'dynamic',
      companionFormats: [],
      skillName: AI_TEMPLATE_DRIVEN_SKILL_NAME,
      templateVersion: 'template-analysis-v1',
      requiredParameters: ['projectId', 'sourceCutoffDate', 'customTemplateId'],
      outputFormats: ['docx', 'pptx'],
    },
  ]
}

export function isAiBusinessTaskType(value: string): value is AiBusinessTaskType {
  return (AI_TASK_TYPES as readonly string[]).includes(value)
}

export function isAiExecutableTaskType(value: string): value is AiExecutableTaskType {
  return value === 'custom_template_document' || isAiBusinessTaskType(value)
}
