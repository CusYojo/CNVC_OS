import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = () => readFile(new URL('../src/services/projectService.ts', import.meta.url), 'utf8')

test('system admins may change only the investment fund owner field', async () => {
  const implementation = await source()
  assert.match(implementation, /isEnabledSystemAdmin/)
  assert.match(implementation, /investmentFundChanged/)
  assert.match(implementation, /requirementsChanged/)
  assert.match(implementation, /requirementsChanged && locked\.ownerUserId !== userId/)
  assert.match(implementation, /investmentFundChanged && locked\.ownerUserId !== userId && !await isEnabledSystemAdmin/)
})

test('controlled fields remain frozen during approval and fund changes are audited', async () => {
  const implementation = await source()
  assert.match(implementation, /investmentFundChanged \|\| requirementsChanged/)
  assert.match(implementation, /FDE_APPROVAL_ACTIVE/)
  assert.match(implementation, /投资基金变更/)
  assert.match(implementation, /locked\.investmentFund/)
  assert.match(implementation, /fdePatch\.investmentFund/)
})
