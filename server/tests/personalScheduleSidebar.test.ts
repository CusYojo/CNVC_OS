import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { PersonalScheduleSidebar } from '../../src/components/PersonalScheduleSidebar.js'

test('today input is always visible; only the future preview is collapsed', () => {
  const html = renderToStaticMarkup(React.createElement(StaticRouter, { location: '/' },
    React.createElement(PersonalScheduleSidebar, {
      today: React.createElement('input', { 'aria-label': '待办内容' }),
      future: React.createElement('p', {}, '明天的项目任务'),
      futureCount: 3,
      tools: React.createElement('a', { href: '/knowledge?view=notes' }, '个人笔记'),
    })))
  assert.match(html, /<aside[^>]+aria-label="今日待办与计划"/)
  assert.ok(html.indexOf('aria-label="待办内容"') < html.indexOf('<details'))
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/)
  assert.match(html, /<summary>.*未来三天.*3 项.*<\/summary>/)
  assert.match(html, /明天的项目任务/)
  assert.match(html, /href="\/collaboration"/)
  assert.ok(html.indexOf('个人笔记') > html.indexOf('</details>'))
})

test('an empty future preview stays optional and does not hide the today editor', () => {
  const html = renderToStaticMarkup(React.createElement(StaticRouter, { location: '/' },
    React.createElement(PersonalScheduleSidebar, {
      today: React.createElement('input', { 'aria-label': '待办内容' }),
      future: React.createElement('p', {}, '未来三天没有任务'), futureCount: 0, tools: null,
    })))
  assert.match(html, /待办内容/)
  assert.match(html, /未来三天没有任务/)
  assert.doesNotMatch(html, /0 项/)
})
