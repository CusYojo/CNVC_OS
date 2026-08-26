import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { publicLeadFundingStatus } from '../services/leadDataQualityService.js'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFile(resolve(root, path), 'utf8')

const [page, detail, app, store, metaRoutes, intakeRoutes, ratingService, summaryService, dataQualityService, industryPresentation, styles] = await Promise.all([
  read('src/pages/SourcingPage.tsx'),
  read('src/pages/LeadDetailPage.tsx'),
  read('src/App.tsx'),
  read('src/store/useAppStore.ts'),
  read('server/src/routes/meta.ts'),
  read('server/src/routes/leadIntake.ts'),
  read('server/src/services/leadRatingV3Service.ts'),
  read('server/src/services/aiSummaryService.ts'),
  read('server/src/services/leadDataQualityService.ts'),
  read('src/lib/leadPresentation.ts'),
  read('src/styles.css'),
])

for (const label of ['批量导入', '上传 BP', '人工复核', 'Radar 同步']) {
  assert.doesNotMatch(page, new RegExp(label, 'i'), `共享线索池列表不应渲染「${label}」入口`)
  assert.doesNotMatch(detail, new RegExp(label, 'i'), `共享线索详情不应渲染「${label}」入口`)
}
for (const endpoint of ['/leads/imports', '/leads/bp-uploads', '/lead-pipeline/reviews', '/leads/sync-radar']) {
  assert.doesNotMatch(page, new RegExp(endpoint.replaceAll('/', '\\/')), `列表不得调用隐藏入口 ${endpoint}`)
  assert.doesNotMatch(detail, new RegExp(endpoint.replaceAll('/', '\\/')), `详情不得调用隐藏入口 ${endpoint}`)
}

for (const filter of ['线索类型', '行业', '阶段', '地区', '渠道', '更新时间']) {
  assert.match(page, new RegExp(`label="${filter}"`), `缺少筛选项：${filter}`)
}
for (const column of ['项目概况', '一句话摘要', '核心信息', '推荐理由 / 信号', '融资 / 估值', '最新动态', '更新时间']) {
  assert.match(page, new RegExp(`columnheader">${column.replace('/', '\\/')}`), `缺少列表列：${column}`)
}

