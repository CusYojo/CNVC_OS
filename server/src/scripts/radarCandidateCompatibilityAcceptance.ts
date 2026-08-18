import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'
import { listRadarCandidates } from '../services/radarSyncService.js'
import { assertIsolatedMysqlAcceptanceDatabase } from './mysqlAcceptanceSafety.js'

assertIsolatedMysqlAcceptanceDatabase('radarCandidateCompatibilityAcceptance')

type Candidate = Record<string, unknown>
const table = quoteMysqlIdentifier(mysqlTableName('radar_candidates'))
const marker = `compat-${randomUUID()}`
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const candidates: Candidate[] = [
  { source: 'openalex', source_key: `${marker}-oa`, source_group: '论文', title: `${marker} Alpha`, summary: 'machine learning platform', authors: ['Ada'], attention_score: 92, worth_attention: true, published_at: '2026-08-16T08:00:00.000Z', collected_at: '2026-08-17T08:00:00.000Z' },
  { source: 'arxiv', source_key: `${marker}-ax`, source_group: '论文', title: `${marker} Beta`, summary: 'robotics research', authors: ['Lin'], attention_score: 72, worth_attention: true, published_at: '2026-08-15T08:00:00.000Z', collected_at: '2026-08-17T07:00:00.000Z' },
  { source: 'wechat_api', source_key: `${marker}-wx`, source_group: '机构公众号', title: `${marker} Gamma`, article_text: '融资和商业化进展', attention_score: 61, worth_attention: true, published_at: '2026-08-14T08:00:00.000Z', collected_at: '2026-08-17T06:00:00.000Z' },
  { source: 'investment', source_key: `${marker}-iv`, source_group: '创投新闻', title: `${marker} Delta`, summary: 'ordinary update', attention_score: 20, worth_attention: false, published_at: '2026-08-13T08:00:00.000Z', collected_at: '2026-08-17T05:00:00.000Z' },
]

function legacyReference(options: { q?: string; source?: string; sourceKey?: string; group?: string; attentionOnly?: boolean; minScore?: number }) {
  const query = (options.q || '').toLocaleLowerCase('zh-CN').trim()
  return candidates.filter((item) => {
    if (options.source && item.source !== options.source) return false
    if (options.sourceKey && item.source_key !== options.sourceKey) return false
    if (options.group && item.source_group !== options.group) return false
    if (options.attentionOnly && !item.worth_attention) return false
    if (Number(item.attention_score || 0) < Number(options.minScore || 0)) return false
    return !query || JSON.stringify(item).toLocaleLowerCase('zh-CN').includes(query)
  })
}

async function insertFixtures() {
  for (const [index, payload] of candidates.entries()) {
    const sourceKeyHash = digest(`${marker}:${index}`)
    const cursorDigest = digest(`${marker}:cursor:${index}`)
    await pool.query(
      `INSERT INTO ${table}
       (source_key_hash,source_key,content_hash,source,source_group,attention_score,worth_attention,collected_at,published_at,cursor_timestamp,cursor_digest,payload,updated_at)
       VALUES (?,?,?,?,?,?,?,STR_TO_DATE(?,'%Y-%m-%dT%H:%i:%s.000Z'),STR_TO_DATE(?,'%Y-%m-%dT%H:%i:%s.000Z'),?,?,?,NOW(3))`,
      [sourceKeyHash, `${marker}:${index}`, digest(JSON.stringify(payload)), payload.source, payload.source_group,
        payload.attention_score, payload.worth_attention, payload.collected_at, payload.published_at,
        Date.parse(String(payload.collected_at)), cursorDigest, JSON.stringify(payload)],
    )
  }
}

async function query(options: Parameters<typeof listRadarCandidates>[0]) {
  const result = await listRadarCandidates(options)
  return (result.items || []).filter((item) => String(item.title || '').startsWith(marker))
}

async function main() {
  await insertFixtures()
  try {
    const cases = [
      { q: marker, limit: 20, sort: 'score' as const },
      { q: marker, source: 'openalex', limit: 20, sort: 'score' as const },
      { q: marker, sourceKey: `${marker}-wx`, limit: 20, sort: 'score' as const },
      { q: marker, group: '论文', limit: 20, sort: 'score' as const },
      { q: marker, attentionOnly: true, limit: 20, sort: 'score' as const },
      { q: marker, minScore: 70, limit: 20, sort: 'score' as const },
      { q: '融资和商业化', limit: 20, sort: 'score' as const },
    ]
    for (const options of cases) {
      const actual = await query(options)
      const expected = legacyReference(options)
      assert.deepEqual(new Set(actual.map((item) => item.title)), new Set(expected.map((item) => item.title)), `filter mismatch: ${JSON.stringify(options)}`)
    }
    const score = await query({ q: marker, limit: 20, sort: 'score' })
    assert.deepEqual(score.map((item) => Number(item.attention_score)), [92, 72, 61, 20])

    const first = await listRadarCandidates({ q: marker, limit: 2, sort: 'collected' })
    assert.equal(first.items?.length, 2)
    assert.equal(first.has_more, true)
    assert.ok(first.next_cursor)
    const second = await listRadarCandidates({ q: marker, limit: 2, sort: 'collected', cursor: first.next_cursor })
    assert.deepEqual(
      [...(first.items || []), ...(second.items || [])].map((item) => item.title),
      candidates.map((item) => item.title),
    )
    await assert.rejects(
      () => listRadarCandidates({ limit: 2, sort: 'collected', cursor: 'invalid' }),
      (error: unknown) => (error as { status?: number; code?: string }).status === 400 && (error as { code?: string }).code === 'RADAR_CURSOR_INVALID',
    )
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'legacy-q-source-source-key-group-attention-score-filters-match',
        'score-order-matches',
        'collected-cursor-is-stable-and-complete',
        'invalid-cursor-is-a-400-contract-error',
      ],
    }))
  } finally {
    await pool.query(`DELETE FROM ${table} WHERE source_key LIKE ?`, [`${marker}:%`])
  }
}

await main().finally(async () => pool.end())
