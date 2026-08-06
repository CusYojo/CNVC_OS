type RadarChannelCandidate = Record<string, unknown>

function radarPaperSourceText(candidate: RadarChannelCandidate) {
  return [
    candidate.source,
    candidate.source_key,
    candidate.source_type,
    candidate.source_name,
    candidate.link,
  ].map((value) => String(value ?? '')).join(' ')
}

export function isRadarPaperCandidate(candidate: RadarChannelCandidate) {
  return String(candidate.source_group ?? '') === '论文'
    || /arxiv/i.test(radarPaperSourceText(candidate))
}

export function is36KrRadarCandidate(candidate: RadarChannelCandidate) {
  // 只认主来源，不使用正文链接或合并后的二级证据。否则机构公众号只要
  // 引用了 36kr.com，就会被错误改成“36氪”渠道。
  const primarySourceText = [
    candidate.source_key,
    candidate.source_name,
    candidate.radarSourceKey,
    candidate.sourceName,
  ].map((value) => String(value ?? '')).join(' ')
  return /36kr|36氪/i.test(primarySourceText)
}

/**
 * 雷达的 source_group 是内容大类（例如“创投新闻”），不是前端展示渠道。
 * 36氪需要根据具体来源字段单独归类，否则新数据会从“36氪”筛选中消失。
 */
export function deriveRadarChannel(candidate: RadarChannelCandidate) {
  if (isRadarPaperCandidate(candidate)) return '论文'
  if (is36KrRadarCandidate(candidate)) return '36氪'
  return String(candidate.source_group ?? '').trim() || '其他'
}
