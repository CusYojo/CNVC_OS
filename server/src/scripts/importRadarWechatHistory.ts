import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareHistoricalWechatImport } from '../services/radarHistoricalWechatImportService.js'

const apply = process.argv.includes('--apply')
const sourceArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'))

if (!sourceArgument) {
  throw new Error('用法：npm run radar:import-wechat-history -- <历史数据.json> [--apply]')
}

let databasePool: { end: () => Promise<void> } | undefined
try {
  const sourcePath = path.resolve(sourceArgument)
  const parsed = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
  const prepared = prepareHistoricalWechatImport(parsed)
  let written = 0
  let syncHandoff: Record<string, unknown> | null = null
  if (apply) {
    const [{ pool }, { ingestRadarCandidates }, { queueRadarSyncAfterCollection }] = await Promise.all([
      import('../db/client.js'),
      import('../services/radarDataMigrationService.js'),
      import('../services/runtimeJobScheduler.js'),
    ])
    databasePool = pool
    written = await ingestRadarCandidates(prepared.rows)
    syncHandoff = await queueRadarSyncAfterCollection({ written })
  }
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'preview',
    source: sourcePath,
    input: prepared.input,
    mapped: prepared.mapped,
    retained: prepared.retained,
    filtered: prepared.filtered,
    duplicatesInInput: prepared.duplicatesInInput,
    readyToWrite: prepared.rows.length,
    written,
    syncHandoff,
  }, null, 2))
} finally {
  await databasePool?.end()
}
