import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseAiEvolutionReleaseTargets } from '../src/services/aiEvolutionReleaseRegistry.js'
import { parseEvolutionPublisherLifecycleConfig } from '../src/services/aiEvolutionPublisherLifecycleRegistry.js'

test('publisher deployment examples are parseable and stay alive when the business service stops', async () => {
  const [targets, lifecycle, unit] = await Promise.all([
    readFile('deploy/ai-evolution-release-targets.example.json', 'utf8').then(JSON.parse).then(parseAiEvolutionReleaseTargets),
    readFile('deploy/ai-evolution-publisher-lifecycle.example.json', 'utf8').then(JSON.parse).then(parseEvolutionPublisherLifecycleConfig),
    readFile('deploy/cybernaut-ai-evolution-publisher.service.example', 'utf8'),
  ])
  assert.deepEqual(targets.targets.map(row => row.id), lifecycle.targets.map(row => row.targetId))
  assert.match(unit, /^User=root$/m)
  assert.match(unit, /^ExecStart=\/usr\/bin\/npm run start:ai-evolution-release-publisher$/m)
  assert.match(unit, /^ProtectSystem=strict$/m)
  assert.match(unit, /^ReadWritePaths=.*\.runtime .*\/dist .*\/server-dist$/m)
  assert.doesNotMatch(unit, /^(?:PartOf|BindsTo)=cybernaut-app\.service$/m)
  assert.deepEqual(lifecycle.targets[0].stop.args, ['stop', 'cybernaut-app.service'])
  assert.deepEqual(lifecycle.targets[0].start.args, ['start', 'cybernaut-app.service'])
})
