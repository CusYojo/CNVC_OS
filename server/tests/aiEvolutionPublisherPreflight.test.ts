import assert from 'node:assert/strict'
import test from 'node:test'
import { EVOLUTION_RELEASE_JOB_COLUMNS, EVOLUTION_RELEASE_JOB_INDEXES, validateEvolutionPublisherPreflight } from '../src/services/aiEvolutionPublisherPreflight.js'

const release = { schemaVersion: 1 as const, targets: [{ id: 'production', label: '生产', repositoryId: '00000000-0000-4000-8000-000000000001',
  root: '/opt/app', baseRef: 'main', allowedUserIds: ['00000000-0000-4000-8000-000000000002'] }] }
const lifecycle = { schemaVersion: 1 as const, targets: [{ targetId: 'production', healthUrl: 'http://127.0.0.1/health',
  stop: { file: '/usr/bin/systemctl', args: ['stop', 'app'] }, start: { file: '/usr/bin/systemctl', args: ['start', 'app'] } }] }
const valid = { release, lifecycle, columns: [...EVOLUTION_RELEASE_JOB_COLUMNS], indexes: [...EVOLUTION_RELEASE_JOB_INDEXES], table: 'sbl_ai_evolution_release_jobs' }

test('publisher preflight requires matching targets and every 0108 lease/idempotency constraint', () => {
  assert.deepEqual(validateEvolutionPublisherPreflight(valid), { targetIds: ['production'] })
  for (const column of EVOLUTION_RELEASE_JOB_COLUMNS) assert.throws(() => validateEvolutionPublisherPreflight({ ...valid,
    columns: valid.columns.filter(value => value !== column) }), new RegExp(column))
  for (const index of EVOLUTION_RELEASE_JOB_INDEXES) assert.throws(() => validateEvolutionPublisherPreflight({ ...valid,
    indexes: valid.indexes.filter(value => value !== index) }), new RegExp(index))
  assert.throws(() => validateEvolutionPublisherPreflight({ ...valid, lifecycle: { schemaVersion: 1, targets: [] } }), /target sets/)
})
