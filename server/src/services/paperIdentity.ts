const TITLE_SEPARATOR_RE = /\s*[:：]\s*/
const QUESTION_SEPARATOR_RE = /\s*[?？]\s*/

const RHETORICAL_ENGLISH_PREFIX_RE = /^(?:when|why|how|can|could|do|does|did|is|are|will|would|should|what|where|who|more|towards?|on|a|an|the)\b/i
const COINED_NAME_RE = /^[A-Za-z][A-Za-z0-9._+\-/]{1,30}$/
const COINED_PHRASE_RE = /^[A-Za-z][A-Za-z0-9._+\-/]*(?:\s+[A-Z][A-Za-z0-9._+\-/]*){0,2}\s+(?:Bench|Benchmark|Dataset|System|Model|Framework|Agent|Lab|Suite|Engine)$/

function clean(value: unknown, maxLength = 180): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[“”"'「」『』\s]+|[“”"'「」『』\s]+$/g, '')
    .replace(/[。；;，,\s]+$/g, '')
    .trim()
    .slice(0, maxLength)
}

function isCoinedPaperName(value: string): boolean {
  const name = clean(value)
  if (!name || RHETORICAL_ENGLISH_PREFIX_RE.test(name)) return false
  if (COINED_NAME_RE.test(name) || COINED_PHRASE_RE.test(name)) return true
  return name.length <= 24
    && /[A-Za-z0-9]/.test(name)
    && /(?:模型|系统|框架|平台|算法|方法|数据集|基准)$/.test(name)
}

function substantiveSuffix(value: string, separator: RegExp): string {
  const parts = value.split(separator).map((part) => clean(part)).filter(Boolean)
  if (parts.length < 2) return ''
  const suffix = clean(parts.slice(1).join('：'))
  return suffix.length >= 4 ? suffix : ''
}

/**
 * Derives the concise research/project name from a paper title while keeping the
 * complete publication title separately. A coined method/system name (GeoMix,
 * gmsEDA) wins; a rhetorical headline ("When Agents Coordinate") is dropped in
 * favour of the substantive subtitle.
 */
export function derivePaperProjectName(titleValue: unknown): string {
  const title = clean(titleValue)
  if (!title) return ''
  const colonParts = title.split(TITLE_SEPARATOR_RE).map((part) => clean(part)).filter(Boolean)
  if (colonParts.length >= 2) {
    const prefix = colonParts[0]
    if (isCoinedPaperName(prefix)) return prefix
    return clean(colonParts.slice(1).join('：')) || title
  }
  const questionSuffix = substantiveSuffix(title, QUESTION_SEPARATOR_RE)
  if (questionSuffix) return questionSuffix
  return title
}

export function resolvePaperProjectIdentity(input: {
  titleOriginal?: unknown
  titleZh?: unknown
  modelProjectName?: unknown
  modelProjectNameZh?: unknown
}) {
  const titleOriginal = clean(input.titleOriginal)
  const titleZh = clean(input.titleZh)
  const projectNameOriginal = clean(input.modelProjectName)
    || derivePaperProjectName(titleOriginal)
  const projectName = clean(input.modelProjectNameZh)
    || derivePaperProjectName(titleZh)
    || projectNameOriginal
  return { projectName, projectNameOriginal }
}
