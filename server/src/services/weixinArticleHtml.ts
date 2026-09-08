/** Extract the article container including nested div/section elements; never accept a verification page. */
export function weixinArticleBodyHtml(html: string): string {
  const opening = /<(div|section)\b[^>]*\bid\s*=\s*["']js_content["'][^>]*>/i.exec(html)
  if (!opening) throw Object.assign(new Error('公众号正文不可用，页面可能需要验证或文章已删除'), { code: 'SOURCE_WEIXIN_BODY_UNAVAILABLE' })
  const start = opening.index + opening[0].length
  const tags = /<\/?(div|section)\b[^>]*>/gi
  tags.lastIndex = start
  let depth = 1
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (/^<\//.test(match[0])) depth--
    else if (!/\/\s*>$/.test(match[0])) depth++
    if (depth === 0) return html.slice(start, match.index)
  }
  throw Object.assign(new Error('公众号正文结构不完整'), { code: 'SOURCE_WEIXIN_BODY_UNAVAILABLE' })
}
