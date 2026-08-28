import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { officePolicyConfig } from '../src/contracts/fdeOfficeContract.js'
import { officeAttachmentGrantAuthority, officeExecutionAuthorized, officeExecutionCommand, officeExecutionPolicy, validateOfficeExecution } from '../src/contracts/fdeOfficeExecutionContract.js'
import { officeRecoveryKey, officeResolvedResult, readOfficePending, rememberOfficePending } from '../../src/lib/fdeOfficeRecovery.js'

const uid = randomUUID(), role = randomUUID(), department = randomUUID()
const execution = officeExecutionPolicy.parse({ enabled: true, roleIds: [role], userIds: [uid], scope: 'institution', requiredFields: ['reference'], authorizationNote: '仅纯单测合成授权依据，不启用实际业务' })
const approvedAt = new Date('2026-08-28T00:00:00Z'), now = new Date('2026-08-28T02:00:00Z')
const command = () => officeExecutionCommand.parse({ clientRequestId: randomUUID(), expectedVersion: 4, expectedLatestId: null, action: 'record', outcome: 'failed', occurredAt: '2026-08-28T09:00:00+08:00', facts: { reference: 'synthetic' }, reason: '纯单测失败事实原因', files: [{ fileId: randomUUID(), version: 1, sha256: 'a'.repeat(64) }] })
const validate = (patch = {}) => validateOfficeExecution({ ...command(), ...patch }, '报销', execution, null, approvedAt, now)
const owner = randomUUID(), applicant = randomUUID(), other = randomUUID()
const grantCases = [
  { name: 'read-only applicant cannot upgrade download, regrant or remove execution grants', purpose: 'execution', uploadedBy: owner, userId: applicant, eligible: false, allowed: false },
  { name: 'applicant who is also an executor but not uploader still cannot manage execution grants', purpose: 'execution', uploadedBy: owner, userId: applicant, eligible: true, allowed: false },
  { name: 'applicant who actually uploaded and remains execution-eligible can manage', purpose: 'execution', uploadedBy: applicant, userId: applicant, eligible: true, allowed: true },
  { name: 'applicant-uploader loses management after execution-role revocation', purpose: 'execution', uploadedBy: applicant, userId: applicant, eligible: false, allowed: false },
  { name: 'non-applicant uploader with current execution eligibility can manage', purpose: 'execution', uploadedBy: owner, userId: owner, eligible: true, allowed: true },
  { name: 'non-uploader executor cannot manage another execution original', purpose: 'execution', uploadedBy: owner, userId: other, eligible: true, allowed: false },
  { name: 'legacy application remains applicant-managed without execution qualification', purpose: 'application', uploadedBy: owner, userId: applicant, eligible: false, allowed: true },
  { name: 'legacy signed copy remains applicant-managed without execution qualification', purpose: 'signed', uploadedBy: applicant, userId: applicant, eligible: false, allowed: true },
  { name: 'legacy file uploader cannot replace the applicant management rule', purpose: 'application', uploadedBy: owner, userId: owner, eligible: true, allowed: false },
]
for (const row of grantCases) test(`attachment management: ${row.name}`, () => {
  assert.equal(officeAttachmentGrantAuthority({ purpose: row.purpose, uploadedBy: row.uploadedBy, applicantId: applicant, userId: row.userId, executionEligible: row.eligible }), row.allowed)
})
test('grant API, detail disclosure and UI use the same explicit management capability', () => {
  const service = readFileSync(new URL('../src/services/fdeOfficeService.ts', import.meta.url), 'utf8')
  const grant = service.slice(service.indexOf('export async function grantOfficeAttachment'), service.indexOf('export async function getOfficeAttachment'))
  const detail = service.slice(service.indexOf('export async function getOfficeRequest'), service.indexOf('export async function listOfficeRequests'))
  assert.match(grant, /if \(!await canManageOfficeAttachment\(tx, row, file, userId\)\)/)
  assert.ok(grant.indexOf('canManageOfficeAttachment') < grant.indexOf('await tx.delete(grants)'))
  assert.match(detail, /const canManageGrants = await canManageOfficeAttachment\(tx, row, file, userId\)/)
  assert.match(detail, /grants: canManageGrants \?/)
  assert.doesNotMatch(detail, /grants: row.applicantUserId/)
  const ui = readFileSync(new URL('../../src/components/FdeOfficePanel.tsx', import.meta.url), 'utf8')
  assert.match(ui, /f.canManageGrants && <button/)
  assert.match(ui, /open=\{Boolean\(grantFile\) && canManageGrantFile\}/)
  assert.doesNotMatch(ui, /f.grants !== undefined && <button/)
})
test('no default executor: explicit account and current role are both required', () => {
  assert.equal(officeExecutionAuthorized(undefined, uid, [role], [], []), false)
  assert.equal(officeExecutionAuthorized({ ...execution, enabled: false }, uid, [role], [], []), false)
  assert.equal(officeExecutionAuthorized(execution, randomUUID(), [role], [], []), false)
  assert.equal(officeExecutionAuthorized(execution, uid, [], [], []), false)
  assert.equal(officeExecutionAuthorized(execution, uid, [role], [], []), true)
  assert.equal(officeExecutionAuthorized({ ...execution, scope: 'applicant_department' }, uid, [role], [], [department]), false)
  assert.equal(officeExecutionAuthorized({ ...execution, scope: 'applicant_department' }, uid, [role], [department], [department]), true)
})
test('old approval policy content and hash remain unchanged without execution configuration', () => {
  const old = { kind: '合同', requiredFields: [], attachmentRequired: false, rejectResubmission: false, routes: [{ key: 'default', when: {}, nodes: [{ key: 'review', name: '合成审批', roleIds: [role], scope: 'institution', mode: '或签', fixedUserIds: [], allowTransfer: false }] }] }
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.deepEqual(officePolicyConfig.parse(old), old)
  assert.equal(hash(officePolicyConfig.parse(old)), hash(old))
  assert.throws(() => officePolicyConfig.parse({ ...old, execution: { ...execution, requiredFields: ['amount'] } }))
  assert.throws(() => officeExecutionPolicy.parse({ ...execution, userIds: [] }))
  assert.throws(() => officeExecutionPolicy.parse({ ...execution, roleIds: [] }))
})
test('execution input rejects actor injection, missing evidence, invalid versions and duplicate originals', () => {
  const input = command()
  for (const patch of [{ actorId: uid }, { automaticPayment: true }, { files: [] }, { files: [input.files[0], input.files[0]] }, { files: [{ ...input.files[0], version: 2 }] }, { files: [{ ...input.files[0], sha256: 'bad' }] }, { outcome: 'approved' }, { occurredAt: '2026-08-28T09:00:00' }]) assert.throws(() => officeExecutionCommand.parse({ ...input, ...patch }))
  assert.deepEqual(validate(), [])
})
test('actual time must be after approval and not in the future; monetary and typed facts are validated', () => {
  for (const patch of [{ occurredAt: '2026-08-27T09:00:00Z' }, { occurredAt: '2026-08-29T09:00:00Z' }, { facts: {} }, { facts: { reference: 'x', amount: '1e3', currency: 'CNY' } }, { facts: { reference: 'x', amount: '1.00' } }, { facts: { reference: 'x', currency: 'cny' } }, { facts: { reference: 'x', signed: 'yes' } }]) assert.ok(validate(patch).length)
  assert.deepEqual(validate({ facts: { reference: 'x', amount: '0.10', currency: 'CNY' } }), [])
})
test('success cannot be retried; corrections link the latest record and never mutate the predecessor', () => {
  const previous = { id: randomUUID(), outcome: 'succeeded' }, snapshot = structuredClone(previous)
  const input = { ...command(), expectedLatestId: previous.id, action: 'correct' as const }
  assert.deepEqual(validateOfficeExecution(input, '报销', execution, previous, approvedAt, now), [])
  assert.deepEqual(previous, snapshot)
  assert.ok(validateOfficeExecution({ ...input, action: 'retry' }, '报销', execution, previous, approvedAt, now).length)
  assert.ok(validateOfficeExecution({ ...input, action: 'record' }, '报销', execution, previous, approvedAt, now).length)
  assert.ok(validateOfficeExecution({ ...input, expectedLatestId: randomUUID() }, '报销', execution, previous, approvedAt, now).length)
  assert.deepEqual(validateOfficeExecution({ ...input, action: 'retry' }, '报销', execution, { ...previous, outcome: 'failed' }, approvedAt, now), [])
})
test('execution recovery uses the existing actor-scoped minimal pointer, not sensitive receipt data', () => {
  const map = new Map<string, string>(), storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) } }
  const id = randomUUID(), marker = { id, commandId: randomUUID(), path: `/oa/office/requests/${id}/executions` }, key = officeRecoveryKey(uid)
  rememberOfficePending(storage, key, marker)
  assert.deepEqual(readOfficePending(storage, key), marker)
  assert.equal(readOfficePending(storage, officeRecoveryKey(randomUUID())), null)
  assert.throws(() => rememberOfficePending(storage, key, { ...marker, commandId: randomUUID() }))
  assert.deepEqual(officeResolvedResult({ state: 'committed', receipt: { id, version: 5 } }, id), { state: 'committed', receipt: { id, version: 5 } })
  assert.throws(() => officeResolvedResult({ state: 'committed', receipt: { id, version: 5, facts: {} } }, id))
})
test('static protection: execution receipts are append-only, linked to originals and separate from approval fields', () => {
  const source = readFileSync(new URL('../src/services/fdeOfficeService.ts', import.meta.url), 'utf8')
  const executionSource = source.slice(source.indexOf('export async function recordOfficeExecution'))
  assert.match(executionSource, /await evidence\(tx, row, userId, true\)/)
  assert.match(executionSource, /await executionEvidence\(tx, previous.id, userId, true\)/)
  assert.match(executionSource, /next = await update\(tx, row, \{\}\)/)
  assert.doesNotMatch(executionSource, /\.update\(executions\)|\.delete\(executions\)|\.update\(executionFiles\)|\.delete\(executionFiles\)/)
  assert.match(executionSource, /tx => beginCommand\(tx, id, userId, input.clientRequestId, hash\)/)
  assert.match(executionSource, /详情及原件须单独授权核对/)
  const sql = readFileSync(new URL('../drizzle/0087_add_fde_office_execution.sql', import.meta.url), 'utf8')
  assert.match(sql, /uq_office_execution_version/); assert.match(sql, /REFERENCES `sbl_oa_office_attachments`/)
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE |DELETE FROM/)
})
test('execution acceptance rejects unsafe database before imports or resources', () => {
  const entry = new URL('../src/scripts/fdeOfficeExecutionAcceptance.ts', import.meta.url)
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry.pathname], { env: { PATH: process.env.PATH, DB_DATABASE: 'business', ALLOW_MYSQL_ACCEPTANCE_WRITES: '1' }, encoding: 'utf8', timeout: 10000 })
  assert.ifError(result.error); assert.equal(result.status, 1)
  assert.match(result.stderr, /requires ALLOW_MYSQL_ACCEPTANCE_WRITES=1 with a dedicated/)
  assert.doesNotMatch(result.stderr + result.stdout, /ECONNREFUSED|ENOTFOUND|mysql config|fixturePrefix/)
  const source = readFileSync(entry, 'utf8')
  assert.ok(source.indexOf("assertIsolatedMysqlAcceptanceDatabase('fdeOfficeExecutionAcceptance')") < source.indexOf("await import('../db/client.js')"))
})
