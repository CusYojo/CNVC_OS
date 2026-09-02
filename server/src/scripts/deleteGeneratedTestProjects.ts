import { and, asc, eq, like } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { projects, users } from '../db/schema.js'
import { deleteProject } from '../services/projectService.js'

const APPLY_TOKEN = 'DELETE_GENERATED_FULL_FLOW_TEST_PROJECTS'
const apply = process.argv.includes('--apply')
const confirmed = process.argv.includes(`--confirm=${APPLY_TOKEN}`)
const exactGeneratedName = /^全流程测试-\d{10,}$/u

async function main() {
  const rows = await db.select({
    id: projects.id,
    name: projects.name,
    companyName: projects.companyName,
    classification: projects.classification,
    lifecycle: projects.lifecycle,
    version: projects.version,
  }).from(projects).where(and(
    eq(projects.classification, 'normal'),
    eq(projects.lifecycle, 'active'),
    eq(projects.companyName, '测试公司'),
    like(projects.name, '全流程测试-%'),
  )).orderBy(asc(projects.createdAt), asc(projects.id)).limit(501)

  if (rows.length > 500) throw new Error('命中超过 500 个项目，已停止；请先缩小清理范围')
  const unsafe = rows.filter((row) => !exactGeneratedName.test(row.name))
  if (unsafe.length) throw new Error(`存在不符合精确命名规则的项目，已停止：${unsafe.map((row) => row.name).join('、')}`)

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'preview',
    criteria: '普通项目 + 活动中 + 测试公司 + 全流程测试-时间戳',
    count: rows.length,
    names: rows.map((row) => row.name),
  }, null, 2))

  if (!apply) return
  if (!confirmed) throw new Error(`应用清理必须同时提供 --confirm=${APPLY_TOKEN}`)
  const [administrator] = await db.select({ id: users.id, name: users.name }).from(users).where(and(
    eq(users.role, '系统管理员'),
    eq(users.status, '启用'),
  )).orderBy(asc(users.id)).limit(1)
  if (!administrator) throw new Error('没有可用的系统管理员账号，未修改任何项目')

  let deleted = 0
  for (const row of rows) {
    const result = await deleteProject(row.id, administrator.id, {
      confirmation: row.name,
      expectedVersion: row.version,
    })
    if (result?.lifecycle === 'deleted') deleted += 1
  }
  const remaining = await db.select({ id: projects.id }).from(projects).where(and(
    eq(projects.classification, 'normal'),
    eq(projects.lifecycle, 'active'),
    eq(projects.companyName, '测试公司'),
    like(projects.name, '全流程测试-%'),
  )).limit(1)
  if (remaining.length) throw new Error('仍有符合条件的测试项目未删除，请重新运行预览')
  console.log(JSON.stringify({ ok: true, deleted, auditedAs: administrator.name }))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => { await pool.end() })
