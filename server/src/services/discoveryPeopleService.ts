import { desc, eq, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import { radarCandidates } from '../db/schema.js'
import { peopleFromResearchCandidates, type DiscoveryPerson, type DiscoveryPersonKind } from '../contracts/discoveryPeopleContract.js'
import { OFFICIAL_DISCOVERY_PEOPLE } from '../data/discoveryOfficialPeople.js'

export async function listDiscoveryPeople(input: {
  kind: DiscoveryPersonKind | 'all'
  query: string
  page: number
  pageSize: number
}) {
  let research: DiscoveryPerson[] = []
  if (input.kind === 'all' || input.kind === 'research') {
    const rows = await db.select({ source: radarCandidates.source, sourceGroup: radarCandidates.sourceGroup, payload: radarCandidates.payload })
      .from(radarCandidates)
      .where(or(eq(radarCandidates.sourceGroup, '论文'), eq(radarCandidates.source, 'openalex'), eq(radarCandidates.source, 'arxiv')))
      .orderBy(desc(radarCandidates.cursorTimestamp))
      .limit(500)
    research = peopleFromResearchCandidates(rows)
  }
  const all = [...OFFICIAL_DISCOVERY_PEOPLE, ...research]
  const keyword = input.query.trim().toLocaleLowerCase('zh-CN')
  const filtered = all.filter((person) => (
    (input.kind === 'all' || person.kind === input.kind)
    && (!keyword || [person.name, person.organization, person.field, person.sourceLabel]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(keyword)))
  ))
  const start = (input.page - 1) * input.pageSize
  return {
    items: filtered.slice(start, start + input.pageSize),
    total: filtered.length, page: input.page, pageSize: input.pageSize,
    totalPages: Math.max(1, Math.ceil(filtered.length / input.pageSize)),
    sourceNote: '榜单与专家为官方已发布名录快照；科研作者来自库内历史论文，自动论文采集当前未启用。',
  }
}
