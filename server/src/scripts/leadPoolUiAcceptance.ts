import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { publicLeadFundingStatus } from '../services/leadDataQualityService.js'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFile(resolve(root, path), 'utf8')

const [page, filterContract, detail, app, store, metaRoutes, queryContract, intakeRoutes, ratingService, summaryService, dataQualityService, industryPresentation, styles, fdeShell, appLayout] = await Promise.all([
  read('src/pages/SourcingPage.tsx'),
  read('src/lib/leadPoolFilters.ts'),
  read('src/pages/LeadDetailPage.tsx'),
  read('src/App.tsx'),
  read('src/store/useAppStore.ts'),
  read('server/src/routes/meta.ts'),
  read('server/src/contracts/leadPoolQueryContract.ts'),
  read('server/src/routes/leadIntake.ts'),
  read('server/src/services/leadRatingV3Service.ts'),
  read('server/src/services/aiSummaryService.ts'),
  read('server/src/services/leadDataQualityService.ts'),
  read('src/lib/leadPresentation.ts'),
  read('src/styles.css'),
  read('src/layout/fde-shell.css'),
  read('src/layout/AppLayout.tsx'),
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
for (const removedFilter of ['一级行业', '二级行业', '细分赛道', '历史行业标签', '产品路线', '投资机构', '高校/院所', '最新轮次', '客户验证', '数据状态', '事实冲突', '排序', '产业化阶段', '机构类型', '重点机构', '高校关系', '成果转化', '融资起始日期', '融资截止日期', '最低估值', '最高估值', '估值币种', '估值口径', '客户等级', '验证客户']) {
  assert.doesNotMatch(page, new RegExp(`label="${removedFilter}"`), `顶部筛选必须保持旧版，不应展示：${removedFilter}`)
}
assert.doesNotMatch(page, /更多投资筛选/, '顶部筛选必须保持旧版，不应展示更多投资筛选入口')
for (const channel of ['36氪', '机构公众号', '高校公众号', '论文']) {
  assert.match(filterContract, new RegExp(`'${channel}'`), `渠道筛选缺少 ${channel}`)
}
for (const removedChannel of ['新闻', '微信群聊']) {
  assert.doesNotMatch(filterContract, new RegExp(`'${removedChannel}'`), `渠道筛选不应展示 ${removedChannel}`)
}
for (const industry of ['自然语言处理', '计算机视觉', '网络安全', '数据科学', '软件工程', '金融', '工具软件', '本地生活', '旅游']) {
  assert.match(filterContract, new RegExp(`'${industry}'`), `全行业筛选缺少 ${industry}`)
}
for (const column of ['企业主体', '方向 / 产品', '团队 / 资本背景', '进展 / 阶段', '最新动态', '更新时间']) {
  assert.match(page, new RegExp(`columnheader">${column.replace('/', '\\/')}`), `缺少列表列：${column}`)
}
for (const removedColumn of ['一句话摘要', '核心信息', '推荐理由 / 信号', '价值 / 转化', '大客户验证', '数据状态']) {
  assert.doesNotMatch(page, new RegExp(`columnheader">${removedColumn.replace('/', '\\/')}`), `列表不应继续展示旧列：${removedColumn}`)
}

assert.match(page, /pageSize[^\n]+20|:\s*20/, '默认分页必须为每页 20 条')
const enterpriseRowSource = page.slice(page.indexOf('export function LeadRow'), page.indexOf('function ResearchLeadRow'))
const enterpriseRowCells = enterpriseRowSource.match(/role="cell"/g) ?? []
assert.equal(enterpriseRowCells.length, 6, `企业列表必须恰好 6 个单元格，当前为 ${enterpriseRowCells.length} 个`)
assert.match(page, /role="row" tabIndex=\{0\}/, '线索行必须可通过键盘聚焦')
assert.match(page, /event\.key === 'Enter' \|\| event\.key === ' '/, '线索行必须支持 Enter 和 Space 打开详情')
assert.match(page, /event\.target === event\.currentTarget/, '子控件键盘事件不得重复触发行打开')
assert.match(styles, /\.lead-pool-row:hover, \.lead-pool-row:focus-visible/, '键盘聚焦必须提供可见焦点反馈')
assert.match(page, /className="lead-pool-table-scroll"/, '表格和固定分页之间必须有独立横向滚动容器')
assert.match(styles, /\.lead-pool-table-scroll \{ overflow-x: auto;/, '不足宽度时必须提供可用的横向滚动降级')
assert.match(styles, /\.lead-pool-table \{ position: relative; min-width: 1040px; \}/, '桌面主验收宽度必须容纳企业六列而不裁切')
assert.match(fdeShell, /body:has\(\.fde-app\) \{ min-width: 320px; \}/, 'FDE 工作台不得继承旧页面 1180px 的全局最小宽度')
assert.match(appLayout, /leadPoolView = location\.pathname === '\/projects'[\s\S]*?view'\) === 'leads'/, '窄屏侧栏折叠必须精确识别共享线索池视图')
assert.match(appLayout, /navigationCollapsed = collapsed \|\| narrow && \(responsibilityView \|\| leadPoolView\)/, '共享线索池窄屏必须复用受控侧栏折叠')
for (const query of ['leadType', 'industry', 'industryLevel1', 'industryLevel2', 'industrySegment', 'stage', 'region', 'channel', 'updatedRange', 'productRoute',
  'institution', 'institutionType', 'academicInstitution', 'latestRound', 'customerStageMin', 'profileStatus', 'hasConflict', 'sort',
  'productionStage', 'hasMajorInstitution', 'academicRelation', 'hasCommercializationLink',
  'fundingDateFrom', 'fundingDateTo', 'valuationMin', 'valuationMax', 'valuationCurrency',
  'valuationType', 'customerTier', 'hasVerifiedCustomer']) {
  assert.match(store, new RegExp(`${query}\\?:`), `客户端查询契约缺少 ${query}`)
  assert.match(queryContract, new RegExp(query), `服务端查询契约缺少 ${query}`)
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
assert.match(summaryService, /fundingStatusDisplay:\s*normalizedStages\.fundingStatus/, '列表 DTO 必须返回独立融资状态字段')
for (const [industry, sectorLabel] of [
  ['人工智能', 'artificial_intelligence'],
  ['具身智能/机器人', 'embodied_intelligence'],
  ['半导体/芯片', 'semiconductor'],
]) {
  assert.match(summaryService, new RegExp(`'${industry}':\\s*'${sectorLabel}'`), `${industry}筛选必须映射到36氪归一化赛道`)
}
assert.match(summaryService, /\$\.profile\.sectorLabels/, '行业筛选必须读取36氪候选入池后的赛道标签')
assert.match(summaryService, /JSON_CONTAINS\([\s\S]*?sectorLabels[\s\S]*?JSON_QUOTE\(\$\{sectorLabel\}\)/, '赛道筛选必须使用 JSON 数组精确包含匹配')
assert.match(summaryService, /LEAD_STAGE_FILTER_PATTERNS/, '阶段筛选必须使用归一化分组规则')
assert.match(summaryService, /'C轮及以后':\s*'\^\(Pre-C/, 'C轮及以后必须覆盖 Pre-C、C-F 轮及上市前阶段')
assert.match(summaryService, /'股权融资\/轮次未披露':/, '阶段筛选必须覆盖已识别但轮次不明确的股权融资')
assert.match(summaryService, /stage === '科研成果'[\s\S]*?channel'[\s\S]*?= '论文'/, '科研成果必须按论文线索类型筛选')
assert.doesNotMatch(summaryService, /const stageKeyword = `%\$\{stage\}%`/, '阶段筛选不得继续使用会混入 Pre-A 的模糊匹配')
assert.match(summaryService, /meaningfulPresentationText\(ratingV3\.scoredAt\)/, '更新日期展示必须与筛选同时纳入 V3 评级时间')
assert.match(page, /availableData\?\.industryTags/, '画像行业缺失时必须展示列表 DTO 中已有的行业数据')
assert.match(summaryService, /LEAD_POOL_SHOW_CANDIDATE_DATA/, '候选数据展示必须具有独立运行时开关')
assert.match(summaryService, /dataStatus:\s*'candidate'/, '候选列表 DTO 必须明确标注 candidate 状态')
assert.match(summaryService, /verificationStatus:\s*'unverified'/, '候选列表 DTO 不得冒充已验证画像')
assert.match(summaryService, /sourceKinds/, '候选列表 DTO 必须区分入池资料与联网候选来源')
assert.doesNotMatch(page, /lead-pool-candidate-note|candidateLabel/, '页面不得显示已有资料或联网候选的待核验提示')
assert.doesNotMatch(styles, /\.lead-pool-candidate-note/, '样式表不得保留候选待核验提示样式')
assert.doesNotMatch(page, /<dt>累计<\/dt>|cumulativeAmount/, '融资进展列不得展示累计融资字段')
for (const hiddenCandidateText of ['联网候选', '已有资料', '已有/联网资料']) {
  assert.match(page, new RegExp(`LIST_EMPTY_VALUES[\\s\\S]*?'${hiddenCandidateText.replace('/', '\\/')}'`), `列表必须隐藏候选提示字样：${hiddenCandidateText}`)
}
assert.match(page, /\^\\d\{4\}-\\d\{2\}\$/, '年月候选必须保留原始精度，不得虚构每月1日')
assert.doesNotMatch(page, /splitLeadIndustryTags\(lead\.industry\)/, '投资画像行业列不得混入没有画像证据绑定的旧 industry 字段')
assert.match(page, /LIST_EMPTY_VALUES/, '列表必须统一识别待核验类占位')
assert.match(page, /function displayText\(value: unknown, fallback = '-'\)/, '列表待核验类占位必须显示为短横线')
assert.match(page, /sessionStorage\.removeItem\(LIST_SCROLL_KEY\)/, '主动切换筛选时必须清除旧滚动位置')
assert.match(page, /const next = new URLSearchParams\(params\)[\s\S]*?next\.delete\(key\)[\s\S]*?setParams\(next\)/, '清空线索筛选必须保留父级 view 等路由参数')
assert.match(page, /normalizedLeadPoolSearchParams/, '页面必须清理非法 URL 查询条件')
assert.match(page, /maxLength=\{100\}/, '搜索输入框必须在浏览器侧限制为 100 字符')
assert.match(page, /event\.target\.value\.slice\(0, 100\)/, '搜索状态入口必须截断绕过 HTML 属性的超长输入')
assert.match(page, /response\.page !== request\.page/, '服务端修正越界页后页面必须同步实际页')
assert.match(page, /void runRequest\(\)/, '首次加载与重试必须复用统一错误处理')
assert.match(summaryService, /\$\{leads\.team\} LIKE \$\{kw\}/, '关键词搜索必须覆盖直接团队字段')
assert.match(summaryService, /normalizeLeadListPage\(requestedPage, pageSize, total\)/, '服务端必须按真实总数回退越界页')
assert.match(summaryService, /LEAD_LIST_READ_TRANSACTION\s*=\s*\{[\s\S]*?isolationLevel:\s*'repeatable read'[\s\S]*?accessMode:\s*'read only'/, '线索列表必须声明只读一致快照契约')
assert.match(summaryService, /db\.transaction\([\s\S]*?LEAD_LIST_READ_TRANSACTION\)/, '计数和分页列表必须应用只读一致快照契约')
assert.match(summaryService, /industry === '其他'[\s\S]*?AND NOT/, '“其他”行业必须使用标准行业规则的补集')
assert.match(summaryService, /deriveAuthoritativeLeadRegion/, '列表地区必须使用权威标准字段')
for (const status of ['已融资', '未融资', '未披露', '待核验', '不适用']) {
  assert.match(dataQualityService, new RegExp(`'${status}'`), `融资状态投影缺少状态：${status}`)
}
assert.equal(publicLeadFundingStatus('A轮', 'source_labeled'), '已融资')
assert.equal(publicLeadFundingStatus('历史B轮，当前轮次待核验', 'source_labeled'), '已融资')
assert.equal(publicLeadFundingStatus('未融资', 'source_labeled'), '未融资')
assert.equal(publicLeadFundingStatus('融资信息未披露', 'unverified'), '未披露')
assert.equal(publicLeadFundingStatus('融资轮次待核验', 'unverified'), '待核验')
assert.equal(publicLeadFundingStatus('不适用', 'not_applicable'), '不适用')
assert.match(detail, /!isUnfinanced\s*&&\s*hasFundingAmount/, '详情仅在存在有效融资金额时展示金额字段')
assert.match(summaryService, /dataQualityV1/, '列表接口必须返回 Codex 数据质量复核结果')
assert.match(detail, /displayLeadRegisteredAddress\(/, '注册地址必须通过专用展示校验')
assert.match(detail, /displayLeadDetailValue/, '详情页必须通过统一规则隐藏待核验类占位')
assert.doesNotMatch(detail, /待核验|待核实|待确认/, '详情页源码不得继续直接渲染待核验类文案')
assert.match(industryPresentation, /INVALID_REGISTERED_ADDRESS/, '注册地址校验必须拒绝置信度与占位值')
assert.match(industryPresentation, /split\(\/\[，,、；;｜\|\]\+\//, '行业拆分必须覆盖逗号、顿号、分号和竖线')
assert.doesNotMatch(industryPresentation, /split\(\/[^\n]*\\\//, '标准行业名称中的斜杠不得误拆')
assert.match(industryPresentation, /new Set/, '拆分后的行业标签必须去重')
assert.match(page, /industryTags\.map\(\(tag\) => <em key=\{tag\}>/, '行业与产品列必须把复合行业拆成独立标签')
assert.match(detail, /industryTags\.map\(\(tag\) => <span key=\{`industry-\$\{tag\}`\}>/, '详情页必须把复合行业拆成独立标签')
assert.match(detail, /paperMeta\?\.authors/, '科研项目团队必须读取论文完整作者列表')
assert.match(detail, /paperMeta\?\.authorContributions/, '科研项目团队必须优先读取论文原文贡献标记')
assert.match(detail, /paperMeta\?\.paperAuthors/, '科研项目团队必须读取稳定作者ID和逐人机构元数据')
assert.match(detail, /https:\/\/orcid\.org\//, '作者存在ORCID时必须优先链接ORCID身份页')
assert.match(detail, /https:\/\/openalex\.org\//, '作者存在OpenAlex ID时必须链接OpenAlex作者页')
assert.match(detail, /论文署名作者，暂无稳定作者ID/, '缺少稳定作者ID时必须明确标注为论文署名身份')
assert.match(detail, /contributionByAuthor\.get\(name\)\?\.label/, '论文作者卡片必须展示共同第一作者或共同资深作者等原文角色')
assert.match(detail, /paperTeam\.length \? paperTeam : verifiedTeam/, '论文作者存在时必须优先作为科研项目团队成员，否则只展示已验证团队事实')
assert.match(detail, /arxiv\.org\/search\//, '论文团队成员必须提供 arXiv 作者检索链接')
assert.match(detail, /const profileUrl = externalUrl\(member\.profileUrl\)[\s\S]*href=\{profileUrl\} target="_blank" rel="noreferrer"/, '论文作者链接必须使用安全外链属性')
assert.match(summaryService, /const teamSize = paperAuthors\.length \|\| structuredTeam\.length \|\| radarTeam\.length/, '科研项目团队人数必须优先使用去重后的论文作者数')
assert.match(summaryService, /and\(eq\(leads\.id, canonicalLeadId\), visiblePublicLeadExpr\)/, '列表排除的注销、删除、合并或质量拒绝线索也不得通过已知ID直接读取')
for (const field of ['所属机构', '研究团队', '作者—机构对应', '论文/成果许可', '数据集许可', '知识产权归属', '元数据来源']) {
  assert.match(detail, new RegExp(field), `论文详情缺少确定性研究元数据字段：${field}`)
}
assert.match(detail, /paperMeta\?\.affiliations/, '所属机构必须读取论文原始页面的多值机构字段')
assert.match(detail, /paperMeta\?\.researchTeam\?\.name/, '研究团队必须由论文共同署名关系确定')
assert.doesNotMatch(detail, /paperMeta\?\.researchTeam\?\.name \|\| profile\.lab \|\| lead\.team/, '研究团队不得回退到未核验的企业团队字段')
assert.match(detail, /paperMeta\?\.authorAffiliations/, '逐人机构关系必须读取来源明确确认的结构化字段')
assert.match(detail, /作者—机构对应：-/, '缺少逐人对应时不得把机构列表强行分配给作者')
assert.match(detail, /paperMeta\?\.rights\?\.articleLicense/, '论文许可必须与其他成果权属拆分展示')
assert.match(detail, /publicationDateStatus === 'source_declared_future'/, '来源声明为未来日期时必须与实际公开时间拆分展示')
assert.match(detail, /paperMeta\?\.resourceType/, '论文、学位论文、数据模型与标准必须展示正确成果形态')
assert.doesNotMatch(detail, /articleLicense\?\.label[^\n]+intellectualProperty/, '论文许可与知识产权归属不得合并为同一字段')
assert.doesNotMatch(detail, /\['成果权属',\s*'待核验'\]/, '论文详情不得继续使用无法解释的成果权属待核验占位')
assert.doesNotMatch(detail, /联网资料补全/, '详情页不得展示联网资料补全运营区块')
assert.doesNotMatch(detail, /主体与关系|已提取事实与直接来源|加载更多事实/, '详情页不得展示主体图或事实浏览等运营信息')
for (const endpoint of ['enrichment/topics', 'enrichment/entity/confirm']) {
  assert.doesNotMatch(detail, new RegExp(endpoint.replaceAll('/', '\\/')), `详情页不得调用补全运营接口：${endpoint}`)
}
assert.doesNotMatch(detail, /conflictReviewOpen|openConflictReview|复核投资画像事实冲突/, '详情页不得展示投资画像冲突复核入口或弹窗')
assert.doesNotMatch(detail, /enrichment\/conflicts/, '详情页不得调用冲突候选或裁决接口')
assert.doesNotMatch(detail, /`\/leads\/\$\{id\}\/enrichment`/, '详情页不得下载完整补全运行状态')
assert.doesNotMatch(detail, /`\/leads\/\$\{leadId\}\/facts\?/, '详情页不得下载包含未验证候选与原文的审计事实')
assert.match(detail, /`\/leads\/\$\{id\}\/verified-profile`/, '详情页只能读取已验证介绍投影')
assert.match(detail, /`\/leads\/\$\{leadId\}\/verified-facts\?/, '详情页只能读取已验证事实最小投影')
assert.match(detail, /loadAllLeadVerifiedFacts/, '详情页必须分页加载全部已验证事实用于投影到现有信息块')
assert.match(detail, /已验证事实超过详情页安全读取上限，不能展示不完整来源链/, '来源超过安全上限时必须失败关闭，不能静默截断')
assert.match(detail, /factsLoadError[\s\S]*相关来源暂时不可用/, '来源读取失败必须向用户显示独立状态')
assert.match(detail, /factsLoadError[\s\S]*重新读取/, '来源读取失败必须提供可见重试入口')
assert.match(detail, /fact\.verificationStatus === 'verified'/, '详情页只允许投影已验证事实')
assert.match(detail, /fact\.evidence\.some\(\(evidence\) => Boolean\(externalUrl\(evidence\.sourceUrl\)\)\)/, '已验证事实还必须至少绑定一个合法公开来源')
assert.match(detail, /verifiedFactNode/, '主体基础信息必须从已验证事实读取')
const companyFactsSource = detail.slice(detail.indexOf('const companyFacts'), detail.indexOf('const paperAffiliations'))
const researchFactsSource = detail.slice(detail.indexOf('const researchFacts'), detail.indexOf('const facts:'))
assert.doesNotMatch(companyFactsSource, /<a\b|lead-review-inline-link/, '主体基础信息不得保留字段级来源入口')
assert.doesNotMatch(researchFactsSource, /<a\b|lead-review-inline-link/, '科研主体信息不得保留字段级来源入口')
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
assert.doesNotMatch(detail, /lead-review-inline-link|Codex 基于原文归纳，待交叉核验|原文已标注，待交叉核验/, '详情内容旁不得显示字段级来源或待交叉核验标注')
assert.match(detail, /lead\.projectIntroduction/, '详情页必须优先纳入完整项目介绍')
assert.match(detail, /function multilineText[\s\S]*?\.replace\(/, '项目简介必须把字面量换行转为真实换行')
assert.match(detail, /multilineText\(projectIntroduction\?\.value/, '项目简介必须使用多行文本格式化')
assert.match(styles, /\.lead-review-introduction[^}]+white-space:\s*pre-wrap/, '项目简介必须保留换行和段落空行')
assert.match(summaryService, /leadReserve\.detailJson[\s\S]*reserveDetail\.intro/, '详情 DTO 必须从储备池返回完整项目介绍')
assert.doesNotMatch(detail, /竞争格局|股权结构|核心团队与股权|sourceBoundShareholders|companyCompetitors/, '企业详情页不得展示竞争格局或股权结构')
assert.match(detail, /title="核心团队"/, '企业详情页必须保留核心团队项目数据')
assert(detail.indexOf('title="最近动态"') < detail.indexOf('title="相关来源"'), '企业最近动态必须紧邻展示在相关来源之前')
assert.match(summaryService, /mergeLeadScoringWithRetainedSources/, 'AI评分保存不得整块覆盖36氪等来源字段')
const anchors = [...detail.matchAll(/<a\b[\s\S]*?>/g)].map((match) => match[0])
assert(anchors.length > 0, '详情页应保留可用的外部链接')
for (const anchor of anchors) {
  assert.match(anchor, /target="_blank"/, '详情页所有链接都必须在新窗口打开')
  assert.match(anchor, /rel="noreferrer"/, '详情页新窗口链接必须隔离 referrer')
}
assert.doesNotMatch(styles, /\.lead-review-enrichment|\.lead-review-entity-graph|\.lead-review-conflict/, '详情样式不得保留已移除运营区块的展示契约')
assert.match(page, /sessionStorage/, '列表必须保留滚动位置')
assert.doesNotMatch(page, /FastSummaryText|FastReasonText|lead-pool-fast-tooltip|createPortal/, '列表不得继续保留摘要或推荐理由浮层')
assert.doesNotMatch(styles, /\.lead-pool-(?:summary|facts|reason-copy|fast-tooltip|signals|funding)\b/, '列表样式不得保留已移除摘要、核心信息、推荐理由和旧融资列契约')
assert.match(styles, /\.lead-pool-updates\b/, '最新动态列必须恢复旧版时间轴样式')
assert.match(styles, /\.lead-pool-updated\b/, '更新时间列必须恢复旧版时间样式')
for (const field of ['investmentProfile', 'profile?.products', 'profile?.institutions', 'profile?.academicLinks',
  'profile?.financing']) {
  assert.match(page, new RegExp(field.replace(/[?.]/g, '\\$&')), `企业六列列表缺少画像字段：${field}`)
}
assert.match(page, /lead\.latestUpdates/, '列表必须使用精简 latestUpdates 恢复最新动态列')
assert.match(page, /lead\.dataUpdatedAt \|\| lead\.poolEnteredAt/, '更新时间列必须优先使用数据更新时间并回退入池时间')
assert.match(summaryService, /leadInvestmentProfileProjections/, '列表查询必须连接权威投资画像投影')
assert.match(summaryService, /leftJoin\(leadInvestmentProfileProjections/, '列表计数和分页必须使用同一画像投影连接')
assert.match(summaryService, /function leadPoolListItem/, '列表必须通过独立最小 DTO 投影返回')
const listItemProjection = summaryService.slice(
  summaryService.indexOf('function leadPoolListItem'),
  summaryService.indexOf('// 公共池分页', summaryService.indexOf('function leadPoolListItem')),
)
assert.doesNotMatch(listItemProjection, /\.\.\.(?:enriched|listItem)/, '列表 DTO 不得通过对象展开继承未来新增详情字段')
for (const field of [
  'id', 'name', 'companyName', 'region', 'leadType', 'businessTags',
  'poolEnteredAt', 'dataUpdatedAt', 'latestUpdates', 'radarProfile', 'investmentProfile', 'availableData',
]) {
  assert.match(listItemProjection, new RegExp(`${field}:`), `列表正向白名单缺少字段 ${field}`)
}
assert.doesNotMatch(listItemProjection, /sourceFactIds/, '列表 DTO 不得返回内部事实 ID 列表')
assert.doesNotMatch(listItemProjection, /snapshotHash/, '列表 DTO 不得返回详情页使用的快照 hash')
assert.match(detail, /productCommercialization:\s*!isPaperChannel/, '论文渠道详情页必须隐藏产品与商业化')
assert.match(detail, /investmentProfile:\s*false/, '所有渠道的详情页都必须隐藏投资证据画像')
assert.match(detail, /sectionVisibility\.productCommercialization\s*&&\s*<ReviewSection title="产品与商业化"/, '产品与商业化必须按渠道可见性渲染')
assert.doesNotMatch(detail, /<ReviewSection title="投资证据画像"/, '企业详情不得渲染投资画像、推荐或数据质量模块')
assert.match(detail, /investmentProfile\.financing\.status, investmentProfile\.financing\.latestRound/, '详情融资进展必须显示融资状态与轮次')
assert.match(page, /hasInstitutionAndAcademic[\s\S]*?\? 1 : 2/, '机构与高校同时存在时不得互相挤掉')
assert.doesNotMatch(page, /profile\?\.customers|customerDisplayName/, '列表移除大客户验证列后不得继续渲染客户画像')
assert.match(detail, /customer\.anonymized[\s\S]*?某保密客户/, '详情必须对异常的保密客户标签失败关闭')
assert.match(page, /hiddenProductCount > 0[^\n]+\+\{hiddenProductCount\}/, '产品超出两项时必须显示 +N')
assert.match(page, /hiddenBackgroundCount > 0[^\n]+\+\{hiddenBackgroundCount\}/, '机构和高校背景超出显示上限时必须显示 +N')
for (const label of ['行业与产品路线', '机构与高校背景', '融资进展', '最新估值', '大客户验证', '数据状态']) {
  assert.match(detail, new RegExp(`label: '${label}'`), `详情画像缺少模块：${label}`)
}
for (const forbidden of ['待评级', '评级中', '评级过期', '评级失败', '评级分数', '线索评级']) {
  assert.doesNotMatch(page, new RegExp(forbidden), `共享线索列表不得展示V3状态：${forbidden}`)
}
assert.match(styles, /\.lead-pool-profile-list[^}]+display:\s*grid/, '融资进展必须使用紧凑键值布局')
assert.match(styles, /\.lead-pool-page/, '共享线索池样式必须使用模块命名空间')
assert.match(styles, /\.lead-review-page/, '研判详情样式必须使用模块命名空间')

// 删除入口只放在详情页且按服务端同一有效权限渲染，并复用已有软删除和审计链。
assert.doesNotMatch(page, /lead-pool-delete-button|pendingDeleteLead|onDelete=/, '共享线索列表不得展示删除入口')
assert.match(detail, /permissionCodes\?\.includes\('system\.manage'\)/, '详情页线索删除入口必须接受有效 system.manage 权限')
assert.match(detail, /canManageLeadPool\(currentUser\)/, '详情页线索删除入口必须复用有效权限判定')
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
    'legacy-filter-contract',
    'kr36-sector-label-filter-contract',
    'normalized-stage-filter-contract',
    'all-industry-and-channel-options',
    'filter-scroll-reset',
    'enterprise-six-column-contract',
    'twenty-row-pagination',
    'keyboard-and-responsive-row-access',
    'independent-detail-route',
    'detail-rating-hidden',
    'old-summary-reason-and-news-columns-removed',
    'enterprise-six-column-profile-projection',
    'industry-tags-split-consistently',
    'paper-authors-projected-as-research-team',
    'enrichment-operations-hidden-and-verified-facts-projected',
    'investment-profile-evidence-failure-visible',
    'list-state-restoration',
    'admin-audited-soft-delete',
    'namespaced-styles',
    'backend-capabilities-retained',
  ],
}, null, 2))
