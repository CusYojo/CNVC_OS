import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  buildInstitutionTrackingDirectory,
  decodeInstitutionTrackingKey,
  encodeInstitutionTrackingKey,
  findInstitutionTrackingProfile,
} from '../src/services/institutionTrackingPresentation.js'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

const dictionary = [{
  id: 'institution-1',
  canonicalName: '星河创投',
  aliases: ['星河资本'],
  institutionType: 'financial_vc',
  tier: 'T1',
  major: true,
  status: 'active',
}]

const leads = [{
  id: 'lead-newer',
  name: '光河芯存',
  companyName: '光河芯存科技有限公司',
  region: '上海',
  poolEnteredAt: '2026-09-22T02:00:00.000Z',
  latestUpdates: [{ occurredAt: '2026-09-22', title: '完成 A 轮融资' }],
  radarProfile: {
    channel: 'VC_Hunter',
    publishedAt: '2026-09-22',
    profile: {
      discoveryCardEdits: {
        name: '光河芯存（已编辑）',
        primaryDate: '2026-09-22',
        summary: '光电混合存储芯片项目',
        region: '上海',
        sourceChannel: '公开融资信息',
        briefFacts: {
          '行业分类': '半导体/芯片',
          '融资金额': '1.2 亿元',
          '融资轮次': 'A轮',
          '投资方': '星河资本、远航基金',
        },
        profileFacts: {},
      },
    },
  },
  investmentProfile: {
    institutions: [{ name: '已被编辑覆盖的旧机构' }],
    financing: { latestRound: 'Pre-A轮', latestRoundDate: '2026-09-20', latestAmount: '1亿元' },
    industry: { level1: '半导体/芯片' },
  },
}, {
  id: 'lead-older',
  name: '智行动力',
  region: '苏州',
  poolEnteredAt: '2026-09-18T02:00:00.000Z',
  radarProfile: { channel: 'VC_Hunter', publishedAt: '2026-09-18', profile: {} },
  availableData: {
    institutions: [{ name: '星河创投', role: 'lead' }],
    financing: { latestRound: '天使轮', latestRoundDate: '2026-09-18', latestAmount: '3000万元' },
    industryTags: ['具身智能/机器人'],
  },
}]

test('institution tracking keys are URL safe and reversible', () => {
  const key = encodeInstitutionTrackingKey('上海半导体装备材料产业投资基金')
  assert.match(key, /^[a-f0-9]+$/)
  assert.equal(decodeInstitutionTrackingKey(key), '上海半导体装备材料产业投资基金')
  assert.equal(decodeInstitutionTrackingKey(encodeInstitutionTrackingKey('中'.repeat(255))), '中'.repeat(255))
  assert.equal(decodeInstitutionTrackingKey('../bad-key'), null)
})

test('new discovery projects bind to canonical institutions and aliases automatically', () => {
  const directory = buildInstitutionTrackingDirectory(leads, dictionary)
  assert.deepEqual(directory.map((institution) => [institution.name, institution.projectCount]), [
    ['星河创投', 2],
    ['远航基金', 1],
  ])
  assert.equal(directory.some((institution) => institution.name === '已被编辑覆盖的旧机构'), false)

  const profile = findInstitutionTrackingProfile(encodeInstitutionTrackingKey('星河创投'), leads, dictionary)
  assert.ok(profile)
  assert.equal(profile.name, '星河创投')
  assert.deepEqual(profile.aliases, ['星河资本'])
  assert.deepEqual(profile.recentProjects.map((project) => project.leadId), ['lead-newer', 'lead-older'])
  assert.deepEqual(profile.recentProjects[0], {
    leadId: 'lead-newer',
    name: '光河芯存（已编辑）',
    companyName: '光河芯存科技有限公司',
    announcedAt: '2026-09-22',
    round: 'A轮',
    amount: '1.2 亿元',
    industry: '半导体/芯片',
    region: '上海',
    summary: '光电混合存储芯片项目',
    sourceChannel: '公开融资信息',
  })
})

test('malformed institution facts do not break tracking or create false matches', () => {
  const malformedLead = {
    id: 'malformed-lead',
    name: '待核验项目',
    radarProfile: { profile: { discoveryCardEdits: { name: '待核验项目', briefFacts: { '投资方': 42 } } } },
    investmentProfile: { institutions: [{ name: 42 }, null] },
    availableData: { institutions: [{ name: '星河资本' }, { name: null }] },
  }
  const directory = buildInstitutionTrackingDirectory([malformedLead] as never, dictionary)
  assert.equal(directory.find((institution) => institution.name === '星河创投')?.projectCount, 1)
})

test('CNVC OS exposes institution tracking routes and discovery-card deep links', async () => {
  const [app, navigation, discovery, discoveryCss, routes, service] = await Promise.all([
    read('src/App.tsx'),
    read('src/layout/AppLayout.tsx'),
    read('src/pages/ProjectDiscoveryPage.tsx'),
    read('src/pages/ProjectDiscoveryPage.css'),
    read('server/src/routes/index.ts'),
    read('server/src/services/aiSummaryService.ts'),
  ])

  assert.match(app, /path="\/institutions"/)
  assert.match(app, /path="\/institutions\/:institutionKey"/)
  assert.match(navigation, /to: '\/institutions', label: '机构追踪'/)
  assert.match(routes, /apiRouter\.use\('\/institutions', institutionTrackingRouter\)/)
  assert.match(discovery, /encodeInstitutionTrackingKey/)
  assert.match(discovery, /className="project-discovery-institution-link"/)
  assert.match(discovery, /保存后将自动关联至机构追踪/)
  assert.match(discoveryCss, /\.project-discovery-institution-link:focus-visible/)
  assert.match(service, /'discoveryCardEdits', \$\{jsonValue\(leads\.radarProfile, '\$\.profile\.discoveryCardEdits'\)\}/)
})

test('discovery card shows institution project links only inside expanded details', async () => {
  const discovery = await read('src/pages/ProjectDiscoveryPage.tsx')
  const card = discovery.split('function DiscoveryCard(')[1]?.split('function CardDetailsToggle(')[0]
  const brief = discovery.split('function DiscoveryInvestmentBrief(')[1]?.split('type ProjectDiscoveryProfileFact')[0]
  assert.ok(card && brief, '应保留发现卡片与投资速览组件')

  const expandedDetails = card.split('{expanded && <>')[1]?.split('</>}')[0]
  assert.ok(expandedDetails, '应保留仅在展开时渲染的详情区域')
  assert.doesNotMatch(brief, /project-discovery-institution-links|project-discovery-institution-hint/, '缩略卡片不应显示机构项目链接或提示')
  assert.match(expandedDetails, /className="project-discovery-institution-links"/, '机构项目链接应放在展开区域')
  assert.match(expandedDetails, /to=\{`\/institutions\/\$\{encodeInstitutionTrackingKey\(investor\)\}`\}/, '展开后应仍可跳转至对应机构')
})
