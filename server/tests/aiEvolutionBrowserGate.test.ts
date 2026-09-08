import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runEvolutionBrowserGate, type EvolutionBrowser } from '../src/runtime/evolution/evolutionBrowserGate.js'

for (const phase of ['before', 'context', 'navigation', 'screenshot'] as const) {
  test(`page gate cancellation during ${phase} cannot return a passing candidate`, async () => {
    const controller = new AbortController()
    const reason = new Error('lease revoked')
    let opened = 0, closed = 0
    let rejectNavigation: ((reason: Error) => void) | undefined
    const browser: EvolutionBrowser = {
      newContext: async () => {
        opened++
        if (phase === 'context') controller.abort(reason)
        return {
          route: async () => {}, routeWebSocket: async () => {},
          close: async () => { closed++; rejectNavigation?.(new Error('context closed')) },
          newPage: async () => ({
            on: () => {},
            evaluate: async <T,>() => ({ viewport: 390, content: 390 }) as T,
            goto: async () => {
              if (phase !== 'navigation') return
              return new Promise((_, reject) => {
                rejectNavigation = reject
                controller.abort(reason)
              })
            },
            locator: () => ({ click: async () => {}, waitFor: async () => {}, innerText: async () => 'verified' }),
            screenshot: async () => { if (phase === 'screenshot') controller.abort(reason); return Buffer.from('image') },
          }),
        }
      },
    }
    if (phase === 'before') controller.abort(reason)
    await assert.rejects(runEvolutionBrowserGate({ browser, store: { read: async () => Buffer.alloc(0) }, files: [],
      control: { signal: controller.signal, identity: { runId: 'test', attempt: 1, leaseToken: 1, inputHash: 'a'.repeat(64) },
        assertCanContinue: async () => controller.signal.throwIfAborted() },
      scenario: { path: '/', viewport: { width: 390, height: 844 }, fixtures: {}, actions: [{ selector: 'p', action: 'visible' }] },
    }), (error) => error === reason)
    assert.equal(opened, phase === 'before' ? 0 : 1)
    assert.equal(closed, opened, 'every created browser context must close exactly once')
  })
}
