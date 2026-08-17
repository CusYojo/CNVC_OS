import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'

export type LegacyAiArtifactSource = {
  id: string
  taskId: string
  userId: string
  projectId: string
  fileName: string
  format: string
  storagePath: string
  qualityStatus: string
  archived: boolean
  metadata: Record<string, unknown>
}

function decodeCopyValue(raw: string): string | null {
  if (raw === String.raw`\N`) return null
  let result = ''
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index]
    if (current !== '\\') {
      result += current
      continue
    }
    const next = raw[index + 1]
    if (next == null) throw new Error('invalid trailing backslash in PostgreSQL COPY value')
    index += 1
    const escapes: Record<string, string> = {
      b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\',
    }
    if (next in escapes) {
      result += escapes[next]
      continue
    }
    if (next === 'x') {
      const hex = raw.slice(index + 1, index + 3).match(/^[0-9A-Fa-f]{1,2}/)?.[0]
      if (!hex) throw new Error('invalid hexadecimal PostgreSQL COPY escape')
      result += String.fromCharCode(Number.parseInt(hex, 16))
      index += hex.length
      continue
    }
    if (/[0-7]/.test(next)) {
      const octal = raw.slice(index, index + 3).match(/^[0-7]{1,3}/)?.[0] ?? next
      result += String.fromCharCode(Number.parseInt(octal, 8))
      index += octal.length - 1
      continue
    }
    result += next
  }
  return result
}

function parseMetadata(value: string | null, id: string): Record<string, unknown> {
  if (!value) return {}
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ai_artifacts metadata must be an object: ${id}`)
  }
  return parsed as Record<string, unknown>
}

export async function loadLegacyAiArtifactSources(): Promise<{
  dumpPath: string
  sourceSha256: string
  records: Map<string, LegacyAiArtifactSource>
}> {
  const dumpPath = path.resolve(process.env.PG_DUMP_PATH?.trim() || 'cybernaut_mvp_dump.sql')
  const hash = createHash('sha256')
  const records = new Map<string, LegacyAiArtifactSource>()
  let columns: string[] | undefined
  let buffered = ''

  const input = createReadStream(dumpPath, { encoding: 'utf8' })
  for await (const chunk of input) {
    hash.update(chunk)
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      processLine(buffered.slice(0, newline).replace(/\r$/, ''))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
  if (buffered) processLine(buffered.replace(/\r$/, ''))
  if (columns) throw new Error('unterminated COPY public.ai_artifacts block')
  if (!records.size) throw new Error('COPY public.ai_artifacts block is missing or empty')

  function processLine(line: string): void {
    if (!columns) {
      const match = line.match(/^COPY public\.ai_artifacts \(([^)]+)\) FROM stdin;$/)
      if (match) columns = match[1].split(', ')
      return
    }
    if (line === String.raw`\.`) {
      columns = undefined
      return
    }
    const values = line.split('\t')
    if (values.length !== columns.length) throw new Error('invalid ai_artifacts COPY row')
    const row = Object.fromEntries(columns.map((column, index) => [column, decodeCopyValue(values[index])]))
    const id = String(row.id || '')
    if (!id) throw new Error('ai_artifacts source row is missing id')
    records.set(id, {
      id,
      taskId: String(row.task_id || ''),
      userId: String(row.user_id || ''),
      projectId: String(row.project_id || ''),
      fileName: String(row.file_name || ''),
      format: String(row.format || ''),
      storagePath: String(row.storage_path || ''),
      qualityStatus: String(row.quality_status || ''),
      archived: row.archived === 't',
      metadata: parseMetadata(row.metadata as string | null, id),
    })
  }

  return { dumpPath, sourceSha256: hash.digest('hex'), records }
}
