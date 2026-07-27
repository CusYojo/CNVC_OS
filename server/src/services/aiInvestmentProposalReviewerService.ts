import type {
  BusinessContent,
  BusinessFinding,
  BusinessSection,
  BusinessTable,
  EvidenceSource,
} from './aiBusinessContentService.js'
import {
  CURRENT_PROJECT_NO_DATA,
  proposalLeafSections,
  proposalSectionByTitle,
  type InvestmentProposalDocumentBlueprint,
} from './aiInvestmentProposalBlueprintService.js'
import type { InvestmentProposalEvidencePlan } from './aiInvestmentProposalEvidenceService.js'
import { isNearDuplicate } from './aiEvidenceQualityService.js'

export type InvestmentProposalReviewIssue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  sectionId?: string
  findingIndex?: number
  tableIndex?: number
}

export type InvestmentProposalReviewResult = {
  passed: boolean
  issues: InvestmentProposalReviewIssue[]
  checked: {
    sectionCount: number
    leafSectionCount: number
    findingCount: number
    tableCount: number
    citedFindingCount: number
    missingEvidenceSectionCount: number
  }
}

const STATUS_VALUES = new Set<BusinessFinding['status']>([
  '资料记载',
  'AI推断',
  '待核验',
  '资料缺口',
])

const TEMPLATE_SAMPLE_TERMS = [
  '佳量脑科学',
  '飞阔科技',
  '轻蜓光电',
  '普雷赛斯',
  '微纳核芯',
  '中数睿智',
  '德塔智能',
  '蓝成应急',
  'Epilcure',
  'BCMod',
]

const UNSUPPORTED_CERTAINTY = /(?:行业第一|绝对领先|唯一|必然|确保|确定性强|毫无风险|无可替代)/
const MISSING_ACTION = /(?:需补充|尚待提供|未提供|无法判断|待取得|待访谈|待核验|资料缺口)/
const RISK_REQUIRED_PARTS = [
  { label: '触发条件', pattern: /(?:触发|若|如|一旦|当|条件)/ },
  { label: '潜在影响', pattern: /(?:影响|导致|造成|可能|风险)/ },
  { label: '缓释或核验动作', pattern: /(?:缓释|核验|补充|取得|审查|跟踪|设置|落实|完成)/ },
  { label: '责任主体', pattern: /(?:责任|投资团队|项目组|法务|财务|管理层|公司|董事会)/ },
  { label: '执行时点', pattern: /(?:时点|交割前|投决前|签约前|持续|定期|截至|阶段|完成后)/ },
]

const DELIVERY_LIMITATION_CODES = new Set([
  'MISSING_EVIDENCE_RESEARCH_REQUIRED',
  'EVIDENCE_AVAILABLE_BUT_MISSING',
])

export function isInvestmentProposalDeliveryLimitation(code: string) {
  return DELIVERY_LIMITATION_CODES.has(code)
}

function numericTokens(value: string) {
  return [...new Set(
    value.match(/(?<![A-Za-z])(?:\d{1,4}(?:[.,]\d+)*%?)(?![A-Za-z])/g) ?? [],
  )]
    .map((token) => token.replace(/,/g, ''))
    .filter((token) => !/^0+$/.test(token))
}

function normalizeNumericText(value: string) {
  return value.replace(/,/g, '').replace(/\s+/g, '')
}

function citedText(indexes: number[], sources: EvidenceSource[]) {
  return indexes.map((index) => sources[index]?.content ?? '').join('\n')
}

function issue(
  issues: InvestmentProposalReviewIssue[],
  value: Omit<InvestmentProposalReviewIssue, 'severity'> & { severity?: 'error' | 'warning' },
) {
  issues.push({ severity: value.severity ?? 'error', ...value })
}

function safeNoDataFinding(topic: string): BusinessFinding {
  return {
    text: `${CURRENT_PROJECT_NO_DATA}需补充${topic}相关原始文件或经确认的项目记录后再行分析。`,
    status: '资料缺口',
    sourceIndexes: [],
  }
}

export function safeInvestmentProposalSection(
  title: string,
  topic = title,
): BusinessSection {
  return {
    title,
    summary: CURRENT_PROJECT_NO_DATA,
    findings: [safeNoDataFinding(topic)],
    tables: [],
  }
}

