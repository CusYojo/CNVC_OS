import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  leadAcademicInstitutionDictionary,
  leadCustomerDictionary,
  leadIndustryDictionary,
  leadInstitutionDictionary,
  leadInvestmentProfileProjections,
} from '../db/schema.js'
import { createMySqlIdentityRepositoryContext } from '../repositories/index.js'
import type { SystemAdministrator } from './systemAdministrationService.js'

type DictionaryStatus = 'active' | 'inactive'

export type LeadInstitutionDictionaryInput = {
  canonicalName: string
  aliases?: string[]
  institutionType: string
  tier?: string | null
  major: boolean
  status?: DictionaryStatus
}

export type LeadCustomerDictionaryInput = {
  canonicalName: string
  aliases?: string[]
  tier: 'A' | 'B' | 'C'
  confidentiality: 'public' | 'confidential' | 'restricted'
  status?: DictionaryStatus
}

export type LeadIndustryDictionaryInput = {
  canonicalName: string
  aliases?: string[]
  level1: string
  level2?: string | null
  segment?: string | null
  chainPosition?: string | null
  status?: DictionaryStatus
}

export type LeadAcademicInstitutionDictionaryInput = {
  canonicalName: string
  aliases?: string[]
  institutionType: string
  status?: DictionaryStatus
}

function dictionaryError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code })
}

function normalizedName(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function normalizedAliases(canonicalName: string, values: string[] | undefined) {
  const canonicalKey = normalizedName(canonicalName)
  return [...new Set((values ?? []).map((value) => value.normalize('NFKC').trim()).filter(Boolean))]
    .filter((value) => normalizedName(value) !== canonicalKey)
}

function assertNoNameCollision(
  rows: Array<{ id: string; canonicalName: string; aliases: string[] }>,
  input: { canonicalName: string; aliases: string[] },
  excludeId?: string,
) {
  const requested = new Set([input.canonicalName, ...input.aliases].map(normalizedName).filter(Boolean))
  for (const row of rows) {
    if (row.id === excludeId) continue
    const collision = [row.canonicalName, ...(row.aliases ?? [])].find((value) => requested.has(normalizedName(value)))
    if (collision) throw dictionaryError(409, 'INVESTMENT_DICTIONARY_ALIAS_CONFLICT', `名称或别名已被占用：${collision}`)
  }
}

async function requireAdministrator(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  actor: SystemAdministrator,
) {
  const identity = createMySqlIdentityRepositoryContext(tx)
  const administrator = await identity.users.lockById(actor.userId)
  if (!administrator || administrator.status !== '启用'
    || !(await identity.users.listPermissionCodes(administrator.id)).includes('system.manage')) {
    throw dictionaryError(403, 'ROLE_FORBIDDEN', '仅启用的系统管理员可维护投资画像字典')
  }
  return { identity, administrator: { id: administrator.id, name: administrator.name } }
}

async function markProfilesStale(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  await tx.update(leadInvestmentProfileProjections)
    .set({ profileStatus: 'stale', updatedAt: new Date() })
    .where(ne(leadInvestmentProfileProjections.profileStatus, 'stale'))
}

async function appendDictionaryAudit(
  identity: ReturnType<typeof createMySqlIdentityRepositoryContext>,
  actor: { id: string; name: string },
  action: string,
  target: unknown,
) {
  await identity.audits.append({
    userId: actor.id,
    userName: actor.name,
    module: '系统管理',
    action,
    target: JSON.stringify(target),
  })
}

export async function listLeadInvestmentProfileDictionaries() {
  const [institutions, customers, industries, academicInstitutions] = await Promise.all([
    db.select().from(leadInstitutionDictionary)
      .orderBy(asc(leadInstitutionDictionary.canonicalName), asc(leadInstitutionDictionary.id)),
    db.select().from(leadCustomerDictionary)
      .orderBy(asc(leadCustomerDictionary.canonicalName), asc(leadCustomerDictionary.id)),
    db.select().from(leadIndustryDictionary)
      .orderBy(asc(leadIndustryDictionary.level1), asc(leadIndustryDictionary.level2), asc(leadIndustryDictionary.canonicalName)),
    db.select().from(leadAcademicInstitutionDictionary)
      .orderBy(asc(leadAcademicInstitutionDictionary.canonicalName), asc(leadAcademicInstitutionDictionary.id)),
  ])
  return { institutions, customers, industries, academicInstitutions }
}

export async function createLeadInstitutionDictionaryItem(
  input: LeadInstitutionDictionaryInput & { reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const canonicalName = input.canonicalName.normalize('NFKC').trim()
    const aliases = normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadInstitutionDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases })
    const [created] = await tx.insert(leadInstitutionDictionary).values({
      canonicalName,
      aliases,
      institutionType: input.institutionType,
      tier: input.tier?.trim() || null,
      major: input.major,
      status: input.status ?? 'active',
      updatedBy: administrator.id,
    }).$returningId()
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '新增投资机构字典项', {
      itemId: created.id, canonicalName, reason: input.reason,
    })
    const [row] = await tx.select().from(leadInstitutionDictionary)
      .where(eq(leadInstitutionDictionary.id, created.id)).limit(1)
    return row!
  })
}

