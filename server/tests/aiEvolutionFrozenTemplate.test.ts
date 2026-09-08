import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'
import { getAiSkillDirectory, getAiSkillRoot } from '../src/services/aiSkillService.js'
import { AI_TEMPLATE_CATALOG } from '../src/services/aiTemplateCatalog.js'
import { evolutionContentHash } from '../src/services/aiEvolutionPolicyService.js'
import { materializeEvolutionTemplate } from '../src/services/aiEvolutionFrozenTemplateService.js'
import { parseComplianceDocumentBlueprint } from '../src/services/aiComplianceBlueprintService.js'

test('compliance template is restored from frozen binary bytes and rejects outside references', async () => {
  const template = AI_TEMPLATE_CATALOG.compliance_statement
  const directory = getAiSkillDirectory(template.skillName)
  const snapshot = await captureEvolutionSkill({ capabilityId: randomUUID(), capabilityKey: template.skillName,
    directory, allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
  const bundle = { schemaVersion: 1, version: snapshot.version, contentHash: snapshot.contentHash,
    packageHash: evolutionContentHash({ contentHash: snapshot.contentHash, runtimePackageHash: snapshot.packageHash }), runtimeSnapshot: snapshot }
  const frozen = await materializeEvolutionTemplate(template, directory, bundle)
  try {
    const relative = path.relative(directory, template.referencePath).split(path.sep).join('/')
    const expected = Buffer.from(snapshot.files.find(file => file.path === relative)!.contentBase64, 'base64')
    assert.deepEqual(await readFile(frozen.template.referencePath), expected)
    assert.notEqual(frozen.template.referencePath, template.referencePath)
    const baselineBlueprint = await parseComplianceDocumentBlueprint(template, { cache: false })
    const frozenBlueprint = await parseComplianceDocumentBlueprint(frozen.template, { cache: false })
    assert.equal(frozenBlueprint.blueprintSha256, baselineBlueprint.blueprintSha256)
    assert.deepEqual(frozenBlueprint.primary.sectionTitles, baselineBlueprint.primary.sectionTitles)
    await assert.rejects(materializeEvolutionTemplate({ ...template, referencePath: path.join(directory, '..', 'outside.docx') }, directory, bundle), /不在冻结技能包/)
  } finally { await frozen.dispose() }
  await assert.rejects(stat(frozen.directory), { code: 'ENOENT' })
})
