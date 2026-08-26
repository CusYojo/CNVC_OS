type PaperAuthorContributionRole =
  | 'first_author'
  | 'joint_first_author'
  | 'joint_senior_author'
  | 'corresponding_author'
  | 'coauthor'

export type PaperAffiliation = {
  name: string
  sourceUrl: string
  evidenceStatus: 'source_confirmed'
}

export type PaperAuthorContribution = {
  author: string
  role: PaperAuthorContributionRole
  label: string
}

export type PaperAuthorIdentity = {
  name: string
  normalizedName: string
  position: number
  role: PaperAuthorContributionRole
  affiliations: Array<{ name: string; evidenceUrl: string }>
  identityStatus: 'ambiguous'
  evidenceUrl: string
}

export type PaperResearchMetadata = {
  affiliations: PaperAffiliation[]
  researchTeam: {
    name: string
    basis: 'paper_coauthorship'
    memberCount: number
  }
  authorContributions: PaperAuthorContribution[]
  paperAuthors: PaperAuthorIdentity[]
  authorAffiliations: Array<{
    author: string
    affiliation: string
    evidenceUrl: string
    status: 'source_confirmed'
  }>
  rights: {
    articleLicense?: {
      code: string
      label: string
      url: string
      status: 'confirmed'
      scope: 'article'
    }
    dataset?: { url: string; licenseStatus: 'pending' }
    code?: { url: string; licenseStatus: 'pending' }
    intellectualProperty: {
      status: 'undisclosed'
      label: '未披露'
      note: '论文开放许可不等于知识产权归属'
    }
  }
  metadataSource: { url: string }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
    dagger: '†', Dagger: '‡', ast: '*', middot: '·', ndash: '–', mdash: '—',
  }
  return value
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
      const point = code.toLowerCase().startsWith('x')
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10)
      return Number.isFinite(point) ? String.fromCodePoint(point) : ''
    })
    .replace(/&([a-z][\w]+);/gi, (match, entity: string) => named[entity] ?? match)
}

