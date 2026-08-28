import type { TypePolicyDefinition } from '../../server/src/contracts/fdeTypePolicyContract'

// Draft-only transformations: never renumber retained identities or infer new
// dates/approvals. The shared server contract still validates the final draft.
export function nextTypeDraftKey(prefix: 'stage' | 'action' | 'material', keys: string[]) {
  const occupied = new Set(keys)
  let i = 1
  while (occupied.has(`${prefix}_${i}`)) i++
  return `${prefix}_${i}`
}

function groupedActions(config: TypePolicyDefinition, actions: TypePolicyDefinition['actions']) {
  const order = new Map(config.stages.map((stage, i) => [stage.key, i]))
  // Keep malformed/unknown references visible for validation, not silently drop.
  return [...actions].sort((a, b) => (order.get(a.stageKey) ?? Infinity) - (order.get(b.stageKey) ?? Infinity))
}

export function addTypeDraftAction(config: TypePolicyDefinition, stageKey: string): TypePolicyDefinition {
  if (!config.stages.some(stage => stage.key === stageKey)) throw new Error('行动必须关联现有阶段')
  if (config.actions.length >= 80) throw new Error('模板最多包含 80 个行动')
  const previous = config.actions.filter(action => action.stageKey === stageKey).at(-1)
  const action: TypePolicyDefinition['actions'][number] = {
    key: nextTypeDraftKey('action', config.actions.map(action => action.key)), stageKey,
    title: '', duty: 'owner', deliverable: '', position: previous?.position ?? 100, needLeader: false,
  }
  return { ...config, actions: groupedActions(config, [...config.actions, action]) }
}

export function addTypeDraftStage(config: TypePolicyDefinition): TypePolicyDefinition {
  if (config.stages.length >= 12) throw new Error('模板最多包含 12 个阶段')
  const key = nextTypeDraftKey('stage', config.stages.map(stage => stage.key))
  return addTypeDraftAction({ ...config, stages: [...config.stages, {
    key, name: '', outcome: '', allowWaiver: false, materials: [],
    approvals: [{ duty: 'owner', name: '负责人核对成果', mode: '会签' }],
  }] }, key)
}

export function moveTypeDraftStage(config: TypePolicyDefinition, index: number, direction: -1 | 1): TypePolicyDefinition {
  const target = index + direction
  if (!Number.isInteger(index) || !config.stages[index] || !config.stages[target]) return config
  const stages = [...config.stages]
  ;[stages[index], stages[target]] = [stages[target], stages[index]]
  const next = { ...config, stages }
  return { ...next, actions: groupedActions(next, config.actions) }
}

export function moveTypeDraftAction(config: TypePolicyDefinition, index: number, direction: -1 | 1): TypePolicyDefinition {
  const target = index + direction
  if (!Number.isInteger(index) || !config.actions[index] || !config.actions[target]
    || config.actions[index].stageKey !== config.actions[target].stageKey) return config
  const actions = [...config.actions]
  ;[actions[index], actions[target]] = [actions[target], actions[index]]
  return { ...config, actions }
}

export function reassignTypeDraftAction(config: TypePolicyDefinition, index: number, stageKey: string): TypePolicyDefinition {
  if (!config.actions[index] || !config.stages.some(stage => stage.key === stageKey)) throw new Error('行动或阶段不存在')
  return { ...config, actions: groupedActions(config, config.actions.map((action, i) => i === index ? { ...action, stageKey } : action)) }
}
