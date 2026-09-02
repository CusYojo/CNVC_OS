import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runtimeJobDefinitions } from '../src/services/runtimeJobScheduler.js'

test('36氪采集和每日准入是两套默认关闭的独立任务', () => {
  const previous = {
    sync: process.env.KR36_PROJECT_SYNC_ENABLED,
    admission: process.env.KR36_PROJECT_ADMISSION_ENABLED,
  }
  process.env.KR36_PROJECT_SYNC_ENABLED = 'false'
  process.env.KR36_PROJECT_ADMISSION_ENABLED = 'false'
  try {
    const definitions = runtimeJobDefinitions()
    const sync = definitions.find((job) => job.id === 'kr36-project-sync')
    const admission = definitions.find((job) => job.id === 'kr36-project-daily-admission')
    assert.ok(sync)
    assert.ok(admission)
    assert.equal(sync.enabled, false)
    assert.equal(sync.scheduleKind, 'interval')
    assert.equal(admission.enabled, false)
    assert.equal(admission.scheduleKind, 'daily')
    assert.equal(admission.dailyHour, 9)
    assert.equal(admission.dailyMinute, 10)
  } finally {
    if (previous.sync === undefined) delete process.env.KR36_PROJECT_SYNC_ENABLED
    else process.env.KR36_PROJECT_SYNC_ENABLED = previous.sync
    if (previous.admission === undefined) delete process.env.KR36_PROJECT_ADMISSION_ENABLED
    else process.env.KR36_PROJECT_ADMISSION_ENABLED = previous.admission
  }
})

test('正式切换默认每日10条并保持旧50条任务关闭', () => {
  const previous = {
    quota: process.env.KR36_PROJECT_DAILY_QUOTA,
    legacy: process.env.LEGACY_LEAD_RESERVE_INTAKE_ENABLED,
    old: process.env.DAILY_INTAKE_ENABLED,
  }
  delete process.env.KR36_PROJECT_DAILY_QUOTA
  delete process.env.LEGACY_LEAD_RESERVE_INTAKE_ENABLED
  process.env.DAILY_INTAKE_ENABLED = 'true'
  try {
    const definitions = runtimeJobDefinitions()
    const admission = definitions.find((job) => job.id === 'kr36-project-daily-admission')
    const legacy = definitions.find((job) => job.id === 'lead-reserve-daily-intake')
    assert.ok(admission)
    assert.ok(legacy)
    assert.equal(legacy.enabled, false)
    assert.equal(admission.dailyHour, 9)
    assert.equal(admission.dailyMinute, 10)
    assert.match(
      readFileSync(new URL('../src/services/runtimeJobScheduler.ts', import.meta.url), 'utf8'),
      /KR36_PROJECT_DAILY_QUOTA', 10, 1/,
    )
  } finally {
    if (previous.quota === undefined) delete process.env.KR36_PROJECT_DAILY_QUOTA
    else process.env.KR36_PROJECT_DAILY_QUOTA = previous.quota
    if (previous.legacy === undefined) delete process.env.LEGACY_LEAD_RESERVE_INTAKE_ENABLED
    else process.env.LEGACY_LEAD_RESERVE_INTAKE_ENABLED = previous.legacy
    if (previous.old === undefined) delete process.env.DAILY_INTAKE_ENABLED
    else process.env.DAILY_INTAKE_ENABLED = previous.old
  }
})

test('每日准入从全部合格候选按日期稳定随机抽取', () => {
  const source = readFileSync(new URL('../src/services/kr36ProjectAdmissionService.ts', import.meta.url), 'utf8')
  assert.match(source, /const selectionSeed = `kr36-daily-admission:\$\{dateKey\}`/)
  assert.match(source, /ORDER BY SHA2\(CONCAT\(\?,':',id\),256\),id/)
  assert.doesNotMatch(source, /first_seen_at>=CURRENT_DATE\(\)/)
})
