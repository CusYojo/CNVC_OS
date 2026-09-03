export type ProjectStage =
  | '入库' | '立项' | '尽调计划制定' | '尽调计划审核' | '启动尽调' | '内核' | '投决' | '打款' | '已 Close'
  | '线索' | '初筛' | '尽调' | '上会' | '投后' | '退出' | '放弃'
export type ProjectClassification = 'pool' | 'normal' | 'key'
export type ProjectLifecycle = 'active' | 'closed' | 'archived' | 'deleted'
export type RiskLevel = '低' | '中' | '高'
export type TaskStatus = '未开始' | '进行中' | '已完成' | '已逾期' | '已关闭' | '待验收' | '已退回' | '已取消' | '已归档'
export type JobStatus = '待处理' | '解析中' | '生成中' | '成功' | '失败' | '已取消'
export type ApprovalStatus = '草稿' | '审批中' | '已通过' | '已退回' | '已拒绝' | '已撤回'
export type ApprovalNodeStatus = '未开始' | '待审批' | '会签中' | '已通过' | '已退回' | '已拒绝' | '已跳过'
export type ApprovalAction = '提交' | '同意' | '退回' | '拒绝' | '撤回' | '转交'
export type ApprovalType = '初筛审批' | '立项审批' | '尽调计划审核' | '尽调启动审批' | '内核审批' | '打款审批' | '上会申请' | '投决审批' | '投后移交审批' | '项目终止审批' | '任务延期'
export type LeadChannel = '微信群' | '论文专利' | '院校' | '重点机构' | '新闻' | '其他'

export interface Project {
  version: number
  pinned?: boolean
  scoring?: LeadScoring
  id: string
  name: string
  companyName: string
  industry: string
  round: string
  stage: ProjectStage
  classification?: ProjectClassification
  lifecycle?: ProjectLifecycle
  workflowModel?: 'legacy' | 'fde-v1'
  ownerUserId?: string
  isParticipant?: boolean
  participantRole?: 'owner' | 'collaborator' | string | null
  investmentFund?: string
  projectType?: string
  healthStatus?: string
  targetDate?: string | null
  cycleDays?: number
  requirements?: string | null
  leaderPriority?: '高' | '中' | '低'
  confidentiality?: string
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
  stageSource?: 'OA审批' | '系统初始化' | '线索转入' | '入库完成'
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
  hasOriginal?: boolean
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
  ownerUserId?: string | null
  dueTime?: string | null
  executionModel?: string
  planActionId?: string | null
  approvalRequestId?: string | null
  version: number
  id: string
  title: string
  projectId: string
  projectName: string
  owner: string
  dueDate: string
  priority: '高' | '中' | '低'
  status: TaskStatus
  type: '待办' | '流程' | '审批' | '通知' | '会议' | '材料' | '风险' | '投后'
  meetingId?: string | null
}

export interface Meeting {
  version: number
  id: string
  projectId: string
  projectName: string
  title: string
  meetingTime: string
  meetingEndTime?: string | null
  participants: string[]
  host?: string
  type: string
  status: JobStatus | '待开始' | '进行中' | '已结束' | '已取消'
  purpose?: string
  requirements?: string
  summary: string
  conclusions: string[]
  rawText?: string
  todoCount: number
  contributions?: Array<{
    id: string
    authorId: string
    authorName: string
    content: string
    files: Array<{ id: string; name: string; version: number }>
    createdAt: string
  }>
  unreadNoticeId?: string | null
  canContribute?: boolean
  canManage?: boolean
  minutesConfirmedAt?: string | null
}

export interface RiskAlert {
  version: number
  id: string
  projectId: string
  projectName: string
  type: string
  level: RiskLevel
  description: string
  status: '待确认' | '处理中' | '已关闭' | '误报'
  owner: string
  occurredAt: string
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
  approverUserIds?: string[]
  approvedByUserIds?: string[]
  completedAt?: string
  comment?: string
}

export interface ApprovalRecord {
  id: string
  nodeId: string
  nodeName: string
  operator: string
  operatorUserId?: string
  action: ApprovalAction
  comment: string
  createdAt: string
}

export interface ApprovalRequest {
  businessType?: 'project_stage' | 'task_extension' | 'agent_schedule' | 'project_replan'
  taskId?: string | null
  businessPayload?: { originalDueDate?: string; requestedDueDate?: string }
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
  applicantUserId?: string
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
  materialSnapshot?: Array<{ requirementKey: string; fileId: string | null; fileVersion: number | null; waiverReason: string | null }>
  planId?: string
  revisions?: Array<{ id: string; revision: number; submittedBy: string; submittedAt: string; snapshot: Record<string, unknown> }>
  nodes: ApprovalNode[]
  records: ApprovalRecord[]
  lockVersion?: number
}

