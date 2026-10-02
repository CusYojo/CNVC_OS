import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { requestOriginAllowed } from '../security/requestOrigin.js'

const originalNodeEnv = process.env.NODE_ENV
const originalOrigins = process.env.AUTH_ALLOWED_ORIGINS
try {
  process.env.NODE_ENV = 'production'
  process.env.AUTH_ALLOWED_ORIGINS = 'https://cybernaut.newmin.cn'
  assert.equal(requestOriginAllowed({ origin: 'https://cybernaut.newmin.cn', host: '127.0.0.1:4100', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cybernaut.newmin.cn' }), true)
  assert.equal(requestOriginAllowed({ origin: 'https://malicious.example', host: '127.0.0.1:4100', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cybernaut.newmin.cn' }), false)
} finally {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv
  if (originalOrigins === undefined) delete process.env.AUTH_ALLOWED_ORIGINS; else process.env.AUTH_ALLOWED_ORIGINS = originalOrigins
}

const [page, workspace, interviews, routes] = await Promise.all([
  readFile(new URL('../../../src/pages/DueDiligencePage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../../src/components/dueDiligence/ExperienceAssetsWorkspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../../src/components/dueDiligence/InterviewsWorkspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../routes/dueDiligence.ts', import.meta.url), 'utf8'),
])
assert.match(page, /\/capabilities\/write-probe/)
assert.match(page, /\/skill-library/)
assert.match(workspace, /沉淀的 Skill 库/)
assert.match(workspace, /从网址链接导入/)
assert.doesNotMatch(workspace, /待确认经验/)
assert.match(interviews, /放弃本次/)
assert.match(interviews, /放弃本次语音/)
assert.match(interviews, /recordingBaseDraft\.current/)
assert.match(interviews, /promptVoiceBase\.current/)
assert.match(routes, /DUE_DILIGENCE_API_VERSION = 2/)
assert.match(routes, /db\.transaction\(async tx =>/)
console.log(JSON.stringify({ ok: true, checks: ['forwarded-origin', 'untrusted-origin', 'write-probe', 'unified-skill-library', 'transactional-publication', 'recording-discard', 'prompt-voice-discard'] }))
