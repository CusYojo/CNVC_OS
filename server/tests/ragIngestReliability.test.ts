import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableIngestError, summarizeIngestError } from '../src/services/ragService.js'

test('ingest error summary keeps the database root cause without document parameters', () => {
  const root = new Error("Data too long for column 'content_text' at row 1")
  const outer = new Error(`Failed query: update project_files set content_text=?\nparams: ${'document-body '.repeat(10_000)}`, { cause: root })
  const summary = summarizeIngestError(outer)

  assert.equal(summary, "Data too long for column 'content_text' at row 1")
  assert.equal(summary.includes('document-body'), false)
  assert.equal(isRetryableIngestError(summary), false)
})

test('ingest error summary strips SQL parameters and stays within TEXT safety budget', () => {
  const summary = summarizeIngestError(`Failed query\nparams: ${'项目正文'.repeat(10_000)}`)

  assert.equal(summary, 'Failed query')
  assert.ok(summary.length <= 2_000)
  assert.equal(isRetryableIngestError('ETIMEDOUT from OCR gateway'), true)
})
