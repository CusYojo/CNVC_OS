import JSZip from 'jszip'

export type CapabilityKind = 'skill' | 'agent' | 'mcp' | 'plugin'
export type CapabilityImportCandidate = {
  capabilityKey: string
  kind: CapabilityKind
  name?: string
  description?: string | null
  enabled?: boolean
  allowedRoles?: string[]
  config?: Record<string, unknown>
  toolNames?: string[]
  dependencyNames?: string[]
  instructions?: string
  sourcePath: string
}

type ExportableCapability = {
  capabilityKey: string
  kind: CapabilityKind
  name: string
  description: string | null
  enabled: boolean
  allowedRoles: string[]
  config: Record<string, unknown>
  toolNames: string[]
}

const MAX_SOURCE_FILES = 2_000
const MAX_MANIFESTS = 200
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024

function cleanPath(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) throw new Error('导入包包含不安全的文件路径。')
  return normalized
}

function basename(path: string) { return path.split('/').filter(Boolean).pop() || '' }
function dirname(path: string) { const parts = path.split('/').filter(Boolean); parts.pop(); return parts.join('/') }
function stem(path: string) { return basename(path).replace(/\.[^.]+$/, '') }
function unquote(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  return trimmed
}

function frontmatter(text: string) {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  const values: Record<string, string> = {}
  if (!match) return values
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/)
    if (item) values[item[1].toLowerCase()] = unquote(item[2])
  }
  return values
}

function listValue(value?: string) {
  if (!value) return undefined
  const normalized = value.replace(/^\[/, '').replace(/\]$/, '')
  return normalized.split(/[,，]/).map((item) => unquote(item).trim()).filter(Boolean)
}

function booleanValue(value?: string) {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function candidateFromText(kind: CapabilityKind, path: string, text: string, fallbackName: string): CapabilityImportCandidate | null {
  if (text.length > MAX_MANIFEST_BYTES) throw new Error(`${path} 超过单个清单 1MB 限制。`)
  if (kind === 'skill') {
    if (basename(path).toLowerCase() !== 'skill.md') return null
    const meta = frontmatter(text)
    const parent = basename(dirname(path))
    const capabilityKey = meta['capability-key'] || parent || fallbackName
    if (!/^[a-zA-Z0-9._-]+$/.test(capabilityKey)) throw new Error(`${path} 的 Skill ID 不合法。`)
    if (!meta.name && !meta.description) throw new Error(`${path} 缺少有效 YAML frontmatter。`)
    const instructions = text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
    if (!instructions) throw new Error(`${path} 缺少 Skill 指令正文。`)
    return {
      capabilityKey, kind, name: meta.name || capabilityKey, description: meta.description || null,
      enabled: booleanValue(meta.enabled), allowedRoles: listValue(meta['allowed-roles']), instructions, sourcePath: path,
    }
  }
  if (kind === 'agent') {
    if (!path.toLowerCase().endsWith('.md') || basename(path).toLowerCase() === 'skill.md') return null
    const meta = frontmatter(text)
    const instructions = text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()
    const capabilityKey = meta['capability-key'] || stem(path)
    if (!/^[a-zA-Z0-9._-]+$/.test(capabilityKey)) throw new Error(`${path} 的 Agent ID 不合法。`)
    if (!meta.name && !meta.description) throw new Error(`${path} 缺少有效 YAML frontmatter。`)
    return {
      capabilityKey, kind, name: meta.name || capabilityKey, description: meta.description || null,
      enabled: booleanValue(meta.enabled), allowedRoles: listValue(meta['allowed-roles']), sourcePath: path,
      config: {
        ...(meta['model-route-key'] ? { modelRouteKey: meta['model-route-key'] } : {}),
        ...(meta['timeout-ms'] ? { timeoutMs: Number(meta['timeout-ms']) } : {}),
        ...(meta['max-turns'] ? { maxTurns: Number(meta['max-turns']) } : {}),
        ...(meta['max-budget-usd'] ? { maxBudgetUsd: Number(meta['max-budget-usd']) } : {}),
        ...(meta.tools ? { toolNames: listValue(meta.tools) || [] } : {}),
        ...(instructions ? { instructions } : {}),
      },
    }
  }
  if (!path.toLowerCase().endsWith('.json')) return null
  const parsed = JSON.parse(text) as Partial<CapabilityImportCandidate>
  const capabilityKey = typeof parsed.capabilityKey === 'string' ? parsed.capabilityKey : stem(path)
  if (parsed.kind && parsed.kind !== kind) return null
  if (!/^[a-zA-Z0-9._-]+$/.test(capabilityKey)) throw new Error(`${path} 的能力 ID 不合法。`)
  const config = parsed.config && typeof parsed.config === 'object' ? parsed.config : {}
  const toolNames = Array.isArray((parsed as { toolNames?: unknown }).toolNames)
    ? (parsed as { toolNames: unknown[] }).toolNames.filter((item): item is string => typeof item === 'string')
    : Array.isArray(config.toolNames) ? config.toolNames.filter((item): item is string => typeof item === 'string') : undefined
  const dependencyNames = Array.isArray((parsed as { dependencyNames?: unknown }).dependencyNames)
    ? (parsed as { dependencyNames: unknown[] }).dependencyNames.filter((item): item is string => typeof item === 'string')
    : undefined
  return { capabilityKey, kind, name: typeof parsed.name === 'string' ? parsed.name : capabilityKey, description: parsed.description ?? null, enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined, allowedRoles: Array.isArray(parsed.allowedRoles) ? parsed.allowedRoles.filter((item): item is string => typeof item === 'string') : undefined, config, toolNames, dependencyNames, sourcePath: path }
}

function relevant(kind: CapabilityKind, path: string) {
  const lower = path.toLowerCase()
  if (kind === 'skill') return basename(lower) === 'skill.md'
  if (kind === 'agent') return lower.endsWith('.md') && basename(lower) !== 'skill.md'
  return lower.endsWith('.json')
}

function dedupe(candidates: CapabilityImportCandidate[]) {
  const map = new Map<string, CapabilityImportCandidate>()
  for (const candidate of candidates) {
    if (map.has(candidate.capabilityKey)) throw new Error(`导入源包含重复能力 ID：${candidate.capabilityKey}`)
    map.set(candidate.capabilityKey, candidate)
  }
  if (!map.size) throw new Error('导入源中没有找到符合当前能力类型的清单文件。')
  return [...map.values()]
}

export async function scanCapabilityFolder(kind: CapabilityKind, files: File[]) {
  if (!files.length) throw new Error('未选择任何文件。')
  if (files.length > MAX_SOURCE_FILES) throw new Error(`文件夹文件数不能超过 ${MAX_SOURCE_FILES}。`)
  const manifests = files.map((file) => ({ file, path: cleanPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name) })).filter((item) => relevant(kind, item.path))
  if (manifests.length > MAX_MANIFESTS) throw new Error(`能力清单不能超过 ${MAX_MANIFESTS} 项。`)
  const fallbackName = manifests[0]?.path.split('/')[0] || 'capability'
  const candidates = await Promise.all(manifests.map(async ({ file, path }) => candidateFromText(kind, path, await file.text(), fallbackName)))
  return dedupe(candidates.filter((item): item is CapabilityImportCandidate => Boolean(item)))
}

