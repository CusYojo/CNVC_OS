import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { knowledgeChunks } from '../db/schema.js'
import { chunkText, ingestToKnowledge } from '../services/ragService.js'

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[knowledge ingestion atomicity] ${message}`)
}

async function rowsFor(refId: string, sourceId: string) {
  return db.select().from(knowledgeChunks).where(and(
    eq(knowledgeChunks.scope, 'project'),
    eq(knowledgeChunks.refId, refId),
    eq(knowledgeChunks.sourceId, sourceId),
  )).orderBy(knowledgeChunks.chunkIndex)
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/knowledge-ingestion-atomicity')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# 知识投影原子替换验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    '- 新投影写入失败时旧版本完整保留',
    '- 成功替换与重复执行不产生重复块',
    '- 数据库唯一约束拒绝同源同序号重复块',
    '- 隔离来源不受替换影响，验收夹具最终清零',
    '',
    '报告不保存知识正文、项目身份或数据库连接信息。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function main() {
  const refId = randomUUID()
  const sourceId = randomUUID()
  const isolatedSourceId = randomUUID()
  const oldText = `${'旧版技术与客户证据。'.repeat(70)}\n\n${'旧版财务与风险证据。'.repeat(70)}`
  const newText = `${'新版技术路线证据。'.repeat(70)}\n\n${'新版订单与现金流证据。'.repeat(70)}`
  try {
    await ingestToKnowledge({
      scope: 'project', refId, sourceType: 'file', sourceId, sourceName: '原子验收资料.md', text: oldText,
    })
    await ingestToKnowledge({
      scope: 'project', refId, sourceType: 'meeting', sourceId: isolatedSourceId,
      sourceName: '隔离来源', text: '隔离来源必须保持不变',
    })
    const oldRows = await rowsFor(refId, sourceId)
    assertContract(oldRows.length === chunkText(oldText).length && oldRows.length >= 2, 'old projection was not seeded')

    const replacementError = await ingestToKnowledge({
      scope: 'project', refId, sourceType: 'file', sourceId,
      sourceName: '超'.repeat(256), text: newText,
    }).then(() => null, (error: unknown) => error as Error)
    assertContract(replacementError, 'invalid replacement unexpectedly succeeded')
    const afterFailure = await rowsFor(refId, sourceId)
    assertContract(
      JSON.stringify(afterFailure.map((row) => row.content)) === JSON.stringify(oldRows.map((row) => row.content)),
      'failed replacement deleted or changed the previous searchable projection',
    )

    await ingestToKnowledge({
      scope: 'project', refId, sourceType: 'file', sourceId, sourceName: '原子验收资料.md', text: newText,
    })
    const afterSuccess = await rowsFor(refId, sourceId)
    const expectedNewChunks = chunkText(newText)
    assertContract(
      JSON.stringify(afterSuccess.map((row) => row.content)) === JSON.stringify(expectedNewChunks),
      'successful replacement did not contain exactly the new chunks',
    )

    await ingestToKnowledge({
      scope: 'project', refId, sourceType: 'file', sourceId, sourceName: '原子验收资料.md', text: newText,
    })
    const afterReplay = await rowsFor(refId, sourceId)
    assertContract(afterReplay.length === expectedNewChunks.length, 'idempotent replay created duplicate chunks')

    const duplicateError = await db.insert(knowledgeChunks).values({
      scope: 'project', refId, sourceType: 'file', sourceId, sourceName: '重复块',
      chunkIndex: 0, content: '不得插入',
    }).then(() => null, (error: unknown) => error as Error)
    assertContract(duplicateError, 'database unique constraint accepted a duplicate source chunk')
    const isolatedRows = await rowsFor(refId, isolatedSourceId)
    assertContract(isolatedRows.length === 1 && isolatedRows[0]?.content === '隔离来源必须保持不变', 'isolated source was changed')

    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.refId, refId))
    const remaining = await db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
      .where(eq(knowledgeChunks.refId, refId)).limit(1)
    assertContract(remaining.length === 0, 'fixture cleanup left knowledge chunks behind')

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      contentExcluded: true,
      connectionIdentityExcluded: true,
      checks: [
        'failed-replacement-rolls-back-delete',
        'previous-searchable-projection-remains-byte-equal',
        'successful-replacement-is-exact',
        'idempotent-replay-does-not-duplicate',
        'database-unique-source-chunk-constraint',
        'isolated-source-remains-unchanged',
        'fixture-cleanup-confirmed',
        'evidence-excludes-content-and-connection-identity',
      ],
    }
    await persistEvidence(report)
    console.log(JSON.stringify(report))
  } finally {
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.refId, refId)).catch(() => undefined)
    await pool.end()
  }
}

await main()
