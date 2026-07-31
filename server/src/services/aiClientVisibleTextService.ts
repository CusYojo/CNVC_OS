const EVIDENCE_STATUS_BADGE =
  /(?:\*{1,2}\s*)?[【〔\[]\s*(?:资料记载|AI\s*推断|待核验|资料缺口)\s*[】〕\]](?:\s*\*{1,2})?/gi

/**
 * 证据状态只供系统内部审计。面向用户的正文不展示状态徽标，也不直接
 * 暴露“待核验”这一内部状态值；仍需确认的边界改用自然业务语言表达。
 */
export function sanitizeClientVisibleEvidenceWording(value: unknown) {
  return String(value ?? '')
    .replace(EVIDENCE_STATUS_BADGE, '')
    .replace(
      /(^|[。！？；\n])\s*待核验(?:事项)?\s*[:：]\s*/g,
      '$1',
    )
    .replace(/待核验事项/g, '后续确认事项')
    .replace(/(?:仍需|仍|尚|有|需|需要)待核验/g, '尚需进一步确认')
    .replace(/待核验/g, '尚需进一步确认')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