export async function scanCapabilityZip(kind: CapabilityKind, file: File) {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件不能超过 20MB。')
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && relevant(kind, cleanPath(entry.name)))
  if (entries.length > MAX_MANIFESTS) throw new Error(`能力清单不能超过 ${MAX_MANIFESTS} 项。`)
  const fallbackName = file.name.replace(/\.zip$/i, '')
  const candidates: CapabilityImportCandidate[] = []
  for (const entry of entries) {
    const size = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0)
    if (size > MAX_MANIFEST_BYTES) throw new Error(`${entry.name} 超过单个清单 1MB 限制。`)
    const candidate = candidateFromText(kind, cleanPath(entry.name), await entry.async('text'), fallbackName)
    if (candidate) candidates.push(candidate)
  }
  return dedupe(candidates)
}

function yamlString(value: string) { return JSON.stringify(value) }

export async function createCapabilityZip(kind: CapabilityKind, capabilities: ExportableCapability[]) {
  const zip = new JSZip()
  for (const item of capabilities) {
    if (kind === 'skill') {
      zip.file(`${item.capabilityKey}/SKILL.md`, `---\nname: ${yamlString(item.name)}\ndescription: ${yamlString(item.description || '')}\ncapability-key: ${item.capabilityKey}\nenabled: ${item.enabled}\nallowed-roles: [${item.allowedRoles.map(yamlString).join(', ')}]\n---\n\n# ${item.name}\n\n${item.description || ''}\n`)
    } else if (kind === 'agent') {
      zip.file(`${item.capabilityKey}.md`, `---\nname: ${yamlString(item.name)}\ndescription: ${yamlString(item.description || '')}\ncapability-key: ${item.capabilityKey}\nenabled: ${item.enabled}\nallowed-roles: [${item.allowedRoles.map(yamlString).join(', ')}]\nmodel-route-key: ${String(item.config.modelRouteKey || item.capabilityKey)}\ntimeout-ms: ${Number(item.config.timeoutMs || 120000)}\nmax-turns: ${Number(item.config.maxTurns || 1)}\nmax-budget-usd: ${Number(item.config.maxBudgetUsd || 1)}\ntools: [${item.toolNames.map(yamlString).join(', ')}]\n---\n\n# ${item.name}\n\n${item.description || ''}\n`)
    } else {
      zip.file(`${kind}/${item.capabilityKey}.json`, JSON.stringify(item, null, 2))
    }
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}
