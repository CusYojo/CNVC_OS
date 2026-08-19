import assert from 'node:assert/strict'
import test from 'node:test'
import { derivePaperProjectName, resolvePaperProjectIdentity } from '../src/services/paperIdentity.js'

test('drops a rhetorical paper headline and keeps the substantive project subtitle', () => {
  assert.equal(
    derivePaperProjectName('When Agents Coordinate: Measuring Coordination in Multi-Agent AI Coding'),
    'Measuring Coordination in Multi-Agent AI Coding',
  )
  assert.equal(
    derivePaperProjectName('当智能体协作时：多智能体 AI 编程中的协作度量'),
    '多智能体 AI 编程中的协作度量',
  )
})

test('keeps a coined method or system name before the subtitle', () => {
  assert.equal(
    derivePaperProjectName('gmsEDA: Decomposition of Electrodermal Activity Signals Using Matrix Separation'),
    'gmsEDA',
  )
  assert.equal(
    derivePaperProjectName('GeoMix: Descriptor-Free Visual Localization via Global Context'),
    'GeoMix',
  )
  assert.equal(
    derivePaperProjectName('Beyond Uncertainty: Generalizable Failure Monitoring for Surgical Segmentation'),
    'Generalizable Failure Monitoring for Surgical Segmentation',
  )
  assert.equal(
    derivePaperProjectName('InfoOps Bench: A Live Information Operations Safety Benchmark'),
    'InfoOps Bench',
  )
})

test('uses the model project translation while retaining the full publication title separately', () => {
  assert.deepEqual(resolvePaperProjectIdentity({
    titleOriginal: 'When Agents Coordinate: Measuring Coordination in Multi-Agent AI Coding',
    titleZh: '当智能体协同时：衡量多智能体AI编程中的协作',
    modelProjectName: 'Measuring Coordination in Multi-Agent AI Coding',
    modelProjectNameZh: '多智能体 AI 编程中的协作度量',
  }), {
    projectName: '多智能体 AI 编程中的协作度量',
    projectNameOriginal: 'Measuring Coordination in Multi-Agent AI Coding',
  })
})
