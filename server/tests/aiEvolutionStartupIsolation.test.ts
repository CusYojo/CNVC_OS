import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('optional evolution executors cannot prevent the business service from becoming ready', async () => {
  const source = await readFile('server/src/index.ts', 'utf8')
  assert.match(source, /Promise\.allSettled\(\[startAiEvolutionHost\(\), startAiEvolutionSkillHost\(\), startAiEvolutionSkillExpiry\(\)\]\)/)
  assert.match(source, /corresponding execution remains disabled/)
  const hostBlock = source.slice(source.indexOf('const evolutionHosts'), source.indexOf('startResponsibilityScanner'))
  assert.doesNotMatch(hostBlock, /throw result\.reason|Promise\.reject/)
})
