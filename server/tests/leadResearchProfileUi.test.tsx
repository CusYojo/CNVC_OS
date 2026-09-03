import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('lead pool switches to the five-column research layout without resource and license', async () => {
  const source = await readFile(new URL('../../src/pages/SourcingPage.tsx', import.meta.url), 'utf8')
  for (const heading of ['项目 / 论文', '方向 / 研究问题', '作者 / 机构', '最新动态', '更新时间']) assert.ok(source.includes(heading), heading)
  assert.doesNotMatch(source, /资源 \/ 许可/)
  assert.doesNotMatch(source, /lead-pool-research-resources/)
  assert.match(source, /lead-pool-table--research/)
  assert.match(source, /researchLayout=\{researchLayout\}/)
  assert.match(source, /function ResearchLeadRow/)
  const researchRow = source.slice(source.indexOf('function ResearchLeadRow'))
  assert.doesNotMatch(researchRow, /原名：|projectNameOriginal/)
  assert.doesNotMatch(researchRow, /financing|valuation|customer/i)
  assert.doesNotMatch(researchRow, /待核验|联网候选|已有资料/)
})

test('research detail uses neutral dashes for undisclosed and unconfirmed fields', async () => {
  const source = await readFile(new URL('../../src/pages/LeadDetailPage.tsx', import.meta.url), 'utf8')
  const researchFacts = source.slice(source.indexOf('const researchFacts'), source.indexOf('const facts:', source.indexOf('const researchFacts')))
  assert.match(researchFacts, /\['所属机构', researchAffiliations\.length \? \[\.\.\.new Set\(researchAffiliations\)\]\.join\('、'\) : '-'\]/)
  assert.match(researchFacts, /\['研究方向', researchDirections\.length \? researchDirections\.join\('、'\) : '-'\]/)
  assert.match(researchFacts, /\['成果形态', researchResourceType\]/)
  assert.doesNotMatch(researchFacts, /\['作者'|\['第一作者'|作者—机构对应/)
  assert.doesNotMatch(researchFacts, />未确认</)
  assert.doesNotMatch(researchFacts, /\|\| '未披露'/)
  assert.match(researchFacts, /articleLicense\?\.label \|\| researchProfile\?\.rights\.articleLicense/)
  assert.match(researchFacts, /intellectualProperty\?\.status === 'confirmed'/)
  assert.doesNotMatch(researchFacts, /\['数据集许可', '-'\]/)
})

test('research detail omits the empty verified-introduction placeholder', async () => {
  const source = await readFile(new URL('../../src/pages/LeadDetailPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /暂无已验证的项目介绍/)
  assert.match(source, /!research && positioningIntroductionText/)
  assert.match(source, /\(!research \|\| researchAbstract\)/)
})

test('research detail exposes evidence-gated sections, restores linked team cards, and omits result resources', async () => {
  const source = await readFile(new URL('../../src/pages/LeadDetailPage.tsx', import.meta.url), 'utf8')
  for (const title of ['论文摘要 / 研究问题', '核心结论与创新', '技术证据', '科研主体信息', '团队成员', '证据与动态']) {
    assert.ok(source.includes(title), title)
  }
  assert.match(source, /researchTechnicalEvidence\(verifiedFacts\)/)
  assert.match(source, /researchInsightCards\.length > 0/)
  assert.doesNotMatch(source, /title="成果资源"/)
  assert.doesNotMatch(source, /researchResources/)
  assert.match(source, /function TeamMemberCard/)
  assert.match(source, /点击成员卡片可打开作者资料页/)
  assert.match(source, /href=\{profileUrl\}/)
  assert.match(source, /verificationStatus === 'verified'/)
})

test('lead detail API returns the public research projection payload', async () => {
  const source = await readFile(new URL('../src/services/aiSummaryService.ts', import.meta.url), 'utf8')
  const detail = source.slice(source.indexOf('export async function getLeadById'), source.indexOf('export async function deleteLeadFromPublicPool'))
  assert.match(detail, /leadResearchProfileProjections\.profilePayload/)
  assert.match(detail, /publicResearchProfilePayload\(objectValue\(researchProjection\.profilePayload\)\)/)
})
