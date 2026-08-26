function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function buildConditionalRollbackPatch<T extends Record<string, unknown>>(input: {
  before: T
  after: T
  current: T
}) {
  const patch: Partial<T> = {}
  const restored: string[] = []
  const conflicts: Array<{ field: string; reason: string }> = []
  for (const field of [...new Set([...Object.keys(input.before), ...Object.keys(input.after)])]) {
    const before = input.before[field]
    const after = input.after[field]
    if (canonical(before) === canonical(after)) continue
    if (canonical(input.current[field]) === canonical(before)) continue
    if (canonical(input.current[field]) !== canonical(after)) {
      conflicts.push({ field, reason: 'current value changed after this batch' })
      continue
    }
    patch[field as keyof T] = before as T[keyof T]
    restored.push(field)
  }
  return { patch, restored, conflicts }
}
