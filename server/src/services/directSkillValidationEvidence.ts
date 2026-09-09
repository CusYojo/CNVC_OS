import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

type ValidationReport = { status?: unknown; errors?: unknown }

function validationError(message: string) {
  return Object.assign(new Error(message), { code: 'DIRECT_SKILL_OUTPUT_VALIDATION_FAILED' })
}

export async function assertDueDiligenceValidationEvidence(input: {
  workspace: string
  outputPath: string
}) {
  const workDirectory = path.join(input.workspace, 'work')
  const candidates = (await readdir(workDirectory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^validation(?:[-_][^.]+)?\.json$/i.test(entry.name))
  const reports = await Promise.all(candidates.map(async (entry) => ({
    path: path.join(workDirectory, entry.name),
    info: await stat(path.join(workDirectory, entry.name)),
  })))
  reports.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)
  const latest = reports[0]
  if (!latest) throw validationError('尽调 Skill 未生成成品校验报告')

  let report: ValidationReport
  try {
    report = JSON.parse(await readFile(latest.path, 'utf8')) as ValidationReport
  } catch {
    throw validationError('尽调 Skill 成品校验报告不是合法 JSON')
  }
  const errors = Array.isArray(report.errors) ? report.errors : []
  if (report.status !== 'pass' || errors.length > 0) {
    throw validationError(`尽调 Skill 成品校验未通过（status=${String(report.status || 'missing')}，errors=${errors.length}）`)
  }

  const output = await readFile(input.outputPath)
  const workingPath = path.join(workDirectory, path.basename(input.outputPath))
  let validatedAt = latest.info.mtimeMs
  let contentMatched = false
  let matchingWorkMtimeMs: number | null = null
  try {
    const [working, workingInfo] = await Promise.all([readFile(workingPath), stat(workingPath)])
    contentMatched = createHash('sha256').update(working).digest('hex')
      === createHash('sha256').update(output).digest('hex')
    if (contentMatched) matchingWorkMtimeMs = workingInfo.mtimeMs
  } catch {
    // A Skill may validate the final output in place instead of keeping a work copy.
  }
  if (contentMatched && matchingWorkMtimeMs !== null) {
    if (validatedAt + 1 < matchingWorkMtimeMs) {
      throw validationError('尽调 Skill 校验报告早于与成品一致的工作文档')
    }
    return { reportPath: latest.path, status: 'pass' as const, errorCount: 0 }
  }
  const outputInfo = await stat(input.outputPath)
  if (!contentMatched && validatedAt + 1 < outputInfo.mtimeMs) {
    throw validationError('尽调 Skill 校验报告早于当前成品，无法证明当前 DOCX 已通过校验')
  }
  return { reportPath: latest.path, status: 'pass' as const, errorCount: 0 }
}
