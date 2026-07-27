import { existsSync } from 'node:fs'
import path from 'node:path'
import { INVESTMENT_PROPOSAL_SECTION_TITLES } from './aiInvestmentProposalBlueprintService.js'

export const AI_TASK_TYPES = [
  'compliance_statement',
  'investment_proposal',
  'investment_recommendation_ppt',
  'due_diligence_report',
  'project_qa',
] as const

export type AiBusinessTaskType = typeof AI_TASK_TYPES[number]

export type AiTemplateDefinition = {
  type: AiBusinessTaskType
  skillName:
    | 'generate-compliance-statement'
    | 'draft-investment-proposal'
    | 'build-investment-recommendation-ppt'
    | 'write-due-diligence-report'
    | 'answer-project-qa'
  label: string
  description: string
  outputFormat: 'docx' | 'pptx'
  companionFormats?: Array<'pdf' | 'png' | 'md'>
  additionalOutputFormats?: Array<'pdf'>
  templateVersion: string
  referencePath: string
  referencePaths?: string[]
  coreRulesPath?: string
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
  templateDirectory: string
  coreRulesPath: string
  referencePaths: string[]
  categories: string[]
  outputMode: 'document-task'
  downloadableArtifact: true
  outputFormats: ['docx', 'pdf']
}

export const AI_TEMPLATE_CATALOG: Record<AiBusinessTaskType, AiTemplateDefinition> = {
  compliance_statement: {
    type: 'compliance_statement',
    skillName: 'generate-compliance-statement',
    label: '合规性说明',
    description: '依据项目资料及基金投资约束生成合规性说明初稿',
    outputFormat: 'docx',
    companionFormats: ['pdf', 'md'],
    templateVersion: 'compliance-corpus-blueprint-20260725-v3',
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
    description: '生成用于内部立项或基金内部汇报的投资提案初稿',
    outputFormat: 'docx',
    templateVersion: 'proposal-corpus-20260726-v5',
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
    skillName: 'build-investment-recommendation-ppt',
    label: '投资建议书（PPT）',
    description: '生成核心文本、表格、基础图表和形状可编辑的投资建议书',
    outputFormat: 'pptx',
    templateVersion: 'recommendation-jialiang-37slides-v2',
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
    description: '按公司尽调模板库的八章结构生成带来源、核验状态和资料缺口的商业尽调报告初稿',
    outputFormat: 'docx',
    templateVersion: 'dd-corpus-202607-v3',
    referencePath: docsPath('尽调报告', '佳量脑科学业务尽调报告6月.docx'),
    referencePaths: [
      docsPath('尽调报告', '3. 普雷赛斯尽调报告.pdf'),
      docsPath('尽调报告', '3. 轻蜓光电尽调报告(1).pdf'),
      docsPath('尽调报告', '5. 普雷赛斯财务内部调研报告.pdf'),
      docsPath('尽调报告', '上海宇核聚能一体化小型模块化压水堆（SMR）项目尽职调查报告(1).docx'),
      docsPath('尽调报告', '中数睿智项目业务尽调报告(1).pdf'),
      docsPath('尽调报告', '佳量脑科学业务尽调报告6月.docx'),
      docsPath('尽调报告', '微纳核芯业务尽调报告.pdf'),
      docsPath('尽调报告', '微纳核芯尽调报告(1).pdf'),
      docsPath('尽调报告', '微纳核芯项目 - 法律尽职调查报告.pdf'),
      docsPath('尽调报告', '德塔智能IC报告.pdf'),
      docsPath('尽调报告', '德塔智能尽职调查报告(1).pdf'),
      docsPath('尽调报告', '蓝成应急尽调报告.pdf'),
    ],
    editableLevel: 'text-and-structure',
    sections: ['投资概要', '公司概况', '股权结构及融资历程', '公司治理与管理团队', '行业概况与市场空间', '产业链与竞争格局', '产品与核心技术', '商业模式与经营情况', '财务分析', '客户与商业化进展', '法律合规与资质', '估值合理性分析', '投资方案', '投资亮点', '风险分析', '资料缺口与后续核验'],
    requiredParameters: ['projectId', 'sourceCutoffDate', 'diligenceScope'],
    disclaimer: '本报告为 AI 基于截至资料截止日已授权资料生成的尽调初稿，不表示尽调程序已经完成，不构成法律、财务或投资意见。',
  },
  project_qa: {
    type: 'project_qa',
    skillName: 'answer-project-qa',
    label: '项目 Q&A',
    description: '基于当前项目资料自动生成投资委员会或尽调 Q&A，经问题生成、去重、回答和 Reviewer 审核后输出 Word 与 PDF',
    outputFormat: 'docx',
    additionalOutputFormats: ['pdf'],
    templateVersion: 'qa-core-rules-20260726-v5',
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
      '企业介绍',
      '商业模式',
      '产品能力',
      '团队',
      '市场',
      '竞争',
      '财务',
      '融资',
      '风险',
      '合规',
      '知识产权',
      '客户',
      '行业',
      '运营',
      '未来规划',
    ],
    requiredParameters: ['projectId', 'sourceCutoffDate', 'qaMode', 'questionDepth'],
    disclaimer: '本文件由 AI 仅基于当前项目资料生成，并已执行重复、完整性、幻觉与引用检查；仅供内部投资研究或尽调使用，不构成正式法律、财务意见或最终投资决策。',
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
  outputFormats: ['docx', 'pdf'],
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
  return AI_TASK_TYPES.map((type) => {
    const item = AI_TEMPLATE_CATALOG[type]
    return {
      type: item.type,
      label: item.label,
      description: item.description,
      outputFormat: item.outputFormat,
      companionFormats: item.companionFormats ?? [],
      skillName: item.skillName,
      templateVersion: item.templateVersion,
      requiredParameters: item.requiredParameters,
      outputFormats: [...new Set([
        item.outputFormat,
        ...(item.companionFormats ?? []),
        ...(item.additionalOutputFormats ?? []),
      ])],
    }
  })
}

export function isAiBusinessTaskType(value: string): value is AiBusinessTaskType {
  return (AI_TASK_TYPES as readonly string[]).includes(value)
}
