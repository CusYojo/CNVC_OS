import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { hashPassword } from '../services/authService.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

const baseUrl = process.env.LEAD_ENRICHMENT_HTTP_ACCEPTANCE_URL || ''
const usersTable = quoteMysqlIdentifier(mysqlTableName('users'))
const rolesTable = quoteMysqlIdentifier(mysqlTableName('roles'))
const userRolesTable = quoteMysqlIdentifier(mysqlTableName('user_roles'))
const sessionsTable = quoteMysqlIdentifier(mysqlTableName('auth_sessions'))
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))

function setCookieLines(headers: Headers): string[] {
  const enhanced = headers as Headers & { getSetCookie?: () => string[] }
  return enhanced.getSetCookie?.() ?? [headers.get('set-cookie') || '']
}

function cookieHeader(lines: string[]) {
  return lines.map((line) => line.split(';')[0]).filter(Boolean).join('; ')
}

function cookieValue(lines: string[], name: string) {
  const match = lines.join(',').match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`))
  assert(match?.[1])
  return decodeURIComponent(match[1])
}

async function login(email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, remember: false }),
  })
  assert.equal(response.status, 200)
  const cookieLines = setCookieLines(response.headers)
  const cookie = cookieHeader(cookieLines)
  assert.match(cookie, /cybernaut_session=/)
  return { cookie, csrf: cookieValue(cookieLines, 'cybernaut_csrf') }
}

async function main() {
  assertIsolatedMysqlAcceptanceDatabase('leadEnrichmentHttpFixtureAcceptance')
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  const ordinaryId = randomUUID()
  const adminId = randomUUID()
  const ordinaryEmail = `lead-display-${ordinaryId}@example.invalid`
  const adminEmail = `lead-admin-${adminId}@example.invalid`
  const ordinaryPassword = `ordinary-${randomUUID()}`
  const adminPassword = `admin-${randomUUID()}`
  try {
    const [leadRows] = await pool.query<Array<RowDataPacket & { id: string; name: string }>>(
      `SELECT id,name FROM ${leadsTable} WHERE name IN ('火种图谱项目','联网补全隔离验收企业')`,
    )
    const leadId = leadRows.find((lead) => lead.name === '火种图谱项目')?.id
    const deregisteredLeadId = leadRows.find((lead) => lead.name === '联网补全隔离验收企业')?.id
    assert(leadId && deregisteredLeadId)
    const [roleRows] = await pool.query<Array<RowDataPacket & { id: string; name: string }>>(
      `SELECT id,name FROM ${rolesTable} WHERE name IN ('投资经理','系统管理员')`,
    )
    const ordinaryRoleId = roleRows.find((role) => role.name === '投资经理')?.id
    const adminRoleId = roleRows.find((role) => role.name === '系统管理员')?.id
    assert(ordinaryRoleId && adminRoleId)
    await pool.query(
      `INSERT INTO ${usersTable} (id,email,name,role,department,password_hash,status,created_at)
       VALUES (?,?,?,'投资经理','验收部',?,'启用',NOW(3)),(?,?,?,'系统管理员','验收部',?,'启用',NOW(3))`,
      [ordinaryId, ordinaryEmail, '普通详情验收用户', await hashPassword(ordinaryPassword),
        adminId, adminEmail, '补全管理验收用户', await hashPassword(adminPassword)],
    )
    await pool.query(
      `INSERT INTO ${userRolesTable} (user_id,role_id,is_primary,created_at)
       VALUES (?,?,1,NOW(3)),(?,?,1,NOW(3))`,
      [ordinaryId, ordinaryRoleId, adminId, adminRoleId],
    )

    const anonymous = await fetch(`${baseUrl}/api/leads/${leadId}/verified-profile`)
    assert.equal(anonymous.status, 401)

    const ordinary = await login(ordinaryEmail, ordinaryPassword)
    const profileResponse = await fetch(`${baseUrl}/api/leads/${leadId}/verified-profile`, {
      headers: { cookie: ordinary.cookie },
    })
    assert.equal(profileResponse.status, 200)
    const profile = await profileResponse.json() as Record<string, unknown>
    assert.deepEqual(Object.keys(profile).sort(), ['frozenAt', 'introductionSources', 'introductions', 'leadId'])
    assert(!Object.hasOwn(profile, 'topics') && !Object.hasOwn(profile, 'entities'))

    const factsResponse = await fetch(`${baseUrl}/api/leads/${leadId}/verified-facts?page=1&pageSize=100`, {
      headers: { cookie: ordinary.cookie },
    })
    assert.equal(factsResponse.status, 200)
    const facts = await factsResponse.json() as { total?: number; facts?: Array<Record<string, unknown>> }
    assert(Number(facts.total) >= 1)
    assert.equal(facts.facts?.length, facts.total)
    assert(!facts.facts?.some((fact) => fact.factKey === 'acceptance.unverified_display_guard'))
    for (const fact of facts.facts || []) {
      assert.equal(fact.verificationStatus, 'verified')
      for (const field of ['topicKey', 'subjectId', 'evidenceLevel', 'version', 'createdAt']) {
        assert(!Object.hasOwn(fact, field))
      }
      for (const evidence of fact.evidence as Array<Record<string, unknown>>) {
        for (const field of ['id', 'quote', 'locator', 'pageHash', 'reliability']) {
          assert(!Object.hasOwn(evidence, field))
        }
      }
    }

    for (const path of [
      `/api/leads/${leadId}/enrichment`,
      `/api/leads/${leadId}/enrichment/conflicts`,
      `/api/leads/${leadId}/facts`,
      '/api/lead-enrichment/metrics',
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: ordinary.cookie } })
      assert.equal(response.status, 403, `ordinary user unexpectedly accessed ${path}`)
    }

    for (const path of [
      `/api/leads/${deregisteredLeadId}`,
      `/api/leads/${deregisteredLeadId}/verified-profile`,
      `/api/leads/${deregisteredLeadId}/verified-facts`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: ordinary.cookie } })
      assert.equal(response.status, 404, `deregistered lead remained publicly readable at ${path}`)
    }
    const publicList = await fetch(`${baseUrl}/api/leads?keyword=${encodeURIComponent('联网补全隔离验收企业')}`, {
      headers: { cookie: ordinary.cookie },
    })
    assert.equal(publicList.status, 200)
    const publicListBody = await publicList.json() as { list?: Array<{ id?: string }> }
    assert(!publicListBody.list?.some((lead) => lead.id === deregisteredLeadId))

    for (const [path, body] of [
      [`/api/leads/${leadId}/enrichment`, { idempotencyKey: 'ordinary-user-must-not-enqueue' }],
      [`/api/leads/${leadId}/enrichment/topics/basic_profile/retry`, { reason: '普通用户不得重试补全专题' }],
      [`/api/leads/${leadId}/enrichment/entity/confirm`, { canonicalName: '越权主体', reason: '普通用户不得确认主体' }],
      [`/api/leads/${leadId}/enrichment/conflicts/${randomUUID()}/resolve`, { decision: 'dismiss', reason: '普通用户不得裁决冲突' }],
      [`/api/leads/${leadId}/score`, {}],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie: ordinary.cookie, 'x-csrf-token': ordinary.csrf, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 403, `ordinary user unexpectedly mutated ${path}`)
    }

    const admin = await login(adminEmail, adminPassword)
    for (const path of [
      `/api/leads/${leadId}/enrichment`,
      `/api/leads/${leadId}/enrichment/conflicts`,
      `/api/leads/${leadId}/facts?page=1&pageSize=5`,
      '/api/lead-enrichment/metrics',
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie: admin.cookie } })
      assert.equal(response.status, 200, `administrator could not access ${path}`)
    }
    const hiddenAudit = await fetch(`${baseUrl}/api/leads/${deregisteredLeadId}/facts?page=1&pageSize=5`, {
      headers: { cookie: admin.cookie },
    })
    assert.equal(hiddenAudit.status, 200)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'anonymous-display-projection-rejected',
        'ordinary-user-minimal-verified-projection-only',
        'ordinary-user-audit-and-operations-forbidden',
        'ordinary-user-mutations-forbidden-with-valid-csrf-session',
        'deregistered-lead-hidden-from-public-list-detail-and-projections',
        'system-administrator-audit-and-operations-readable',
        'system-administrator-can-audit-hidden-lead-evidence',
      ],
    }))
  } finally {
    await pool.query(`DELETE FROM ${sessionsTable} WHERE user_id IN (?,?)`, [ordinaryId, adminId]).catch(() => undefined)
    await pool.query(`DELETE FROM ${userRolesTable} WHERE user_id IN (?,?)`, [ordinaryId, adminId]).catch(() => undefined)
    await pool.query(`DELETE FROM ${usersTable} WHERE id IN (?,?)`, [ordinaryId, adminId]).catch(() => undefined)
    await pool.end()
  }
}

await main()
