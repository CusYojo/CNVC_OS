import { createHash, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2'
import { pool } from '../db/client.js'
import { mysqlTableName, quoteMysqlIdentifier } from '../db/config.js'

const leadId = 'd9c76f8b-baad-4b0f-901f-b606549a8263'
const pitchhubUrl = 'https://pitchhub.36kr.com/project/1713109508991236'
const articleUrl = 'https://36kr.com/p/1725216882689'
const cnnicUrl = 'https://webwhois.cnnic.cn/WhoisServlet?queryType=Domain&domain=jwdingzhi.cn'
const leadsTable = quoteMysqlIdentifier(mysqlTableName('leads'))
const auditLogsTable = quoteMysqlIdentifier(mysqlTableName('audit_logs'))

function record(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, any> } catch { return {} }
  }
  return {}
}

function array(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object') as Array<Record<string, any>>
  if (typeof value === 'string') {
    try { return array(JSON.parse(value)) } catch { return [] }
  }
  return []
}

function stableHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function mergeBy<T extends Record<string, any>>(existing: T[], incoming: T[], key: (item: T) => string) {
  const seen = new Set<string>()
  return [...incoming, ...existing].filter((item) => {
    const identity = key(item)
    if (!identity || seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

const connection = await pool.getConnection()
try {
  await connection.beginTransaction()
  const [rows] = await connection.query<Array<RowDataPacket & {
    id: string; name: string; company_name: string | null; scoring: unknown; sources: unknown; funding_rounds: unknown;
  }>>(
    `SELECT id,name,company_name,scoring,sources,funding_rounds FROM ${leadsTable} WHERE id=? FOR UPDATE`,
    [leadId],
  )
  const lead = rows[0]
  if (!lead || lead.name !== '尽无服饰' || lead.company_name !== '苏州尽无服饰定制有限公司') {
    throw new Error('target lead identity mismatch')
  }

  const beforeScoring = record(lead.scoring)
  const registry: Record<string, any> = {
    ...record(beforeScoring.registry),
    companyName: '苏州尽无服饰定制有限公司',
    foundedAt: '2018-01-25',
    registeredCapital: '500万人民币',
    legalRepresentative: '江波',
    registeredAddress: '常熟高新技术产业开发区东南大道33号701',
    regLocation: '常熟高新技术产业开发区东南大道33号701',
    province: '江苏省',
  }
  delete registry.establishDate
  delete registry.address

  const registryEvidence = mergeBy(array(beforeScoring.registryEvidence), [
    {
      field: 'companyName', value: '苏州尽无服饰定制有限公司',
      quote: '工商全称 苏州尽无服饰定制有限公司', sourceUrl: pitchhubUrl,
      evidenceStatus: 'source_labeled', note: '36氪工商栏目；CNNIC域名注册者记录交叉一致',
    },
    {
      field: 'foundedAt', value: '2018-01-25', quote: '成立时间 2018-01-25', sourceUrl: pitchhubUrl,
      evidenceStatus: 'source_labeled', note: '与36氪报道中的2018年5月创立口径存在冲突',
    },
    {
      field: 'registeredCapital', value: '500万人民币', quote: '翁新杰 20.00% 100万人民币', sourceUrl: pitchhubUrl,
      evidenceStatus: 'derived_source_labeled', note: '由6名股东认缴额合计500万元、股比合计100%推算，待官方工商复核',
    },
    {
      field: 'legalRepresentative', value: '江波', quote: '法定代表人 江波', sourceUrl: pitchhubUrl,
      evidenceStatus: 'source_labeled', note: '36氪工商栏目，待官方工商复核',
    },
    {
      field: 'registeredAddress', value: '常熟高新技术产业开发区东南大道33号701',
      quote: '注册地址 常熟高新技术产业开发区东南大道33号701', sourceUrl: pitchhubUrl,
      evidenceStatus: 'source_labeled', note: '36氪工商栏目，待官方工商复核',
    },
    {
      field: 'companyIntroduction',
      value: '公司面向中小私人定制服装店提供面料与加工集采、下单系统、CRM、客流导入、营销模式和服装款式等服务；2019年建立面料集采平台“五星定制联盟”。',
      quote: '面料集采，加工集采，下单系统，CRM系统，客流导入，营销模式，服装款式等',
      sourceUrl: pitchhubUrl, evidenceStatus: 'derived_source_labeled',
      note: 'Codex根据36氪项目页和原创报道作客观归纳，不包含未经审计的经营数字',
    },
  ], (item) => `${item.field}|${item.sourceUrl}|${item.value}`)

  const sourceField = (
    value: string,
    quote: string,
    sourceUrl = pitchhubUrl,
    evidenceStatus: 'source_labeled' | 'derived_source_labeled' = 'source_labeled',
    note = '',
  ) => ({
    value, quote, sourceUrl,
    sourceTitle: sourceUrl === pitchhubUrl
      ? '尽无服饰 | 项目信息-36氪'
      : '【南京眼】变革者出现，整合产业资源会为定制服装产业带来新突破吗？',
    evidenceStatus, note,
  })

  const sourceLabeledProfile = {
    projectIntroduction: sourceField(
      '面向全国中小私人服装定制店，通过产业资源整合和系统服务提升小B端盈利能力。',
      '提供一站式系统服务，提高小B端的盈利能力', pitchhubUrl, 'derived_source_labeled',
      'Codex根据项目页作客观归纳',
    ),
    product: sourceField(
      '面料集采、加工集采、下单系统、CRM系统、客流导入、营销模式、服装款式',
      '面料集采，加工集采，下单系统，CRM系统，客流导入，营销模式，服装款式等',
    ),
    productDescription: sourceField(
      '已落地的第一模块为面料集采；2019年建立面料集采平台“五星定制联盟”。',
      '完成第一模块面料集采的切入', pitchhubUrl, 'derived_source_labeled',
      '平台名称由36氪原创报道补充',
    ),
    applicationScenario: sourceField('全国中小品牌私人服装定制店', '全国有几万家服装私人定制的中小品牌定制店'),
    applicationDescription: sourceField(
      '目标门店面临运营不专业、采购成本高、获客能力差和互联网化不足等问题。',
      '运营不专业-采购成本高-获客能力差-互联网化不足', pitchhubUrl, 'derived_source_labeled',
      'Codex根据项目页归纳用户问题',
    ),
    mainBusiness: sourceField(
      '为中小服装定制店提供产业集采与数字化运营服务',
      '提供一站式的解决方案', pitchhubUrl, 'derived_source_labeled',
      'Codex根据已披露服务模块归纳',
    ),
    mainBusinessDescription: sourceField(
      '通过汇总采购主流面料、下单与CRM系统、营销及客流服务，降低门店采购和运营成本。',
      '围绕目标B端的核心痛点，提供一站式的解决方案', pitchhubUrl, 'derived_source_labeled',
      '降本效果数字未纳入本摘要',
    ),
    teamIntroduction: sourceField(
      '公开来源确认创始人江波及系统开发总监冯晓斌；任职起止和完整履历仍待进一步核验。',
      '冯晓斌 系统开发总监', pitchhubUrl, 'derived_source_labeled',
      '江波创始人身份来自36氪原创报道',
    ),
  }

  const structuredTeam = [
    {
      name: '江波', title: '创始人',
      background: '曾任多家国内知名服装品牌战略总监和战略顾问；该履历来自单一媒体采访，待进一步核验。',
      sourceUrl: articleUrl, evidenceStatus: 'source_labeled',
    },
    {
      name: '冯晓斌', title: '系统开发总监',
      background: '36氪项目页确认其团队成员及职务，未披露任职起止时间。',
      sourceUrl: pitchhubUrl, evidenceStatus: 'source_labeled',
    },
  ]
  const structuredNews = mergeBy(array(beforeScoring.structuredNews), [
    {
      date: '2020-03-09', title: '36氪发布尽无服饰与五星定制联盟专题报道',
      summary: '报道披露创始人背景、面料集采平台、门店入驻及后续融资计划。',
      sourceName: '36氪江苏', sourceUrl: articleUrl,
    },
    {
      date: '2019-09-01', title: '建立面料集采平台“五星定制联盟”',
      summary: '36氪报道披露平台通过汇总采购主流面料向上游争取折扣。',
      sourceName: '36氪江苏', sourceUrl: articleUrl,
    },
  ], (item) => `${item.date}|${item.title}|${item.sourceUrl}`)

  const fundingRounds = array(lead.funding_rounds).map((round) => (
    round.sourceUrl === pitchhubUrl && round.round === '种子轮'
      ? {
          ...round,
          evidenceQuote: '种子轮 2020-02 300万人民币 快鱼服饰董事长、梦百合董事长、波司登集团执行董事',
          evidenceStatus: 'conflicting',
          conflictNote: '36氪原创报道另称公司创立约三个月后获数百万元种子轮；融资日期口径未裁决',
        }
      : round
  ))

  const nextScoring = {
    ...beforeScoring,
    companyIntroduction: '公司面向中小私人定制服装店提供面料与加工集采、下单系统、CRM、客流导入、营销模式和服装款式等服务；2019年建立面料集采平台“五星定制联盟”。',
    officialSite: 'http://www.jwdingzhi.cn/',
    officialSiteStatus: {
      status: 'unreachable', checkedAt: new Date().toISOString(),
      note: 'CNNIC确认域名注册者为公司且有效期至2027-04-10，但当前HTTP/HTTPS均无法正常访问',
      sourceUrl: cnnicUrl,
    },
    registry,
    registryEvidence,
    sourceLabeledProfile,
    structuredTeam,
    structuredNews,
    fundingRoundsResearched: fundingRounds,
    publicIntelUpdatedAt: new Date().toISOString(),
    codexSourceLabeledEnrichment: {
      method: 'codex-parallel-source-labeled-research-v1', model: 'gpt-5.6-sol',
      completedAt: new Date().toISOString(), processes: 3,
      completedFields: [
        'companyIntroduction', 'website', 'companyName', 'foundedAt', 'registeredCapital',
        'legalRepresentative', 'registeredAddress', 'projectIntroduction', 'product',
        'applicationScenario', 'mainBusiness', 'team', 'financingConflict', 'latestDevelopments',
      ],
      unresolvedFields: ['creditCode', 'registrationStatus', 'companyType'],
    },
  }
  const sources = mergeBy(array(lead.sources), [
    {
      id: 'jinwu-36kr-feature', title: '【南京眼】变革者出现，整合产业资源会为定制服装产业带来新突破吗？',
      url: articleUrl, publisher: '36氪江苏', publishedAt: '2020-03-09',
      accessedAt: new Date().toISOString(), category: '权威媒体', reliability: '中',
      excerpt: '披露创始人背景、五星定制联盟、经营进展和融资计划。',
    },
    {
      id: 'jinwu-cnnic-whois', title: 'CNNIC WHOIS：jwdingzhi.cn', url: cnnicUrl,
      publisher: 'CNNIC', accessedAt: new Date().toISOString(), category: '监管/政府', reliability: '高',
      excerpt: '域名注册者为苏州尽无服饰定制有限公司，有效期至2027-04-10。',
    },
  ], (item) => String(item.url || ''))

  await connection.query(
    `UPDATE ${leadsTable}
     SET scoring=CAST(? AS JSON),funding_rounds=CAST(? AS JSON),sources=CAST(? AS JSON),
         business_region='江苏',business_region_source='36氪工商注册地址',business_region_confidence='中'
     WHERE id=?`,
    [JSON.stringify(nextScoring), JSON.stringify(fundingRounds), JSON.stringify(sources), leadId],
  )
  await connection.query(
    `INSERT INTO ${auditLogsTable}
      (id,user_id,user_name,module,action,target,result,request_id,created_at)
     VALUES (?,NULL,'（Codex）','项目获取池','补充来源标注信息',?,'success',?,NOW(3))`,
    [randomUUID(), JSON.stringify({
      leadId, name: lead.name,
      method: 'codex-parallel-source-labeled-research-v1', processes: 3,
      beforeHash: stableHash(beforeScoring), afterHash: stableHash(nextScoring),
      unresolvedFields: ['creditCode', 'registrationStatus', 'companyType'],
      financingConflictPreserved: true,
    }), `codex-jinwu-enrichment-${Date.now()}`],
  )
  await connection.commit()
  console.log(JSON.stringify({
    ok: true, leadId, beforeHash: stableHash(beforeScoring), afterHash: stableHash(nextScoring),
    completedFields: nextScoring.codexSourceLabeledEnrichment.completedFields,
    unresolvedFields: nextScoring.codexSourceLabeledEnrichment.unresolvedFields,
  }, null, 2))
} catch (error) {
  await connection.rollback()
  throw error
} finally {
  connection.release()
  await pool.end()
}
