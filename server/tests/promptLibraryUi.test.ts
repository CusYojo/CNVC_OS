import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PromptLibraryPage } from '../../src/pages/PromptLibraryPage.js'

test('Skill and Agent libraries present distinct accessible headings and creation actions', () => {
  const skill = renderToStaticMarkup(React.createElement(PromptLibraryPage, { kind: 'skill' }))
  const agent = renderToStaticMarkup(React.createElement(PromptLibraryPage, { kind: 'agent' }))
  assert.match(skill, /智能 Skill 库/)
  assert.match(agent, /智能 Agent 库/)
  assert.match(skill, /创建 Skill/)
  assert.match(agent, /创建 Agent/)
  assert.match(skill, /搜索提示词/)
})
