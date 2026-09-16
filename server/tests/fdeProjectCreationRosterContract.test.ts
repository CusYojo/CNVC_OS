import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('investment project team candidates are restricted to the investment department end to end', () => {
  const governance = source('server/src/services/fdeGovernanceService.ts')
  const modal = source('src/components/UnifiedProjectCreateModal.tsx')

  assert.match(governance, /canProjectManager: person\.department === '投资部'/)
  assert.match(governance, /FDE_PROJECT_MANAGER_INVALID', '投资项目组必须选择投资部的启用账号'/)
  assert.match(modal, /const isInvestmentDepartment = \(person: CreationPerson\) => person\.department\.trim\(\) === '投资部'/)
  assert.match(modal, /person\.capabilities\.canProjectManager && isInvestmentDepartment\(person\)/)
  assert.match(modal, /PeoplePicker label="投资项目组"/)
})
