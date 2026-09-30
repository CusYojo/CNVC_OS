export type SaiAgentContextKind =
  | 'workspace'
  | 'project'
  | 'discovery'
  | 'institution'
  | 'due-diligence'
  | 'collaboration'
  | 'workflow'
  | 'knowledge'
  | 'ai'

export type SaiAgentContext = {
  kind: SaiAgentContextKind
  label: string
  detail: string
  path: string
  projectId?: string
  projectName?: string
}

export type SaiAgentAction = {
  id: string
  label: string
  description: string
  kind: 'prompt' | 'navigate' | 'approval'
  value: string
}

type ProjectSummary = {
  id: string
  name: string
  companyName?: string
  stage?: string
  lifecycle?: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const projectTabLabels: Record<string, string> = {
  overview: '项目概览',
  workflow: '项目流程',
  files: '项目材料',
  tasks: '项目任务',
  collaboration: '项协作',
  intelligence: '项目情报',
  summary: '项目摘要',
  risks: '项目风险',
}

function context(
  kind: SaiAgentContextKind,
  label: string,
  detail: string,
  path: string,
  project?: ProjectSummary,
): SaiAgentContext {
  return {
    kind,
    label,
    detail,
    path,
    ...(project ? { projectId: project.id, projectName: project.name } : {}),
  }
}

export function resolveSaiAgentContext(
  pathname: string,
  search: string,
  projects: readonly ProjectSummary[],
): SaiAgentContext {
  const params = new URLSearchParams(search)
  const path = `${pathname}${search}`
  const projectId = pathname.match(/^\/projects\/([^/]+)$/)?.[1]

  if (projectId && UUID_PATTERN.test(projectId)) {
    const project = projects.find((item) => item.id === projectId && item.lifecycle !== 'deleted')
    if (project) {
      const tab = params.get('tab') || 'overview'
      return context('project', project.name, `${project.stage || '未分阶段'} · ${projectTabLabels[tab] || '项目工作区'}`, path, project)
    }
  }

  if (pathname === '/projects/boss-dashboard') return context('workspace', '管理驾驶舱', '组织级项目视图', path)
  if (pathname === '/projects' && params.get('view') === 'discover') return context('discovery', '新项目发现', '候选项目研判', path)
  if (pathname === '/projects' && params.get('view') === 'leads') return context('discovery', '线索池', '项目线索筛选', path)
  if (pathname === '/projects') return context('workspace', '项目中心', '项目组合与进展', path)
  if (pathname.startsWith('/institutions')) return context('institution', '机构追踪', pathname === '/institutions' ? '投资机构全景' : '机构详情', path)
  if (pathname.startsWith('/due-diligence')) return context('due-diligence', '尽调工作台', '证据、访谈与核查', path)
  if (pathname === '/meetings' || pathname === '/committee' || pathname === '/collaboration') return context('collaboration', '任务与日历', '协作、会议与计划', path)
  if (pathname === '/workflow') return context('workflow', '申请与记录', '待办审批与流程', path)
  if (pathname === '/knowledge' || pathname.startsWith('/responsibility')) return context('knowledge', '知识库', '制度、档案与知识', path)
  if (pathname === '/ai') return context('ai', 'AI 智能助手', '完整 Agent 工作台', path)
  return context('workspace', '今日工作台', '全局工作台', path)
}

const sharedOpenAi: SaiAgentAction = {
  id: 'open-ai',
  label: '进入完整 AI 助手',
  description: '处理复杂任务与材料',
  kind: 'navigate',
  value: '/ai',
}

export function getSaiAgentActions(current: SaiAgentContext): SaiAgentAction[] {
  if (current.kind === 'project') return [
    { id: 'project-brief', label: '一页研判', description: '提炼价值、证据与疑点', kind: 'prompt', value: '请基于当前项目已有材料，给出一页式投资研判，区分已验证事实、待核实主张和你的推断。' },
    { id: 'project-risks', label: '风险与缺口', description: '找出证据冲突和遗漏', kind: 'prompt', value: '请检查当前项目的重大风险、证据冲突和材料缺口，按严重性排序并给出核验方法。' },
    { id: 'project-next', label: '下一步行动', description: '拆成负责人可执行的计划', kind: 'prompt', value: '请结合当前项目阶段，草拟下一步行动清单，包括优先级、建议负责角色、完成标准和依赖。不要直接创建任务。' },
  ]
  if (current.kind === 'discovery') return [
    { id: 'screen-candidates', label: '筛选值得关注的项目', description: '从壁垒、团队与信号切入', kind: 'prompt', value: '请梳理当前页面的候选项目，提出值得优先关注的标的及理由，严格区分事实与推断。' },
    { id: 'compare-leads', label: '生成对比维度', description: '先对齐口径，再做比较', kind: 'prompt', value: '请为当前候选项目设计一套可比的评估维度，并标出缺失数据和不可比项。' },
    sharedOpenAi,
  ]
  if (current.kind === 'due-diligence') return [
    { id: 'dd-checklist', label: '草拟尽调核查清单', description: '先生成草案，确认后再写入', kind: 'prompt', value: '请根据当前尽调情境草拟分优先级的核查清单，每项包含目标、所需证据和完成标准，暂不写入系统。' },
    { id: 'evidence-conflicts', label: '发现证据矛盾', description: '聚焦口径冲突与待追问项', kind: 'prompt', value: '请寻找当前尽调材料中的证据冲突、异常口径和待追问事项，并说明核验路径。' },
    { id: 'open-knowledge', label: '查看知识库', description: '对照制度与历史档案', kind: 'navigate', value: '/knowledge' },
  ]
  if (current.kind === 'collaboration') return [
    { id: 'today-plan', label: '整理今日节奏', description: '会议、任务与阻塞点', kind: 'prompt', value: '请帮我整理今日的会议、任务和阻塞点，给出按时间与优先级排列的建议。' },
    { id: 'meeting-prep', label: '会前准备', description: '生成议程、问题与材料清单', kind: 'prompt', value: '请根据当前会议与项目上下文，草拟会前议程、必问问题和应准备材料。' },
    sharedOpenAi,
  ]
  if (current.kind === 'workflow') return [
    { id: 'approval-summary', label: '梳理待审事项', description: '先看风险和决策点', kind: 'prompt', value: '请从决策人视角梳理当前待办事项需关注的风险、证据和决策点，不要代替我审批。' },
    { id: 'open-approvals', label: '打开待我审批', description: '直接进入审批工作台', kind: 'approval', value: 'inbox' },
    sharedOpenAi,
  ]
  if (current.kind === 'institution') return [
    { id: 'institution-map', label: '提炼机构偏好', description: '阶段、赛道与投资节奏', kind: 'prompt', value: '请基于可用的机构记录，提炼投资偏好、活跃阶段和可验证的共投线索。' },
    { id: 'institution-followup', label: '草拟跟进计划', description: '不直接联系或写入', kind: 'prompt', value: '请草拟对当前机构的跟进计划，包括目标、切入点、材料和节奏，不要直接发送消息或创建任务。' },
    sharedOpenAi,
  ]
  if (current.kind === 'knowledge') return [
    { id: 'knowledge-answer', label: '从知识库找答案', description: '优先引用可追溯材料', kind: 'prompt', value: '请根据当前知识库中可追溯的材料回答，明确列出依据、缺口和不确定性。' },
    { id: 'policy-check', label: '对照制度检查', description: '找出适用条款与例外', kind: 'prompt', value: '请帮我对照制度和职责文档进行检查，列出适用条款、例外和需要人工确认的点。' },
    sharedOpenAi,
  ]
  return [
    { id: 'daily-brief', label: '梳理今日重点', description: '项目、任务、会议与风险', kind: 'prompt', value: '请帮我梳理今天最需要关注的项目、任务、会议和风险，按优先级给出简洁行动建议。' },
    { id: 'open-approvals', label: '打开待我审批', description: '直接进入审批工作台', kind: 'approval', value: 'inbox' },
    sharedOpenAi,
  ]
}

export function buildSaiAgentPrompt(current: SaiAgentContext, userGoal: string): string {
  const projectContext = current.projectId
    ? `\n【当前项目】${current.projectName}\n【项目 ID】${current.projectId}`
    : ''
  return [
    '你正在赛智伯乐工作空间的“小赛”轻量 Agent 控制台中协助用户。',
    `【当前页面】${current.label}（${current.detail}）`,
    `【页面路径】${current.path}${projectContext}`,
    `【用户目标】${userGoal.trim()}`,
    '【安全边界】默认只读：先检索、分析、引用与草拟。任何创建、修改、删除、发送、审批、数据回填或其他业务写入，必须先明确列出计划、影响范围和可回退方式，等待用户确认后再执行。',
    '【回答方式】先给结论，再给依据和下一步；区分已验证事实、推断与待核实项，不要编造系统中不存在的信息。',
  ].join('\n')
}

export function extractSaiPromptGoal(message: string): string {
  const match = message.match(/【用户目标】([\s\S]*?)\n【安全边界】/)
  return match?.[1]?.trim() || message
}

export function getSaiConversationScopeKey(current: SaiAgentContext): string {
  return current.projectId ? `project:${current.projectId}` : 'global'
}
