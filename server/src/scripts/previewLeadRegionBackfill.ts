import { createHash } from 'node:crypto'
import { pool } from '../db/client.js'
import { previewLeadBusinessRegions } from '../services/leadRegionBackfill.js'

const idHash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12)

await previewLeadBusinessRegions().then((preview) => {
  const transitions = new Map<string, number>()
  const confidence = new Map<string, number>()
  for (const candidate of preview.candidates) {
    const transition = `${candidate.currentRegion || '空'} -> ${candidate.proposedRegion}`
    transitions.set(transition, (transitions.get(transition) ?? 0) + 1)
    confidence.set(candidate.proposedConfidence, (confidence.get(candidate.proposedConfidence) ?? 0) + 1)
  }
  console.log(JSON.stringify({
    ok: true,
    readOnly: true,
    scanned: preview.scanned,
    resolved: preview.resolved,
    unresolved: preview.unresolved,
    candidateCount: preview.candidates.length,
    transitions: Object.fromEntries([...transitions].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
    proposedConfidence: Object.fromEntries([...confidence].sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
    sample: preview.candidates.slice(0, 50).map((candidate) => ({
      idHash: idHash(candidate.id),
      currentRegion: candidate.currentRegion,
      currentConfidence: candidate.currentConfidence,
      proposedRegion: candidate.proposedRegion,
      proposedConfidence: candidate.proposedConfidence,
    })),
  }, null, 2))
}).finally(async () => pool.end())
