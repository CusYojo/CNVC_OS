import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('reimbursement UI keeps only core fields and category-specific PDF materials', () => {
  const fields = read('src/components/FdeOfficeSmartFields.tsx')
  const panel = read('src/components/FdeOfficePanel.tsx')
  for (const label of ['报销原因', '报销事项说明', '关联出差申请（可选）', '发票 PDF', '行程单', '住宿单']) assert.match(fields, new RegExp(label.replace(/[（）]/g, '.')))
  assert.doesNotMatch(fields, /电子发票 PDF 链接|保存为我的模板|消费水单/)
  assert.match(panel, /\.pdf,application\/pdf/)
  assert.match(panel, /报销证明材料仅支持 PDF/)
  assert.match(panel, /其他需要上传材料（可选）/)
  assert.match(panel, /补充说明（可选）/)
})

test('travel and leave forms remove duplicate and unused inputs', () => {
  const fields = read('src/components/FdeOfficeSmartFields.tsx')
  const panel = read('src/components/FdeOfficePanel.tsx')
  assert.doesNotMatch(fields, /会议通知链接|工作交接|交接人/)
  assert.match(fields, /申请原因 \*/)
  assert.match(panel, /关联项目 \*/)
  assert.match(panel, /申请附件（可选）/)
  assert.doesNotMatch(panel, /<span className="label">申请类型<\/span>/)
})

test('new reimbursement policy template follows supervisor, leadership, finance and cashier order', () => {
  const policy = read('src/components/FdeOfficePolicyPanel.tsx')
  const migration = read('server/drizzle/0103_add_cashier_role.sql')
  const reimbursementTemplate = policy.slice(policy.indexOf("if (kind !== '报销')"))
  const order = ['直属上级审批', '领导审批', '财务审批', '出纳打款'].map(label => reimbursementTemplate.indexOf(label))
  assert.ok(order.every(index => index >= 0))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  assert.match(policy, /\['黄昕', '陈斌'\]/)
  assert.match(migration, /'FDE_CASHIER','出纳'/)
})

test('travel uses the project leader after the supervisor and leave uses only the supervisor', () => {
  const policy = read('src/components/FdeOfficePolicyPanel.tsx')
  assert.match(policy, /kind === '出差'[\s\S]*上级领导审批[\s\S]*项目领导审批[\s\S]*projectDuty: 'concerned_leader'/)
  assert.match(policy, /kind === '请假'[\s\S]*nodes: \[\{ \.\.\.blankNode\('supervisor'\), name: '上级领导审批'/)
})
