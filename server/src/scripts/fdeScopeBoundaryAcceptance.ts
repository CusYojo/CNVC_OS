import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFile(resolve(root, path), 'utf8')
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const [assistantPage, sourcingPage, projectCenter, app, leadDetail, summaryService, migration] = await Promise.all([
  read('src/pages/AIAssistantPage.tsx'),
  read('src/pages/SourcingPage.tsx'),
  read('src/pages/ProjectCenterPage.tsx'),
  read('src/App.tsx'),
  read('src/pages/LeadDetailPage.tsx'),
  read('server/src/services/aiSummaryService.ts'),
  read('server/drizzle/0050_add_fde_project_operating_model.sql'),
])

assert.equal(
  // Only the reviewed FDE shell CSS hook is excluded; AI business/interaction
  // code must still match the original page byte-for-byte.
  sha256(assistantPage.replace('className="fde-ai-page -m-6', 'className="-m-6')),
  '0d50ab934be90e33a1b6a3ff69456dcc491a85c0740f766af43685c6eb7131c2',
  'AI 助手页面源码已变化；本次迁移要求该板块保持原业务与交互不变',
)
assert.equal(
  sha256(sourcingPage),
  '9e0b83979b423f31fc1524fbc3830f981d6a81862eb6e3fcff5cb23e76287e0b',
  '线索池页面源码已变化；本次只允许移动入口，不允许改模板与业务逻辑',
)

assert.match(projectCenter, /import \{ SourcingPage \} from '\.\/SourcingPage'/, '项目中心必须直接复用原线索池页面')
assert.match(projectCenter, /id: 'leads', label: '线索池'/, '项目中心首个视图必须为线索池')
assert.match(projectCenter, /id: 'pool', label: '项目池'/, '项目中心必须包含项目池')
assert.match(projectCenter, /view === 'leads' \? <SourcingPage \/>/, '线索池不得复制或重写为新模板')
assert.match(app, /path="\/sourcing" element=\{<Navigate to="\/projects\?view=leads" replace \/>\}/, '旧线索池列表路由必须兼容跳转')
assert.match(app, /path="\/sourcing\/:id" element=\{<LeadDetailPage \/>\}/, '旧线索详情深链必须继续可用')
assert.match(leadDetail, /convertLead\(lead\.id\)/, '仅线索详情保留“转为我的专属项目”动作')
assert.equal((leadDetail.match(/convertLead\(/g) ?? []).length, 1, '线索详情只能有一个转换调用点')
assert.match(summaryService, /classification: 'normal'/, '线索转换后必须直接进入普通项目')
assert.match(summaryService, /lifecycle: 'active'/, '线索转换后必须为活动生命周期')
assert.match(summaryService, /stage: '立项'/, '线索转换后必须进入立项待审批阶段')
assert.match(summaryService, /projectClassificationHistory/, '线索转换必须在同一事务写入分类历史')
assert.match(migration, /CREATE TABLE `sbl_project_classification_history`/, '迁移必须创建项目分类历史表')
assert.match(migration, /CHECK \(`classification` IN \('pool','normal','key'\)\)/, '项目分类必须有数据库级合法值约束')
assert.match(migration, /FOREIGN KEY \(`project_id`\) REFERENCES `sbl_projects` \(`id`\)/, '项目分类历史必须有项目外键')

console.log('FDE 不可变范围与线索到普通项目边界验收通过（16 项）')
