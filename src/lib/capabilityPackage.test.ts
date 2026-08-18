import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { createCapabilityZip, scanCapabilityFolder, scanCapabilityZip } from './capabilityPackage.js'

function folderFile(path: string, content: string) {
  const file = new File([content], path.split('/').pop() || 'file')
  Object.defineProperty(file, 'webkitRelativePath', { value: path })
  return file
}

test('scans a JW skill folder and reads SKILL.md frontmatter', async () => {
  const candidates = await scanCapabilityFolder('skill', [
    folderFile('skills/demo-skill/SKILL.md', '---\nname: "演示技能"\ndescription: "用于验证导入"\n---\n'),
    folderFile('skills/demo-skill/references/readme.md', 'ignored'),
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.capabilityKey, 'demo-skill')
  assert.equal(candidates[0]?.name, '演示技能')
})

test('scans a JW agent zip and retains bounded policy fields', async () => {
  const zip = new JSZip()
  zip.file('agents/interactive-assistant.md', '---\nname: "互动助手"\ndescription: "Agent"\nmodel-route-key: interactive-assistant\nmax-turns: 8\ntools: [search_project_docs]\n---\n')
  const data = await zip.generateAsync({ type: 'uint8array' })
  const candidates = await scanCapabilityZip('agent', new File([data], 'agents.zip'))
  assert.equal(candidates[0]?.capabilityKey, 'interactive-assistant')
  assert.equal(candidates[0]?.config?.maxTurns, 8)
  assert.deepEqual(candidates[0]?.config?.toolNames, ['search_project_docs'])
})

test('exports skills as JW-compatible directories in a zip', async () => {
  const blob = await createCapabilityZip('skill', [{
    capabilityKey: 'demo-skill', kind: 'skill', name: '演示技能', description: '说明',
    enabled: true, allowedRoles: [], config: {}, toolNames: [],
  }])
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  assert.ok(zip.file('demo-skill/SKILL.md'))
})

test('scans an uploaded plugin manifest and preserves host tool declarations', async () => {
  const candidates = await scanCapabilityFolder('plugin', [
    folderFile('plugins/demo-plugin.json', JSON.stringify({
      capabilityKey: 'demo-plugin', name: '演示插件', description: '受控插件',
      config: { prompt: '只输出有证据的结论。' }, toolNames: ['search_project_docs'],
    })),
  ])
  assert.equal(candidates[0]?.capabilityKey, 'demo-plugin')
  assert.deepEqual(candidates[0]?.toolNames, ['search_project_docs'])
  assert.equal(candidates[0]?.config?.prompt, '只输出有证据的结论。')
})
