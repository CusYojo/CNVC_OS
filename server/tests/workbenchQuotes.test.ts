import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WORKBENCH_QUOTES, QUOTE_INTERVAL_MS, createQuoteRotation, advanceQuoteRotation } from '../../src/lib/workbenchQuotes.js'
import { WorkbenchQuote } from '../../src/components/WorkbenchQuote.js'

test('the local collection contains 20 short original messages about work and supporting enterprises', () => {
  assert.equal(WORKBENCH_QUOTES.length, 20)
  assert.equal(new Set(WORKBENCH_QUOTES.map(quote => quote.text)).size, 20)
  assert.equal(new Set(WORKBENCH_QUOTES.map(quote => quote.id)).size, 20)
  for (const quote of WORKBENCH_QUOTES) {
    assert.ok(quote.text.length > 5 && quote.text.length <= 24)
    assert.deepEqual(Object.keys(quote).sort(), ['id', 'text'])
    assert.doesNotMatch(quote.text, /读书|学习|学而|吾日三省/)
  }
  assert.ok(WORKBENCH_QUOTES.filter(quote => /企业|同行|陪伴|创业/.test(quote.text)).length >= 8)
  assert.ok(WORKBENCH_QUOTES.some(quote => quote.text === '做精品创投，与伟大企业同行。'))
  assert.equal(QUOTE_INTERVAL_MS, 15_000)
})

test('random playback covers all 20 quotes before repeating, including cycle boundaries', () => {
  for (const random of [() => 0, () => 0.5, () => 0.99999]) {
    let rotation = createQuoteRotation(random)
    const seen: number[] = []
    for (let i = 0; i < 80; i++) {
      const current = rotation.order[rotation.cursor]
      if (seen.length) assert.notEqual(current, seen.at(-1))
      seen.push(current)
      rotation = advanceQuoteRotation(rotation, random)
      assert.equal(rotation.previous, current)
    }
    for (let round = 0; round < 4; round++) assert.equal(new Set(seen.slice(round * 20, round * 20 + 20)).size, 20)
  }
})

test('advancing never mutates the previous snapshot or stored quotation order', () => {
  const initial = createQuoteRotation(() => 0.25)
  const before = JSON.stringify(initial)
  const next = advanceQuoteRotation(initial, () => 0.75)
  assert.equal(JSON.stringify(initial), before)
  assert.notEqual(next, initial)
  assert.equal(next.cursor, 1)
  assert.notDeepEqual(createQuoteRotation(() => 0).order, createQuoteRotation(() => 0.99).order)
})

test('header message offers an always visible change-now button alongside pause, without fake attribution', () => {
  const html = renderToStaticMarkup(React.createElement(WorkbenchQuote))
  assert.match(html, /aria-label="工作寄语"/)
  assert.match(html, /aria-live="off"/)
  assert.match(html, /aria-label="暂停寄语轮播"/)
  assert.match(html, /aria-label="换一句工作寄语"/)
  assert.match(html, />换一句<\/span>/)
  assert.doesNotMatch(html, /<cite|名言|孔子|荀子/)
  assert.doesNotMatch(html, /aria-live="(?:polite|assertive)"/)
})

test('quotes only replace the workbench title; visibility, reduced motion and timer cleanup are respected', async () => {
  const layout = await readFile(new URL('../../src/layout/AppLayout.tsx', import.meta.url), 'utf8')
  const component = await readFile(new URL('../../src/components/WorkbenchQuote.tsx', import.meta.url), 'utf8')
  const css = await readFile(new URL('../../src/components/WorkbenchQuote.css', import.meta.url), 'utf8')
  assert.match(layout, /location\.pathname === '\/'/)
  assert.match(layout, /<WorkbenchQuote/)
  assert.match(layout, /<strong>\{pageTitle\}<\/strong>/)
  assert.match(component, /visibilitychange/)
  assert.match(component, /clearInterval/)
  assert.match(component, /onMouseEnter/)
  assert.match(component, /onFocusCapture/)
  assert.match(css, /prefers-reduced-motion: reduce/)
})
