export type ProjectStage = '线索' | '初筛' | '立项' | '尽调' | '上会' | '投决' | '投后' | '退出' | '放弃'
export type RiskLevel = '低' | '中' | '高'
export type TaskStatus = '未开始' | '进行中' | '已完成' | '已逾期'
export type JobStatus = '待处理' | '解析中' | '生成中' | '成功' | '失败' | '已取消'
export type ApprovalStatus = '草稿' | '审批中' | '已通过' | '已退回' | '已拒绝' | '已撤回'
export type ApprovalNodeStatus = '未开始' | '待审批' | '会签中' | '已通过' | '已退回' | '已拒绝' | '已跳过'
export type ApprovalAction = '提交' | '同意' | '退回' | '拒绝' | '撤回' | '转交'
export type ApprovalType = '初筛审批' | '立项审批' | '尽调启动审批' | '上会申请' | '投决审批' | '投后移交审批' | '项目终止审批'
export type LeadChannel = '微信群' | '论文专利' | '院校' | '重点机构' | '新闻' | '其他'

export interface Project {
  pinned?: boolean
  scoring?: LeadScoring
  id: string
  name: string
  companyName: string
  industry: string
  round: string
  stage: ProjectStage
  owner: string
  collaborators: string[]
  source: string
  financing: string
  valuation: string
  riskLevel: RiskLevel
  summary: string
  score: number
  updatedAt: string
  createdAt: string
  tags: string[]
  businessModel: string
  market: string
  team: string
  progress: number
  stageSource?: 'OA审批' | '系统初始化' | '线索转入'
  latestApprovalId?: string
}

export interface ProjectFile {
  id: string
  projectId?: string
  name: string
  type: string
  category: string
  size: string
  uploader: string
  uploadedAt: string
  parseStatus: JobStatus
  version: number
  visibility: string
}

export interface AISummary {
  projectId: string
  positioning: string
  highlights: string[]
  risks: string[]
  questions: string[]
  missing: string[]
  confidence: number
  sources: string[]
  updatedAt: string
}

export interface Todo {
  id: string
  title: string
  projectId: string
  projectName: string
  owner: string
  dueDate: string
  priority: '高' | '中' | '低'
  status: TaskStatus
  type: '流程' | '会议' | '材料' | '风险' | '投后'
}

export interface Meeting {
  id: string
  projectId: string
  projectName: string
  title: string
  meetingTime: string
  participants: string[]
  type: string
  status: JobStatus
  summary: string
  conclusions: string[]
  rawText?: string
  todoCount: number
}

export interface RiskAlert {
  id: string
  projectId: string
  projectName: string
  type: string
  level: RiskLevel
  description: string
  status: '待确认' | '处理中' | '已关闭' | '误报'
  owner: string
  occurredAt: string
  suggestion: string
}

export interface WorkflowLog {
  id: string
  projectId: string
  fromStage: ProjectStage
  toStage: ProjectStage
  operator: string
  comment: string
  createdAt: string
  requestId?: string
  requestNo?: string
  source?: 'OA审批' | '系统初始化' | '管理员修正'
}

export interface ApprovalNode {
  id: string
  name: string
  approver: string
  approverRole: string
  mode: '或签' | '会签'
  sequence: number
  status: ApprovalNodeStatus
  approvedBy?: string[]
  completedAt?: string
  comment?: string
}

export interface ApprovalRecord {
  id: string
  nodeId: string
  nodeName: string
  operator: string
  action: ApprovalAction
  comment: string
  createdAt: string
}

export interface ApprovalRequest {
  id: string
  requestNo: string
  projectId: string
  projectName: string
  title: string
  type: ApprovalType
  fromStage: ProjectStage
  targetStage: ProjectStage
  status: ApprovalStatus
  applicant: string
  department: string
  priority: '普通' | '紧急'
  currentNodeId?: string
  currentNodeName: string
  reason: string
  amount?: string
  valuation?: string
  submittedAt: string
  completedAt?: string
  attachments: string[]
  checklist: { label: string; passed: boolean; required: boolean }[]
  nodes: ApprovalNode[]
  records: ApprovalRecord[]
}

export interface MaterialJob {
  id: string
  projectId: string
  projectName: string
  type: string
  template: string
  version: string
  status: JobStatus
  progress: number
  createdBy: string
  createdAt: string
  outputUrl?: string
}