assert.match(page, /pageSize[^\n]+20|:\s*20/, '默认分页必须为每页 20 条')
for (const query of ['leadType', 'industry', 'stage', 'region', 'channel', 'updatedRange']) {
  assert.match(store, new RegExp(`${query}\\?:`), `客户端查询契约缺少 ${query}`)
  assert.match(metaRoutes, new RegExp(query), `服务端查询契约缺少 ${query}`)
}
assert.match(app, /path="\/sourcing\/:id"/, '缺少独立线索研判页路由')
assert.doesNotMatch(detail, /ratingV3|评级研判|开始 V3 评级|人工重试评级/, '详情页不得展示评级研判及评分入口')
assert.match(ratingService, /LEAD_RATING_V3_WORKFLOW/, '隐藏详情展示不得删除后台 V3 评级能力')
assert.match(detail, /返回共享线索池/, '详情页必须提供返回列表入口')
for (const field of ['成立时间', '注册资本', '法定代表人', '统一社会信用代码', '登记状态', '公司类型', '注册地址']) {
  assert.match(detail, new RegExp(field), `详情页缺少工商字段：${field}`)
}
for (const field of ['融资轮次', '融资状态', '业务阶段']) {
  assert.match(detail, new RegExp(field), `详情页缺少严谨拆分字段：${field}`)
}
assert.doesNotMatch(detail, /\['融资阶段'/, '详情页不得再用“融资阶段”混淆融资轮次与业务阶段')
for (const field of ['融资状态', '融资金额', '估值']) {
  assert.match(page, new RegExp(`'${field}'`), `融资 / 估值列缺少固定子项：${field}`)
}
assert.match(summaryService, /fundingStatusDisplay:\s*normalizedStages\.fundingStatus/, '列表 DTO 必须返回独立融资状态字段')
for (const status of ['已融资', '未融资', '未披露', '待核验', '不适用']) {
  assert.match(dataQualityService, new RegExp(`'${status}'`), `融资状态投影缺少状态：${status}`)
}
assert.doesNotMatch(page, /funding\.stage/, '列表不得再把融资轮次字段直接当作融资状态')
assert.match(page, /const amount = status === '未融资'\s*\? '—'/, '未融资项目的融资金额必须显示横线')
assert.match(page, /const valuation = status === '未融资'\s*\? '—'/, '未融资项目的估值必须显示横线')
assert.match(page, /leadType\(lead\) === '科研项目'\) return \{ status: '-', amount: '-', valuation: '-' \}/, '科研项目的融资与估值字段必须显示短横线')
assert.match(page, /status === '不适用'\) return \{ status: '-', amount: '-', valuation: '-' \}/, '不适用的融资与估值字段必须统一显示短横线')
assert.equal(publicLeadFundingStatus('A轮', 'source_labeled'), '已融资')
assert.equal(publicLeadFundingStatus('历史B轮，当前轮次待核验', 'source_labeled'), '已融资')
assert.equal(publicLeadFundingStatus('未融资', 'source_labeled'), '未融资')
assert.equal(publicLeadFundingStatus('融资信息未披露', 'unverified'), '未披露')
assert.equal(publicLeadFundingStatus('融资轮次待核验', 'unverified'), '待核验')
assert.equal(publicLeadFundingStatus('不适用', 'not_applicable'), '不适用')
assert.match(detail, /!isUnfinanced\s*&&\s*hasFundingAmount/, '详情仅在存在有效融资金额时展示金额字段')
assert.match(summaryService, /dataQualityV1/, '列表接口必须返回 Codex 数据质量复核结果')
assert.match(page, /companyRegistry\?\.foundedAt/, '列表成立时间必须读取统一工商字段')
assert.match(page, /companyRegistry\?\.legalRepresentative/, '列表法人必须读取统一工商字段')
assert.match(detail, /displayLeadRegisteredAddress\(/, '注册地址必须通过专用展示校验')
assert.match(industryPresentation, /INVALID_REGISTERED_ADDRESS/, '注册地址校验必须拒绝置信度与占位值')
assert.match(industryPresentation, /split\(\/\[，,、；;｜\|\]\+\//, '行业拆分必须覆盖逗号、顿号、分号和竖线')
assert.doesNotMatch(industryPresentation, /split\(\/[^\n]*\\\//, '标准行业名称中的斜杠不得误拆')
assert.match(industryPresentation, /new Set/, '拆分后的行业标签必须去重')
assert.match(page, /industryTags\.map\(\(tag\) => <em key=\{`industry-\$\{tag\}`\}>/, '项目概况必须把复合行业拆成独立标签')
assert.match(detail, /industryTags\.map\(\(tag\) => <span key=\{`industry-\$\{tag\}`\}>/, '详情页必须把复合行业拆成独立标签')
assert.match(detail, /paperMeta\?\.authors/, '科研项目团队必须读取论文完整作者列表')
assert.match(detail, /paperMeta\?\.authorContributions/, '科研项目团队必须优先读取论文原文贡献标记')
assert.match(detail, /paperMeta\?\.paperAuthors/, '科研项目团队必须读取稳定作者ID和逐人机构元数据')
assert.match(detail, /https:\/\/orcid\.org\//, '作者存在ORCID时必须优先链接ORCID身份页')
assert.match(detail, /https:\/\/openalex\.org\//, '作者存在OpenAlex ID时必须链接OpenAlex作者页')
assert.match(detail, /作者身份待通过ORCID、机构或主页进一步消歧/, '缺少稳定作者ID时必须明确保持身份待消歧')
assert.match(detail, /contributionByAuthor\.get\(name\)\?\.label/, '论文作者卡片必须展示共同第一作者或共同资深作者等原文角色')
assert.match(detail, /paperTeam\.length \? paperTeam : verifiedTeam/, '论文作者存在时必须优先作为科研项目团队成员，否则只展示已验证团队事实')
assert.match(detail, /arxiv\.org\/search\//, '论文团队成员必须提供 arXiv 作者检索链接')
assert.match(detail, /member\.profileUrl[^\n]+target="_blank" rel="noreferrer"/, '论文作者链接必须使用安全外链属性')
assert.match(summaryService, /const teamSize = paperAuthors\.length \|\| structuredTeam\.length \|\| radarTeam\.length/, '科研项目团队人数必须优先使用去重后的论文作者数')
assert.match(summaryService, /and\(eq\(leads\.id, canonicalLeadId\), visiblePublicLeadExpr\)/, '列表排除的注销、删除、合并或质量拒绝线索也不得通过已知ID直接读取')
for (const field of ['所属机构', '研究团队', '作者—机构对应', '论文/成果许可', '数据集许可', '知识产权归属', '元数据来源']) {
  assert.match(detail, new RegExp(field), `论文详情缺少确定性研究元数据字段：${field}`)
}
assert.match(detail, /paperMeta\?\.affiliations/, '所属机构必须读取论文原始页面的多值机构字段')
assert.match(detail, /paperMeta\?\.researchTeam\?\.name/, '研究团队必须由论文共同署名关系确定')
assert.doesNotMatch(detail, /paperMeta\?\.researchTeam\?\.name \|\| profile\.lab \|\| lead\.team/, '研究团队不得回退到未核验的企业团队字段')
assert.match(detail, /paperMeta\?\.authorAffiliations/, '逐人机构关系必须读取来源明确确认的结构化字段')
assert.match(detail, /不根据机构列表强行分配作者/, '缺少逐人对应时不得把机构列表强行分配给作者')
assert.match(detail, /paperMeta\?\.rights\?\.articleLicense/, '论文许可必须与其他成果权属拆分展示')
assert.match(detail, /publicationDateStatus === 'source_declared_future'/, '来源声明为未来日期时必须与实际公开时间拆分展示')
assert.match(detail, /paperMeta\?\.resourceType/, '论文、学位论文、数据模型与标准必须展示正确成果形态')
assert.match(detail, /论文许可不代表成果所有权/, '详情必须明确开放许可不等于成果所有权')
assert.doesNotMatch(detail, /\['成果权属',\s*'待核验'\]/, '论文详情不得继续使用无法解释的成果权属待核验占位')
assert.doesNotMatch(detail, /联网资料补全/, '详情页不得展示联网资料补全运营区块')
assert.doesNotMatch(detail, /主体与关系|已提取事实与直接来源|裁决联网补全冲突|加载更多事实/, '详情页不得展示主体图、事实浏览或冲突裁决等运营信息')
for (const endpoint of ['enrichment/topics', 'enrichment/entity/confirm', 'enrichment/conflicts']) {
  assert.doesNotMatch(detail, new RegExp(endpoint.replaceAll('/', '\\/')), `详情页不得调用补全运营接口：${endpoint}`)
}
assert.doesNotMatch(detail, /`\/leads\/\$\{id\}\/enrichment`/, '详情页不得下载完整补全运行状态')
assert.doesNotMatch(detail, /`\/leads\/\$\{leadId\}\/facts\?/, '详情页不得下载包含未验证候选与原文的审计事实')
assert.match(detail, /`\/leads\/\$\{id\}\/verified-profile`/, '详情页只能读取已验证介绍投影')
assert.match(detail, /`\/leads\/\$\{leadId\}\/verified-facts\?/, '详情页只能读取已验证事实最小投影')
assert.match(detail, /loadAllLeadVerifiedFacts/, '详情页必须分页加载全部已验证事实用于投影到现有信息块')
assert.match(detail, /fact\.verificationStatus === 'verified'/, '详情页只允许投影已验证事实')
assert.match(detail, /fact\.evidence\.some\(\(evidence\) => Boolean\(externalUrl\(evidence\.sourceUrl\)\)\)/, '已验证事实还必须至少绑定一个合法公开来源')
assert.match(detail, /verifiedFactNode/, '主体基础信息必须从已验证事实读取并提供来源')
assert.match(detail, /verifiedTeamAsMembers/, '普通项目团队成员必须从已验证团队事实生成')
assert.match(detail, /verifiedNewsUpdates/, '动态路径必须从已验证新闻事实生成')
assert.match(detail, /展示可打开的原始来源与已验证事实来源/, '来源区必须如实区分原始线索来源与已验证事实来源')
assert.match(detail, /const productValue = verifiedFact\([\s\S]*?\? verifiedFactText/, '产品卡片必须读取已验证事实')
assert.match(detail, /const applicationValue = verifiedFact\([\s\S]*?\? verifiedFactText/, '应用场景卡片必须读取已验证事实')
assert.match(detail, /const mainBusinessValue = verifiedFact\([\s\S]*?\? verifiedFactText/, '主营业务卡片必须读取已验证事实')
assert.doesNotMatch(detail, /lead\.product \|\| lead\.scoring\?\.whatIsIt \|\| lead\.summary/, '产品卡片不得回退到未核验采集摘要')
assert.doesNotMatch(detail, /lead\.scoring\?\.structuredTeam\?\.length/, '团队成员不得回退到未核验结构化团队字段')
assert.doesNotMatch(detail, /lead\.highlights\?\.\[0\]|lead\.suggestion/, '主营业务与场景不得回退到推荐文案')
assert.match(detail, /claimedFoundedAt !== registeredAt && claimedFoundedAtSource/, '品牌或团队成立时间只有绑定直接来源时才允许展示')
assert.match(detail, /generatedIntroductions\?\.companyIntroduction/, '企业介绍必须接入冻结快照中的已验证事实摘要')
assert.match(detail, /generatedIntroductions\?\.teamIntroduction/, '团队介绍必须接入冻结快照中的已验证事实摘要')
assert.match(detail, /generatedIntroductions\?\.projectIntroduction/, '项目介绍必须接入冻结快照中的已验证事实摘要')
assert.match(detail, /generatedIntroductionSources\?\.companyIntroduction/, '企业介绍必须保留贡献事实的公开来源')
assert.match(detail, /generatedIntroductionSources\?\.teamIntroduction/, '团队介绍必须保留贡献事实的公开来源')
assert.match(detail, /generatedIntroductionSources\?\.projectIntroduction/, '项目介绍必须保留贡献事实的公开来源')
assert.match(detail, /projectIntroductionSource[\s\S]*target="_blank" rel="noreferrer">来源/, '项目简介必须在现有区块内提供可打开的直接来源')
assert.match(detail, /暂无已验证的项目介绍，不使用企业介绍或原始宣传文案替代/, '缺少项目事实时必须保持待核验，不得使用企业介绍替代')
assert.doesNotMatch(styles, /\.lead-review-enrichment|\.lead-review-entity-graph|\.lead-review-conflict-form/, '详情样式不得保留已移除运营区块的展示契约')
assert.match(page, /sessionStorage/, '列表必须保留滚动位置')
assert.match(page, /function FastClampedText/, '摘要与推荐理由必须共用即时完整内容浮层')
assert.match(page, /function FastSummaryText/, '一句话摘要必须使用即时完整内容浮层')
assert.match(page, /<FastSummaryText text=\{summaryText\} \/>/, '列表摘要必须接入即时完整内容浮层')
assert.match(page, /function FastReasonText/, '推荐理由必须使用快速完整内容浮层')
assert.match(page, /createPortal\(<div className="lead-pool-fast-tooltip"/, '推荐理由完整浮层必须脱离滚动容器以避免裁切')
assert.match(page, /detailView\.rating\.coreTags/, '推荐理由区域必须展示最新评级核心标签')
assert.match(page, /function joinedReason/, '推荐理由必须清理历史句尾标点后再拼接')
assert.match(page, /function ratingReason/, '推荐理由必须通过统一优先级函数生成')
assert.match(page, /rating\.status === '无法评级'/, '无法评级线索必须优先展示最新证据不足判断')
assert.match(page, /mainView\.displayGrade === 'D'/, 'D 级线索必须优先展示最新证据不足判断')
assert.match(page, /detailView\.investmentThesis/, '正式或参考评级必须优先展示最新投资逻辑')
assert.match(page, /oneSentenceJudgment/, '缺少投资逻辑时必须回退最新一句话判断')
assert.match(page, /legacyHighlights/, '没有可用 V3 理由时必须兼容历史 highlights')
for (const status of ['补全中', '待复核', '待评级', '评级中', '评级过期', '补全失败', '评级失败']) {
  assert.match(page, new RegExp(`'${status}'`), `共享线索列表缺少处理状态：${status}`)
}
assert.match(page, /enrichment\?\.status === 'rejected'/, '补全任务拒绝后必须展示为补全失败')
assert.match(page, /rating\?\.status === 'stale'[^\n]+评级过期/, '评级快照过期后必须与待评级区分展示')
assert.match(styles, /\.lead-pool-summary\s*>\s*p[^}]+-webkit-line-clamp:\s*3/, '一句话摘要默认最多显示三行')
assert.match(styles, /\.lead-pool-reason-copy\s*>\s*p[^}]+-webkit-line-clamp:\s*2/, '推荐理由默认最多显示两行')
assert.match(styles, /\.lead-pool-fast-tooltip[^}]+position:\s*fixed/, '推荐理由完整浮层必须即时显示且不受列表裁切')
assert.match(styles, /\.lead-pool-funding div[^}]+display:\s*grid[^}]+grid-template-columns:\s*48px 1fr/, '融资 / 估值必须与核心信息使用左标签右内容的键值排列')
assert.doesNotMatch(styles, /\.lead-pool-funding dd\.status[^}]+(?:padding|background|border-radius):/, '融资状态不得使用破坏键值对齐的独立徽标布局')
assert.match(styles, /\.lead-pool-page/, '共享线索池样式必须使用模块命名空间')
assert.match(styles, /\.lead-review-page/, '研判详情样式必须使用模块命名空间')

// 删除入口只放在详情页且仅对系统管理员渲染，并复用服务端已有的权限、软删除和审计链。
assert.doesNotMatch(page, /lead-pool-delete-button|pendingDeleteLead|onDelete=/, '共享线索列表不得展示删除入口')
assert.match(detail, /currentUser\?\.role === '系统管理员'/, '详情页线索删除入口必须仅对系统管理员渲染')
assert.match(detail, /apiDelete<[^>]+>\(`\/leads\/\$\{lead\.id\}`\)/, '详情页删除确认必须调用单条线索删除接口')
assert.match(detail, /确认删除「\{lead\.name\}」/, '删除弹窗必须明确展示待删除线索名称')
assert.match(detail, /navigate\(state\?\.from \|\| '\/sourcing', \{ replace: true \}\)/, '删除成功后必须返回共享线索池列表')
assert.match(metaRoutes, /delete\('\/leads\/:id', requireSystemAdmin/, '删除接口必须继续执行系统管理员权限检查')
assert.match(summaryService, /poolStatus: '已删除'/, '线索删除必须是可审计软删除')
assert.match(summaryService, /action: '删除公共线索'/, '线索删除必须写入审计记录')

// 仅隐藏前端入口；后台能力、权限与审计路径继续保留。
assert.match(intakeRoutes, /post\('\/leads\/imports\/preview'/)
assert.match(intakeRoutes, /post\('\/leads\/bp-uploads'/)
assert.match(metaRoutes, /get\('\/lead-pipeline\/reviews'/)
assert.match(metaRoutes, /post\('\/leads\/sync-radar'/)
assert.match(metaRoutes, /post\('\/leads\/:id\/enrichment\/topics\/:topic\/retry', requireSystemAdmin/, '后台必须保留管理员专题重试接口')
assert.match(metaRoutes, /post\('\/leads\/:id\/enrichment\/entity\/confirm', requireSystemAdmin/, '后台必须保留管理员主体确认接口')
assert.match(metaRoutes, /post\('\/leads\/:id\/enrichment\/conflicts\/:conflictId\/resolve', requireSystemAdmin/, '后台必须保留管理员冲突裁决接口')

console.log(JSON.stringify({
  ok: true,
  checks: [
    'hidden-operations-not-rendered',
    'hidden-operations-not-called',
    'six-filter-contract',
    'seven-column-contract',
    'twenty-row-pagination',
    'independent-detail-route',
    'detail-rating-hidden',
    'fast-three-line-summary-and-two-line-reason-tooltip',
    'rating-core-tags-visible',
    'v3-recommendation-reason-priority',
    'three-field-funding-column',
    'funding-layout-matches-core-facts',
    'unfinanced-amount-and-valuation-dash',
    'not-applicable-funding-fields-use-dash',
    'industry-tags-split-consistently',
    'paper-authors-projected-as-research-team',
    'enrichment-operations-hidden-and-verified-facts-projected',
    'list-state-restoration',
    'admin-audited-soft-delete',
    'namespaced-styles',
    'backend-capabilities-retained',
  ],
}, null, 2))
