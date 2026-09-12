import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')

const layout = await read('src/layout/AppLayout.tsx')
const shell = await read('src/layout/fde-shell.css')
const ui = await read('src/components/ui.tsx')
const workspace = await read('src/components/fde-workspace.css')
const globalStyles = await read('src/styles.css')
const ai = await read('src/pages/AIAssistantPage.tsx')
const pageStyles = await Promise.all([
  'src/pages/DashboardPage.css',
  'src/pages/ProjectDetailPage.css',
  'src/pages/CollaborationPage.css',
  'src/pages/DataKnowledgePage.css',
  'src/pages/LoginPage.css',
].map(read))

assert.match(layout, /mobileNavigationOpen/, 'mobile navigation state is required')
assert.match(layout, /aria-expanded=\{mobileNavigationOpen\}/, 'mobile menu must expose expanded state')
assert.match(layout, /aria-controls="mobile-navigation"/, 'mobile menu must reference its navigation')
assert.match(layout, /setMobileNavigationOpen\(false\)/, 'mobile navigation needs an explicit close path')
assert.match(layout, /fde-mobile-nav-backdrop/, 'mobile navigation requires a backdrop')
assert.match(layout, /fde-mobile-nav-close/, 'mobile navigation requires an explicit close button')

assert.match(shell, /@media\s*\(max-width:\s*720px\)/, 'the shell needs the agreed phone breakpoint')
assert.match(shell, /\.fde-shell[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s, 'phone shell must use the full viewport width')
assert.match(shell, /\.fde-mobile-nav-open/, 'shell needs an open navigation state')
assert.match(shell, /100dvh/, 'dynamic viewport height is required')
assert.match(shell, /safe-area-inset-(top|bottom)/, 'safe area padding is required')
assert.match(shell, /min-height:\s*44px/, 'phone touch targets must reach 44px')
assert.match(shell, /prefers-reduced-motion:\s*reduce/, 'reduced motion support is required')

for (const className of ['fde-ui-page-header-actions', 'fde-ui-modal-backdrop', 'fde-ui-modal-body', 'fde-ui-drawer-backdrop', 'fde-ui-drawer-body', 'fde-ui-table-scroll']) {
  assert.match(ui, new RegExp(className), `${className} must be present in shared UI markup`)
}
assert.match(shell, /\.fde-ui-modal/, 'shared modal needs phone styling')
assert.match(shell, /\.fde-ui-drawer/, 'shared drawer needs phone styling')

assert.match(globalStyles, /@media\s*\(max-width:\s*720px\)/, 'legacy pages need a phone breakpoint')
assert.match(globalStyles, /\.jw-admin-page/, 'administration layouts need mobile coverage')
assert.match(globalStyles, /\.lead-pool-filters/, 'lead filters need mobile coverage')
assert.match(workspace, /@media\s*\(max-width:\s*720px\)/, 'workspaces need a phone breakpoint')
assert.match(workspace, /\.fde-collab-time-grid/, 'time grids need local overflow coverage')

pageStyles.forEach((css, index) => {
  assert.match(css, /@media\s*\(max-width:\s*720px\)/, `page stylesheet ${index + 1} needs a phone breakpoint`)
})
assert.match(ai, /fde-ai-(?:composer|messages|page)/, 'AI page needs stable responsive hooks')

console.log('mobile responsive acceptance passed')
