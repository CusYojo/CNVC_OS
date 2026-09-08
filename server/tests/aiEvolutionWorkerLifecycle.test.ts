import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EvolutionWorkerLifecycle } from '../src/runtime/evolution/evolutionWorkerLifecycle.js'
import { AiEvolutionExecutorRegistry } from '../src/services/aiEvolutionExecutorRegistry.js'

test('executor readiness and unregistration are isolated by evolution kind', async () => {
  const registry = new AiEvolutionExecutorRegistry()
  const removeCode = registry.register({ available: async () => true }, 'code')
  await registry.assertReady('code')
  await assert.rejects(registry.assertReady('skill'), { code: 'EVOLUTION_EXECUTOR_NOT_READY' })
  await assert.rejects(registry.assertReady('experience'), { code: 'EVOLUTION_EXECUTOR_NOT_READY' })
  registry.register({ available: async () => true }, 'skill')
  removeCode()
  await registry.assertReady('skill')
  assert.equal(await registry.available('code'), false)
})

test('registration is unavailable by default and unregister fences an in-flight readiness probe', async () => {
  const registry = new AiEvolutionExecutorRegistry()
  await assert.rejects(registry.assertReady(), { code: 'EVOLUTION_EXECUTOR_NOT_READY' })
  let resolve!: (value: boolean) => void
  const unregister = registry.register({ available: () => new Promise((done) => { resolve = done }) })
  const pending = registry.available()
  unregister()
  resolve(true)
  assert.equal(await pending, false)
})

test('shutdown stops admission immediately and waits for the active coordinator cleanup', async () => {
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  let ticks = 0, stops = 0
  const worker = new EvolutionWorkerLifecycle({
    tick: () => { ticks++; entered(); return new Promise<void>((resolve) => { finish = resolve }) },
    stop: () => { stops++ },
  }, async () => true, () => {}, 10)
  await worker.start()
  // An explicit test handle keeps the loop alive; the production scheduler is deliberately unref'd.
  const guard = setTimeout(() => {}, 1000)
  try {
    await started
    assert.equal(await worker.available(), true)
    let drained = false
    const stopping = worker.stop().then(() => { drained = true })
    assert.equal(await worker.available(), false)
    assert.equal(drained, false)
    finish()
    await stopping
    assert.equal(stops, 1)
    assert.equal(ticks, 1)
    await assert.rejects(worker.start())
  } finally { clearTimeout(guard); await worker.stop() }
})

test('shutdown during startup cannot resurrect a scheduler', async () => {
  let release!: (value: boolean) => void
  let ticks = 0
  const worker = new EvolutionWorkerLifecycle({ tick: async () => { ticks++ }, stop: () => {} },
    () => new Promise((resolve) => { release = resolve }), () => {})
  const starting = worker.start()
  await worker.stop()
  release(true)
  await assert.rejects(starting, /stopped during startup/)
  assert.equal(await worker.available(), false)
  assert.equal(ticks, 0)
})