function reviewFinding(input: {
  finding: BusinessFinding
  section: BusinessSection
  sectionId: string
  findingIndex: number
  sources: EvidenceSource[]
  allowedSourceIndexes?: ReadonlySet<number>
  projectIdentity: string
  issues: InvestmentProposalReviewIssue[]
}) {
  const {
    finding,
    section,
    sectionId,
    findingIndex,
    sources,
    allowedSourceIndexes,
    projectIdentity,
    issues,
  } = input
  const location = { sectionId, findingIndex }
  if (!finding.text.trim()) {
    issue(issues, { ...location, code: 'EMPTY_FINDING', message: `${section.title}包含空事实项` })
    return
  }
  if (!STATUS_VALUES.has(finding.status)) {
    issue(issues, { ...location, code: 'INVALID_STATUS', message: `${section.title}包含非法证据状态` })
  }
  const validIndexes = finding.sourceIndexes.filter((index) =>
    Number.isInteger(index) && index >= 0 && index < sources.length)
  if (validIndexes.length !== finding.sourceIndexes.length) {
    issue(issues, { ...location, code: 'INVALID_CITATION', message: `${section.title}包含越界引用` })
  }
  if (
    (finding.status === '资料记载' || finding.status === 'AI推断')
    && validIndexes.length === 0
  ) {
    issue(issues, {
      ...location,
      code: 'CITATION_REQUIRED',
      message: `${finding.status}必须引用当前项目证据`,
    })
  }
  if (
    validIndexes.length > 0
    && validIndexes.every((index) => sources[index]?.sourceType.startsWith('public_web'))
    && finding.status !== '待核验'
  ) {
    issue(issues, {
      ...location,
      code: 'PUBLIC_WEB_REQUIRES_VERIFICATION',
      message: `${section.title}仅由联网公开信息支持，证据状态必须为“待核验”`,
    })
  }
  if (
    validIndexes.length === 0
    && finding.status !== '资料缺口'
    && !finding.text.startsWith(CURRENT_PROJECT_NO_DATA)
    && !MISSING_ACTION.test(finding.text)
  ) {
    issue(issues, {
      ...location,
      code: 'UNCITED_CLAIM',
      message: `${section.title}包含无引用的事实或判断`,
    })
  }
  if (finding.status === '资料缺口') {
    if (!finding.text.startsWith(CURRENT_PROJECT_NO_DATA)) {
      issue(issues, {
        ...location,
        code: 'NO_DATA_TEXT_REQUIRED',
        message: `资料缺口必须以“${CURRENT_PROJECT_NO_DATA}”开头`,
      })
    }
    if (validIndexes.length > 0) {
      issue(issues, {
        ...location,
        code: 'MISSING_WITH_CITATION',
        message: '资料缺口不得附带事实引用',
      })
    }
  }
  if (allowedSourceIndexes && validIndexes.some((index) => !allowedSourceIndexes.has(index))) {
    issue(issues, {
      ...location,
      code: 'CITATION_OUTSIDE_SECTION_EVIDENCE',
      message: `${section.title}引用了未进入本章节 Evidence Packet 的来源`,
    })
  }
  const support = normalizeNumericText(citedText(validIndexes, sources))
  numericTokens(finding.text).forEach((token) => {
    if (validIndexes.length && !support.includes(normalizeNumericText(token))) {
      issue(issues, {
        ...location,
        code: 'UNSUPPORTED_NUMBER',
        message: `${section.title}中的数字“${token}”未出现在所引证据中`,
      })
    }
  })
  TEMPLATE_SAMPLE_TERMS.forEach((term) => {
    if (finding.text.includes(term) && !projectIdentity.includes(term)) {
      issue(issues, {
        ...location,
        code: 'TEMPLATE_SAMPLE_LEAK',
        message: `${section.title}疑似泄露模板项目事实：${term}`,
      })
    }
  })
  if (UNSUPPORTED_CERTAINTY.test(finding.text)) {
    issue(issues, {
      ...location,
      code: 'UNSUPPORTED_CERTAINTY',
      message: `${section.title}使用了无条件确定性表达`,
    })
  }
}

