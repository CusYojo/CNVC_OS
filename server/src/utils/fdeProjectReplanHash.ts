import { createHash } from 'node:crypto'

// Replan-only wire format: MySQL JSON may reorder object keys. Array order and
// dates remain evidence; Date must serialize to its ISO instant, never to {}.
// Reject non-JSON values instead of silently collapsing them into null/{}.
export function replanCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  function encode(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (item instanceof Date) {
      if (!Number.isFinite(item.getTime())) throw new TypeError('REPLAN_HASH_INVALID_DATE')
      return JSON.stringify(item.toISOString())
    }
    if (!item || typeof item !== 'object') throw new TypeError('REPLAN_HASH_NON_JSON_VALUE')
    if (ancestors.has(item)) throw new TypeError('REPLAN_HASH_CIRCULAR_VALUE')
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('REPLAN_HASH_NON_JSON_OBJECT')
    ancestors.add(item)
    try {
      return Array.isArray(item) ? `[${Array.from(item, encode).join(',')}]`
        : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(',')}}`
    } finally { ancestors.delete(item) }
  }
  return encode(value)
}

export const replanHash = (value: unknown) => createHash('sha256').update(replanCanonicalJson(value)).digest('hex')