export interface LeadScoringDimensionItem { name: string; score: number; max: number; reason: string }
export interface LeadScoringDimension { key: string; name: string; score: number; max: number; items: LeadScoringDimensionItem[] }
export interface LeadCompetitor { name: string; is_self: boolean; tech: string; product: string; funding: string; differentiation: string; sourceUrl?: string; sourceRef?: string; evidence?: string; matchType?: 'self' | 'direct' | 'substitute'; comparisonBasis?: string; verificationStatus?: 'self' | 'evidence-backed' }
export type LeadScoreJobStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'dead_letter'
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
  companyIntroduction?: string
  claimedFoundedAt?: string
  claimedFoundedAtEvidence?: { quote: string; sourceUrl: string }
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
  registryEvidence?: Array<{
    field: string
    value: string
    quote: string
    sourceUrl: string
    evidenceStatus?: 'source_labeled' | 'derived_source_labeled'
    note?: string
  }>
  sourceLabeledProfile?: Partial<Record<
    | 'projectIntroduction'
    | 'product'
    | 'productDescription'
    | 'applicationScenario'
    | 'applicationDescription'
    | 'mainBusiness'
    | 'mainBusinessDescription'
    | 'teamIntroduction',
    {
      value: string
      quote: string
      sourceUrl: string
      sourceTitle?: string
      evidenceStatus: 'source_labeled' | 'derived_source_labeled'
      note?: string
    }
  >>
  structuredTeam?: {
    name: string
    title: string
    background: string
    sourceUrl?: string
    profileUrl?: string
    evidenceStatus?: 'source_labeled'
  }[]
  structuredShareholders?: {
    name: string
    percentage?: string
    percent?: string
    amount?: string
    date?: string
    type?: string
    sourceUrl?: string
    evidenceStatus?: 'source_labeled'
  }[]
  structuredNews?: { date: string; title: string; summary: string; sourceName: string; sourceUrl: string }[]
  scoreJob?: LeadScoreJob
  enrichment?: {
    jobId: string
    status: 'queued' | 'running' | 'snapshot_ready' | 'review' | 'rejected'
    entityType: 'company' | 'project' | 'team' | 'research' | 'unknown'
    entityStatus: 'confirmed' | 'claimed' | 'inferred' | 'ambiguous' | 'missing'
    completedTopics: number
    totalTopics: number
    topicCounts: Record<string, number>
    updatedAt: string
  }
  ratingV3?: LeadRatingV3
  dataQualityV1?: {
    schemaVersion: 'lead-data-quality-v1'
    method: 'codex-semantic-normalization-v1'
    model: string
    reviewedAt: string
    sourceStage: string
    funding: {
      stageDisplay: string
      evidenceStatus: 'source_supported' | 'source_labeled' | 'unverified' | 'not_applicable'
      amountDisplay?: string
      amountEvidenceStatus?: 'source_supported' | 'source_labeled' | 'unverified' | 'not_applicable'
    }
    businessStage: { stageDisplay: string; evidenceStatus: 'source_supported' | 'source_labeled' | 'unverified' | 'not_applicable' }
    reason: string
  }
}

export interface LeadCompanyRegistry {
  companyName?: string
  foundedAt?: string
  registeredCapital?: string
  legalRepresentative?: string
  creditCode?: string
  registrationStatus?: string
  companyType?: string
  registeredAddress?: string
  regLocation?: string
}

export type LeadRatingGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D' | '待评级'
export type LeadRatingStatus = '正式评级' | '参考评级' | '无法评级'
export type LeadRatingConfidence = '高' | '中' | '低'

export interface LeadRatingEvidence {
  content: string
  evidenceLevel: 'E1' | 'E2' | 'E3'
}

export interface LeadRatingDimension {
  key: string
  dimension: string
  weight: number
  score: number | null
  assessment: string
  keyEvidence: LeadRatingEvidence[]
  risksOrGaps: string[]
}

