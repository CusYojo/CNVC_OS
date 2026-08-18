import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import {
  AI_DOCUMENT_PLUGIN_BINDINGS,
  getAiSkillDirectory,
  getAiSkillRuntimeDirectory,
  loadAiSkill,
} from '../src/services/aiSkillService.js'
import { AI_TEMPLATE_CATALOG } from '../src/services/aiTemplateCatalog.js'

test('four AI assistant document shortcuts load their installed plugin entry skills', async () => {
  assert.equal(AI_DOCUMENT_PLUGIN_BINDINGS.length, 4)

  for (const binding of AI_DOCUMENT_PLUGIN_BINDINGS) {
    const template = AI_TEMPLATE_CATALOG[binding.taskType]
    const pluginSkillDirectory = getAiSkillDirectory(binding.skillName)
    const hostRuntimeDirectory = getAiSkillRuntimeDirectory(binding.skillName)
    const skill = await loadAiSkill(binding.skillName)

    assert.equal(template.skillName, binding.skillName)
    assert.equal(template.pluginName, binding.pluginName)
    assert.equal(template.pluginEntrySkillName, binding.entrySkillName)
    assert.equal(skill.name, binding.skillName)
    assert.equal(skill.pluginName, binding.pluginName)
    assert.equal(skill.pluginVersion, binding.pluginVersion)
    assert.equal(skill.entrySkillName, binding.entrySkillName)
    assert.match(skill.version, /^sha256-[a-f0-9]{12}$/)
    assert.ok(existsSync(`${pluginSkillDirectory}/SKILL.md`))
    assert.ok(existsSync(`${hostRuntimeDirectory}/SKILL.md`))
    assert.notEqual(pluginSkillDirectory, hostRuntimeDirectory)
  }
})
