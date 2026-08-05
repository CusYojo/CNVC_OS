import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { AiCustomTemplateAnalysis } from '../db/schema.js'
import {
  AI_TEMPLATE_DRIVEN_SKILL_NAME,
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
  editableLevel: 'text-and-structure' | 'core-elements'
  sections: string[]
  requiredParameters: string[]
  disclaimer: string
  customAnalysis?: AiCustomTemplateAnalysis
}

const docsPath = (...segments: string[]) => path.resolve(process.cwd(), 'docs', ...segments)

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
  skillName: 'answer-project-qa'
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
    skillName: 'generate-compliance-statement',
    label: '合规性说明',
    description: '依据项目资料及基金投资约束生成合规性说明初稿',
    outputFormat: 'docx',
    templateVersion: 'compliance-corpus-20260804-v5-project-study-template-fidelity',
    referencePath: docsPath('合规性说明', '关于德塔智能项目投资合规性的说明_20260701.docx'),
    referencePaths: [
      docsPath('合规性说明', '关于德塔智能项目投资合规性的说明_20260701.docx'),
      docsPath('合规性说明', '20260615-蓝成合规性说明（初稿）V2-甬元改.docx'),
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
    templateVersion: 'proposal-corpus-20260804-v10-project-study-template-fidelity',
    referencePath: docsPath('投资提案', '佳量脑科学项目投资提案0622(1).docx'),
    referencePaths: [
      docsPath('投资提案', '佳量脑科学项目投资提案0622(1).docx'),
      docsPath('投资提案', '1.众创叁期对飞阔科技的投资提案(1).docx'),
      docsPath('投资提案', '1. 轻蜓光电投资提案(1).pdf'),
      docsPath('投资提案', '1. 普雷赛斯投资提案(1).pdf'),
      docsPath('投资提案', '微纳核芯投资提案 -东阳基金(2).pdf'),
      docsPath('投资提案', '微纳核芯投资提案 -众创基金(3).pdf'),
      docsPath('投资提案', '关于宁波赛智具身股权投资合伙企业（有限合伙）对北京中数睿智科技有限公司实施股权投资的提案(1).pdf'),
      docsPath('投资提案', '德塔智能投资提案.pdf'),
      docsPath('投资提案', '蓝成应急投资提案(1).pdf'),
    ],
    editableLevel: 'text-and-structure',
    sections: INVESTMENT_PROPOSAL_SECTION_TITLES,
    requiredParameters: ['projectId', 'sourceCutoffDate', 'audience', 'length'],
    disclaimer: '本文件为 AI 辅助生成的内部投资提案初稿，不替代投资建议书、尽职调查报告或投资决策文件。',
  },
  investment_recommendation_ppt: {
    type: 'investment_recommendation_ppt',
    skillName: 'create-reference-driven-editable-ppt',
    label: '投资建议书（PPT）',
    description: '基于当前项目资料、用户上传文件和会话要求生成可编辑投资建议书',
    outputFormat: 'pptx',
    templateVersion: 'recommendation-house-corpus-20260805-v3',
    referencePath: docsPath('agent', '投资建议书', '佳量脑科学_投资建议书6月.pptx'),
    referencePaths: [
      docsPath('投资建议书', '2. 普雷赛斯投资建议书.pdf'),
      docsPath('投资建议书', '2. 轻蜓光电投资建议书.pdf'),
      docsPath('投资建议书', '2.飞阔科技投资建议书-终稿.pdf'),
      docsPath('投资建议书', '微纳核芯投资建议书(2).pdf'),
      docsPath('投资建议书', '投资建议书_中数睿智(1).pdf'),
      docsPath('投资建议书', '浙江蓝成应急信息科技有限公司投资建议书(1).pdf'),
      docsPath('投资建议书', '飞阔科技投资建议书6.12(1).pdf'),
    ],
    workflowSkillNames: [
      'create-reference-driven-editable-ppt',
      'GordenSuperPPTSkill',
      'pdf-to-editable-ppt',
    ],
    templateSourceMode: 'native-pptx',
    editableLevel: 'core-elements',
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
    disclaimer: '本演示文稿由 AI 基于已授权资料生成，仅供内部讨论，不构成最终投资决策。',
  },
  due_diligence_report: {
    type: 'due_diligence_report',
    skillName: 'write-due-diligence-report',
    label: '尽调报告',
    description: '由资深投资经理先研读项目资料，再综合公司尽调模板语料库生成内部尽调报告',
    outputFormat: 'docx',
    templateVersion: 'dd-corpus-202608-v13-project-study-template-fidelity',
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
    skillName: 'answer-project-qa',
    label: '项目 Q&A',
    description: '由资深投资经理研读当前项目资料并按公司标准模板生成内部投资 Q&A',
    outputFormat: 'docx',
    templateVersion: 'qa-core-rules-20260804-v10-project-study-template-fidelity',
    referencePath: docsPath('Q&A', '中数睿智项目Q&A.pdf'),
    coreRulesPath: docsPath('Q&A', 'Q&A模板核心规则.md'),
    referencePaths: [
      docsPath('Q&A', '4. 普雷赛斯Q&A.pdf'),
      docsPath('Q&A', '4. 轻蜓光电Q&A(1).pdf'),
      docsPath('Q&A', '中数睿智项目Q&A.pdf'),
      docsPath('Q&A', '德塔智能项目Q&A(1).pdf'),
      docsPath('Q&A', '浙江蓝成应急信息科技有限公司 Q&A(1).pdf'),
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
    requiredParameters: ['projectId', 'sourceCutoffDate', 'qaMode', 'questionDepth'],
    disclaimer: '本文件由投资中台资深投资经理角色基于当前项目资料库及经页面核验的公开资料生成，仅供投资团队、风控法务、投资总监和投委会内部审阅，不构成正式法律、财务意见或最终投资决策；项目阶段以 OA 审批结果为准。',
  },
}

// Q&A 的五份 PDF 只用于 Template Parser 提炼结构、版式和语言风格。
// 样本正文永远不进入当前项目 RAG，也不能成为问题回答的证据。
export const AI_QA_TEMPLATE: AiQaTemplateDefinition = {
  type: 'project_qa',
  skillName: 'answer-project-qa',
  label: '项目 Q&A',
  templateVersion: AI_TEMPLATE_CATALOG.project_qa.templateVersion,
  templateDirectory: docsPath('Q&A'),
  coreRulesPath: AI_TEMPLATE_CATALOG.project_qa.coreRulesPath
    ?? docsPath('Q&A', 'Q&A模板核心规则.md'),
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
