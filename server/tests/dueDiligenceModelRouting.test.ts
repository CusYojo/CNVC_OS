import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

Object.assign(process.env, {
  DB_HOST: '127.0.0.1', DB_PORT: '1', DB_DATABASE: 'isolated_no_connection',
  DB_USERNAME: 'test', DB_PASSWORD: 'test', DB_FREFIX: 'unit_',
})
const { resolveDueDiligenceModelRuntime } = await import('../src/services/aiDueDiligenceSkillRuntimeService.js')

const legacyEnv = {
  LLM_BASE_URL: 'https://legacy.example.test/v1/',
  OPENAI_API_KEY: 'test-legacy-key',
  LLM_MODEL: 'legacy-model',
}

test('due diligence uses the configured document model route for the actor role', async () => {
  const requested: Array<[string, string | undefined]> = []
  const runtime = await resolveDueDiligenceModelRuntime('投资经理', {
    resolveRoute: async (profile, role) => {
      requested.push([profile, role])
      return { baseUrl: 'https://configured.example.test/v1/', apiKey: 'test-configured-key', model: 'configured-model' }
    },
    hasConfiguredModel: async () => { throw new Error('must not check fallback when route resolves') },
    env: legacyEnv,
  })

  assert.deepEqual(requested, [['ai-document', '投资经理']])
  assert.deepEqual(runtime, { baseUrl: 'https://configured.example.test/v1', apiKey: 'test-configured-key', model: 'configured-model' })
})

test('due diligence keeps the existing server gateway when no model route is configured', async () => {
  const runtime = await resolveDueDiligenceModelRuntime('投资经理', {
    resolveRoute: async () => null,
    hasConfiguredModel: async () => false,
    env: legacyEnv,
  })

  assert.deepEqual(runtime, { baseUrl: 'https://legacy.example.test/v1', apiKey: 'test-legacy-key', model: 'legacy-model' })
})

test('document report cannot resolve a role-restricted model without an actor role', async () => {
  await assert.rejects(
    resolveDueDiligenceModelRuntime('', {
      resolveRoute: async () => { throw new Error('route must not be checked without a role') },
      hasConfiguredModel: async () => false,
      env: legacyEnv,
    }),
    { code: 'DUE_DILIGENCE_ROLE_REQUIRED' },
  )
})

test('configured but unavailable model does not fall back around role restrictions', async () => {
  await assert.rejects(
    resolveDueDiligenceModelRuntime('观察员', {
      resolveRoute: async () => null,
      hasConfiguredModel: async () => true,
      env: legacyEnv,
    }),
    { code: 'DUE_DILIGENCE_MODEL_ROUTE_UNAVAILABLE' },
  )
})

test('all due diligence route model calls use the shared runtime', async () => {
  const source = await readFile(new URL('../src/routes/dueDiligence.ts', import.meta.url), 'utf8')
  assert.equal((source.match(/resolveDueDiligenceModelRuntime\(/g) ?? []).length, 4)
  assert.doesNotMatch(source, /process\.env\.(?:LLM_MODEL|LLM_BASE_URL|OPENAI_BASE_URL|OPENAI_API_KEY|LLM_API_KEY)/)
})

test('document task loads its current user role before invoking the due diligence report runtime', async () => {
  const source = await readFile(new URL('../src/services/aiTaskService.ts', import.meta.url), 'utf8')
  assert.match(source, /generateDueDiligenceReportWithSkill\(\{[\s\S]*?role: taskUser\.role,/)
})
