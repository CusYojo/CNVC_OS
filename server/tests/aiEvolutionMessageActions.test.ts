import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('assistant answers expose evolution shortcuts and bind actual message or selected text', async () => {
  const page = await readFile('src/pages/AIAssistantPage.tsx', 'utf8')
  for (const label of ['纠正此处', '沉淀经验', '优化所用技能', '改进所选内容']) assert.match(page, new RegExp(`>${label}<`))
  assert.match(page, /extractTextParts\(message\).*slice\(0, 500\)/)
  assert.match(page, /onEvolutionAction\('correct', message\)/)
  assert.match(page, /onEvolutionAction\('experience', message\)/)
  assert.match(page, /onEvolutionAction\('skill', message\)/)
  assert.match(page, /data-evolution-component-id="assistant-answer"/)
  for (const card of ['自进化提案卡', '自进化状态卡', '自进化结果卡', '自进化取消卡']) assert.match(page, new RegExp(card))
  assert.match(page, /root\?\.contains\(selection\.anchorNode\)/)
})