function reviewTable(input: {
  table: BusinessTable
  section: BusinessSection
  sectionId: string
  tableIndex: number
  sources: EvidenceSource[]
  allowedSourceIndexes?: ReadonlySet<number>
  issues: InvestmentProposalReviewIssue[]
}) {
  const { table, section, sectionId, tableIndex, sources, allowedSourceIndexes, issues } = input
  const location = { sectionId, tableIndex }
  if (table.columns.length < 2 || table.columns.length > 8) {
    issue(issues, { ...location, code: 'INVALID_TABLE_COLUMNS', message: `${section.title}表格列数必须为 2–8` })
  }
  if (!table.rows.length || table.rows.length > 30) {
    issue(issues, { ...location, code: 'INVALID_TABLE_ROWS', message: `${section.title}表格行数必须为 1–30` })
  }
  if (table.rows.some((row) => row.length !== table.columns.length)) {
    issue(issues, { ...location, code: 'TABLE_SHAPE_MISMATCH', message: `${section.title}表格行列不一致` })
  }
  const validIndexes = table.sourceIndexes.filter((index) =>
    Number.isInteger(index) && index >= 0 && index < sources.length)
  if (!validIndexes.length) {
    issue(issues, { ...location, code: 'TABLE_CITATION_REQUIRED', message: `${section.title}表格必须引用当前项目证据` })
  }
  if (
    validIndexes.length > 0
    && validIndexes.every((index) => sources[index]?.sourceType.startsWith('public_web'))
    && table.status !== '待核验'
  ) {
    issue(issues, {
      ...location,
      code: 'PUBLIC_WEB_TABLE_REQUIRES_VERIFICATION',
      message: `${section.title}表格仅由联网公开信息支持，证据状态必须为“待核验”`,
    })
  }
  if (allowedSourceIndexes && validIndexes.some((index) => !allowedSourceIndexes.has(index))) {
    issue(issues, {
      ...location,
      code: 'TABLE_CITATION_OUTSIDE_SECTION',
      message: `${section.title}表格引用了未进入本章节 Evidence Packet 的来源`,
    })
  }
  const support = normalizeNumericText(citedText(validIndexes, sources))
  const tableText = [...table.columns, ...table.rows.flat()].join(' ')
  numericTokens(tableText).forEach((token) => {
    if (!support.includes(normalizeNumericText(token))) {
      issue(issues, {
        ...location,
        code: 'UNSUPPORTED_TABLE_NUMBER',
        message: `${section.title}表格数字“${token}”未出现在所引证据中`,
      })
    }
  })
}

