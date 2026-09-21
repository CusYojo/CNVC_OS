import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import express from 'express'

const app = express()
const port = Number(process.env.PROJECT_DISCOVERY_PREVIEW_PORT || 4177)
const dist = resolve(process.cwd(), 'dist')
const indexHtml = await readFile(resolve(dist, 'index.html'), 'utf8')

const shanghaiDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date)
const day = (offset) => {
  const date = new Date(Date.now() - offset * 86_400_000)
  return shanghaiDay(date)
}
const timestamp = (offset, hour) => `${day(offset)}T${String(hour).padStart(2, '0')}:30:00.000Z`

const company = ({ id, name, legalName, region, industry, segment, product, institution, round, amount, offset, signal }) => ({
  id, name, companyName: legalName, region, leadType: 'company',
  poolEnteredAt: timestamp(offset, 1), dataUpdatedAt: timestamp(offset, 6),
  latestUpdates: [{ occurredAt: day(offset), title: signal }],
  investmentProfile: {
    schemaVersion: 'lead-investment-profile-v1',
    subject: { leadId: id, name, legalEntityName: legalName, subjectType: 'company', region, profileReviewStatus: 'clear' },
    industry: { level1: industry, level2: segment, segment },
    products: [{ name: product, productRoute: segment, productionStage: '中试', productionStageStatus: 'realized' }],
    institutions: [{ name: institution, round, role: 'lead', major: true }],
    academicLinks: [],
    financing: { status: '已完成融资', latestRound: round, latestRoundDate: day(offset), latestAmount: amount, completedRoundCount: 1 },
    valuation: { type: 'undisclosed', currency: 'CNY' },
    customers: { highestStage: 'L3', verifiedCount: 1, tierACount: 1, tierBCount: 0, tierCCount: 0, representatives: [] },
    dataStatus: { verifiedDimensions: 5, applicableDimensions: 6, conflictCount: 0, status: 'partial', updatedAt: day(offset) },
  },
})

const research = ({ id, name, institution, region, category, problem, offset, signal }) => ({
  id, name, companyName: institution, region, leadType: 'research',
  poolEnteredAt: timestamp(offset, 2), dataUpdatedAt: timestamp(offset, 7),
  latestUpdates: [{ occurredAt: day(offset), title: signal }],
  radarProfile: { channel: '论文', profile: { lab: institution } },
  researchProfile: {
    schemaVersion: 'lead-research-profile-v1', projectionVersion: 'lead-research-profile-projection-v1',
    subject: { leadId: id, type: 'research', name, providerIds: {} },
    direction: { categories: [category], researchProblem: problem, methods: ['原型验证'] },
    team: { authors: [{ name: '陈博士' }, { name: '林教授' }], affiliations: [institution] },
    progress: { venue: '顶会论文', publishedAt: day(offset), resourceType: '论文' },
    valueAndTransfer: { applicationScenarios: ['智能制造'], partners: [] },
    rights: { patents: [] }, latestDevelopments: [{ title: signal, occurredAt: day(offset) }],
    dataStatus: { status: 'verified', verifiedDimensions: 6, applicableDimensions: 6, conflictCount: 0, source: 'paper_metadata', updatedAt: day(offset) },
  },
})

const leads = [
  company({ id: 'preview-photon-memory', name: '光河芯存', legalName: '光河芯存科技有限公司', region: '上海', industry: '半导体/芯片', segment: '光存储', product: '光电混合存储芯片', institution: '星河创投', round: 'A轮', amount: '1亿元', offset: 0, signal: '完成 A 轮融资，新增存算一体中试线' }),
  company({ id: 'preview-space-material', name: '凌宇复材', legalName: '苏州凌宇新材料有限公司', region: '江苏', industry: '新材料', segment: '航空航天复材', product: '高温陶瓷基复合材料', institution: '先导产业基金', round: 'Pre-A轮', amount: '6000万元', offset: 0, signal: '完成热防护材料客户装机验证' }),
  research({ id: 'preview-tactile', name: '柔性触觉传感项目', institution: '浦江实验室', region: '上海', category: '具身智能/机器人', problem: '解决机器人高密度触觉感知与柔性封装问题', offset: 0, signal: '工程原型数据在公开论文中首次披露' }),
  company({ id: 'preview-robotics', name: '知行动力', legalName: '北京知行动力机器人科技有限公司', region: '北京', industry: '具身智能/机器人', segment: '人形机器人', product: '一体化关节模组', institution: '启明创投', round: '天使轮', amount: '3000万元', offset: 2, signal: '发布新一代轻量化一体化关节' }),
  research({ id: 'preview-photonic', name: '片上光互连工程原型', institution: '长三角集成电路创新中心', region: '江苏', category: '半导体/芯片', problem: '降低算力系统芯片间通信功耗', offset: 4, signal: '片上光互连工程样片完成流片' }),
  company({ id: 'preview-synthetic-bio', name: '合缘生物', legalName: '深圳合缘合成生物有限公司', region: '广东', industry: '生物医药', segment: '合成生物学', product: '酶催化药物中间体平台', institution: '红杉中国', round: 'Pre-A轮', amount: '未披露', offset: 8, signal: '新增两条药物中间体客户验证线' }),
]

