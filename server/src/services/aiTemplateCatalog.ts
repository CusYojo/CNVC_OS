import { existsSync } from 'node:fs'
import path from 'node:path'

export const AI_TASK_TYPES = [
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
] as const

export type AiBusinessTaskType = typeof AI_TASK_TYPES[number]

export type AiTemplateDefinition = {
  type: AiBusinessTaskType
  skillName:
    | 'generate-compliance-statement'
    | 'draft-investment-proposal'
    | 'build-investment-recommendation-ppt'
    | 'write-due-diligence-report'
  label: string
  description: string
  outputFormat: 'docx' | 'pptx'
  templateVersion: string
  referencePath: string
  editableLevel: 'text-and-structure' | 'core-elements'
  sections: string[]
  requiredParameters: string[]
  disclaimer: string
}

const docsPath = (...segments: string[]) => path.resolve(process.cwd(), 'docs', ...segments)

export type AiQaTemplateDefinition = {
  type: 'project_qa'
  skillName: 'answer-project-qa'
  label: string
  templateVersion: string
  referencePaths: string[]
  categories: string[]
}

export const AI_TEMPLATE_CATALOG: Record<AiBusinessTaskType, AiTemplateDefinition> = {
  compliance_statement: {
    type: 'compliance_statement',
    skillName: 'generate-compliance-statement',
    label: '合规性说明',
    description: '依据项目资料及基金投资约束生成合规性说明初稿',
    outputFormat: 'docx',
    templateVersion: 'compliance-deita-20260701-v1',
    referencePath: docsPath('合规性说明', '关于德塔智能项目投资合规性的说明_20260701.docx'),
    editableLevel: 'text-and-structure',
    sections: ['公司情况介绍', '公司简介', '核心团队', '产品及技术', '投资理由', '投资计划', '投资情形分析', '结论'],
    requiredParameters: ['projectId', 'sourceCutoffDate'],
    disclaimer: '本文件由 AI 基于已授权资料生成，仅供内部合规初审，不构成正式法律意见；须经法务或风控人员审核后方可作为正式材料。',
  },
  investment_proposal: {
    type: 'investment_proposal',
    skillName: 'draft-investment-proposal',
    label: '投资提案',
    description: '生成用于内部立项或基金内部汇报的投资提案初稿',
    outputFormat: 'docx',
    templateVersion: 'proposal-jialiang-20260622-v1',
    referencePath: docsPath('投资提案', '佳量脑科学项目投资提案0622(1).docx'),
    editableLevel: 'text-and-structure',
    sections: ['公司基本情况', '核心团队', '产品及技术', '市场与竞争', '财务摘要', '本次交易方案', '风险控制及保护性条款', '公司业务计划', '项目亮点总结', '风险与待核验事项'],
    requiredParameters: ['projectId', 'sourceCutoffDate', 'audience', 'length'],
    disclaimer: '本文件为 AI 辅助生成的内部投资提案初稿，不替代投资建议书、尽职调查报告或投资决策文件。',
  },
  investment_recommendation_ppt: {
    type: 'investment_recommendation_ppt',
    skillName: 'build-investment-recommendation-ppt',
    label: '投资建议书（PPT）',
    description: '生成核心文本、表格、基础图表和形状可编辑的投资建议书',
    outputFormat: 'pptx',
    templateVersion: 'recommendation-jialiang-37slides-v1',
    referencePath: docsPath('投资建议书', '佳量脑科学_投资建议书6月.pptx'),
    editableLevel: 'core-elements',
    sections: ['投资结论', '项目概览', '行业与市场', '产品与技术', '商业模式与客户', '团队', '竞争分析', '财务与估值', '投资方案', '核心风险', '尽调缺口', '下一步建议'],
    requiredParameters: ['projectId', 'sourceCutoffDate', 'template', 'pageCount', 'language'],
    disclaimer: '本演示文稿由 AI 基于已授权资料生成，仅供内部讨论，不构成最终投资决策。',
  },
  due_diligence_report: {
    type: 'due_diligence_report',
    skillName: 'write-due-diligence-report',
    label: '尽调报告',
    description: '生成带来源、核验状态和资料缺口的商业尽调报告初稿',
    outputFormat: 'docx',
    templateVersion: 'dd-jialiang-202606-v1',
    referencePath: docsPath('尽调报告', '佳量脑科学业务尽调报告6月.docx'),
    editableLevel: 'text-and-structure',
    sections: ['投资概要', '公司概况', '股权结构及融资历程', '公司治理与管理团队', '行业概况与市场空间', '产业链与竞争格局', '产品与核心技术', '商业模式与经营情况', '财务分析', '客户与商业化进展', '法律合规与资质', '估值合理性分析', '投资方案', '投资亮点', '风险分析', '资料缺口与后续核验'],
    requiredParameters: ['projectId', 'sourceCutoffDate', 'diligenceScope'],
    disclaimer: '本报告为 AI 基于截至资料截止日已授权资料生成的尽调初稿，不表示尽调程序已经完成，不构成法律、财务或投资意见。',
  },
}

// Q&A 没有可下载文档，但仍以 docs/Q&A 中经业务确认的项目问答样本提炼
// 展示顺序、证据披露和责任边界。样本正文永远不进入项目 RAG，也不能当作
// 当前项目证据；运行时只记录模板文件名及版本，避免跨项目事实污染。
export const AI_QA_TEMPLATE: AiQaTemplateDefinition = {
  type: 'project_qa',
  skillName: 'answer-project-qa',
  label: '项目 Q&A',
  templateVersion: 'qa-docs-samples-202607-v1',
  referencePaths: [
    docsPath('Q&A', '中数睿智项目Q&A.pdf'),
    docsPath('Q&A', '德塔智能项目Q&A(1).pdf'),
    docsPath('Q&A', '浙江蓝成应急信息科技有限公司 Q&A(1).pdf'),
  ],
  categories: ['投资亮点', '核心风险', '财务', '客户', '竞争', '合规', '资料缺口'],
}

export function assertAiTemplateReferences(
  template: Pick<AiTemplateDefinition, 'referencePath'> | Pick<AiQaTemplateDefinition, 'referencePaths'>,
) {
  const paths = 'referencePath' in template ? [template.referencePath] : template.referencePaths
  const missing = paths.filter((referencePath) => !existsSync(referencePath))
  if (missing.length > 0) {
    throw Object.assign(new Error(`AI 业务模板不存在：${missing.map((item) => path.basename(item)).join('、')}`), {
      status: 503,
      code: 'AI_TEMPLATE_NOT_AVAILABLE',
    })
  }
}

export function listAiTaskTypes() {
  return AI_TASK_TYPES.map((type) => {
    const item = AI_TEMPLATE_CATALOG[type]
    return {
      type: item.type,
      label: item.label,
      description: item.description,
      outputFormat: item.outputFormat,
      skillName: item.skillName,
      templateVersion: item.templateVersion,
      requiredParameters: item.requiredParameters,
    }
  })
}

export function isAiBusinessTaskType(value: string): value is AiBusinessTaskType {
  return (AI_TASK_TYPES as readonly string[]).includes(value)
}
