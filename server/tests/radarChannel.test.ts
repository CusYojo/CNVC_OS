import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveRadarChannel,
  is36KrRadarCandidate,
  isRadarPaperCandidate,
} from '../src/services/radarChannel.js'

test('maps 36Kr RSS from the generic news group to the 36氪 channel', () => {
  const candidate = {
    source_group: '创投新闻',
    source_key: '36kr_feed',
    source_name: '36氪 RSS',
  }
  assert.equal(is36KrRadarCandidate(candidate), true)
  assert.equal(deriveRadarChannel(candidate), '36氪')
})

test('maps 36Kr PitchHub financing flashes to the 36氪 channel', () => {
  assert.equal(deriveRadarChannel({
    source_group: '创投新闻',
    source_key: '36kr_pitchhub_financing_flash',
    link: 'https://pitchhub.36kr.com/financing-flash/123',
  }), '36氪')
})

test('keeps non-36Kr venture news in the generic news channel', () => {
  assert.equal(deriveRadarChannel({
    source_group: '创投新闻',
    source_key: 'other_venture_news',
  }), '创投新闻')
})

test('does not treat a secondary 36Kr evidence link as the primary channel', () => {
  assert.equal(deriveRadarChannel({
    source_group: '机构公众号',
    source_key: 'meihua-ventures',
    source_name: '梅花创投',
    link: 'https://36kr.com/p/secondary-evidence',
  }), '机构公众号')
})

test('paper classification takes precedence over source channel classification', () => {
  const candidate = {
    source_group: '论文',
    source_key: 'arxiv_36kr_dataset',
  }
  assert.equal(isRadarPaperCandidate(candidate), true)
  assert.equal(deriveRadarChannel(candidate), '论文')
})
