import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_PROJECT_INDUSTRY, PROJECT_INDUSTRIES } from '../../src/lib/projectIndustries.js'

test('project creation uses the approved industry list', () => {
  assert.deepEqual(PROJECT_INDUSTRIES, [
    '具身智能',
    'AI',
    '半导体',
    '商业航天',
    '其他硬科技',
    '新能源新材料',
    '生物医药',
    '其他行业',
  ])
  assert.equal(DEFAULT_PROJECT_INDUSTRY, '具身智能')
})

test('both project creation entry points render the shared list', () => {
  const unified = readFileSync(new URL('../../src/components/UnifiedProjectCreateModal.tsx', import.meta.url), 'utf8')
  const legacy = readFileSync(new URL('../../src/components/ProjectModal.tsx', import.meta.url), 'utf8')
  for (const source of [unified, legacy]) {
    assert.match(source, /PROJECT_INDUSTRIES\.map/)
    assert.match(source, /DEFAULT_PROJECT_INDUSTRY/)
    assert.doesNotMatch(source, /<option>AI 医疗<\/option>|<option>工业软件<\/option>/)
  }
})
