import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readEvolutionReevaluationBase } from '../src/services/aiEvolutionReevaluationBase.js'

test('real Git reevaluation observes new commits and rejects dirty or unsynchronized repositories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-rebase-'))
  const target = path.join(root, 'target'), other = path.join(root, 'other')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  try {
    await mkdir(target); await mkdir(other)
    git(target, 'init', '--quiet'); git(other, 'init', '--quiet')
    await writeFile(path.join(target, 'file.txt'), 'first')
    git(target, 'add', 'file.txt')
    const commit = () => git(target, '-c', 'user.name=Evolution Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'isolated fixture')
    commit()
    const first = await readEvolutionReevaluationBase({ root: target, baseRef: 'HEAD' }, target)
    await writeFile(path.join(target, 'file.txt'), 'second')
    await assert.rejects(readEvolutionReevaluationBase({ root: target, baseRef: 'HEAD' }, target), { code: 'EVOLUTION_RELEASE_WORKTREE_DIRTY' })
    git(target, 'add', 'file.txt'); commit()
    const second = await readEvolutionReevaluationBase({ root: target, baseRef: 'HEAD' }, target)
    assert.notEqual(first, second)
    assert.equal(second, git(target, 'rev-parse', 'HEAD').trim())
    await assert.rejects(readEvolutionReevaluationBase({ root: target, baseRef: 'HEAD' }, other), { code: 'EVOLUTION_REEVALUATION_BASE_UNAVAILABLE' })
    await assert.rejects(readEvolutionReevaluationBase({ root: target, baseRef: '--all' }, target), /Invalid registered/)
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('evolution-rebase-'))
    await rm(root, { recursive: true, force: true })
  }
})
