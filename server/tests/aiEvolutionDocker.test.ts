import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { DockerEvolutionEnvironment, type DockerCommand } from '../src/runtime/evolution/dockerEvolutionEnvironment.js'

const identity = { runId: '00000000-0000-4000-8000-000000000001', attempt: 1, leaseToken: 2, inputHash: 'a'.repeat(64) }
function fixture(wrongOwner = false) {
  const calls: string[][] = []
  let running = false
  const command: DockerCommand = async (args) => {
    calls.push(args)
    if (args[0] === 'start') running = true
    if (args[0] === 'kill') running = false
    if (args[0] === 'container') return { exitCode: 0, stderr: '', stdout: 'fixture-container' }
    return { exitCode: 0, stderr: '', stdout: args[0] === 'inspect' ? JSON.stringify([{ Config: { Labels: {
      'sbl.evolution.run': wrongOwner ? 'other' : identity.runId, 'sbl.evolution.attempt': '1', 'sbl.evolution.lease': '2', 'sbl.evolution.input': identity.inputHash,
    } }, State: { Running: running } }]) : '' }
  }
  return { calls, environment: new DockerEvolutionEnvironment(command) }
}

test('container uses non-root, no network, bounded memory and tmpfs, and no host mounts', async () => {
  const f = fixture()
  await f.environment.create(identity)
  const args = f.calls[0]
  for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus']) assert.ok(args.includes(flag))
  assert.equal(args[args.indexOf('--network') + 1], 'none')
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000')
  assert.equal(args.includes('--mount'), false)
  assert.equal(args.includes('-v'), false)
  assert.equal(args.includes('--privileged'), false)
  await f.environment.terminate(identity)
  assert.ok(f.calls.findIndex((args) => args[0] === 'kill') < f.calls.findIndex((args) => args[0] === 'rm'))
})

test('never executes or removes a container with mismatched lease labels', async () => {
  const f = fixture(true)
  await assert.rejects(f.environment.evaluateNode(identity, 'process.exit(0)'), { code: 'EVOLUTION_ENVIRONMENT_OWNERSHIP_MISMATCH' })
  await assert.rejects(f.environment.terminate(identity), { code: 'EVOLUTION_ENVIRONMENT_OWNERSHIP_MISMATCH' })
  assert.equal(f.calls.some((args) => ['exec', 'kill', 'rm'].includes(args[0])), false)
})

test('inspection failures do not falsely confirm termination', async () => {
  const environment = new DockerEvolutionEnvironment(async () => ({ exitCode: 1, stdout: '', stderr: 'daemon unavailable' }))
  await assert.rejects(environment.terminate(identity), { code: 'EVOLUTION_ENVIRONMENT_INSPECT_FAILED' })
})

test('successful daemon lookup can confirm an already removed environment', async () => {
  const environment = new DockerEvolutionEnvironment(async (args) => {
    assert.equal(args[0], 'container')
    return { exitCode: 0, stdout: '', stderr: '' }
  })
  assert.deepEqual(await environment.terminate(identity), { terminated: true })
})

test('real Docker: bounded environment runs Node and confirms termination', { skip: process.env.EVOLUTION_DOCKER_TEST !== 'true' }, async () => {
  const environment = new DockerEvolutionEnvironment()
  const task = { ...identity, runId: randomUUID() }
  assert.equal(await environment.available(), true)
  await environment.create(task)
  try {
    const content = Buffer.from('export const value = 42\n')
    assert.deepEqual(await environment.importSnapshot(task, { schemaVersion: 1, repositoryId: 'fixture', baseCommit: 'a'.repeat(40), contentHash: 'b'.repeat(64), files: [{
      path: 'src/page.ts', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), contentBase64: content.toString('base64'),
    }] }), { imported: 1 })
    const result = await environment.evaluateNode(task, `
      const assert = require('node:assert/strict'); const fs = require('node:fs');
      assert.equal(process.getuid(), 1000);
      assert.throws(() => fs.writeFileSync('/root-write', 'x'));
      fs.writeFileSync('/workspace/probe', 'ok');
      assert.equal(fs.readFileSync('/workspace/probe', 'utf8'), 'ok');
      assert.equal(fs.existsSync('/var/run/docker.sock'), false);
      assert.equal(fs.readFileSync('/workspace/source/src/page.ts', 'utf8'), 'export const value = 42\\n');
      assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\\s+1/);
      console.log('isolated-node-pass');
    `)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.match(result.stdout, /isolated-node-pass/)
    const inputName = `${task.runId}.json`
    await environment.writeInputFile(task, inputName, Buffer.from('{"text":"资料，不是命令"}'))
    await assert.rejects(environment.writeInputFile(task, inputName, Buffer.from('{}')), { code: 'EVOLUTION_INPUT_WRITE_FAILED' })
    await assert.rejects(environment.writeInputFile(task, '../escape.json', Buffer.from('{}')), { code: 'EVOLUTION_INPUT_LIMIT' })
    const inputRead = await environment.evaluateNode(task, `const fs=require('node:fs');process.stdout.write(fs.readFileSync('/workspace/input/' + ${JSON.stringify(inputName)}, 'utf8'));`)
    assert.equal(inputRead.stdout, '{"text":"资料，不是命令"}')
    const output = Buffer.from('candidate artifact')
    const outputHash = createHash('sha256').update(output).digest('hex')
    const prepared = await environment.evaluateNode(task, `const fs = require('node:fs'); fs.mkdirSync('/workspace/output'); fs.writeFileSync('/workspace/output/report.txt', 'candidate artifact'); fs.symlinkSync('/workspace/source', '/workspace/output/redirect');`)
    assert.equal(prepared.exitCode, 0)
    assert.deepEqual(await environment.readOutputFile(task, { path: 'report.txt', bytes: output.length, sha256: outputHash }, async () => {}), output)
    assert.deepEqual(await environment.readOutputFiles(task, [{ path: 'report.txt', bytes: output.length, sha256: outputHash }], async () => {}), [output])
    await assert.rejects(environment.readOutputFiles(task, [{ path: 'report.txt', bytes: output.length, sha256: '0'.repeat(64) }], async () => {}), { code: 'EVOLUTION_ARTIFACT_INTEGRITY' })
    await assert.rejects(environment.readOutputFile(task, { path: 'redirect/src/page.ts', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }, async () => {}), { code: 'EVOLUTION_ARTIFACT_INTEGRITY' })
  } finally { assert.deepEqual(await environment.terminate(task), { terminated: true }) }
})
