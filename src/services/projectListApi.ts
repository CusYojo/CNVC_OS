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
