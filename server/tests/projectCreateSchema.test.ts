import assert from 'node:assert/strict'
import test from 'node:test'
import { ProjectCreateSchema } from '../src/schemas/project.js'

test('accepts nullable optional lead fields when converting a lead to a project', () => {
  const parsed = ProjectCreateSchema.parse({
    name: 'MobAI',
    owner: '林知远',
    companyName: null,
    team: null,
    financing: null,
    collaborators: null,
    tags: ['人工智能', null, '', '待核验'],
  })

  assert.equal(parsed.companyName, undefined)
  assert.equal(parsed.team, undefined)
  assert.equal(parsed.financing, undefined)
  assert.deepEqual(parsed.collaborators, [])
  assert.deepEqual(parsed.tags, ['人工智能', '待核验'])
})
