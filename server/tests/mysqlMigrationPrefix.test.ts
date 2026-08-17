import assert from 'node:assert/strict'
import test from 'node:test'
import { rewriteMigrationSqlForPrefix } from '../src/db/migrate.js'

test('migration SQL honors DB_FREFIX for tables, constraints and references', () => {
  const source = [
    'CREATE TABLE `sbl_jobs` (`id` int, `active_name` varchar(20), CONSTRAINT `sbl_jobs_id` PRIMARY KEY (`id`), CONSTRAINT `uq_jobs_active` UNIQUE (`active_name`), CONSTRAINT `ck_jobs_id` CHECK (`id` > 0));',
    'ALTER TABLE `sbl_runs` ADD CONSTRAINT `fk_runs_job` FOREIGN KEY (`job_id`) REFERENCES `sbl_jobs`(`id`);',
  ].join('\n')
  const rewritten = rewriteMigrationSqlForPrefix(source, 'tenant42_')
  assert.equal(rewritten.includes('`sbl_'), false)
  assert.match(rewritten, /`tenant42_jobs`/)
  assert.match(rewritten, /`tenant42_runs`/)
  assert.match(rewritten, /`tenant42_jobs_id`/)
  assert.match(rewritten, /CONSTRAINT `uq_jobs_active` UNIQUE/)
  assert.match(rewritten, /CONSTRAINT `tenant42_ck_jobs_id` CHECK/)
  assert.match(rewritten, /CONSTRAINT `tenant42_fk_runs_job`/)
})

test('migration constraint names remain schema-unique, deterministic and within MySQL limits', () => {
  const source = 'ALTER TABLE `sbl_ai_artifacts` ADD CONSTRAINT `fk_ai_artifacts_extremely_long_relationship_name_that_would_exceed_mysql_identifier_limits` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`);'
  const first = rewriteMigrationSqlForPrefix(source, 'lba_12345678_')
  const repeated = rewriteMigrationSqlForPrefix(source, 'lba_12345678_')
  const secondTenant = rewriteMigrationSqlForPrefix(source, 'lba_87654321_')
  const firstName = first.match(/CONSTRAINT `([^`]+)`/)?.[1] || ''
  const secondName = secondTenant.match(/CONSTRAINT `([^`]+)`/)?.[1] || ''
  assert.equal(first, repeated)
  assert.equal(firstName.length <= 64, true)
  assert.equal(secondName.length <= 64, true)
  assert.notEqual(firstName, secondName)
  assert.match(firstName, /^lba_12345678_/)
})

test('default migration prefix remains byte-for-byte unchanged', () => {
  const source = 'ALTER TABLE `sbl_runs` ADD CONSTRAINT `fk_runs_job` FOREIGN KEY (`job_id`) REFERENCES `sbl_jobs`(`id`);'
  assert.equal(rewriteMigrationSqlForPrefix(source, 'sbl_'), source)
})