app.use(express.json())
app.get('/api/auth/me', (_req, res) => res.json({ user: { id: 'preview-user', email: 'preview@example.invalid', name: '本地预览', role: '投资经理', department: '投资部', status: '启用', permissionCodes: [] } }))
app.get('/api/leads', (req, res) => {
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20))
  const page = Math.max(1, Number(req.query.page) || 1)
  const totalPages = Math.max(1, Math.ceil(leads.length / pageSize))
  res.json({ list: leads.slice((page - 1) * pageSize, page * pageSize), total: leads.length, page, pageSize, totalPages })
})
app.post('/api/leads/sync-radar', (_req, res) => {
  const id = 'preview-radar-new'
  const exists = leads.some((item) => item.id === id)
  if (!exists) leads.unshift(company({ id, name: '澄空智航', legalName: '杭州澄空智能航空有限公司', region: '浙江', industry: '高端制造', segment: '低空经济', product: '自主飞行控制平台', institution: '启航产业基金', round: '天使轮', amount: '2500万元', offset: 0, signal: '公开信源披露首轮融资与样机试飞进展' }))
  res.json({ fetched: 18, created: exists ? 0 : 1, updated: exists ? 1 : 0, unchanged: 17, skipped: 17 })
})
app.post('/api/leads/bp-uploads', (req, res) => {
  const rawName = String(req.body?.name || '人工上传项目')
  const name = rawName.replace(/\.[^.]+$/, '').replace(/(?:商业计划书|融资计划书|项目介绍|路演材料|BP)/gi, '').trim() || '人工上传项目'
  const id = `preview-upload-${Date.now()}`
  leads.unshift(company({ id, name, legalName: `${name}（主体待核对）`, region: '待核对', industry: '人工上传', segment: '待研判', product: '材料解析中', institution: '待核对', round: '未披露', amount: '未披露', offset: 0, signal: '人工上传材料已保存，等待结构化核验' }))
  res.status(202).json({ id, name: rawName, status: 'queued', progress: 5 })
})
app.get('/api/leads/:id/verified-profile', (req, res) => {
  const lead = leads.find((item) => item.id === req.params.id)
  if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '预览线索不存在' })
  res.json({ introductions: { companyIntroduction: null, teamIntroduction: null, projectIntroduction: lead.latestUpdates[0].title }, introductionSources: { companyIntroduction: [], teamIntroduction: [], projectIntroduction: [{ sourceUrl: 'https://example.com/', title: '本地预览来源' }] } })
})
app.get('/api/leads/:id/verified-facts', (req, res) => {
  const lead = leads.find((item) => item.id === req.params.id)
  if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '预览线索不存在' })
  res.json({ facts: [], total: 0, hasMore: false, page: 1, pageSize: 100 })
})
app.get('/api/leads/:id', (req, res) => {
  const lead = leads.find((item) => item.id === req.params.id)
  if (!lead) return res.status(404).json({ code: 'NOT_FOUND', message: '预览线索不存在' })
  res.json({ ...lead, channel: lead.leadType === 'research' ? '论文专利' : '新闻', poolStatus: '公共池', source: '本地预览', sourceUrl: 'https://example.com/', industry: lead.investmentProfile?.industry.level1 || lead.researchProfile?.direction.categories[0] || '', round: lead.investmentProfile?.financing.latestRound || '', website: '', foundedAt: '', registeredCapital: '', legalRepresentative: '', creditCode: '', registrationStatus: '', registeredAddress: '', companyType: '', score: 0, completeness: 0, verificationStatus: '部分核验', lastVerifiedAt: day(0), riskTags: [], status: '成功', summary: lead.latestUpdates[0].title, team: '', product: lead.investmentProfile?.products[0]?.name || '', financing: lead.investmentProfile?.financing.latestAmount || '', highlights: [], risks: [], suggestion: '', shareholders: [], founders: [], fundingRounds: [], companyNews: [], sources: [] })
})
app.get(['/api/projects', '/api/meetings', '/api/todos', '/api/risks', '/api/ai-summaries', '/api/projects/files/all', '/api/templates', '/api/oa/requests', '/api/oa/workflow-logs'], (_req, res) => res.json({ list: [] }))
app.use('/api', (_req, res) => res.status(404).json({ code: 'PREVIEW_ONLY', message: '本地预览未提供此写入接口' }))
app.use(express.static(dist))
app.use((_req, res) => res.type('html').send(indexHtml))

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Project discovery preview: http://127.0.0.1:${port}/projects?view=discover`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
