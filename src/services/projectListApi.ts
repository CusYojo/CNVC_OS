import { apiGet } from '../lib/api'
import type { Project, ProjectClassification, ProjectLifecycle, RiskLevel } from '../types'

export type ProjectListCounts = { normal: number; key: number }

export type ProjectListQuery = {
  page: number
  pageSize: number
  scope: 'mine' | 'all'
  classification?: ProjectClassification
  lifecycle?: ProjectLifecycle
  keyword?: string
  stage?: string
  industry?: string
  owner?: string
  risk?: RiskLevel | ''
}

export type ProjectListResponse = {
  list: Project[]
  total: number
  page: number
  pageSize: number
  counts: ProjectListCounts
}

export function projectListPath(query: ProjectListQuery) {
  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value))
  })
  return `/projects?${params.toString()}`
}

export const fetchProjectList = (query: ProjectListQuery) =>
  apiGet<ProjectListResponse>(projectListPath(query))

type ProjectPageFetcher = (query: ProjectListQuery) => Promise<ProjectListResponse>

async function fetchProjectClassificationPages(
  classification: Extract<ProjectClassification, 'normal' | 'key'>,
  fetchPage: ProjectPageFetcher,
) {
  const query = (page: number): ProjectListQuery => ({
    page,
    pageSize: 100,
    scope: 'mine',
    classification,
    lifecycle: 'active',
  })
  const first = await fetchPage(query(1))
  const totalPages = Math.ceil(first.total / first.pageSize)
  const rest = await Promise.all(Array.from(
    { length: Math.max(0, totalPages - 1) },
    (_, index) => fetchPage(query(index + 2)),
  ))
  return [first, ...rest].flatMap((page) => page.list)
}

export async function fetchAiAssistantProjects(fetchPage: ProjectPageFetcher = fetchProjectList) {
  const groups = await Promise.all([
    fetchProjectClassificationPages('normal', fetchPage),
    fetchProjectClassificationPages('key', fetchPage),
  ])
  const unique = new Map(groups.flat().map((project) => [project.id, project]))
  return [...unique.values()].sort((left, right) => (
    Number(right.pinned) - Number(left.pinned)
      || right.updatedAt.localeCompare(left.updatedAt)
      || right.id.localeCompare(left.id)
  ))
}
