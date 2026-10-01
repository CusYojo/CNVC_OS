import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { getDueDiligenceAsrCapability } from '../src/services/dueDiligenceAsrService.js'

test('due diligence model runtime resolves the requested platform profile', async () => {
  Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_DATABASE: 'contract_test', DB_USERNAME: 'contract', DB_PASSWORD: 'contract', DB_FREFIX: 'sbl_' })
  const { resolveDueDiligenceModelRuntime } = await import('../src/services/aiDueDiligenceSkillRuntimeService.js')
  const seen: string[] = []
  const runtime = await resolveDueDiligenceModelRuntime('投资经理', 'interactive-assistant', {
    resolveRoute: async (profile) => { seen.push(profile); return { baseUrl: 'https://model.example/v1/', apiKey: 'secret', model: 'interactive-model' } },
  })
  assert.deepEqual(seen, ['interactive-assistant'])
  assert.equal(runtime.baseUrl, 'https://model.example/v1')
  assert.equal(runtime.model, 'interactive-model')
  assert.equal(runtime.profile, 'interactive-assistant')
})

test('ASR capability requires the complete server-side configuration', () => {
  assert.deepEqual(getDueDiligenceAsrCapability({}), { configured: false, provider: null, model: null })
  assert.deepEqual(getDueDiligenceAsrCapability({ ASR_BASE_URL: 'not-a-url', ASR_API_KEY: 'secret', ASR_MODEL: 'whisper-large' }), { configured: false, provider: null, model: 'whisper-large' })
  const configured = getDueDiligenceAsrCapability({ ASR_BASE_URL: 'https://asr.example/v1', ASR_API_KEY: 'secret', ASR_MODEL: 'whisper-large' })
  assert.equal(configured.configured, true)
  assert.equal(configured.provider, 'asr.example')
  assert.equal(configured.model, 'whisper-large')
})

test('stabilized workbench has one implementation and migration-backed contracts', async () => {
  const [page, styles, route, migration] = await Promise.all([
    readFile(new URL('../../src/pages/DueDiligencePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/dueDiligence.ts', import.meta.url), 'utf8'),
    readFile(new URL('../drizzle/0132_stabilize_due_diligence_workbench.sql', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(page, /Legacy|InterviewsPanelV2|ExperienceAssetsWorkspaceV2/)
  assert.doesNotMatch(styles, /due-diligence-interview-content/)
  assert.match(route, /TRANSCRIPT_VERSION_CONFLICT/)
  assert.match(route, /interactive-assistant/)
  assert.match(route, /clientRequestId/)
  assert.match(route, /select-learning-target/)
  assert.match(migration, /due_diligence_transcription_jobs/)
  assert.match(migration, /digital_twin_private_assets/)
  assert.match(migration, /learning_target_at/)
})
