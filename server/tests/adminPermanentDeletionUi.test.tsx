import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('system administration exposes a three-step permanent deletion center', async () => {
  const [panel, page, workspaces] = await Promise.all([
    readFile(new URL('../../src/components/AdminPermanentDeletionPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages/SystemPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/lib/systemWorkspaces.ts', import.meta.url), 'utf8'),
  ])
  assert.match(workspaces, /danger-zone[\s\S]*permanent-deletion/)
  assert.match(page, /AdminPermanentDeletionPanel/)
  assert.match(panel, /我确认继续/)
  assert.match(panel, /resourceName !== preview\?\.resourceName/)
  assert.match(panel, /riskText !== ADMIN_PERMANENT_DELETION_RISK_TEXT/)
  assert.match(panel, />永久删除</)
  assert.match(panel, /useEffect\(\(\) => \{ void load\(1\) \}, \[resourceType\]\)/)
  assert.match(panel, /留空显示全部/)
  assert.match(panel, /上一页/)
})
