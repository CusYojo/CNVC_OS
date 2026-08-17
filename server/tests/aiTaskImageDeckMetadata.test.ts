import assert from 'node:assert/strict'
import test from 'node:test'
import { buildImageDeckArtifactMetadata } from '../src/services/aiTaskService.js'

test('image-faithful PPT artifacts retain the registered Skill identity', () => {
  const metadata = buildImageDeckArtifactMetadata({
    existingMetadata: { retained: true, skillName: 'stale-skill' },
    generationMetadata: {
      generationSkill: 'create-reference-driven-editable-ppt',
      artifactStage: 'stale-stage',
    },
    skill: {
      name: 'create-reference-driven-editable-ppt',
      version: 'sha256-123456789abc',
      sha256: 'a'.repeat(64),
    },
    slideCount: 14,
    bytes: 4096,
    sha256: 'b'.repeat(64),
    refreshedAfterResume: true,
  })

  assert.equal(metadata.skillName, 'create-reference-driven-editable-ppt')
  assert.equal(metadata.skillVersion, 'sha256-123456789abc')
  assert.equal(metadata.skillSha256, 'a'.repeat(64))
  assert.equal(metadata.artifactStage, 'image-deck')
  assert.equal(metadata.editableScope, 'image')
  assert.equal(metadata.retained, true)
  assert.equal(metadata.refreshedAfterResume, true)
})
