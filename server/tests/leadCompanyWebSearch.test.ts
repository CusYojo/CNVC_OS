import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEAD_COMPANY_WEB_SEARCH_METHOD,
  shouldAttemptLeadCompanyWebSearch,
} from '../src/services/leadCompanyWebSearchService.js'

test('ordinary follow-up retries fields left missing by a partially completed search', () => {
  assert.equal(shouldAttemptLeadCompanyWebSearch({
    priorMethod: LEAD_COMPANY_WEB_SEARCH_METHOD,
    priorStatus: 'completed',
    missingFields: ['creditCode', 'registrationStatus'],
  }), true)
})

test('an all-empty prior search remains opt-in to avoid an endless automatic loop', () => {
  const input = {
    priorMethod: LEAD_COMPANY_WEB_SEARCH_METHOD,
    priorStatus: 'no_match',
    missingFields: ['creditCode'] as const,
  }
  assert.equal(shouldAttemptLeadCompanyWebSearch({ ...input, missingFields: [...input.missingFields] }), false)
  assert.equal(shouldAttemptLeadCompanyWebSearch({
    ...input,
    missingFields: [...input.missingFields],
    retryNoMatch: true,
  }), true)
})

test('complete records never trigger another company search', () => {
  assert.equal(shouldAttemptLeadCompanyWebSearch({
    priorMethod: LEAD_COMPANY_WEB_SEARCH_METHOD,
    priorStatus: 'completed',
    missingFields: [],
    retry: true,
  }), false)
})
