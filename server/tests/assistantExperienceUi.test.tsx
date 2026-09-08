import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('assistant page exposes opt-in review before experience activation', async () => {
  const component = await readFile(new URL('../../src/components/AssistantExperiencePanel.tsx', import.meta.url), 'utf8')
  const page = await readFile(new URL('../../src/pages/AIAssistantPage.tsx', import.meta.url), 'utf8')
  for (const label of ['自动总结经验', '每 5 轮总结一次', '采用', '不采用', '已采用经验']) assert.ok(component.includes(label))
  assert.match(component, /\/assistant-experiences\/candidates\/\$\{candidate\.id\}\/decision/)
  assert.match(page, /<AssistantExperiencePanel/)
  assert.doesNotMatch(component, /回滚发布|技能版本|自进化发布/)
})
