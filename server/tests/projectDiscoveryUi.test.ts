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
  assert.doesNotMatch(discovery, /label: '全部'/, '发现页不应将首页候选误标为全量')
  assert.match(discovery, /启动信源扫描/, '发现模块应提供真实的雷达采集入口')
  assert.match(discovery, /apiPost<[^>]+>\('\/leads\/sync-radar'/, '信源扫描应复用目标系统现有雷达接口')
  assert.match(discovery, /AbortSignal\.timeout\(10 \* 60_000\)/, '全局雷达任务应使用长任务超时')
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
  assert.doesNotMatch(discovery, /role="button"/, '卡片整体不应充当按钮，展开与详情操作应使用独立语义按钮')
  assert.match(discoveryCss, /project-discovery-card\.is-expanded/, '展开卡片应跨越完整网格宽度')
  assert.match(discoveryCss, /project-discovery-investment-brief/, '投资速览应有独立的双列卡片样式')
  assert.match(sourcing, /<h1>共享线索池<\/h1>/, '原线索池仍需独立保留')
})