export interface LeadRatingV3 {
  schemaVersion: 'lead-rating-v3'
  mainView: { displayGrade: LeadRatingGrade }
  detailView: {
    project: { name: string; industry: string; stage: string }
    rating: {
      grade: Exclude<LeadRatingGrade, '待评级'> | null
      status: LeadRatingStatus
      score: number | null
      informationCoverage: number
      confidence: LeadRatingConfidence
      oneSentenceJudgment: string
      coreTags: string[]
      recommendedAction: string
    }
    evidenceSummary: {
      confirmedFacts: string[]
      unverifiedCompanyClaims: string[]
      conflictingInformation: string[]
      criticalMissingInformation: string[]
    }
    dimensionScores: LeadRatingDimension[]
    investmentThesis: Array<{ thesis: string; supportingBasis: string; necessaryConditions: string[] }>
    keyRisks: string[]
    failureScenario: string[]
    investmentRedFlags: string[]
    transactionValue: {
      valuationInformationAvailable: boolean
      termsInformationAvailable: boolean
      assessment: string
    }
    dueDiligence: {
      P0: Array<{ question: string; requiredMaterialOrMethod: string }>
      P1: Array<{ question: string; requiredMaterialOrMethod: string }>
      P2: Array<{ question: string; requiredMaterialOrMethod: string }>
    }
    ratingSystemImprovements: string[]
  }
  computed: {
    score: number | null
    assessableWeight: number
    informationCoverage: number
    ratingStatus: LeadRatingStatus
  }
  scoreJob?: LeadScoreJob
  scoredAt?: string
}

export interface LeadPoolLatestUpdate {
  occurredAt: string
  title: string
  sourceUrl?: string
}

