export function aiBusinessErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/(unsupported|not supported|file format|不支持.*格式|文件格式)/i.test(detail)) return '暂不支持该文件格式'
  if (/(timeout|timed out|超时)/i.test(detail)) return '生成时间较长，请稍后重试'
  if (/(network|fetch failed|econn|socket|connection|网络|连接)/i.test(detail)) return '连接失败，请重试'
  if (/(quota|credit|insufficient|rate.?limit|429|额度|余额|配额)/i.test(detail)) return 'AI 服务暂不可用，请联系管理员'
  if (/(文档尚未完成|本轮生成|模板分析未完成)/i.test(detail)) return '文档尚未生成完成，可继续生成或稍后重试'
  return 'AI 服务暂不可用，请稍后重试'
}
