import type { EvolutionSpec, PersonalAiExperience } from '../contracts/aiEvolutionContract.js'

type ManagementRow = {
  experience: { id: string; ownerUserId: string; revision: number; status: string; updatedAt: Date }
  version: { id: string; proposalId: string; contentHash: string; spec: EvolutionSpec }
}

/** Keep an owner-only stop control after revocation without exposing the inaccessible rule or sources. */
export async function listManagedAiExperiences(userId: string, rows: ManagementRow[],
  authorize: (proposalId: string, savedSpec: EvolutionSpec) => Promise<void>): Promise<PersonalAiExperience[]> {
  const list: PersonalAiExperience[] = []
  for (const row of rows) {
    if (row.experience.ownerUserId !== userId) continue
    const base = { id: row.experience.id, revision: row.experience.revision, status: row.experience.status,
      updatedAt: row.experience.updatedAt.toISOString() }
    try { await authorize(row.version.proposalId, row.version.spec) }
    catch (error) {
      if (![403, 404].includes((error as { status?: number } | null)?.status ?? 0)) throw error
      list.push({ ...base, access: 'revoked', versionId: null, contentHash: null, spec: null })
      continue
    }
    list.push({ ...base, access: 'available', versionId: row.version.id, contentHash: row.version.contentHash, spec: row.version.spec })
  }
  return list
}
