import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { captureEvolutionSkill } from '../src/runtime/evolution/evolutionSkillSnapshot.js'
import { getAiSkillDirectory, getAiSkillRoot } from '../src/services/aiSkillService.js'
import { prepareEvolutionDueDiligenceRenderer } from '../src/runtime/evolution/evolutionDueDiligenceRenderer.js'
import { DockerEvolutionEnvironment } from '../src/runtime/evolution/dockerEvolutionEnvironment.js'

test('isolated Docker produces actual DOCX, PDF and page evidence without turning failed quality checks into acceptance',
  { skip: process.env.EVOLUTION_SKILL_RENDER_DOCKER_TEST !== 'true', timeout: 360_000 }, async () => {
    const image = process.env.EVOLUTION_SKILL_RENDER_IMAGE
    assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/)
    const environment = new DockerEvolutionEnvironment(undefined, image)
    assert.equal(await environment.available(), true)
    const control = { identity: { runId: randomUUID(), attempt: 1, leaseToken: 1, inputHash: 'a'.repeat(64) },
      signal: new AbortController().signal, assertCanContinue: async () => {} }
    const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-dd-render-evidence-'))
    try {
      const snapshot = await captureEvolutionSkill({ capabilityId: 'fixture-skill', capabilityKey: 'draft-due-diligence-report',
        directory: getAiSkillDirectory('draft-due-diligence-report'), allowedRoot: getAiSkillRoot(), toolNames: [], dependencyNames: [], config: {} })
      const renderer = await prepareEvolutionDueDiligenceRenderer({ environment, control, skillSnapshot: snapshot })
      const fixture = async (name: string) => JSON.parse(await readFile(path.resolve('server/tests/fixtures/evolution-due-diligence', `${name}.json`), 'utf8'))
      const result = await renderer.render({ report: await fixture('report'), diligenceData: await fixture('diligence-data'), evidence: await fixture('evidence') })
      for (const file of result.files) await writeFile(path.join(root, path.basename(file.path)), file.content)
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ image, rendererHash: result.rendererHash, checks: result.checks,
        files: result.files.map(({ content: _content, ...file }) => file) }, null, 2))
      console.log(JSON.stringify({ evidenceRoot: root, runId: control.identity.runId, checks: result.checks }))
      assert.ok(result.files.some(file => file.path.endsWith('/report.docx') && file.content.subarray(0, 2).toString() === 'PK'))
      assert.ok(result.files.some(file => file.path.endsWith('/report.pdf') && file.content.subarray(0, 5).toString() === '%PDF-'))
      assert.ok(result.files.some(file => /\/page-\d+\.png$/.test(file.path)))
      const checks = JSON.parse(result.files.find(file => file.path.endsWith('/render-checks.json'))!.content.toString())
      assert.equal(checks.requiresIndependentReview, true)
      assert.equal('verdict' in checks, false)
      assert.equal(checks.renderCompleted, true)
      assert.equal(checks.checks.find((row: { id: string }) => row.id === 'format')?.passed, false,
        'the deliberately incomplete fixture must retain its failed structural audit despite producing viewable files')
    } finally { await environment.terminate(control.identity) }
  })
