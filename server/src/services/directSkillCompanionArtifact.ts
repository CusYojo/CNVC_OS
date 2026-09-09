import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CreateAiArtifactRecord } from '../repositories/aiTaskRepository.js'

export function directSkillCompanionArtifact(docx: CreateAiArtifactRecord, result: {
  pdfPath?: string; pdfBytes?: number; pdfSha256?: string
}): CreateAiArtifactRecord[] {
  if (!result.pdfPath) return []
  return [{
    ...docx,
    id: randomUUID(),
    fileName: path.basename(result.pdfPath),
    storagePath: result.pdfPath,
    format: 'pdf',
    mimeType: 'application/pdf',
    editableLevel: 'none',
    metadata: {
      companionDocxArtifactId: docx.id,
      bytes: result.pdfBytes,
      pdfSha256: result.pdfSha256,
      validationScope: 'pdf-readable-and-same-filename-only',
      contentAndVisualAcceptanceAuthority: 'executing-skill',
    },
  }]
}
