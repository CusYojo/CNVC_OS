import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanupStaleProjectFileTemps } from '../services/projectFileStorageService.js'

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[project file temp cleanup] ${message}`)
}

async function exists(target: string) {
  return Boolean(await lstat(target).catch(() => null))
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/project-file-temp-cleanup')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# 项目文件临时残留清理验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    '- 只删除超过 TTL 且符合服务自有 `.UUID.tmp` 命名的普通文件',
    '- 正式文件、新鲜临时文件、普通 `.tmp`、符号链接及其外部目标均保留',
    '- 第二次执行删除数为 0，证明清理可幂等重放',
    '',
    '报告不记录文件正文、绝对测试路径或数据库连接身份。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'project-file-temp-cleanup-'))
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'project-file-temp-outside-'))
  const nowMs = Date.parse('2026-08-10T00:00:00.000Z')
  const maxAgeMs = 60_000
  const staleTime = new Date(nowMs - maxAgeMs - 1_000)
  const freshTime = new Date(nowMs - maxAgeMs + 1_000)
  const nested = path.join(root, 'project', 'file')
  const stale = path.join(nested, `revision.${randomUUID()}.tmp`)
  const staleNested = path.join(nested, 'nested', `revision.${randomUUID()}.tmp`)
  const fresh = path.join(nested, `revision.${randomUUID()}.tmp`)
  const formal = path.join(nested, randomUUID())
  const ordinaryTemp = path.join(nested, 'manual.tmp')
  const outside = path.join(outsideRoot, 'must-remain.txt')
  const linked = path.join(nested, `linked.${randomUUID()}.tmp`)
  try {
    await mkdir(path.dirname(staleNested), { recursive: true })
    await Promise.all([
      writeFile(stale, 'stale-owned-temp'),
      writeFile(staleNested, 'stale-nested-owned-temp'),
      writeFile(fresh, 'fresh-owned-temp'),
      writeFile(formal, 'formal-file'),
      writeFile(ordinaryTemp, 'ordinary-temp'),
      writeFile(outside, 'outside-target'),
    ])
    await Promise.all([
      utimes(stale, staleTime, staleTime),
      utimes(staleNested, staleTime, staleTime),
      utimes(fresh, freshTime, freshTime),
      utimes(ordinaryTemp, staleTime, staleTime),
    ])
    await symlink(outside, linked)

    const first = await cleanupStaleProjectFileTemps({ root, nowMs, maxAgeMs })
    assertContract(first.removed === 2, `expected two stale owned temporary files removed, received ${first.removed}`)
    assertContract(!await exists(stale) && !await exists(staleNested), 'stale owned temporary file remains')
    assertContract(await exists(fresh), 'fresh owned temporary file was deleted')
    assertContract(await exists(formal), 'formal file was deleted')
    assertContract(await exists(ordinaryTemp), 'ordinary .tmp file was deleted')
    assertContract(await exists(linked) && (await lstat(linked)).isSymbolicLink(), 'temporary-looking symlink was changed')
    assertContract(await exists(outside), 'external symlink target was deleted')

    const second = await cleanupStaleProjectFileTemps({ root, nowMs, maxAgeMs })
    assertContract(second.removed === 0, 'second cleanup was not idempotent')

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      pathsExcluded: true,
      contentExcluded: true,
      firstRun: {
        removed: first.removed,
        retainedFresh: first.retainedFresh,
        ignored: first.ignored,
        skippedSymlinks: first.skippedSymlinks,
      },
      secondRunRemoved: second.removed,
      checks: [
        'stale-owned-temporary-files-removed',
        'nested-stale-temporary-file-removed',
        'fresh-temporary-file-retained',
        'formal-file-retained',
        'ordinary-dot-tmp-file-retained',
        'symlink-and-outside-target-retained',
        'second-run-idempotent',
        'evidence-excludes-paths-and-content',
      ],
    }
    await persistEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ])
  }
}

await main()
