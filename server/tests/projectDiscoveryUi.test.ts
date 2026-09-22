import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('project center exposes the imported discovery workspace without rewriting the lead pool', async () => {
  const [center, discovery, discoveryCss, sourcing] = await Promise.all([
    read('src/pages/ProjectCenterPage.tsx'),
    read('src/pages/ProjectDiscoveryPage.tsx'),
    read('src/pages/ProjectDiscoveryPage.css'),
    read('src/pages/SourcingPage.tsx'),
  ])

  assert.match(center, /id: 'discover', label: '新项目发现'/)
  assert.match(center, /view === 'discover' \? <ProjectDiscoveryPage \/>/)
  assert.match(discovery, /<h1>新项目发现<\/h1>/)
  assert.match(discovery, /今天新发现/)
  assert.match(discovery, /近 7 天/)
  assert.match(discovery, /value: 'all', label: '全部项目'/, '时间筛选应提供全部项目入口')
  assert.doesNotMatch(discovery, /label: '全部'/, '发现页不应将首页候选误标为全量')
  assert.match(discovery, /action === 'refresh' \? '开始更新' : '检查更新'/, '检查期间应立即显示开始更新状态')
  assert.match(discovery, /action === 'upload' \? '上传中' : '人工上传项目'/, '标题右侧应保留人工上传项目入口')
  assert.doesNotMatch(discovery, /刷新发现/, '页面不应保留与检查更新重复的刷新入口')
  assert.doesNotMatch(discovery, /补充发现来源/, '操作区只保留两个明确动作')
  assert.doesNotMatch(discovery, /从已收录的公开信源中/, '标题区只保留新项目发现和两个操作')
  assert.match(discovery, /<header className="project-discovery-hero">[\s\S]*<h1>新项目发现<\/h1>[\s\S]*className="project-discovery-action-buttons"[\s\S]*<\/header>/, '检查更新和人工上传项目应位于标题同一行右侧')
  assert.doesNotMatch(discovery, /<section className="project-discovery-actions"/, '不应再渲染独立的空白操作框')
  assert.doesNotMatch(discoveryCss, /\.project-discovery-actions\s*\{/, '应删除独立操作框样式')
  assert.doesNotMatch(discovery, /<section className="project-discovery-metrics"/, '不应再渲染发现概览统计卡片')
  assert.doesNotMatch(discovery, /<DiscoveryMetric/, '应删除已无用途的统计卡片组件调用')
  assert.doesNotMatch(discovery, /buildProjectDiscoverySummary/, '应删除已无用途的统计汇总计算')
  assert.doesNotMatch(discoveryCss, /\.project-discovery-metrics/, '应删除统计卡片及其响应式样式')
  assert.match(discovery, /<section className="project-discovery-results" aria-label="待查看项目">/, '结果卡片应保留一个带无障碍名称的外框')
  assert.doesNotMatch(discovery, /project-discovery-results-heading/, '结果外框不应再显示标题、说明或数量栏')
  assert.doesNotMatch(discoveryCss, /\.project-discovery-results-heading/, '应删除结果标题栏样式')
  assert.doesNotMatch(discovery, /\/leads\/sync-radar/, '新项目发现不得再调用原自动找项目 Agent')
  assert.doesNotMatch(discovery, /RadarSyncResult|canRunRadar|useAuthStore/, '数据库刷新不应保留 Agent 权限和结果依赖')
  assert.match(discovery, /const refreshed = await loadCandidates\(true\)/, '检查更新应直接重新读取数据库')
  assert.match(discovery, /已从数据库读取最新项目数据/, '数据库刷新完成后应明确反馈数据来源')
  assert.match(discovery, /\/leads\/bp-uploads/, '发现模块应提供人工 BP 上传入口')
  assert.match(discovery, /apiGet<[^>]+>\(`\/leads\/bp-uploads\/\$\{/, 'BP 上传后应轮询异步解析结果')
  assert.match(discovery, /`\/leads\/bp-uploads\/\$\{uploaded\.id\}\/retry`/, '失败的 BP 任务应复用既有重试接口')
  assert.doesNotMatch(discovery, /idempotencyKey:\s*crypto\.randomUUID/, '同一文件重试应由服务端内容哈希保持幂等')
  assert.match(discoveryCss, /focus-within/, '隐藏的文件输入仍需提供可见键盘焦点')
  assert.match(discoveryCss, /prefers-reduced-motion/, '加载动画应尊重减少动态效果设置')
  assert.match(discovery, /navigate\(`\/sourcing\/\$\{lead\.id\}`/)
  assert.doesNotMatch(discovery, /convertLead\(/, '发现页应先进入证据详情，不得绕过原转换流程')
  assert.match(discovery, /project-discovery-investment-brief/, '卡片应使用 VC Hunter 同款投资速览区')
  assert.match(discovery, /展开详细信息/)
  assert.match(discovery, /收起详细信息/)
  assert.match(discovery, /项目摘要/)
  assert.match(discovery, /公司画像/)
  assert.match(discovery, /research\?\.dataStatus\?\.status/, '兼容型科研画像缺少 dataStatus 时卡片仍应可渲染')
  assert.match(discovery, /projectDiscoveryStatusLabel\(lead\.poolStatus\)/, '状态徽标应反映真实线索池生命周期')
  assert.doesNotMatch(discovery, /role="button"/, '卡片整体不应充当按钮，展开与详情操作应使用独立语义按钮')
  assert.match(discoveryCss, /project-discovery-card\.is-expanded/, '展开卡片应跨越完整网格宽度')
  assert.match(discoveryCss, /project-discovery-investment-brief/, '投资速览应有独立的双列卡片样式')
  assert.match(sourcing, /<h1>共享线索池<\/h1>/, '原线索池仍需独立保留')
})