export function reviewInvestmentProposalContent(input: {
  content: BusinessContent
  blueprint: InvestmentProposalDocumentBlueprint
  evidencePlan: InvestmentProposalEvidencePlan
  sources: EvidenceSource[]
  projectName: string
  companyName?: string | null
  sectionIds?: ReadonlySet<string>
}): InvestmentProposalReviewResult {
  const {
    content,
    blueprint,
    evidencePlan,
    sources,
    projectName,
    companyName,
    sectionIds,
  } = input
  const issues: InvestmentProposalReviewIssue[] = []
  const expectedDefinitions = blueprint.sections.filter((definition) =>
    !sectionIds || sectionIds.has(definition.id))
  const expectedTitles = expectedDefinitions.map((definition) => definition.title)
  const actualTitles = content.sections.map((section) => section.title)
  if (
    actualTitles.length !== expectedTitles.length
    || actualTitles.some((title, index) => title !== expectedTitles[index])
  ) {
    issue(issues, {
      code: 'SECTION_TREE_MISMATCH',
      message: `章节必须逐字、逐序匹配 Blueprint；预期 ${expectedTitles.length} 节，实际 ${actualTitles.length} 节`,
    })
  }
  if (!content.title.includes('提案') || !(content.title.includes(companyName || '') || content.title.includes(projectName))) {
    issue(issues, { code: 'INVALID_TITLE', message: '主标题未按目标公司投资提案格式生成' })
  }
  const projectIdentity = `${projectName} ${companyName ?? ''}`
  const evidenceBySection = new Map(evidencePlan.sections.map((section) => [
    section.sectionId,
    new Set(section.sourceIndexes),
  ]))
  const coverageBySection = new Map(evidencePlan.sections.map((section) => [
    section.sectionId,
    section.coverage,
  ]))
  const priorFindings: string[] = []

  expectedDefinitions.forEach((definition, expectedIndex) => {
    const sectionValue = content.sections[expectedIndex]
      ?? content.sections.find((section) => section.title === definition.title)
    if (!sectionValue) {
      issue(issues, {
        sectionId: definition.id,
        code: 'MISSING_SECTION',
        message: `缺少章节：${definition.title}`,
      })
      return
    }
    if (definition.container) {
      if (sectionValue.findings.length || (sectionValue.tables?.length ?? 0) > 0) {
        issue(issues, {
          sectionId: definition.id,
          code: 'CONTAINER_HAS_CONTENT',
          message: `容器章节“${definition.title}”不得与子章节重复承载正文`,
        })
      }
      return
    }
    if (!sectionValue.findings.length) {
      issue(issues, {
        sectionId: definition.id,
        code: 'EMPTY_SECTION',
        message: `章节“${definition.title}”没有正文或资料缺口说明`,
      })
      return
    }
    if (coverageBySection.get(definition.id) === 'missing') {
      issue(issues, {
        severity: 'warning',
        sectionId: definition.id,
        code: 'MISSING_EVIDENCE_RESEARCH_REQUIRED',
        message: `章节“${definition.title}”既没有项目证据，也没有联网检索记录；受限初稿中保留资料缺口并提示补充原始资料`,
      })
    } else if (sectionValue.findings.every((finding) => finding.status === '资料缺口')) {
      issue(issues, {
        // 章节生成阶段仍先要求模型按已有 Evidence 重生；两次生成后若仍无法
        // 形成受支持的结论，全篇 Reviewer 将其降级为可交付限制项。
        severity: sectionIds ? 'error' : 'warning',
        sectionId: definition.id,
        code: 'EVIDENCE_AVAILABLE_BUT_MISSING',
        message: `章节“${definition.title}”已有项目或联网证据，但未形成可安全引用的结论；受限初稿中保留资料缺口`,
      })
    }
    sectionValue.findings.forEach((finding, findingIndex) => {
      reviewFinding({
        finding,
        section: sectionValue,
        sectionId: definition.id,
        findingIndex,
        sources,
        allowedSourceIndexes: evidenceBySection.get(definition.id),
        projectIdentity,
        issues,
      })
      if (definition.analysisKind === 'risk_summary' && finding.status !== '资料缺口') {
        const missingParts = RISK_REQUIRED_PARTS
          .filter((part) => !part.pattern.test(finding.text))
          .map((part) => part.label)
        if (missingParts.length) {
          issue(issues, {
            sectionId: definition.id,
            findingIndex,
            code: 'RISK_ACTION_CHAIN_INCOMPLETE',
            message: `风险项缺少：${missingParts.join('、')}`,
          })
        }
      }
      if (
        definition.analysisKind === 'conclusion'
        && finding.status !== '资料缺口'
        && (
          !/(?:建议|推进|暂停|重新评估)/.test(finding.text)
          || !/(?:在.+后|完成|落实|经.+确认|若|如|前提|条件)/.test(finding.text)
        )
      ) {
        issue(issues, {
          sectionId: definition.id,
          findingIndex,
          code: 'CONDITIONAL_CONCLUSION_REQUIRED',
          message: '结论必须包含建议方向和明确的前置条件',
        })
      }
      if (isNearDuplicate(finding.text, priorFindings, 0.86)) {
        issue(issues, {
          severity: 'warning',
          sectionId: definition.id,
          findingIndex,
          code: 'DUPLICATE_FINDING',
          message: `章节“${definition.title}”与前文存在近似重复`,
        })
      } else {
        priorFindings.push(finding.text)
      }
    })
    ;(sectionValue.tables ?? []).forEach((table, tableIndex) => reviewTable({
      table,
      section: sectionValue,
      sectionId: definition.id,
      tableIndex,
      sources,
      allowedSourceIndexes: evidenceBySection.get(definition.id),
      issues,
    }))
  })

  blueprint.requiredAnalysisKinds.forEach((kind) => {
    const definition = blueprint.sections.find((item) => item.analysisKind === kind)
    if (!definition || (sectionIds && !sectionIds.has(definition.id))) return
    if (!content.sections.some((section) => section.title === definition.title)) {
      issue(issues, {
        sectionId: definition.id,
        code: 'REQUIRED_ANALYSIS_MISSING',
        message: `缺少必做分析：${definition.title}`,
      })
    }
  })

  return {
    passed: !issues.some((item) => item.severity === 'error'),
    issues,
    checked: {
      sectionCount: content.sections.length,
      leafSectionCount: proposalLeafSections(blueprint).filter((section) =>
        !sectionIds || sectionIds.has(section.id)).length,
      findingCount: content.sections.reduce((count, section) => count + section.findings.length, 0),
      tableCount: content.sections.reduce((count, section) => count + (section.tables?.length ?? 0), 0),
      citedFindingCount: content.sections.reduce(
        (count, section) => count + section.findings.filter((finding) => finding.sourceIndexes.length).length,
        0,
      ),
      missingEvidenceSectionCount: expectedDefinitions.filter((definition) =>
        !definition.container && coverageBySection.get(definition.id) === 'missing').length,
    },
  }
}

export function reviewIssuesForPrompt(review: InvestmentProposalReviewResult) {
  return review.issues
    .filter((item) => item.severity === 'error')
    .slice(0, 20)
    .map((item) => `${item.code}：${item.message}`)
    .join('\n')
}

export function proposalSectionIdForTitle(
  blueprint: InvestmentProposalDocumentBlueprint,
  title: string,
) {
  return proposalSectionByTitle(blueprint, title)?.id
}
