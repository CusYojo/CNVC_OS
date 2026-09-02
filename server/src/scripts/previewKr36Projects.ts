import { previewKr36ProjectSupply } from '../services/kr36ProjectSyncService.js'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function integerArg(name: string, fallback: number) {
  const token = process.argv.find((value) => value.startsWith(`${name}=`))
  const value = Number(token?.slice(name.length + 1))
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

const result = await previewKr36ProjectSupply({
  minimumYear: integerArg('--minimum-year', 2025),
  pagesPerYear: integerArg('--pages-per-year', 1),
  mode: process.argv.includes('--backfill') ? 'backfill' : 'incremental',
})
const outputArg = process.argv.find((value) => value.startsWith('--output='))?.slice('--output='.length).trim()
if (outputArg) {
  const outputPath = resolve(process.cwd(), outputArg)
  await writeFile(outputPath, `${result.records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  console.error(`[kr36-preview] JSONL written: ${outputPath}`)
}
console.log(JSON.stringify(result, null, 2))
