import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const evidenceDir = path.resolve(root, '.runtime/migration-evidence/ui-contract-baseline')
const screenshotDir = path.join(evidenceDir, 'screenshots')
const baselineDocument = path.resolve(root, 'docs/迁移计划/迁移契约与交互基线-20260810.md')
const issueDocument = path.resolve(root, 'docs/迁移计划/旧系统已知问题基线-20260810.md')

const expectedFrontendRoutes = [
  '/', '/login', '/projects', '/projects/:id', '/sourcing', '/ai', '/materials', '/meetings',
  '/workflow', '/risks', '/post-investment', '/knowledge', '/system', '/system/ai/models',
  '/system/ai/capabilities',
] as const

const expectedApiMounts = [
  '/auth', '/projects', '/meetings', '/todos', '/risks', '/', '/oa', '/ai', '/agent',
  '/ai/model-settings', '/ai/capabilities', '/conversations', '/workspace',
] as const

const expectedScreenshots = [
  '01-login.png',
  '02-dashboard-navigation.png',
  '03-ai-assistant.png',
  '04-sourcing-pipeline.png',
  '05-system-admin.png',
] as const

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function source(pathname: string) {
  return await readFile(path.resolve(root, pathname), 'utf8')
}

async function main() {
  const [app, apiIndex, errorHandler, authMiddleware, aiPage, sourcingPage, baseline, issues] = await Promise.all([
    source('src/App.tsx'),
    source('server/src/routes/index.ts'),
    source('server/src/middleware/errorHandler.ts'),
    source('server/src/middleware/requireAuth.ts'),
    source('src/pages/AIAssistantPage.tsx'),
    source('src/pages/SourcingPage.tsx'),
    readFile(baselineDocument, 'utf8'),
    readFile(issueDocument, 'utf8'),
  ])

  for (const route of expectedFrontendRoutes) {
    const represented = route === '/'
      ? /<Route index element=/.test(app)
      : app.includes(`path="${route}"`)
    requireCondition(represented, `frontend route baseline is missing ${route}`)
  }
  for (const mount of expectedApiMounts) {
    requireCondition(apiIndex.includes(`apiRouter.use('${mount}'`), `API mount baseline is missing ${mount}`)
  }

  const routeFiles = (await readdir(path.resolve(root, 'server/src/routes')))
    .filter((name) => name.endsWith('.ts'))
    .sort()
  const routeSources = await Promise.all(routeFiles.map(async (name) => await source(`server/src/routes/${name}`)))
  const routeDefinitions = routeSources.reduce(
    (count, content) => count + (content.match(/\.(?:get|post|put|patch|delete)\(\s*['"`]/g)?.length ?? 0),
    0,
  )
  requireCondition(routeDefinitions >= 100, 'REST baseline route extraction is unexpectedly incomplete')
  requireCondition(/code:/.test(errorHandler) && /message:/.test(errorHandler)
    && /details:/.test(errorHandler) && /requestId,/.test(errorHandler),
    'unified REST error shape is not present')
  requireCondition(/requireAuth/.test(authMiddleware) && /requireSystemAdmin/.test(authMiddleware),
    'authentication and administrator authorization contracts are not present')

  for (const marker of [
    '/conversations', 'useJwAgent', 'AiQuickActions', 'AiTaskCards', '/workspace/artifacts',
    '请先选择项目，再向 AI 提问',
  ]) {
    requireCondition(aiPage.includes(marker), `AI interaction baseline is missing ${marker}`)
  }
  for (const marker of [
    '共享线索池', '线索类型', '推荐理由 / 信号', 'fetchLeads', '/sourcing/${leadId}',
  ]) {
    requireCondition(sourcingPage.includes(marker), `lead workflow baseline is missing ${marker}`)
  }
  requireCondition(!/人工复核|从雷达同步|批量导入|上传 BP/.test(sourcingPage),
    'shared lead pool must keep operational actions hidden')

  const issueIds = [...issues.matchAll(/\| `?(ISSUE-\d{3})`? \|/g)].map((match) => match[1])
  requireCondition(issueIds.length >= 12, 'known-issue baseline must preserve all approved issue IDs')
  for (const id of ['MIG-0020', 'MIG-0021', 'MIG-0022', 'MIG-0023']) {
    requireCondition(baseline.includes(id), `contract baseline document is missing ${id}`)
  }
  requireCondition(issues.includes('MIG-0026'), 'known-issue baseline document is missing MIG-0026')

  const screenshots = []
  for (const name of expectedScreenshots) {
    const filePath = path.join(screenshotDir, name)
    const info = await stat(filePath)
    requireCondition(info.isFile() && info.size > 10_000, `baseline screenshot is missing or too small: ${name}`)
    const bytes = await readFile(filePath)
    screenshots.push({ name, bytes: info.size, sha256: sha256(bytes) })
    await chmod(filePath, 0o600)
  }

  const sourceChecksums = Object.fromEntries([
    ['src/App.tsx', app],
    ['server/src/routes/index.ts', apiIndex],
    ['server/src/middleware/errorHandler.ts', errorHandler],
    ['server/src/middleware/requireAuth.ts', authMiddleware],
    ['src/pages/AIAssistantPage.tsx', aiPage],
    ['src/pages/SourcingPage.tsx', sourcingPage],
    ['docs/迁移计划/迁移契约与交互基线-20260810.md', baseline],
    ['docs/迁移计划/旧系统已知问题基线-20260810.md', issues],
  ].map(([name, content]) => [name, sha256(content)]))

  const report = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ok: true,
    frontend: {
      routes: expectedFrontendRoutes,
      routeCount: expectedFrontendRoutes.length,
      screenshots,
      dataClass: 'isolated-synthetic-schema-only',
    },
    rest: {
      mounts: expectedApiMounts,
      mountCount: expectedApiMounts.length,
      routeDefinitions,
      errorShape: ['code', 'message', 'details', 'requestId'],
      auth: ['server-session-cookie', 'csrf', 'role-guard', 'project-access'],
    },
    aiInteraction: {
      surfaces: ['conversation', 'streaming-message-parts', 'project-files', 'six-task-cards', 'artifacts'],
      authority: 'mysql+jw-runtime+controlled-file-roots',
    },
    leadWorkflow: {
      stages: ['capture', 'subject-review', 'research', 'screening', 'manual-review', 'scoring', 'enrichment', 'convert'],
      authority: 'mysql-lead-pipeline',
    },
    knownIssues: { count: issueIds.length, ids: issueIds },
    sourceChecksums,
  }

  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  await chmod(screenshotDir, 0o700)
  await writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(path.join(evidenceDir, 'summary.md'), [
    '# 迁移契约与交互基线证据',
    '',
    `- 前端路由：${expectedFrontendRoutes.length}`,
    `- API 挂载组：${expectedApiMounts.length}`,
    `- REST 方法定义：${routeDefinitions}`,
    `- 隔离合成截图：${screenshots.length}`,
    `- 已知问题：${issueIds.length}`,
    '- 截图只使用随机隔离 MySQL Schema 和 `.invalid` 合成账号，不包含生产业务数据。',
    '',
  ].join('\n'), { mode: 0o600 })

  console.log(JSON.stringify({
    ok: true,
    frontendRoutes: expectedFrontendRoutes.length,
    apiMounts: expectedApiMounts.length,
    routeDefinitions,
    screenshots: screenshots.length,
    knownIssues: issueIds.length,
  }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
