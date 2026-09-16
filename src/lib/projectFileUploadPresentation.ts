export type ProjectFileUploadResultKind = 'success' | 'parse_warning' | 'duplicate' | 'error'

export interface ProjectFileUploadResult {
  fileName: string
  kind: ProjectFileUploadResultKind
  message: string
}

export interface ProjectFileUploadSummary {
  tone: 'success' | 'warning' | 'error' | 'info'
  title: '上传成功' | '部分文件处理异常' | '上传失败' | '未上传新文件'
  text: string
  details: string[]
}

const labels: Record<ProjectFileUploadResultKind, string> = {
  success: '成功',
  parse_warning: '解析异常',
  duplicate: '已存在',
  error: '失败',
}

export function summarizeProjectFileUpload(results: ProjectFileUploadResult[]): ProjectFileUploadSummary {
  const counts: Record<ProjectFileUploadResultKind, number> = { success: 0, parse_warning: 0, duplicate: 0, error: 0 }
  for (const result of results) counts[result.kind] += 1

  const onlyDuplicates = results.length > 0 && counts.duplicate === results.length
  const allFailed = results.length > 0 && counts.error === results.length
  const hasProblem = counts.error > 0 || counts.parse_warning > 0
  const tone: ProjectFileUploadSummary['tone'] = allFailed ? 'error' : onlyDuplicates ? 'info' : hasProblem ? 'warning' : 'success'
  const title: ProjectFileUploadSummary['title'] = allFailed
    ? '上传失败'
    : onlyDuplicates
      ? '未上传新文件'
      : hasProblem
        ? '部分文件处理异常'
        : '上传成功'
  const text = (Object.keys(counts) as ProjectFileUploadResultKind[])
    .filter(kind => counts[kind] > 0)
    .map(kind => `${labels[kind]} ${counts[kind]}`)
    .join('，')

  return {
    tone,
    title,
    text: `本批 ${results.length} 个：${text}`,
    details: results.map(result => `${result.fileName}：${result.message}`),
  }
}
