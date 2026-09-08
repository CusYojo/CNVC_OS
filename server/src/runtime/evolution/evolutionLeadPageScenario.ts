import { runEvolutionBrowserGate, type EvolutionPageScenario } from './evolutionBrowserGate.js'

/** Every required viewport must pass; retain separate screenshots and evidence. */
export async function runEvolutionLeadPageGate(input: Omit<Parameters<typeof runEvolutionBrowserGate>[0], 'scenario'>) {
  const results = []
  for (const width of [1280, 390]) results.push(await runEvolutionBrowserGate({ ...input, scenario: evolutionLeadPageScenario(width) }))
  return results
}

/** Platform-owned regression scenario. All records are synthetic and contain no session credentials. */
export function evolutionLeadPageScenario(width = 1280): EvolutionPageScenario {
  const id = 'evolution-fixture-lead'
  const fixtures: Record<string, unknown> = {
    '/api/auth/me': { user: { id: 'evolution-fixture-user', name: '验收用户', email: 'fixture@example.invalid', role: '投资经理', department: '测试', permissionCodes: [] } },
    [`/api/leads/${id}`]: {
      id, name: '自进化验收样本', companyName: '自进化验收样本有限公司', channel: '新闻', poolStatus: '公共池',
      source: '固定验收数据', sourceUrl: '', industry: '人工智能', round: '', region: '测试地区', website: '',
      foundedAt: '', registeredCapital: '', legalRepresentative: '', creditCode: '', registrationStatus: '', registeredAddress: '', companyType: '',
      score: 0, analysisStatus: 'pending', leadType: 'company', status: '待处理', summary: '用于隔离页面验收的合成线索。',
      team: '', product: '', financing: '', suggestion: '', highlights: [], risks: [], shareholders: [], founders: [], fundingRounds: [], companyNews: [],
      sources: [{ url: 'https://source.example.invalid/evolution-fixture', title: '验收原始来源', publisher: '固定测试来源', publishedAt: '2026-01-01' }],
    },
    [`/api/leads/${id}/verified-profile`]: null,
    [`/api/leads/${id}/verified-facts?page=1&pageSize=100`]: { facts: [], hasMore: false },
  }
  for (const route of ['/projects?pageSize=100', '/meetings', '/todos', '/risks', '/ai-summaries', '/projects/files/all', '/templates', '/oa/requests', '/oa/workflow-logs']) {
    fixtures[`/api${route}`] = { list: [] }
  }
  return { path: `/sourcing/${id}`, viewport: { width, height: 900 }, fixtures,
    actions: [
      { selector: 'h1', action: 'text', expectedText: '自进化验收样本' },
      { selector: 'a[href="https://source.example.invalid/evolution-fixture"]', action: 'text', expectedText: '验收原始来源' },
    ] }
}
