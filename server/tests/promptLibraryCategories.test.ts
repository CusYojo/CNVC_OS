import assert from 'node:assert/strict'
import test from 'node:test'
import { filterPromptLibraryItems, PROMPT_LIBRARY_CATEGORIES } from '../src/contracts/promptLibraryCategories.js'

test('categories include the requested work domains without duplicate ids', () => {
  const ids = PROMPT_LIBRARY_CATEGORIES.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ['general', 'office', 'finance', 'legal', 'investment', 'research', 'technology', 'biomed']) {
    assert.ok(ids.includes(id as typeof ids[number]))
  }
})

test('category filter composes with text search and preserves source order', () => {
  const items = [
    { category: 'finance', name: '财务模型', description: '现金流' },
    { category: 'legal', name: '合同审阅', description: '风险' },
    { category: 'finance', name: '预算差异', description: '现金流分析' },
  ] as const
  assert.deepEqual(filterPromptLibraryItems(items, 'finance', '现金流'), [items[0], items[2]])
  assert.deepEqual(filterPromptLibraryItems(items, 'all', '合同'), [items[1]])
  assert.deepEqual(filterPromptLibraryItems(items, 'legal', '现金流'), [])
})
