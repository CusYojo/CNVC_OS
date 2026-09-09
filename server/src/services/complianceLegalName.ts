import type { EvidenceSource } from './aiBusinessContentService.js'

const LEGAL_NAME = /[\u3400-\u9fff·]{2,24}(?:（[\u3400-\u9fff]{1,12}）)?(?:有限责任公司|股份有限公司|有限公司)/g

export function supportedComplianceLegalName(projectCompanyName: string | null | undefined, sources: EvidenceSource[]) {
  const declared = projectCompanyName?.trim()
  if (declared && sources.some(source => source.content.includes(declared))) return declared
  const counts = new Map<string, number>()
  for (const source of sources) {
    const matches = (source.content.match(LEGAL_NAME) ?? []).map(match => match
      .replace(/^(?:企业名称为|企业名称|公司名称为|公司名称|名称为|名称)[：:]?/, '').trim())
    for (const match of new Set(matches)) {
      counts.set(match, (counts.get(match) ?? 0) + 1)
    }
  }
  const ranked = [...counts].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
  const projectStem = (declared || '')
    .replace(/（(?:新|项目)）|\((?:新|项目)\)/g, '')
    .replace(/项目$/, '')
    .trim()
  const projectMatches = projectStem ? ranked.flatMap(([name, count]) => {
    const offset = name.indexOf(projectStem)
    return offset >= 0 ? [[name.slice(offset), count] as [string, number]] : []
  }) : []
  if (projectMatches.length && (!projectMatches[1] || projectMatches[0][1] > projectMatches[1][1])) {
    return projectMatches[0][0]
  }
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return undefined
  return ranked[0][0]
}
