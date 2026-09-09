import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertDueDiligenceValidationEvidence } from '../src/services/directSkillValidationEvidence.js'

test('due diligence delivery rejects a failed Skill validation report', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dd-validation-fail-'))
  try {
    await mkdir(path.join(workspace, 'work'))
    await mkdir(path.join(workspace, 'output'))
    const outputPath = path.join(workspace, 'output', 'report.docx')
    await writeFile(outputPath, Buffer.alloc(1_200, 1))
    await writeFile(path.join(workspace, 'work', 'report.docx'), Buffer.alloc(1_200, 1))
    await writeFile(path.join(workspace, 'work', 'validation.json'), JSON.stringify({ status: 'fail', errors: [{ code: 'END_MARKER' }] }))
    await assert.rejects(assertDueDiligenceValidationEvidence({ workspace, outputPath }), {
      code: 'DIRECT_SKILL_OUTPUT_VALIDATION_FAILED',
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('due diligence delivery accepts a passing report for identical work and output DOCX', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dd-validation-pass-'))
  try {
    await mkdir(path.join(workspace, 'work'))
    await mkdir(path.join(workspace, 'output'))
    const bytes = Buffer.alloc(1_200, 2)
    const outputPath = path.join(workspace, 'output', 'report.docx')
    await writeFile(outputPath, bytes)
    await writeFile(path.join(workspace, 'work', 'report.docx'), bytes)
    await writeFile(path.join(workspace, 'work', 'validation-round2.json'), JSON.stringify({ status: 'pass', errors: [] }))
    const result = await assertDueDiligenceValidationEvidence({ workspace, outputPath })
    assert.equal(result.status, 'pass')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
