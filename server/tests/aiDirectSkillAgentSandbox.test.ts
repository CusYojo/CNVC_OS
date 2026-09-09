import assert from 'node:assert/strict'
import test from 'node:test'
import { directSkillAgentSandboxEnabled, directSkillAgentSandboxFailIfUnavailable } from '../src/services/aiDirectSkillAgentSandbox.js'

test('direct Skill Agent fails closed where SDK sandboxing is supported', () => {
  assert.equal(directSkillAgentSandboxFailIfUnavailable('linux'), true)
  assert.equal(directSkillAgentSandboxFailIfUnavailable('darwin'), true)
})

test('direct Skill Agent permits the documented SDK fallback only on native Windows', () => {
  assert.equal(directSkillAgentSandboxFailIfUnavailable('win32'), false)
})

test('direct Skill Agent disables unsupported native Windows SDK sandbox', () => {
  assert.equal(directSkillAgentSandboxEnabled('win32'), false)
  assert.equal(directSkillAgentSandboxEnabled('linux'), true)
  assert.equal(directSkillAgentSandboxEnabled('darwin'), true)
})
