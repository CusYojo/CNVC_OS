import type { TypePolicyDefinition } from '../contracts/fdeTypePolicyContract.js'

// Synthetic acceptance-only definition; never seeded or activated in the app.
export function typePolicyFixture(type: TypePolicyDefinition['type'] = 'fundraising'): TypePolicyDefinition {
  return { schemaVersion: 2, type, timezone: 'Asia/Shanghai', cycleDays: [15, 30, 40, 50], calendar: { basis: 'calendar', workingWeekdays: [], holidays: [], extraWorkingDates: [] },
    stages: [
      { key: 'objectives', name: '合成目标确认', outcome: '合成验收：明确目标和证据', allowWaiver: false, materials: [{ key: 'objective_evidence', label: '合成目标依据' }], approvals: [{ duty: 'owner', name: '合成负责人核对', mode: '会签' }] },
      { key: 'delivery', name: '合成成果验收', outcome: '合成验收：提交可复核成果', allowWaiver: false, materials: [], approvals: [{ duty: 'concerned_leader', name: '合成业务领导验收', mode: '会签' }] },
    ], actions: [
      { key: 'confirm_objective', stageKey: 'objectives', title: '合成目标核对', duty: 'secretary', deliverable: '合成目标确认和证据清单', position: 50, needLeader: false },
      { key: 'accept_delivery', stageKey: 'delivery', title: '合成成果验收', duty: 'owner', deliverable: '合成最终成果及验收证据', position: 100, needLeader: true },
    ] }
}
