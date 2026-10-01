export type DiscoveryMonitorKey = 'venture-tech' | 'registry' | 'hiring' | 'rankings'

export interface DiscoveryMonitorSource {
  id: string
  kind: string
  group: string
  name: string
  enabled: boolean
  config: { type: string; url: string; note?: string }
  lastError?: string
  lastFetched?: number | null
}

export interface DiscoveryMonitoringPlan {
  key: DiscoveryMonitorKey
  title: string
  description: string
  schedule: string
  ready: boolean
  enabled: boolean
  schedulerEnabled: boolean
  activeSourceCount: number
  sourceIds: string[]
  sources: DiscoveryMonitorSource[]
  readinessNote: string
}

const plans: Array<Pick<DiscoveryMonitoringPlan, 'key' | 'title' | 'description' | 'schedule' | 'readinessNote'> & { groups: string[] }> = [
  { key: 'venture-tech', title: '创投与科技动态', description: '融资、投资、产品发布与技术讨论', schedule: '随 Radar 自动采集任务运行', groups: ['创投新闻', '海外项目', '高校成果', '专利'], readinessNote: '总开关会批量启停本类所有可运行来源；单个来源可在这里单独调整。' },
  { key: 'registry', title: '工商科技企业', description: '企业设立、经营范围和工商变更', schedule: '待接入', groups: ['工商科技企业'], readinessNote: '尚无可运行的公开工商连接器；授权 API 接入前保持关闭。' },
  { key: 'hiring', title: '招聘增长信号', description: '研发岗位新增、招聘规模变化与关键岗位', schedule: '待接入', groups: ['招聘增长信号'], readinessNote: '尚无可运行的公开招聘连接器；授权 API 接入前保持关闭。' },
  { key: 'rankings', title: '榜单与奖项', description: '科技榜单、创新奖项、入选团队与人物', schedule: '待接入', groups: ['榜单与奖项'], readinessNote: '人物发掘已有官方名录快照，自动榜单采集尚未接入。' },
]
const runnablePublicTypes = new Set(['rss', 'html_list', '36kr_financing_flash'])

export function buildDiscoveryMonitoringPlans(sources: DiscoveryMonitorSource[], schedulerEnabled = true): DiscoveryMonitoringPlan[] {
  return plans.map((plan) => {
    const matching = sources.filter((source) => source.kind === 'public-source' && plan.groups.includes(source.group))
    const runnable = matching.filter((source) => (
      runnablePublicTypes.has(source.config.type)
      && /^https?:\/\//i.test(source.config.url)
      && !/TLS 不稳定|已移除|仅作人工参考|验证码和反爬/i.test(source.config.note || '')
    ))
    return {
      key: plan.key, title: plan.title, description: plan.description,
      schedule: plan.schedule, readinessNote: plan.readinessNote,
      ready: runnable.length > 0 && schedulerEnabled,
      enabled: schedulerEnabled && runnable.some((source) => source.enabled),
      schedulerEnabled,
      activeSourceCount: runnable.filter((source) => source.enabled).length,
      sourceIds: runnable.map((source) => source.id),
      sources: matching,
    }
  })
}

export function isDiscoveryMonitorKey(value: string): value is DiscoveryMonitorKey {
  return plans.some((plan) => plan.key === value)
}

export function redactDiscoveryMonitoringPlans(plansToShow: DiscoveryMonitoringPlan[]): DiscoveryMonitoringPlan[] {
  return plansToShow.map((plan) => ({
    ...plan,
    sources: plan.sources.map((source) => ({
      id: source.id, kind: source.kind, group: source.group, name: source.name,
      enabled: source.enabled, config: { type: source.config.type, url: '' },
    })),
  }))
}
