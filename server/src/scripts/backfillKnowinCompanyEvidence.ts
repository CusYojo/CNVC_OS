import { commitLeadPublicIntel, type PublicIntelResult } from '../services/leadPublicIntelService.js'
import { pool } from '../db/client.js'

const apply = process.argv.includes('--apply')
const leadId = process.argv.find((value) => value.startsWith('--lead-id='))?.slice(10)
  || 'daf2a843-797c-44da-a13b-3eec6a4dd5b7'
const officialUrl = 'https://www.knowinai.com/about.html'
const registryUrl = 'https://vc.pedaily.cn/company/819613.html'
const companyTypeUrl = 'https://www.innohere.com/ir/160268/holder.html'

const intel: PublicIntelResult = {
  positioning: '诺因智能面向消费级家庭场景研发具身智能系统和机器人产品，覆盖生成式具身大模型、软硬件协同及家庭服务机器人。',
  canonicalCompanyName: '深圳诺因智能有限公司',
  companyIntroduction: '诺因智能面向消费级家庭场景研发具身智能系统和机器人产品，覆盖生成式具身大模型、软硬件协同及家庭服务机器人。',
  claimedFoundedAt: '2025-07',
  claimedFoundedAtEvidence: {
    quote: '诺因成立于2025年7月',
    sourceUrl: officialUrl,
  },
  website: 'https://www.knowinai.com/',
  registeredCapital: '133.19万元人民币',
  legalRepresentative: '李银川',
  foundedAt: '2025-06-23',
  creditCode: '91440300MAEMB59A5L',
  registrationStatus: '存续',
  companyType: '有限责任公司（外商投资、非独资）',
  region: '广东',
  registeredAddress: '深圳市南山区粤海街道高新区社区科技南路18号深圳湾科技生态园12栋A2406',
  fundingRounds: [],
  shareholders: [],
  competitors: [],
  companyNews: [],
  sources: [
    { title: '关于诺因智能 | 深圳诺因智能有限公司 | Knowin AI', url: officialUrl, reliability: '公司自有域名官网' },
    { title: '诺因智能公司资料与工商信息', url: registryUrl, reliability: '投资行业数据库公开资料，工商字段待持续复核' },
    { title: '诺因智能公司详情', url: companyTypeUrl, reliability: '投资行业数据库公开资料，工商字段待持续复核' },
  ],
  searchEvidence: [
    {
      query: '诺因智能公司官网与工商主体',
      title: '关于诺因智能 | 深圳诺因智能有限公司 | Knowin AI',
      snippet: '诺因成立于2025年7月，聚焦消费级家庭场景；公司地址为深圳市南山区粤海街道高新区社区科技南路18号深圳湾科技生态园12栋A2406。',
      url: officialUrl,
      publisher: 'Knowin AI',
      reliability: '公司自有域名官网',
    },
    {
      query: '深圳诺因智能有限公司工商信息',
      title: '诺因智能公司资料与工商信息',
      snippet: '工商信息显示，深圳诺因智能有限公司法定代表人为李银川，成立于2025-06-23，注册资本133.19万人民币，经营状态为存续；统一社会信用代码为91440300MAEMB59A5L。',
      url: registryUrl,
      publisher: '投资界',
      reliability: '公开资料整理，工商字段待持续复核',
    },
  ],
  registryEvidence: [
    { field: 'companyName', value: '深圳诺因智能有限公司', quote: '深圳诺因智能有限公司', sourceUrl: officialUrl },
    { field: 'companyIntroduction', value: '诺因智能面向消费级家庭场景研发具身智能系统和机器人产品，覆盖生成式具身大模型、软硬件协同及家庭服务机器人。', quote: '诺因面向消费级家庭场景，打造具备物理实体、能够在真实环境中形成“感知—生成—执行—演进”闭环并持续交互的具身智能系统。', sourceUrl: officialUrl },
    { field: 'website', value: 'https://www.knowinai.com/', quote: '关于诺因智能 | 深圳诺因智能有限公司 | Knowin AI', sourceUrl: officialUrl },
    { field: 'foundedAt', value: '2025-06-23', quote: '工商信息显示，深圳诺因智能有限公司成立于2025-06-23', sourceUrl: registryUrl },
    { field: 'creditCode', value: '91440300MAEMB59A5L', quote: '统一社会信用代码：91440300MAEMB59A5L', sourceUrl: registryUrl },
    { field: 'companyType', value: '有限责任公司（外商投资、非独资）', quote: '公司类型：有限责任公司（外商投资、非独资）', sourceUrl: companyTypeUrl },
  ],
  registryEnrichment: {
    method: 'codex-evidence-bound-web-enrichment-v1',
    model: 'host-reviewed-public-evidence',
    requestedFields: ['companyName', 'companyIntroduction', 'website', 'foundedAt', 'creditCode', 'companyType'],
    completedFields: ['companyName', 'companyIntroduction', 'website', 'foundedAt', 'creditCode', 'companyType'],
    status: 'completed',
  },
  confidence: 0.8,
  fetchedAt: '2026-08-26T00:00:00.000Z',
}

if (!apply) {
  console.log(JSON.stringify({ ok: true, mode: 'preview', leadId, company: '诺因智能', intel }, null, 2))
} else {
  try {
    const result = await commitLeadPublicIntel({ company: '诺因智能', intel, targetLeadId: leadId })
    console.log(JSON.stringify({
      ok: true,
      mode: 'apply',
      leadId,
      status: result.status,
      replayed: result.replayed,
      eventId: result.eventId,
    }, null, 2))
  } finally {
    await pool.end()
  }
}
