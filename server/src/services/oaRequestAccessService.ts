import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { oaApprovalRequests as requests, oaApprovalNodes as nodes, projects } from '../db/schema.js'
import { projectAccessCondition, type ProjectAccessActor } from './projectAccessService.js'
import { directiveApprovalAccessCondition } from './fdeDirectiveLinksService.js'
import { projectFileWorkspaceCondition } from './projectFileAccessService.js'

// Keep legacy applicant/assigned/project scopes identical across the original
// endpoint and the unified center. This never grants node action authority.
export function legacyApprovalAccessCondition(actor: ProjectAccessActor) {
  const projectIds = db.select({ id: projects.id }).from(projects).where(projectAccessCondition(actor))
  return and(ne(requests.businessType, 'office'), or(
    eq(requests.applicantUserId, actor.uid),
    inArray(requests.projectId, projectIds),
    sql<boolean>`EXISTS (SELECT 1 FROM ${nodes} assigned WHERE assigned.request_id=${requests.id}
      AND JSON_CONTAINS(assigned.approver_user_ids,JSON_QUOTE(${actor.uid})))`,
  ), or(and(ne(requests.businessType, 'agent_schedule'), ne(requests.businessType, 'project_replan')), inArray(requests.projectId, db.select({ id: projects.id }).from(projects).where(projectFileWorkspaceCondition(actor.uid)))), directiveApprovalAccessCondition(actor.uid))!
}
