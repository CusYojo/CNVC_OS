import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePublicIntelPython } from '../src/services/publicIntelPythonRuntime.js'

test('public intel Python prefers an explicit configured executable', () => {
  const result = resolvePublicIntelPython({
    env: { AI_INTEL_PYTHON: 'C:\\runtime\\python.exe' },
    platform: 'win32',
    projectRoot: 'C:\\project',
    exists: () => false,
  })
  assert.deepEqual(result, { executable: 'C:\\runtime\\python.exe', argsPrefix: [], source: 'configured' })
})

test('public intel Python uses the project virtual environment on Windows', () => {
  const result = resolvePublicIntelPython({
    env: {}, platform: 'win32', projectRoot: 'C:\\project',
    exists: (candidate) => candidate.endsWith('server\\.venv\\Scripts\\python.exe'),
  })
  assert.equal(result.source, 'project-venv')
  assert.match(result.executable, /server\\\.venv\\Scripts\\python\.exe$/)
  assert.deepEqual(result.argsPrefix, [])
})

test('public intel Python uses the project virtual environment on Linux', () => {
  const result = resolvePublicIntelPython({
    env: {}, platform: 'linux', projectRoot: '/srv/app',
    exists: (candidate) => candidate === '/srv/app/server/.venv/bin/python3',
  })
  assert.deepEqual(result, {
    executable: '/srv/app/server/.venv/bin/python3', argsPrefix: [], source: 'project-venv',
  })
})

test('public intel Python falls back to the platform command', () => {
  assert.deepEqual(resolvePublicIntelPython({
    env: {}, platform: 'win32', projectRoot: 'C:\\project', exists: () => false,
  }), { executable: 'py', argsPrefix: ['-3'], source: 'platform-fallback' })
  assert.deepEqual(resolvePublicIntelPython({
    env: {}, platform: 'linux', projectRoot: '/srv/app', exists: () => false,
  }), { executable: 'python3', argsPrefix: [], source: 'platform-fallback' })
})