export interface LeadScoringDimensionItem { name: string; score: number; max: number; reason: string }
export interface LeadScoringDimension { key: string; name: string; score: number; max: number; items: LeadScoringDimensionItem[] }
export interface LeadCompetitor { name: string; is_self: boolean; tech: string; product: string; funding: string; differentiation: string; sourceUrl?: string }
export type LeadScoreJobStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed'
export interface LeadScoreJob {
  status: LeadScoreJobStatus
  attempts: number
  maxAttempts: number
  retryCycles?: number
  queuedAt?: string
  startedAt?: string
  updatedAt: string
  completedAt?: string
  nextRetryAt?: string
  error?: string
}
export interface LeadScoring {
  total: number
  verdict: string
  overall_comment: string
  dimensions: LeadScoringDimension[]
  rank?: { peers_count: number; position: number; percentile: number; industry: string }
  scored_at?: string
  competitors?: LeadCompetitor[]
  projectName?: string
  whatIsIt?: string
  officialSite?: string
  fundingRoundsResearched?: Array<{ round: string; date: string; amount: string; valuation: string; investors: string; sourceUrl?: string }>
  researchSources?: Array<{ title: string; url: string; excerpt: string }>
  registry?: Record<string,string>
  structuredTeam?: { name: string; title: string; background: string }[]
  structuredShareholders?: { name: string; percentage: string; type: string; sourceUrl?: string }[]
  structuredNews?: { date: string; title: string; summary: string; sourceName: string; sourceUrl: string }[]
  scoreJob?: LeadScoreJob
}

export interface LeadValuationDisplay {
  value?: string
  status: 'available' | 'pending' | 'unavailable'
  sourceUrl?: string
  sourceLabel?: string
}

export interface LeadTechnicalScore {
  score?: number
  maxScore?: number
  status: 'ready' | 'pending'
}

export interface Lead {
  id: string
  name: string
  companyName: string
  channel: LeadChannel
  poolStatus?: '公共池' | '已转专属项目'
  claimedBy?: string
  convertedProjectId?: string
  source: string
  sourceUrl: string
  industry: string
  round: string
  region: string
  businessRegion?: string
  businessRegionSource?: string
  businessRegionConfidence?: '高' | '中'
  regionSource?: string
  regionConfidence?: '高' | '中'
  website: string
  foundedAt: string
  registeredCapital: string
  legalRepresentative: string
  creditCode: string
  registrationStatus: string
  registeredAddress: string
  companyType: string
  score: number
  /** 由后端根据 scoring.dimensions 派生；新同步但尚未评分的线索为 pending。 */
  analysisStatus?: 'pending' | 'ready'
  /** 公共池首页使用的轻量业务标签；最简版由后端按现有行业和注册地派生。 */
  businessTags?: { industry: string[]; region: string[] }
  valuationDisplay?: LeadValuationDisplay
  technicalScore?: LeadTechnicalScore
  scoreJob?: LeadScoreJob | null
  /** 首次进入公共线索池的时间；“最新入池”排序和列表展示统一使用该字段。 */
  poolEnteredAt?: string
  dataUpdatedAt?: string
  completeness: number
  verificationStatus: '已核验' | '部分核验' | '待核验'
  lastVerifiedAt: string
  riskTags: string[]
  status: JobStatus
  summary: string
  team: string
  product: string
  financing: string
  highlights: string[]
  risks: string[]
  suggestion: string
  shareholders: { name: string; percentage: string; type: string; sourceUrl?: string }[]
  founders: { name: string; title: string; background: string }[]
  fundingRounds: { round: string; date: string; amount: string; valuation: string; investors: string[]; sourceUrl: string }[]
  companyNews: { date: string; type: string; title: string; summary: string; sourceName: string; sourceUrl: string }[]
  sources: SourceEvidence[]
  scoring?: LeadScoring
  radarProfile?: { decisionLabel?: string; thesis?: string; sourceName?: string; sourceGroup?: string; sourceTitle?: string; channel?: string; accountName?: string; publishedAt?: string; profile?: Record<string,string>; team?: { name: string }[]; radarDimensions?: { code: string; label: string; score: number; maxScore: number; detail: string }[]; radarScore?: number; disclosure?: Record<string,string>; nextActions?: string[]; signals?: { code: string; score: number; detail: string }[]; articleText?: string; articleTextLength?: number; link?: string; paperMeta?: { title?: string; titleOriginal?: string; titleZh?: string; abstract?: string; abstractOriginal?: string; abstractZh?: string; authors?: string[]; firstAuthor?: string; secondAuthor?: string; categories?: string[]; venue?: string; comment?: string; pdfUrl?: string; publishedAt?: string } }
}

export interface SourceEvidence {
  id: string
  title: string
  url: string
  publisher: string
  publishedAt?: string
  accessedAt: string
  category: '官网' | '监管/政府' | '企业材料' | '权威媒体' | '第三方数据库'
  reliability: '高' | '中' | '待核验'
  excerpt: string
}

export interface PostUpdate {
  id: string
  projectId: string
  period: string
  revenue: string
  grossMargin: string
  cashFlow: string
  milestone: string
  updatedAt: string
}

export interface User {
  id: string
  name: string
  email: string
  department: string
  role: string
  status: '启用' | '禁用'
  lastLogin: string
}

export interface Template {
  id: string
  name: string
  type: string
  version: string
  status: '启用' | '停用'
  updatedAt: string
}

export interface AuditLog {
  id: string
  user: string
  module: string
  action: string
  target: string
  ip: string
  createdAt: string
}

export interface Notification {
  id: string
  title: string
  content: string
  type: string
  isRead: boolean
  createdAt: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
  confidence?: number
  createdAt: string
  pptJobId?: string
  pptUrl?: string
  pptStatus?: 'running' | 'done' | 'failed'
  pptProgress?: string
}