export async function updateLeadInstitutionDictionaryItem(
  id: string,
  input: Partial<LeadInstitutionDictionaryInput> & { expectedVersion: number; reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const [current] = await tx.select().from(leadInstitutionDictionary)
      .where(eq(leadInstitutionDictionary.id, id)).limit(1).for('update')
    if (!current) throw dictionaryError(404, 'INVESTMENT_INSTITUTION_NOT_FOUND', '投资机构字典项不存在')
    if (current.version !== input.expectedVersion) throw dictionaryError(409, 'VERSION_CONFLICT', '投资机构字典项已被修改，请刷新后重试')
    const canonicalName = input.canonicalName?.normalize('NFKC').trim() || current.canonicalName
    const aliases = input.aliases === undefined ? current.aliases : normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadInstitutionDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases }, id)
    await tx.update(leadInstitutionDictionary).set({
      ...(input.canonicalName !== undefined ? { canonicalName } : {}),
      ...(input.aliases !== undefined ? { aliases } : {}),
      ...(input.institutionType !== undefined ? { institutionType: input.institutionType } : {}),
      ...(input.tier !== undefined ? { tier: input.tier?.trim() || null } : {}),
      ...(input.major !== undefined ? { major: input.major } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      version: current.version + 1,
      updatedBy: administrator.id,
      updatedAt: new Date(),
    }).where(and(eq(leadInstitutionDictionary.id, id), eq(leadInstitutionDictionary.version, input.expectedVersion)))
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '更新投资机构字典项', {
      itemId: id, beforeVersion: current.version, patch: input, reason: input.reason,
    })
    const [row] = await tx.select().from(leadInstitutionDictionary)
      .where(eq(leadInstitutionDictionary.id, id)).limit(1)
    return row!
  })
}

export async function createLeadCustomerDictionaryItem(
  input: LeadCustomerDictionaryInput & { reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const canonicalName = input.canonicalName.normalize('NFKC').trim()
    const aliases = normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadCustomerDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases })
    const [created] = await tx.insert(leadCustomerDictionary).values({
      canonicalName,
      aliases,
      tier: input.tier,
      confidentiality: input.confidentiality,
      status: input.status ?? 'active',
      updatedBy: administrator.id,
    }).$returningId()
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '新增客户等级字典项', {
      itemId: created.id, canonicalName, reason: input.reason,
    })
    const [row] = await tx.select().from(leadCustomerDictionary)
      .where(eq(leadCustomerDictionary.id, created.id)).limit(1)
    return row!
  })
}

export async function updateLeadCustomerDictionaryItem(
  id: string,
  input: Partial<LeadCustomerDictionaryInput> & { expectedVersion: number; reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const [current] = await tx.select().from(leadCustomerDictionary)
      .where(eq(leadCustomerDictionary.id, id)).limit(1).for('update')
    if (!current) throw dictionaryError(404, 'INVESTMENT_CUSTOMER_NOT_FOUND', '客户等级字典项不存在')
    if (current.version !== input.expectedVersion) throw dictionaryError(409, 'VERSION_CONFLICT', '客户等级字典项已被修改，请刷新后重试')
    const canonicalName = input.canonicalName?.normalize('NFKC').trim() || current.canonicalName
    const aliases = input.aliases === undefined ? current.aliases : normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadCustomerDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases }, id)
    await tx.update(leadCustomerDictionary).set({
      ...(input.canonicalName !== undefined ? { canonicalName } : {}),
      ...(input.aliases !== undefined ? { aliases } : {}),
      ...(input.tier !== undefined ? { tier: input.tier } : {}),
      ...(input.confidentiality !== undefined ? { confidentiality: input.confidentiality } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      version: current.version + 1,
      updatedBy: administrator.id,
      updatedAt: new Date(),
    }).where(and(eq(leadCustomerDictionary.id, id), eq(leadCustomerDictionary.version, input.expectedVersion)))
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '更新客户等级字典项', {
      itemId: id, beforeVersion: current.version, patch: input, reason: input.reason,
    })
    const [row] = await tx.select().from(leadCustomerDictionary)
      .where(eq(leadCustomerDictionary.id, id)).limit(1)
    return row!
  })
}

export async function createLeadIndustryDictionaryItem(
  input: LeadIndustryDictionaryInput & { reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const canonicalName = input.canonicalName.normalize('NFKC').trim()
    const aliases = normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadIndustryDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases })
    const [created] = await tx.insert(leadIndustryDictionary).values({
      canonicalName,
      aliases,
      level1: input.level1.normalize('NFKC').trim(),
      level2: input.level2?.normalize('NFKC').trim() || null,
      segment: input.segment?.normalize('NFKC').trim() || null,
      chainPosition: input.chainPosition?.normalize('NFKC').trim() || null,
      status: input.status ?? 'active',
      updatedBy: administrator.id,
    }).$returningId()
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '新增投资画像行业字典项', {
      itemId: created.id, canonicalName, reason: input.reason,
    })
    const [row] = await tx.select().from(leadIndustryDictionary)
      .where(eq(leadIndustryDictionary.id, created.id)).limit(1)
    return row!
  })
}