export interface LeadPoolRatingSummary {
  displayGrade: LeadRatingGrade
  status: 'ready' | 'pending' | 'running' | 'failed' | 'stale'
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

export interface PaperAffiliation {
  name: string
  sourceUrl: string
  evidenceStatus: 'source_confirmed'
}

export interface PaperAuthorContribution {
  author: string
  role: 'joint_first_author' | 'joint_senior_author' | 'sole_author' | 'first_author' | 'corresponding_author' | 'coauthor'
  label: string
}

export interface PaperAuthorIdentity {
  name: string
  normalizedName?: string
  position?: number
  role?: PaperAuthorContribution['role']
  openAlexAuthorId?: string
  orcid?: string
  affiliations?: Array<{ id?: string; name: string; evidenceUrl?: string }>
  identityStatus?: 'confirmed' | 'claimed' | 'ambiguous'
  evidenceUrl?: string
}

export interface PaperAuthorAffiliation {
  author: string
  authorOpenAlexId?: string
  affiliation: string
  institutionOpenAlexId?: string
  evidenceUrl: string
  status: 'source_confirmed'
}

export interface PaperResearchRights {
  articleLicense?: {
    code: string
    label: string
    url: string
    status: 'confirmed'
    scope: 'article'
  }
  dataset?: { url: string; licenseStatus: 'pending' | 'confirmed'; license?: string }
  code?: { url: string; licenseStatus: 'pending' | 'confirmed'; license?: string }
  intellectualProperty: {
    status: 'undisclosed' | 'confirmed'
    label: string
    note: string
    owner?: string
    sourceUrl?: string
  }
}

export interface PaperMetadata {
  title?: string
  titleOriginal?: string
  titleZh?: string
  projectName?: string
  projectNameOriginal?: string
  abstract?: string
  abstractOriginal?: string
  abstractZh?: string
  authors?: string[]
  firstAuthor?: string
  secondAuthor?: string
  categories?: string[]
  venue?: string
  comment?: string
  pdfUrl?: string
  publishedAt?: string
  declaredPublishedAt?: string
  publicationDateStatus?: 'confirmed' | 'source_declared_future'
  publicationDateBasis?: 'publisher_published_at' | 'metadata_record_created_at'
  doi?: string
  resourceType?: string
  affiliations?: PaperAffiliation[]
  paperAuthors?: PaperAuthorIdentity[]
  authorAffiliations?: PaperAuthorAffiliation[]
  researchTeam?: { name: string; basis: 'paper_coauthorship'; memberCount: number }
  authorContributions?: PaperAuthorContribution[]
  rights?: PaperResearchRights
  metadataSource?: { url: string; provider?: string; recordCreatedAt?: string; declaredPublishedAt?: string; publicationDateStatus?: 'confirmed' | 'source_declared_future'; publicationDateBasis?: 'publisher_published_at' | 'metadata_record_created_at' }
}

export interface LeadResearchProfile {
  schemaVersion: 'lead-research-profile-v1'
  projectionVersion: 'lead-research-profile-projection-v1'
  subject: { leadId: string; type: 'research'; name: string; title?: string; provider?: string; providerIds: Record<string, string> }
  direction: { categories: string[]; researchProblem?: string; methods: string[] }
  team: { authors: Array<{ name: string; role?: string; openAlexAuthorId?: string; orcid?: string }>; affiliations: string[] }
  progress: { venue?: string; publishedAt?: string; resourceType?: string; codeUrl?: string; datasetUrl?: string; modelUrl?: string; reproducibility?: string }
  valueAndTransfer: { applicationScenarios: string[]; trl?: string; prototype?: string; validation?: string; commercialization?: string; transferStatus?: string; spinOff?: string; partners: string[] }
  rights: { articleLicense?: string; datasetLicense?: string; codeLicense?: string; modelLicense?: string; patents: string[]; intellectualProperty?: string }
  latestDevelopments: Array<{ title: string; occurredAt?: string; sourceUrl?: string }>
  dataStatus: { status: 'verified' | 'partial' | 'missing' | 'conflicted' | 'stale'; verifiedDimensions: number; applicableDimensions: number; conflictCount: number; source: 'paper_metadata' | 'snapshot' | 'paper_metadata+snapshot'; updatedAt?: string }
}

export interface Lead {
  id: string
  name: string
  companyName: string
  channel: LeadChannel
  poolStatus?: '公共池' | '已转专属项目' | '已注销' | '已删除' | '已合并' | '解析失败'
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
  leadType?: 'company' | 'research'
  stageDisplay?: string
  fundingStatusDisplay?: '已融资' | '未融资' | '未披露' | '待核验' | '不适用'
  businessStageDisplay?: string
  stageEvidenceStatus?: 'source_supported' | 'source_labeled' | 'unverified' | 'not_applicable'
  teamSizeDisplay?: string
  foundedAtDisplay?: string
  companyRegistry?: LeadCompanyRegistry
  backgroundTags?: string[]
  latestUpdates?: LeadPoolLatestUpdate[]
  rating?: LeadPoolRatingSummary
  scoreJob?: LeadScoreJob | null
  /** 首次进入公共线索池的时间；“最新入池”排序和列表展示统一使用该字段。 */
  poolEnteredAt?: string
  dataUpdatedAt?: string
  investmentProfile?: {
    profileSchemaVersion?: 'lead-investment-profile-v1'
    enrichmentSchemaVersion?: string
    projectionVersion?: string
    dictionaryBinding?: { industryHash?: string; institutionHash?: string; customerHash?: string; academicHash?: string }
    subject?: { leadId: string; name: string; legalEntityName?: string; subjectType: string; region?: string; profileReviewStatus?: 'clear' | 'review' }
    schemaVersion: 'lead-investment-profile-v1'
    snapshotId?: string
    snapshotHash?: string
    industry: { level1?: string; level2?: string; segment?: string; chainPosition?: string }
    products: Array<{
      instanceKey?: string; name: string; productRoute?: string; technologyRoute?: string; productionStage?: string;
      productionStageStatus?: 'planned' | 'realized' | 'undisclosed';
    }>
    productTotalCount?: number
    institutions: Array<{ institutionId?: string; name: string; round?: string; role: 'lead' | 'follow' | 'strategic' | 'undisclosed'; type?: string; tier?: string; major: boolean }>
    institutionTotalCount?: number
    academicLinks: Array<{ instanceKey?: string; institution: string; relationType: string; person?: string; departmentLab?: string; validFrom?: string; validTo?: string; current?: boolean; commercialization: boolean }>
    academicLinkTotalCount?: number
    financing: {
      status: string; latestRound?: string; latestRoundDate?: string; latestAmount?: string;
      latestAmountValue?: number; latestAmountCurrency?: string; cumulativeAmount?: string;
      cumulativeAmountValue?: number; completedRoundCount: number; latestCompletedRound?: string; latestCompletedAt?: string;
      latestAmountSummary?: { raw?: string; value?: string; minValue?: string; maxValue?: string; unit?: string; currency?: string; undisclosed?: boolean };
      cumulativeAmountByCurrency?: Array<{ currency: string; value: string; completedRoundCount: number }>
    }
    valuation: { value?: string; numericValue?: number; type?: 'pre_money' | 'post_money' | 'planned' | 'estimated' | 'undisclosed'; currency?: string; date?: string; round?: string }
    customers: {
      highestStage?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'; verifiedCount: number;
      tierACount: number; tierBCount: number; tierCCount: number;
      mentionedCount?: number; engagedCount?: number; trialCount?: number; contractedCount?: number; deliveredCount?: number; payingCount?: number;
      verifiedCustomerCount?: number; customerTotalCount?: number;
      representatives: Array<{ customerId?: string; name: string; displayName?: string; tier?: 'A' | 'B' | 'C'; stage: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'; anonymized: boolean }>
    }
    dataStatus: {
      verifiedDimensions: number; applicableDimensions: number; conflictCount: number;
      status: 'verified' | 'partial' | 'conflicted' | 'missing' | 'not_applicable' | 'stale'; updatedAt?: string;
      dimensionStates?: Record<string, 'verified' | 'partial' | 'conflicted' | 'missing' | 'not_applicable'>;
      stale?: boolean; staleReason?: string; factUpdatedAt?: string; sourceFreshnessAt?: string; snapshotCreatedAt?: string; projectedAt?: string
    }
  }
  researchProfile?: LeadResearchProfile
  completeness: number
  verificationStatus: '已核验' | '部分核验' | '待核验'
  lastVerifiedAt: string
  riskTags: string[]
  status: JobStatus
  summary: string
  /** 详情页使用的完整项目介绍；列表仍使用 summary 一句话摘要。 */
  projectIntroduction?: string
  projectIntroductionSourceUrl?: string
  projectLogoUrl?: string
  team: string
  product: string
  financing: string
  highlights: string[]
  risks: string[]
  suggestion: string
  shareholders: { name: string; percentage: string; type: string; sourceUrl?: string }[]
  founders: { name: string; title: string; background: string }[]
  fundingRounds: {
    round: string
    roundRaw?: string
    date: string
    amount: string
    amountRaw?: string
    currency?: 'CNY' | 'USD' | ''
    valuation: string
    investors: string[]
    leadInvestors?: string[]
    sourceUrl: string
    evidenceQuote?: string
    evidenceStatus?: 'source_labeled' | 'source_supported' | 'conflicting'
    extractionMethod?: string
    extractorVersion?: string
    idempotencyKey?: string
  }[]
  companyNews: { date: string; type: string; title: string; summary: string; sourceName: string; sourceUrl: string }[]
  sources: SourceEvidence[]
  scoring?: LeadScoring
  radarProfile?: { decisionLabel?: string; thesis?: string; sourceName?: string; sourceGroup?: string; sourceTitle?: string; sourceId?: string; channel?: string; accountName?: string; publishedAt?: string; profile?: Record<string,string>; team?: { name: string }[]; radarDimensions?: { code: string; label: string; score: number; maxScore: number; detail: string }[]; radarScore?: number; disclosure?: Record<string,string>; nextActions?: string[]; signals?: { code: string; score: number; detail: string }[]; articleText?: string; articleTextLength?: number; link?: string; paperMeta?: PaperMetadata }
}

export type LeadListItem = Pick<Lead,
  'id' | 'name' | 'companyName' | 'region' | 'leadType' | 'businessTags'
  | 'poolEnteredAt' | 'dataUpdatedAt' | 'latestUpdates'
> & {
  radarProfile?: {
    channel?: string
    link?: string
    publishedAt?: string
    profile?: { lab?: string }
    paperMeta?: Pick<PaperMetadata,
      'titleZh' | 'projectName' | 'projectNameOriginal' | 'authors' | 'categories' | 'pdfUrl' | 'rights'
    >
  }
  investmentProfile?: NonNullable<Lead['investmentProfile']>
  researchProfile?: LeadResearchProfile
  /** 投资画像缺项时使用的已有公开资料；不改变画像的验证状态。 */
  availableData?: {
    dataStatus: 'candidate'
    verificationStatus: 'unverified'
    displayLabel: string
    sourceKinds: Array<'intake' | 'web_research'>
    conflictFields: Array<'financing'>
    industryTags: string[]
    products: Array<{
      name: string
      productRoute?: string
      technologyRoute?: string
      productionStage?: string
      productionStageStatus?: 'planned' | 'realized' | 'undisclosed'
    }>
    institutions: Array<{
      name: string
      round?: string
      role: 'lead' | 'follow' | 'strategic' | 'undisclosed'
      major: boolean
    }>
    academicLinks: Array<{
      institution: string
      relationType: string
      person?: string
      commercialization: boolean
    }>
    financing?: {
      status?: string
      latestRound?: string
      latestRoundDate?: string
      latestAmount?: string
      cumulativeAmount?: string
      completedRoundCount?: number
    }
    valuation?: {
      value?: string
      type?: 'pre_money' | 'post_money' | 'planned' | 'estimated' | 'undisclosed'
      currency?: string
      date?: string
      round?: string
    }
  }
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

export interface User {
  id: string
  name: string
  email: string
  department: string
  role: string
  status: '待审核' | '启用' | '禁用'
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
