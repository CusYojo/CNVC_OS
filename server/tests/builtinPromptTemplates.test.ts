import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_PROMPT_TEMPLATES } from '../src/data/builtinPromptTemplates.js'

test('expanded prompt catalog covers each work domain with both skills and agents', () => {
  assert.ok(BUILTIN_PROMPT_TEMPLATES.length >= 30)
  assert.equal(new Set(BUILTIN_PROMPT_TEMPLATES.map(item => item.slug)).size, BUILTIN_PROMPT_TEMPLATES.length)
  for (const category of ['office', 'finance', 'legal', 'investment', 'technology', 'biomed']) {
    const entries = BUILTIN_PROMPT_TEMPLATES.filter(item => item.category === category)
    assert.ok(entries.some(item => item.kind === 'skill'), `${category} needs a skill`)
    assert.ok(entries.some(item => item.kind === 'agent'), `${category} needs an agent`)
  }
  for (const item of BUILTIN_PROMPT_TEMPLATES) {
    assert.equal(new URL(item.sourceUrl).protocol, 'https:')
    assert.match(item.markdown, /## 使用边界/)
    assert.match(item.markdown, /## 来源与许可/)
    assert.ok(item.markdown.length > 500, `${item.slug} should contain a usable workflow`)
  }
})
