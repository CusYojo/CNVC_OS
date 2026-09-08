import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEvolutionTap } from '../src/runtime/evolution/evolutionTestGate.js'

test('independent gate rejects empty, skipped, partial and failed test runs even with zero exit status', () => {
  const output = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
  assert.equal(parseEvolutionTap(output, 0, 2).verdict, 'PASS')
  for (const invalid of ['', output.replace('# pass 2', '# pass 1'), output.replace('# skipped 0', '# skipped 1'), `${output}# tests 2\n`, output.replace('# todo 0\n', '')]) {
    assert.equal(parseEvolutionTap(invalid, 0, 2).verdict, 'FAIL')
  }
  assert.equal(parseEvolutionTap(output, 1, 2).verdict, 'FAIL')
  assert.equal(parseEvolutionTap(output, 0, 3).verdict, 'FAIL')
})
