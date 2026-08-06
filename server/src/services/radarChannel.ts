type RadarChannelCandidate = Record<string, unknown>

function radarSourceText(candidate: RadarChannelCandidate) {
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
    || /arxiv/i.test(radarSourceText(candidate))
}

export function is36KrRadarCandidate(candidate: RadarChannelCandidate) {
  return /36kr|36氪/i.test(radarSourceText(candidate))
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
