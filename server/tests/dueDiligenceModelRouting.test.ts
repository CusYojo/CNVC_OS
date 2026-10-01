import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

Object.assign(process.env, {
  DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: 'isolated_no_connection',
  DB_USERNAME: 'test', DB_PASSWORD: 'test', DB_FREFIX: 'unit_',
})
const { resolveDueDiligenceModelRuntime } = await import('../src/services/aiDueDiligenceSkillRuntimeService.js')

test('due diligence uses the configured document model route for the actor role', async () => {
  const requested: Array<[string, string | undefined]> = []
  const runtime = await resolveDueDiligenceModelRuntime('投资经理', 'ai-document', {
    resolveRoute: async (profile, role) => {
      requested.push([profile, role])
      return { baseUrl: 'https://configured.example.test/v1/', apiKey: 'test-configured-key', model: 'configured-model' }
    },
  })

  assert.deepEqual(requested, [['ai-document', '投资经理']])
  assert.deepEqual(runtime, { baseUrl: 'https://configured.example.test/v1', apiKey: 'test-configured-key', model: 'configured-model', profile: 'ai-document' })
})

test('due diligence requires a configured platform model route', async () => {
  await assert.rejects(
    resolveDueDiligenceModelRuntime('投资经理', 'ai-document', { resolveRoute: async () => null }),
    { code: 'DUE_DILIGENCE_MODEL_ROUTE_UNAVAILABLE' },
  )
})

test('document report cannot resolve a role-restricted model without an actor role', async () => {
  await assert.rejects(
    resolveDueDiligenceModelRuntime('', 'ai-document', {
      resolveRoute: async () => { throw new Error('route must not be checked without a role') },
    }),
    { code: 'DUE_DILIGENCE_ROLE_REQUIRED' },
  )
})

test('configured but unavailable model does not fall back around role restrictions', async () => {
  await assert.rejects(
    resolveDueDiligenceModelRuntime('观察员', 'interactive-assistant', {
      resolveRoute: async () => null,
    }),
    { code: 'DUE_DILIGENCE_MODEL_ROUTE_UNAVAILABLE' },
  )
})

test('all due diligence route model calls use the shared runtime', async () => {
  const source = await readFile(new URL('../src/routes/dueDiligence.ts', import.meta.url), 'utf8')
  assert.ok((source.match(/resolveDueDiligenceModelRuntime\(/g) ?? []).length >= 4)
  assert.doesNotMatch(source, /process\.env\.(?:LLM_MODEL|LLM_BASE_URL|OPENAI_BASE_URL|OPENAI_API_KEY|LLM_API_KEY)/)
})

test('document task loads its current user role before invoking the due diligence report runtime', async () => {
  const source = await readFile(new URL('../src/services/aiTaskService.ts', import.meta.url), 'utf8')
  assert.match(source, /generateDueDiligenceReportWithSkill\(\{[\s\S]*?role: taskUser\.role,/)
})
