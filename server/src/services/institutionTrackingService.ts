import { asc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { leadInstitutionDictionary } from '../db/schema.js'
import { listLeads } from './aiSummaryService.js'
import {
  buildInstitutionTrackingDirectory,
  findInstitutionTrackingProfile,
  type InstitutionTrackingProfile,
} from './institutionTrackingPresentation.js'

async function discoveryLeads() {
  const first = await listLeads({ page: 1, pageSize: 100, projectDiscoveryOnly: true })
  const leads = [...first.list]
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await listLeads({ page, pageSize: 100, projectDiscoveryOnly: true })
    leads.push(...next.list)
  }
  return leads
}

async function institutionDictionary() {
  return db.select({
    id: leadInstitutionDictionary.id,
    canonicalName: leadInstitutionDictionary.canonicalName,
    aliases: leadInstitutionDictionary.aliases,
    institutionType: leadInstitutionDictionary.institutionType,
    tier: leadInstitutionDictionary.tier,
    major: leadInstitutionDictionary.major,
    status: leadInstitutionDictionary.status,
  }).from(leadInstitutionDictionary)
    .where(eq(leadInstitutionDictionary.status, 'active'))
    .orderBy(asc(leadInstitutionDictionary.canonicalName))
}

export async function listInstitutionTrackingProfiles(): Promise<InstitutionTrackingProfile[]> {
  const [leads, dictionary] = await Promise.all([discoveryLeads(), institutionDictionary()])
  return buildInstitutionTrackingDirectory(leads, dictionary)
}

export async function getInstitutionTrackingProfile(key: string): Promise<InstitutionTrackingProfile | null> {
  const [leads, dictionary] = await Promise.all([discoveryLeads(), institutionDictionary()])
  return findInstitutionTrackingProfile(key, leads, dictionary)
}
