import assert from 'node:assert/strict'
import test from 'node:test'
import { directSkillPlatformEnvironment } from '../src/services/directSkillEnvironment.js'

test('Windows uses Scripts, semicolon and preserves OS executable lookup', () => {
  const result = directSkillPlatformEnvironment('C:\\app', 'win32', { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', API_KEY: 'private' })
  assert.equal(result.PATH, 'C:\\app\\server\\.venv\\Scripts;C:\\Windows')
  assert.equal(result.SystemRoot, 'C:\\Windows')
  assert.equal(result.PYTHONUTF8, '1')
  assert.equal('API_KEY' in result, false)
})

test('Unix uses bin and colon', () => {
  assert.equal(directSkillPlatformEnvironment('/app', 'linux', { PATH: '/usr/bin' }).PATH, '/app/server/.venv/bin:/usr/bin')
})
