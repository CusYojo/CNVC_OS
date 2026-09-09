// Search each original string separately so JSON escaping cannot alter quotations
// and unrelated fields cannot be joined into fabricated evidence.
export function sourceContainsText(value: unknown, quote: string, normalize: (text: string) => string): boolean {
  const needle = normalize(quote)
  if (!needle) return false
  if (typeof value === 'string') return normalize(value).includes(needle)
  if (Array.isArray(value)) return value.some(item => sourceContainsText(item, quote, normalize))
  if (value && typeof value === 'object') return Object.values(value).some(item => sourceContainsText(item, quote, normalize))
  return false
}
