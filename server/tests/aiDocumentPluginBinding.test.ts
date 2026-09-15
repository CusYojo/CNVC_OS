import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import {
  AI_DOCUMENT_PLUGIN_BINDINGS,
  getAiSkillDirectory,
  loadAiSkill,
} from '../src/services/aiSkillService.js'
import { AI_TEMPLATE_CATALOG } from '../src/services/aiTemplateCatalog.js'

test('four AI assistant document shortcuts load same-name standalone Skills', async () => {
  assert.equal(AI_DOCUMENT_PLUGIN_BINDINGS.length, 0)
  const bindings = [
    ['compliance_statement', 'generate-investment-compliance-note'],
    ['investment_proposal', 'draft-investment-proposal'],
    ['project_qa', 'draft-investment-qa'],
    ['due_diligence_report', 'draft-due-diligence-report'],
  ] as const

  for (const [taskType, skillName] of bindings) {
    const template = AI_TEMPLATE_CATALOG[taskType]
    const skillDirectory = getAiSkillDirectory(skillName)
    const skill = await loadAiSkill(skillName)

    assert.equal(template.skillName, skillName)
    assert.equal(skill.name, skillName)
    assert.match(skill.version, /^sha256-[a-f0-9]{12}$/)
    assert.ok(existsSync(`${skillDirectory}/SKILL.md`))
    assert.match(skillDirectory, new RegExp(`[/\\\\]skills[/\\\\]${skillName}$`))
    assert.equal('pluginName' in skill, false)
    assert.equal('entrySkillName' in skill, false)
  }
})
