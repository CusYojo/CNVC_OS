type JsonObject = Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function authorList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean)
  return text(value).split(/\s*[,;；，]\s*/).map((author) => author.trim()).filter(Boolean)
}

/**
 * Merge refreshed paper metadata without allowing an incomplete source to
 * erase a previously verified author list.
 */
export function mergePaperMetadataPreservingAuthors(existing: JsonObject, incoming: JsonObject): JsonObject {
  const merged: JsonObject = { ...existing, ...incoming }
  const incomingAuthors = authorList(incoming.authors)
  if (incomingAuthors.length > 0) {
    merged.authors = incomingAuthors
    merged.firstAuthor = text(incoming.firstAuthor) || incomingAuthors[0] || ''
    merged.secondAuthor = text(incoming.secondAuthor) || incomingAuthors[1] || ''
    return merged
  }

  const existingAuthors = authorList(existing.authors)
  if (existingAuthors.length > 0) {
    merged.authors = existingAuthors
    merged.firstAuthor = text(existing.firstAuthor) || existingAuthors[0] || ''
    merged.secondAuthor = text(existing.secondAuthor) || existingAuthors[1] || ''
    return merged
  }

  merged.authors = []
  merged.firstAuthor = ''
  merged.secondAuthor = ''
  return merged
}
