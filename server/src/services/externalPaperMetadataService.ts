type JsonObject = Record<string, unknown>

export type ExternalPaperContribution = {
  author: string
  role: 'sole_author' | 'first_author' | 'coauthor'
  label: '独立作者' | '第一作者' | '共同作者'
}

export type ExternalPaperMetadata = {
  doi: string
  title: string
  authors: string[]
  affiliations: Array<{ name: string; sourceUrl: string; evidenceStatus: 'source_confirmed' }>
  publishedAt: string
  declaredPublishedAt: string
  publicationDateStatus: 'confirmed' | 'source_declared_future'
  publicationDateBasis: 'publisher_published_at' | 'metadata_record_created_at'
  resourceType: string
  venue: string
  landingPageUrl: string
  pdfUrl: string
  license?: { code: string; label: string; url: string }
  metadataSource: { provider: 'Crossref' | 'DataCite' | 'Zenodo'; url: string; recordCreatedAt: string }
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function dateFromParts(value: unknown): string {
  const parts = Array.isArray(object(value)['date-parts']) ? object(value)['date-parts'] as unknown[] : []
  const first = Array.isArray(parts[0]) ? parts[0] : []
  const year = Number(first[0])
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return ''
  const month = Number(first[1] || 1)
  const day = Number(first[2] || 1)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function isoDate(value: unknown): string {
  const raw = text(value)
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

function futureDate(value: string, now = new Date()): boolean {
  const timestamp = Date.parse(`${value}T23:59:59Z`)
  return Boolean(value) && Number.isFinite(timestamp) && timestamp > now.getTime()
}

function normalizedDate(declaredPublishedAt: string, recordCreatedAt: string, now?: Date) {
  if (futureDate(declaredPublishedAt, now)) return {
    publishedAt: recordCreatedAt,
    publicationDateStatus: 'source_declared_future' as const,
    publicationDateBasis: 'metadata_record_created_at' as const,
  }
  return {
    publishedAt: declaredPublishedAt || recordCreatedAt,
    publicationDateStatus: 'confirmed' as const,
    publicationDateBasis: declaredPublishedAt ? 'publisher_published_at' as const : 'metadata_record_created_at' as const,
  }
}

function canonicalLicense(label: string, url: string) {
  const combined = `${label} ${url}`.toLowerCase()
  const mappings = [
    { match: /by-nc-nd[-/ ]?4\.0/, code: 'CC BY-NC-ND 4.0', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' },
    { match: /by-nc-sa[-/ ]?4\.0/, code: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
    { match: /by-nc[-/ ]?4\.0/, code: 'CC BY-NC 4.0', url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
    { match: /by-sa[-/ ]?4\.0/, code: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    { match: /by[-/ ]?4\.0/, code: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  ]
  const mapping = mappings.find((item) => item.match.test(combined))
  const code = mapping?.code || label.trim()
  return code ? { code, label: code, url: mapping?.url || url.replace(/^http:/i, 'https:') } : undefined
}

function resourceTypeLabel(value: string): string {
  const normalized = value.toLowerCase()
  if (/journal/.test(normalized)) return '期刊论文'
  if (/thesis|dissertation/.test(normalized)) return '学位论文'
  if (/dataset|model/.test(normalized)) return '研究数据/模型'
  if (/standard/.test(normalized)) return '研究标准/框架'
  return value || '科研成果'
}

export function doiFromPaperSource(value: unknown): string {
  const raw = text(value)
  const direct = raw.match(/10\.\d{4,9}\/[\w.()/:;-]+/i)?.[0]?.replace(/[),.;]+$/, '')
  if (direct) return direct.toLowerCase()
  const cairn = raw.match(/INNO_PR2_(\d{4})/i)
  if (cairn) return `10.3917/inno.pr2.${cairn[1]}`
  const cairnPage = raw.match(/page-I(\d{3})/i)
  return cairnPage ? `10.3917/inno.pr2.0${cairnPage[1]}` : ''
}

export function authorContributions(authors: string[]): ExternalPaperContribution[] {
  const names = unique(authors)
  if (names.length === 1) return [{ author: names[0], role: 'sole_author', label: '独立作者' }]
  return names.map((author, index) => index === 0
    ? { author, role: 'first_author' as const, label: '第一作者' as const }
    : { author, role: 'coauthor' as const, label: '共同作者' as const })
}

export function parseCrossrefPaperMetadata(payload: unknown, doi: string, now?: Date): ExternalPaperMetadata {
  const message = object(object(payload).message)
  const authors = (Array.isArray(message.author) ? message.author : []).flatMap((value) => {
    const author = object(value)
    const name = [text(author.given), text(author.family)].filter(Boolean).join(' ')
    return name ? [name] : []
  })
  const sourceUrl = `https://api.crossref.org/works/${doi}`
  const affiliations = unique((Array.isArray(message.author) ? message.author : []).flatMap((value) => {
    const author = object(value)
    return (Array.isArray(author.affiliation) ? author.affiliation : []).map((item) => text(object(item).name))
  })).map((name) => ({ name, sourceUrl, evidenceStatus: 'source_confirmed' as const }))
  const declaredPublishedAt = dateFromParts(message.published) || dateFromParts(message.issued)
  const recordCreatedAt = isoDate(object(message.created)['date-time'])
  const date = normalizedDate(declaredPublishedAt, recordCreatedAt, now)
  const licenseEntry = object((Array.isArray(message.license) ? message.license : [])[0])
  const license = canonicalLicense('', text(licenseEntry.URL))
  const rawType = text(message.type)
  return {
    doi,
    title: decodeEntities(text((Array.isArray(message.title) ? message.title : [])[0])),
    authors,
    affiliations,
    ...date,
    declaredPublishedAt,
    resourceType: resourceTypeLabel(rawType),
    venue: decodeEntities(text((Array.isArray(message['container-title']) ? message['container-title'] : [])[0]) || text(message.publisher)),
    landingPageUrl: text(message.URL) || `https://doi.org/${doi}`,
    pdfUrl: '',
    ...(license ? { license } : {}),
    metadataSource: { provider: 'Crossref', url: sourceUrl, recordCreatedAt },
  }
}

export function parseDataCitePaperMetadata(payload: unknown, doi: string, now?: Date): ExternalPaperMetadata {
  const data = object(object(payload).data)
  const attributes = object(data.attributes)
  const creators = Array.isArray(attributes.creators) ? attributes.creators : []
  const authors = creators.map((value) => {
    const creator = object(value)
    return [text(creator.givenName), text(creator.familyName)].filter(Boolean).join(' ') || text(creator.name)
  }).filter(Boolean)
  const sourceUrl = `https://api.datacite.org/dois/${doi}`
  const creatorAffiliations = creators.flatMap((value) => (Array.isArray(object(value).affiliation) ? object(value).affiliation as unknown[] : []))
    .map((value) => typeof value === 'string' ? value : text(object(value).name))
  const rawType = text(object(attributes.types).resourceType) || text(object(attributes.types).resourceTypeGeneral)
  const publisherAsInstitution = /thesis|dissertation/i.test(rawType) ? [text(attributes.publisher)] : []
  const affiliations = unique([...creatorAffiliations, ...publisherAsInstitution]).map((name) => ({ name, sourceUrl, evidenceStatus: 'source_confirmed' as const }))
  const declaredYear = Number(attributes.publicationYear)
  const declaredPublishedAt = isoDate(attributes.published) || (Number.isInteger(declaredYear) ? `${declaredYear}-01-01` : '')
  const recordCreatedAt = isoDate(attributes.created)
  const date = normalizedDate(declaredPublishedAt, recordCreatedAt, now)
  const rightsEntry = object((Array.isArray(attributes.rightsList) ? attributes.rightsList : [])[0])
  const license = canonicalLicense(text(rightsEntry.rightsIdentifier || rightsEntry.rights), text(rightsEntry.rightsUri))
  return {
    doi,
    title: text((Array.isArray(attributes.titles) ? object(attributes.titles[0]).title : '')),
    authors,
    affiliations,
    ...date,
    declaredPublishedAt,
    resourceType: resourceTypeLabel(rawType),
    venue: text(attributes.publisher),
    landingPageUrl: text(attributes.url) || `https://doi.org/${doi}`,
    pdfUrl: '',
    ...(license ? { license } : {}),
    metadataSource: { provider: 'DataCite', url: sourceUrl, recordCreatedAt },
  }
}

export function parseZenodoPaperMetadata(payload: unknown, doi: string, now?: Date): ExternalPaperMetadata {
  const root = object(payload)
  const metadata = object(root.metadata)
  const creators = Array.isArray(metadata.creators) ? metadata.creators : []
  const authors = creators.map((value) => {
    const creator = object(value)
    const raw = text(creator.name)
    const parts = raw.split(',').map((part) => part.trim()).filter(Boolean)
    return parts.length === 2 ? `${parts[1]} ${parts[0]}` : raw
  }).filter(Boolean)
  const affiliations = unique(creators.map((value) => text(object(value).affiliation))).map((name) => ({
    name,
    sourceUrl: `https://zenodo.org/api/records/${root.id}`,
    evidenceStatus: 'source_confirmed' as const,
  }))
  const declaredPublishedAt = isoDate(metadata.publication_date)
  const recordCreatedAt = isoDate(root.created)
  const date = normalizedDate(declaredPublishedAt, recordCreatedAt, now)
  const licenseId = text(object(metadata.license).id)
  const license = canonicalLicense(licenseId, licenseId ? `https://spdx.org/licenses/${licenseId}.html` : '')
  const rawType = text(object(metadata.resource_type).subtype) || text(object(metadata.resource_type).type) || text(object(metadata.resource_type).title)
  const files = Array.isArray(root.files) ? root.files : []
  const pdfFile = files.find((value) => /\.pdf$/i.test(text(object(value).key)))
  const pdfUrl = text(object(object(pdfFile).links).self).replace(/\/api\/records\/(\d+)\/files\//, '/records/$1/files/').replace(/\/content$/, '')
  return {
    doi,
    title: text(metadata.title),
    authors,
    affiliations,
    ...date,
    declaredPublishedAt,
    resourceType: resourceTypeLabel(rawType),
    venue: 'Zenodo',
    landingPageUrl: `https://zenodo.org/records/${root.id}`,
    pdfUrl,
    ...(license ? { license } : {}),
    metadataSource: { provider: 'Zenodo', url: `https://zenodo.org/api/records/${root.id}`, recordCreatedAt },
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'sbl-jedi-external-paper-metadata/1.0 (metadata repair)' },
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`${url} HTTP ${response.status} ${response.statusText}`)
  return await response.json()
}

export async function fetchDoiPaperMetadata(doi: string): Promise<ExternalPaperMetadata> {
  const normalized = doiFromPaperSource(doi)
  if (!normalized) throw new Error(`无法识别 DOI：${doi}`)
  const zenodoId = normalized.match(/^10\.5281\/zenodo\.(\d+)$/i)?.[1]
  if (zenodoId) return parseZenodoPaperMetadata(await fetchJson(`https://zenodo.org/api/records/${zenodoId}`), normalized)
  try {
    return parseCrossrefPaperMetadata(await fetchJson(`https://api.crossref.org/works/${normalized}`), normalized)
  } catch (crossrefError) {
    try {
      return parseDataCitePaperMetadata(await fetchJson(`https://api.datacite.org/dois/${normalized}`), normalized)
    } catch (dataciteError) {
      throw new Error(`DOI 元数据读取失败：Crossref=${crossrefError instanceof Error ? crossrefError.message : crossrefError}; DataCite=${dataciteError instanceof Error ? dataciteError.message : dataciteError}`)
    }
  }
}
