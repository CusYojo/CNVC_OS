import type { DockerEvolutionEnvironment } from './dockerEvolutionEnvironment.js'
import type { EvolutionExecutionControl } from './evolutionRunCoordinator.js'
import { safeEvolutionSourcePath } from './evolutionSourceSnapshot.js'
import { evolutionError } from '../../services/aiEvolutionPolicyService.js'

export function parseEvolutionTap(output: string, exitCode: number, minimumTests: number) {
  const count = (name: string) => {
    const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))]
    return matches.length === 1 ? Number(matches[0][1]) : null
  }
  const tests = count('tests'), passed = count('pass'), failed = count('fail'), cancelled = count('cancelled'), skipped = count('skipped'), todo = count('todo')
  const complete = Number.isSafeInteger(minimumTests) && minimumTests > 0 && tests !== null && tests >= minimumTests
    && passed === tests && failed === 0 && cancelled === 0 && skipped === 0 && todo === 0
  return { verdict: exitCode === 0 && complete ? 'PASS' as const : 'FAIL' as const, tests, passed, failed, cancelled, skipped, todo }
}

/** Gate files are installed in the immutable image, never copied from candidate sources. */
export async function runEvolutionTestGate(input: {
  id: 'permissions' | 'contract' | 'functional'; file: string; minimumTests: number; timeoutMs: number
  environment: Pick<DockerEvolutionEnvironment, 'evaluateNode'>; control: EvolutionExecutionControl
}) {
  if (!safeEvolutionSourcePath(input.file) || !Number.isSafeInteger(input.minimumTests) || input.minimumTests < 1) {
    throw evolutionError(503, 'EVOLUTION_GATE_CONFIGURATION', '固定验收脚本配置无效')
  }
  await input.control.assertCanContinue()
  const script = `
    const fs = require('node:fs'), assert = require('node:assert/strict'), cp = require('node:child_process');
    const file = '/opt/evolution-gates/' + ${JSON.stringify(input.file)};
    assert.equal(fs.realpathSync(file), file);
    assert.equal(fs.statSync(file).isFile(), true);
    // Read-only image files must not be replaceable by the candidate's non-root user.
    let writable = true; try { fs.accessSync(file, fs.constants.W_OK) } catch { writable = false }
    assert.equal(writable, false);
    const result = cp.spawnSync(process.execPath, ['--import', '/opt/evolution-dependencies/node_modules/tsx/dist/loader.mjs', '--test', '--test-reporter=tap', file], {
      cwd:'/workspace/source', env:{PATH:process.env.PATH, NODE_ENV:'test', TZ:'UTC', EVOLUTION_CANDIDATE_ROOT:'/workspace/source',
        DB_HOST:'127.0.0.1', DB_PORT:'1', DB_DATABASE:'evolution_gate_fixture', DB_USERNAME:'fixture', DB_PASSWORD:'fixture-only', DB_FREFIX:'gate_'},
      encoding:'utf8', timeout:${Math.max(100, input.timeoutMs - 1000)}, maxBuffer:400000,
    });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    process.exitCode = result.error ? 1 : (result.status ?? 1);
  `
  const result = await input.environment.evaluateNode(input.control.identity, script, input.timeoutMs)
  await input.control.assertCanContinue()
  const summary = parseEvolutionTap(result.stdout, result.exitCode, input.minimumTests)
  return { id: input.id, ...summary, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}
