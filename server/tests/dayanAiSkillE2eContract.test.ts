import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const scriptPath = path.resolve('server/src/scripts/dayanAiSkillE2eAcceptance.ts')

test('大衍专项验收覆盖数据导入、解析轮询和七项能力', async () => {
  const source = await readFile(scriptPath, 'utf8')
  const expectedMarkers = [
    '大衍科技（txt版本）',
    '/projects/files/upload',
    'parseStatus',
    'free_chat',
    'generate-investment-compliance-note',
    'draft-investment-proposal',
    'investment-committee-ppt',
    'draft-due-diligence-report',
    'draft-investment-qa',
    'generate-document-from-template',
  ]
  for (const marker of expectedMarkers) assert.ok(source.includes(marker), `缺少验收标记：${marker}`)
})
