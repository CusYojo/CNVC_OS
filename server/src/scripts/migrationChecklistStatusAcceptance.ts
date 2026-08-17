import { readFile } from 'node:fs/promises'
import path from 'node:path'

type ChecklistRow = {
  id: string
  priority: 'P0' | 'P1'
  done: boolean
  result: string
  evidence: string
}

type ExceptionRow = {
  id: string
  owner: string
  deadline: string
  approver: string
}

const root = process.cwd()
const checklistPath = path.resolve(root, 'docs/迁移计划/JW底座与MySQL迁移验收清单.md')
const pendingPath = path.resolve(root, 'docs/迁移计划/未完成迁移清单-20260811.md')

function parseChecklist(markdown: string): ChecklistRow[] {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\| \[([ x])\] \| ([A-Z]+-[0-9]+) \| (P[01]) \|/)
    if (!match) return []
    const cells = line.split('|').map((cell) => cell.trim())
    return [{
      done: match[1] === 'x',
      id: match[2],
      priority: match[3] as 'P0' | 'P1',
      result: cells[5] ?? '',
      evidence: cells[6] ?? '',
    }]
  })
}

function parseExceptions(markdown: string): ExceptionRow[] {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\| (EXC-[A-Z0-9-]+) \|/)
    if (!match) return []
    const cells = line.split('|').map((cell) => cell.trim())
    return [{
      id: match[1],
      owner: cells[6] ?? '',
      deadline: cells[7] ?? '',
      approver: cells[8] ?? '',
    }]
  })
}

function exceptionIsFormallyApproved(row: ExceptionRow) {
  return row.owner.length > 0 && row.owner !== '待指定'
    && /^\d{4}-\d{2}-\d{2}(?:$|\s)/.test(row.deadline)
    && row.approver.length > 0 && !/待补|待指定/.test(row.approver)
}

function section(markdown: string, start: string, end: string) {
  const startIndex = markdown.indexOf(start)
  const endIndex = startIndex < 0 ? -1 : markdown.indexOf(end, startIndex + start.length)
  assert(startIndex >= 0 && endIndex > startIndex, `required checklist section is missing: ${start}`)
  return markdown.slice(startIndex + start.length, endIndex)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[migration checklist status] ${message}`)
}

async function main() {
  const [checklist, pendingDocument] = await Promise.all([
    readFile(checklistPath, 'utf8'),
    readFile(pendingPath, 'utf8'),
  ])
  const rows = parseChecklist(checklist)
  const pending = rows.filter((row) => !row.done)
  const deferred = rows.filter((row) => row.done && /^不适用（本批次延期/.test(row.result))
  const productionBlockingDeferredP0 = deferred.filter((row) => row.priority === 'P0'
    && (/未安全验收/.test(row.result) || /不解除生产发布阻断|生产启用前仍必须/.test(row.evidence)))
  const exceptions = parseExceptions(checklist)
  const unapprovedExceptions = exceptions.filter((row) => !exceptionIsFormallyApproved(row))
  const smokeSection = section(checklist, '## 19. 生产冒烟清单', '## 20. 缺陷与例外记录')
  const finalConfirmationSection = section(checklist, '### 21.1 阻断项确认', '### 21.2 签字')
  const pendingProductionSmoke = smokeSection.match(/^- \[ \]/gm)?.length ?? 0
  const pendingFinalConfirmations = finalConfirmationSection.match(/^- \[ \]/gm)?.length ?? 0
  const productionBlockingDeferredSmoke = smokeSection.split(/\r?\n/).filter((line) =>
    /^- \[x\]/.test(line) && /本批次延期/.test(line) && /本勾选不代表/.test(line)).length
  const productionBlockingDeferrals = productionBlockingDeferredP0.length + productionBlockingDeferredSmoke
  const completed = rows.length - pending.length
  const p0 = pending.filter((row) => row.priority === 'P0').length
  const p1 = pending.filter((row) => row.priority === 'P1').length
  const blank = pending.filter((row) => row.result.length === 0).length
  const described = pending.length - blank
  const uncheckedBullets = checklist.match(/^- \[ \]/gm)?.length ?? 0
  assert(uncheckedBullets === pendingProductionSmoke + pendingFinalConfirmations,
    'unchecked non-core bullets must belong only to production smoke or final confirmation sections')
  const totalUnchecked = pending.length + uncheckedBullets
  const completionRate = ((completed / rows.length) * 100).toFixed(1)
  const expectedSummary = [
    `核心验收项：共 ${rows.length} 项，已完成 ${completed} 项，未完成 ${pending.length} 项，完成率 ${completionRate}%。`,
    `未完成核心项优先级：P0 ${p0} 项，P1 ${p1} 项。`,
    blank === 0
      ? `未完成核心项中，0 项结果栏为空；${described} 项均已标记当前证据、明确阻断或下一验收环境。`
      : `未完成核心项中，${blank} 项结果栏为空；其余 ${described} 项已标记为部分完成、阻塞、本地通过但生产待验等状态。`,
    `文档全部未勾选项合计：${totalUnchecked} 项。`,
    `核心未完成验收项（${pending.length} 项）`,
    `累计将 ${deferred.length} 项核心验收设为“不适用（本批次延期）”并登记 ${exceptions.length} 组例外；其中 ${productionBlockingDeferredP0.length} 项 P0 安全延期不代表验收通过，不解除生产发布阻断`,
    `生产冒烟：未完成 ${pendingProductionSmoke} 项。`,
    `最终验收确认：未完成 ${pendingFinalConfirmations} 项；`,
  ]
  for (const text of expectedSummary) {
    assert(pendingDocument.includes(text), `derived pending document is stale: ${text}`)
  }

  const derivedIds = new Set(
    [...pendingDocument.matchAll(/^\| ([A-Z]+-[0-9]+) \| P[01] \|/gm)].map((match) => match[1]),
  )
  const derivedStatuses = new Map(
    [...pendingDocument.matchAll(/^\| ([A-Z]+-[0-9]+) \| P[01] \| ([^|]+) \|/gm)]
      .map((match) => [match[1], match[2].trim()]),
  )
  const pendingIds = new Set(pending.map((row) => row.id))
  const missingIds = [...pendingIds].filter((id) => !derivedIds.has(id))
  const completedIdsStillListed = [...derivedIds].filter((id) => !pendingIds.has(id))
  assert(missingIds.length === 0, `derived pending document omits ${missingIds.join(',')}`)
  assert(completedIdsStillListed.length === 0, `derived pending document still lists completed ${completedIdsStillListed.join(',')}`)
  const mismatchedStatuses = pending.filter((row) => derivedStatuses.get(row.id) !== row.result)
    .map((row) => row.id)
  assert(mismatchedStatuses.length === 0, `derived pending document has stale statuses for ${mismatchedStatuses.join(',')}`)
  assert(blank === 0, 'every pending core item must state current evidence or an explicit blocker')

  console.log(JSON.stringify({
    ok: true,
    coreItems: rows.length,
    completed,
    pending: pending.length,
    pendingP0: p0,
    pendingP1: p1,
    pendingWithoutResult: blank,
    totalUnchecked,
    derivedPendingIds: derivedIds.size,
    deferredCoreItems: deferred.length,
    productionBlockingDeferredP0: productionBlockingDeferredP0.length,
    productionBlockingDeferredSmoke,
    productionBlockingDeferrals,
    exceptionRows: exceptions.length,
    unapprovedExceptions: unapprovedExceptions.length,
    pendingProductionSmoke,
    pendingFinalConfirmations,
    databaseWrites: 0,
  }))
}

await main()