function plainText(value: string): string {
  return decodeEntities(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const normalized = value.normalize('NFKC').toLocaleLowerCase('en-US')
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function validAffiliation(value: string): boolean {
  const organizationCue = /\b(?:university|université|universidad|college|school|department|faculty|institute|institution|laborator(?:y|ies)|labs?|research|centre|center|hospital|academy|foundation|corporation|company|inc\.?|ltd\.?|gmbh|deepmind|google|microsoft|meta|openai|anthropic|bytedance|amazon|nvidia|ibm|tencent|alibaba|baidu|huawei|riken|cnrs|inria|mit|eth|epfl)\b/i
  return value.length >= 3
    && value.length <= 180
    && !/^\[+$/.test(value)
    && !/^affiliation\s*:?$/i.test(value)
    && !/[\\{}]/.test(value)
    && !/@|https?:\/\//i.test(value)
    && organizationCue.test(value)
}

function affiliationNames(html: string): string[] {
  const structured = [...html.matchAll(/<span\b[^>]*class=["'][^"']*\bltx_role_affiliation\b[^"']*["'][^>]*>(?:\s*<span\b[^>]*class=["'][^"']*\bltx_contact_name\b[^"']*["'][^>]*>[\s\S]*?<\/span>)?([\s\S]*?)<\/span>/gi)]
    .map((match) => plainText(match[1]).replace(/^affiliation\s*:\s*/i, '').trim())
    .filter(validAffiliation)
  if (structured.length > 0) return unique(structured)

  const titleStart = html.search(/<h1\b[^>]*class=["'][^"']*\bltx_title_document\b/i)
  const headerText = plainText((titleStart >= 0 ? html.slice(0, titleStart) : html).slice(-16_000))
  const fallback = [...headerText.matchAll(/(?:^|\s)\d+\]\s*(.+?)(?=\s+\d+\]|\s+\\?(?:correspondence|contribution)\b|\s+Joint\s+(?:first|senior)\s+author\b|$)/gi)]
    .map((match) => match[1].trim().replace(/[.;,]+$/, ''))
    .filter(validAffiliation)
  return unique(fallback)
}

function canonicalLicense(label: string, originalUrl: string) {
  const normalized = label.replace(/^license\s*:\s*/i, '').trim()
  const compact = normalized.toUpperCase().replace(/\s+/g, ' ')
  const secureUrl = originalUrl.replace(/^http:/i, 'https:')
  if (/\/licenses\/nonexclusive-distrib\/1\.0/i.test(originalUrl)) {
    return { code: 'arXiv.org perpetual non-exclusive license', label: 'arXiv.org perpetual non-exclusive license', url: secureUrl }
  }
  const mappings = [
    { pattern: /CC\s+BY-NC-SA\s+4\.0/, code: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
    { pattern: /CC\s+BY-SA\s+4\.0/, code: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    { pattern: /CC\s+BY\s+4\.0/, code: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    { pattern: /CC0\s+1\.0/, code: 'CC0 1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  ]
  const urlCode = originalUrl.match(/creativecommons\.org\/licenses\/(by(?:-nc)?(?:-nd|-sa)?|by-nc-sa)\/(\d\.\d)/i)
  const urlLabel = urlCode ? `CC ${urlCode[1].toUpperCase()} ${urlCode[2]}` : ''
  const mapped = mappings.find((item) => item.pattern.test(compact) || item.pattern.test(urlLabel))
  const code = mapped?.code ?? normalized
  return code ? { code, label: code, url: mapped?.url ?? secureUrl } : undefined
}

function linkAfterLabel(html: string, label: 'Dataset' | 'Code'): string {
  const match = html.match(new RegExp(`${label}\\s*:\\s*(?:<[^>]+>\\s*)*<a\\b[^>]*href=["']([^"']+)["']`, 'i'))
  return match?.[1] ? decodeEntities(match[1]).trim() : ''
}

function authorContribution(
  author: string,
  authorHtml: string,
  definitions: { jointFirst: boolean; jointSenior: boolean },
  position: number,
): PaperAuthorContribution {
  const index = authorHtml.indexOf(author)
  const nearby = index >= 0 ? plainText(authorHtml.slice(index, index + 480)) : ''
  if (definitions.jointFirst && /(?:∗|\*)/.test(nearby.slice(0, 80))) {
    return { author, role: 'joint_first_author', label: '共同第一作者' }
  }
  if (definitions.jointSenior && /†/.test(nearby.slice(0, 80))) {
    return { author, role: 'joint_senior_author', label: '共同资深作者' }
  }
  if (position === 0) return { author, role: 'first_author', label: '第一作者' }
  return { author, role: 'coauthor', label: '共同作者' }
}

export function arxivPaperId(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = value.trim().match(/(?:arxiv(?:\.org)?[:/]\s*)?(\d{4}\.\d{4,5})(v\d+)?/i)
  return match ? `${match[1]}${match[2] || ''}` : ''
}

export function parseArxivResearchMetadata(input: {
  html: string
  authors: string[]
  projectName: string
  sourceUrl: string
}): PaperResearchMetadata {
  const { html, sourceUrl } = input
  const authors = unique(input.authors.map((author) => author.trim()).filter(Boolean))
  const authorStart = html.search(/<div\b[^>]*class=["'][^"']*\bltx_authors\b/i)
  const abstractStart = html.search(/<div\b[^>]*class=["'][^"']*\bltx_abstract\b/i)
  const authorHtml = authorStart >= 0
    ? html.slice(authorStart, abstractStart > authorStart ? abstractStart : authorStart + 20_000)
    : html
  const headerText = plainText(html.slice(0, abstractStart >= 0 ? abstractStart : 30_000))
  const definitions = {
    jointFirst: /Joint\s+first\s+author/i.test(headerText),
    jointSenior: /Joint\s+senior\s+author/i.test(headerText),
  }
  const licenseMatch = html.match(/<a\b[^>]*id=["']license-tr["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
    ?? html.match(/<div\b[^>]*class=["'][^"']*\babs-license\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
  const license = licenseMatch
    ? canonicalLicense(plainText(licenseMatch[2]), decodeEntities(licenseMatch[1]))
    : undefined
  const datasetUrl = linkAfterLabel(html, 'Dataset')
  const codeUrl = linkAfterLabel(html, 'Code')
  const authorContributions = authors.map((author, position) => authorContribution(author, authorHtml, definitions, position))

  return {
    affiliations: affiliationNames(html).map((name) => ({ name, sourceUrl, evidenceStatus: 'source_confirmed' })),
    researchTeam: {
      name: `${input.projectName.trim() || '论文'}联合研究团队`,
      basis: 'paper_coauthorship',
      memberCount: authors.length,
    },
    authorContributions,
    paperAuthors: authors.map((name, position) => ({
      name,
      normalizedName: name.normalize('NFKC').toLocaleLowerCase('en-US'),
      position: position + 1,
      role: authorContributions[position]?.role || (position === 0 ? 'first_author' : 'coauthor'),
      affiliations: [],
      identityStatus: 'ambiguous',
      evidenceUrl: sourceUrl,
    })),
    authorAffiliations: [],
    rights: {
      ...(license ? { articleLicense: { ...license, status: 'confirmed' as const, scope: 'article' as const } } : {}),
      ...(datasetUrl ? { dataset: { url: datasetUrl, licenseStatus: 'pending' as const } } : {}),
      ...(codeUrl ? { code: { url: codeUrl, licenseStatus: 'pending' as const } } : {}),
      intellectualProperty: {
        status: 'undisclosed',
        label: '未披露',
        note: '论文开放许可不等于知识产权归属',
      },
    },
    metadataSource: { url: sourceUrl },
  }
}

export async function fetchArxivResearchMetadata(input: {
  arxivId: string
  authors: string[]
  projectName: string
}): Promise<PaperResearchMetadata> {
  const id = arxivPaperId(input.arxivId)
  if (!id) throw new Error(`无法识别 arXiv ID：${input.arxivId}`)
  let sourceUrl = `https://arxiv.org/html/${id}`
  let response = await fetch(sourceUrl, {
    headers: { 'User-Agent': 'sbl-jedi-paper-research-metadata/1.0 (deterministic metadata enrichment)' },
    signal: AbortSignal.timeout(45_000),
  })
  if (response.status === 404) {
    sourceUrl = `https://arxiv.org/abs/${id}`
    response = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'sbl-jedi-paper-research-metadata/1.0 (deterministic metadata enrichment)' },
      signal: AbortSignal.timeout(45_000),
    })
  }
  if (!response.ok) throw new Error(`arXiv source HTTP ${response.status} ${response.statusText}`)
  return parseArxivResearchMetadata({
    html: await response.text(),
    authors: input.authors,
    projectName: input.projectName,
    sourceUrl,
  })
}