export async function updateLeadIndustryDictionaryItem(
  id: string,
  input: Partial<LeadIndustryDictionaryInput> & { expectedVersion: number; reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const [current] = await tx.select().from(leadIndustryDictionary)
      .where(eq(leadIndustryDictionary.id, id)).limit(1).for('update')
    if (!current) throw dictionaryError(404, 'INVESTMENT_INDUSTRY_NOT_FOUND', '行业字典项不存在')
    if (current.version !== input.expectedVersion) throw dictionaryError(409, 'VERSION_CONFLICT', '行业字典项已被修改，请刷新后重试')
    const canonicalName = input.canonicalName?.normalize('NFKC').trim() || current.canonicalName
    const aliases = input.aliases === undefined ? current.aliases : normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadIndustryDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases }, id)
    await tx.update(leadIndustryDictionary).set({
      ...(input.canonicalName !== undefined ? { canonicalName } : {}),
      ...(input.aliases !== undefined ? { aliases } : {}),
      ...(input.level1 !== undefined ? { level1: input.level1.normalize('NFKC').trim() } : {}),
      ...(input.level2 !== undefined ? { level2: input.level2?.normalize('NFKC').trim() || null } : {}),
      ...(input.segment !== undefined ? { segment: input.segment?.normalize('NFKC').trim() || null } : {}),
      ...(input.chainPosition !== undefined ? { chainPosition: input.chainPosition?.normalize('NFKC').trim() || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      version: current.version + 1,
      updatedBy: administrator.id,
      updatedAt: new Date(),
    }).where(and(eq(leadIndustryDictionary.id, id), eq(leadIndustryDictionary.version, input.expectedVersion)))
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '更新投资画像行业字典项', {
      itemId: id, beforeVersion: current.version, patch: input, reason: input.reason,
    })
    const [row] = await tx.select().from(leadIndustryDictionary)
      .where(eq(leadIndustryDictionary.id, id)).limit(1)
    return row!
  })
}

export async function createLeadAcademicInstitutionDictionaryItem(
  input: LeadAcademicInstitutionDictionaryInput & { reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const canonicalName = input.canonicalName.normalize('NFKC').trim()
    const aliases = normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadAcademicInstitutionDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases })
    const [created] = await tx.insert(leadAcademicInstitutionDictionary).values({
      canonicalName,
      aliases,
      institutionType: input.institutionType.normalize('NFKC').trim(),
      status: input.status ?? 'active',
      updatedBy: administrator.id,
    }).$returningId()
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '新增高校科研机构字典项', {
      itemId: created.id, canonicalName, reason: input.reason,
    })
    const [row] = await tx.select().from(leadAcademicInstitutionDictionary)
      .where(eq(leadAcademicInstitutionDictionary.id, created.id)).limit(1)
    return row!
  })
}

export async function updateLeadAcademicInstitutionDictionaryItem(
  id: string,
  input: Partial<LeadAcademicInstitutionDictionaryInput> & { expectedVersion: number; reason: string },
  actor: SystemAdministrator,
) {
  return db.transaction(async (tx) => {
    const { identity, administrator } = await requireAdministrator(tx, actor)
    const [current] = await tx.select().from(leadAcademicInstitutionDictionary)
      .where(eq(leadAcademicInstitutionDictionary.id, id)).limit(1).for('update')
    if (!current) throw dictionaryError(404, 'ACADEMIC_INSTITUTION_NOT_FOUND', '高校科研机构字典项不存在')
    if (current.version !== input.expectedVersion) throw dictionaryError(409, 'VERSION_CONFLICT', '高校科研机构字典项已被修改，请刷新后重试')
    const canonicalName = input.canonicalName?.normalize('NFKC').trim() || current.canonicalName
    const aliases = input.aliases === undefined ? current.aliases : normalizedAliases(canonicalName, input.aliases)
    const rows = await tx.select().from(leadAcademicInstitutionDictionary).for('update')
    assertNoNameCollision(rows, { canonicalName, aliases }, id)
    await tx.update(leadAcademicInstitutionDictionary).set({
      ...(input.canonicalName !== undefined ? { canonicalName } : {}),
      ...(input.aliases !== undefined ? { aliases } : {}),
      ...(input.institutionType !== undefined ? { institutionType: input.institutionType.normalize('NFKC').trim() } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      version: current.version + 1,
      updatedBy: administrator.id,
      updatedAt: new Date(),
    }).where(and(eq(leadAcademicInstitutionDictionary.id, id), eq(leadAcademicInstitutionDictionary.version, input.expectedVersion)))
    await markProfilesStale(tx)
    await appendDictionaryAudit(identity, administrator, '更新高校科研机构字典项', {
      itemId: id, beforeVersion: current.version, patch: input, reason: input.reason,
    })
    const [row] = await tx.select().from(leadAcademicInstitutionDictionary)
      .where(eq(leadAcademicInstitutionDictionary.id, id)).limit(1)
    return row!
  })
}
