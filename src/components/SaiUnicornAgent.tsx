import {
  ArrowUp,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileSearch,
  ListChecks,
  Mic,
  MicOff,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useJwAgent } from '../hooks/useJwAgent'
import { extractTextParts, normalizeAgentMessages } from '../lib/aiMessageSafety'
import { apiDelete, apiGet, apiPost } from '../lib/api'
import { openApproval } from '../lib/approvalWorkspace'
import {
  buildSaiAgentPrompt,
  buildSaiWorkspaceSnapshot,
  buildSaiTurnReceipt,
  extractSaiPromptGoal,
  getSaiAgentActions,
  getSaiConversationScopeKey,
  needsSaiWorkspaceSnapshot,
  resolveSaiAgentContext,
  resolveSaiNavigationAction,
  resolveSaiCreateAction,
  resolveSaiToolMode,
  resolveSaiUploadAction,
  type SaiAgentAction,
} from '../lib/saiAgent'
import { useAppStore } from '../store/useAppStore'
import { useSaiPageContext } from '../store/useSaiPageContext'
import './SaiUnicornAgent.css'

type ConversationRow = {
  id: string
  agentId?: string
  title: string
}

type SpeechRecognizer = {
  lang: string
  continuous: boolean
  interimResults: boolean
  processLocally?: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognizerConstructor = {
  new (): SpeechRecognizer
  available?: (options: { langs: string[]; processLocally: boolean; quality: 'dictation' | 'command' }) => Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>
  install?: (options: { langs: string[]; processLocally: boolean; quality: 'dictation' | 'command' }) => Promise<boolean>
}

const actionIcons = {
  'project-brief': BrainCircuit,
  'project-risks': FileSearch,
  'project-next': ListChecks,
  'screen-candidates': FileSearch,
  'compare-leads': BrainCircuit,
  'dd-checklist': ListChecks,
  'evidence-conflicts': FileSearch,
  'today-plan': ListChecks,
  'meeting-prep': BrainCircuit,
  'approval-summary': FileSearch,
  'open-approvals': ListChecks,
  'institution-map': BrainCircuit,
  'institution-followup': ListChecks,
  'knowledge-answer': FileSearch,
  'policy-check': ShieldCheck,
  'daily-brief': Sparkles,
  'open-knowledge': ExternalLink,
  'open-ai': ExternalLink,
} as const

function ActionIcon({ action }: { action: SaiAgentAction }) {
  const Icon = actionIcons[action.id as keyof typeof actionIcons] ?? Sparkles
  return <Icon aria-hidden="true" />
}

function formatAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  if (!message) return '小赛暂时无法响应，请稍后重试。'
  return message.length > 120 ? `${message.slice(0, 120)}…` : message
}

function formatSpeechError(error: string): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') return '麦克风权限未开启，请在浏览器地址栏允许麦克风后重试。'
  if (error === 'audio-capture') return '未检测到可用麦克风，请检查设备连接。'
  if (error === 'network') return '语音识别服务暂时无法连接，请稍后重试或使用文字输入。'
  if (error === 'no-speech') return '没有听清语音，请靠近麦克风后重试。'
  return '语音识别未完成，请重试或使用文字输入。'
}

export function SaiUnicornAgent() {
  const location = useLocation()
  const navigate = useNavigate()
  const projects = useAppStore((state) => state.projects)
  const todos = useAppStore((state) => state.todos)
  const meetings = useAppStore((state) => state.meetings)
  const approvalRequests = useAppStore((state) => state.approvalRequests)
  const risks = useAppStore((state) => state.risks)
  const discoverySnapshot = useSaiPageContext((state) => state.discoverySnapshot)
  const reviewSnapshot = useSaiPageContext((state) => state.reviewSnapshot)
  const knowledgeSnapshot = useSaiPageContext((state) => state.knowledgeSnapshot)
  const institutionSnapshot = useSaiPageContext((state) => state.institutionSnapshot)
  const institutionName = useSaiPageContext((state) => state.institutionName)
  const dueDiligenceSnapshot = useSaiPageContext((state) => state.dueDiligenceSnapshot)
  const dueDiligenceProject = useSaiPageContext((state) => state.dueDiligenceProject)
  const [open, setOpen] = useState(false)
  const [composer, setComposer] = useState('')
  const [agentId, setAgentId] = useState<string>()
  const [sending, setSending] = useState(false)
  const [localError, setLocalError] = useState<string>()
  const [listening, setListening] = useState(false)
  const [speechError, setSpeechError] = useState<string>()
  const [localSpeechStatus, setLocalSpeechStatus] = useState<'available' | 'downloadable' | 'downloading' | 'unavailable'>()
  const [localSpeechQuality, setLocalSpeechQuality] = useState<'dictation' | 'command'>('command')
  const [installingLocalSpeech, setInstallingLocalSpeech] = useState(false)
  const [offerLocalSpeech, setOfferLocalSpeech] = useState(false)
  const [preferLocalSpeech, setPreferLocalSpeech] = useState(false)
  const [interactionAnswers, setInteractionAnswers] = useState<Record<string, string | string[]>>({})
  const [turnReceipt, setTurnReceipt] = useState<(
    ReturnType<typeof buildSaiTurnReceipt> & { assistantBaseline: number }
  )>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const recognizerRef = useRef<SpeechRecognizer | null>(null)
  const agent = useJwAgent(agentId)

  const currentContext = useMemo(
    () => {
      const context = resolveSaiAgentContext(location.pathname, location.search, projects)
      if (context.kind === 'institution' && institutionName && location.pathname !== '/institutions') return { ...context, detail: `${institutionName} · ${context.detail}` }
      return context.kind === 'due-diligence' && dueDiligenceProject
        ? { ...context, projectId: dueDiligenceProject.id, projectName: dueDiligenceProject.name, detail: `${dueDiligenceProject.name} · ${context.detail}` }
        : context
    },
    [location.pathname, location.search, projects, dueDiligenceProject, institutionName],
  )
  const conversationScopeKey = getSaiConversationScopeKey(currentContext)
  const conversationScopeRef = useRef(conversationScopeKey)
  const pendingConversationRef = useRef<{ scope: string; promise: Promise<string | null> } | null>(null)
  const draftConversationRef = useRef<{ id: string; used: boolean } | null>(null)
  const submittingRef = useRef(false)
  const panelOpenRef = useRef(open)
  panelOpenRef.current = open
  const discardUnusedConversation = useCallback(() => {
    const draft = draftConversationRef.current
    if (draft?.used || submittingRef.current) return
    draftConversationRef.current = null
    pendingConversationRef.current = null
    if (draft) void apiDelete(`/conversations/${encodeURIComponent(draft.id)}`).catch(() => undefined)
    setAgentId(undefined)
  }, [])
  const actions = useMemo(() => getSaiAgentActions(currentContext), [currentContext])
  const messages = useMemo(
    () => normalizeAgentMessages(agent.messages)
      .map((message) => {
        const text = extractTextParts(message).trim()
        return { ...message, text: message.role === 'user' ? extractSaiPromptGoal(text) : text }
      })
      .filter((message) => message.text)
      .slice(-8),
    [agent.messages],
  )
  const busy = sending || agent.status === 'submitted' || agent.status === 'streaming' || agent.status === 'connecting'
  const assistantMessageCount = messages.filter((message) => message.role === 'assistant').length
  const statusLabel = agent.status === 'streaming' || agent.status === 'submitted'
    ? '思考中'
    : agent.status === 'connecting' || sending
      ? '连接中'
      : agent.status === 'error' || localError
        ? '需要重试'
        : '就绪'
  const activeTodoCount = todos.filter((item) => !['已完成', '已关闭', '已取消', '已归档'].includes(item.status)).length
  const upcomingMeetingCount = meetings.filter((item) => new Date(item.meetingTime).getTime() >= Date.now()).length
  const pendingApprovalCount = approvalRequests.filter((item) => item.status === '审批中').length
  const highRiskCount = risks.filter((item) => item.level === '高' && !['已关闭', '误报'].includes(item.status)).length

  useEffect(() => {
    if (conversationScopeRef.current === conversationScopeKey) return
    discardUnusedConversation()
    draftConversationRef.current = null
    conversationScopeRef.current = conversationScopeKey
    if (recognizerRef.current) {
      recognizerRef.current.onend = null
      recognizerRef.current.stop()
      recognizerRef.current = null
      setListening(false)
    }
    pendingConversationRef.current = null
    setAgentId(undefined)
    setLocalError(undefined)
    setInteractionAnswers({})
    setTurnReceipt(undefined)
  }, [conversationScopeKey, discardUnusedConversation])

  const ensureConversation = useCallback((): Promise<string | null> => {
    if (agentId) return Promise.resolve(agentId)
    if (pendingConversationRef.current?.scope === conversationScopeKey) return pendingConversationRef.current.promise
    const promise = apiPost<ConversationRow>('/conversations', {
      title: `小赛 · ${currentContext.label}`,
      scope: currentContext.projectId ? 'project' : 'global',
      projectId: currentContext.projectId ?? null,
      projectName: currentContext.projectName ?? null,
    }).then((row) => {
      const nextAgentId = row.agentId || row.id
      if (conversationScopeRef.current !== conversationScopeKey ||
        pendingConversationRef.current?.promise !== promise ||
        (!panelOpenRef.current && !submittingRef.current)) {
        void apiDelete(`/conversations/${encodeURIComponent(row.id)}`).catch(() => undefined)
        return null
      }
      draftConversationRef.current = { id: row.id, used: false }
      setAgentId(nextAgentId)
      void apiPost(`/agent/conversations/${encodeURIComponent(nextAgentId)}/prewarm`, { responseMode: 'compact', toolMode: resolveSaiToolMode(currentContext) }).catch(() => {
        // The normal message path can still initialize the session if warming fails.
      })
      return nextAgentId
    }).catch((error) => {
      if (pendingConversationRef.current?.promise === promise) pendingConversationRef.current = null
      throw error
    })
    pendingConversationRef.current = { scope: conversationScopeKey, promise }
    return promise
  }, [agentId, conversationScopeKey, currentContext.label, currentContext.projectId, currentContext.projectName])

  useEffect(() => {
    if (!open || agentId) return
    void ensureConversation().catch((error) => setLocalError(formatAgentError(error)))
  }, [open, agentId, ensureConversation])

  useEffect(() => {
    if (!open) discardUnusedConversation()
  }, [open, discardUnusedConversation])

  useEffect(() => {
    if (turnReceipt && assistantMessageCount > turnReceipt.assistantBaseline) setTurnReceipt(undefined)
  }, [assistantMessageCount, turnReceipt])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
    window.addEventListener('keydown', onEscape)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onEscape)
    }
  }, [open])

  useEffect(() => {
    if (open || !recognizerRef.current) return
    recognizerRef.current.onend = null
    recognizerRef.current.stop()
    recognizerRef.current = null
    setListening(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const speechWindow = window as typeof window & { SpeechRecognition?: SpeechRecognizerConstructor; webkitSpeechRecognition?: SpeechRecognizerConstructor }
    const Speech = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (!Speech?.available) return
    let active = true
    void (async () => {
      for (const quality of ['dictation', 'command'] as const) {
        try {
          const status = await Speech.available!({ langs: ['zh-CN'], processLocally: true, quality })
          if (status === 'unavailable') continue
          if (active) { setLocalSpeechQuality(quality); setLocalSpeechStatus(status) }
          return
        } catch { /* Try the smaller pack or keep online recognition. */ }
      }
      if (active) setLocalSpeechStatus('unavailable')
    })()
    return () => { active = false }
  }, [open])

  useEffect(() => {
    setInteractionAnswers({})
  }, [agent.interaction?.id])

  useEffect(() => () => {
    if (recognizerRef.current) {
      recognizerRef.current.onend = null
      recognizerRef.current.stop()
      recognizerRef.current = null
    }
  }, [])

  const toggleVoiceInput = () => {
    if (recognizerRef.current) {
      recognizerRef.current.onend = null
      recognizerRef.current.stop()
      recognizerRef.current = null
      setListening(false)
      return
    }
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognizerConstructor
      webkitSpeechRecognition?: SpeechRecognizerConstructor
    }
    const Speech = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (!Speech) {
      setSpeechError('当前浏览器不支持语音识别，请使用文字输入。')
      return
    }
    const recognizer = new Speech()
    let recognized = false
    let failed = false
    const initialComposer = composer
    recognizer.lang = 'zh-CN'
    recognizer.continuous = false
    recognizer.interimResults = true
    if (preferLocalSpeech && localSpeechStatus === 'available') recognizer.processLocally = true
    recognizer.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0]?.transcript ?? '').join('').trim()
      if (transcript) {
        recognized = true
        setComposer(`${initialComposer}${initialComposer.trim() ? ' ' : ''}${transcript}`)
        window.requestAnimationFrame(() => composerRef.current?.focus())
      }
    }
    recognizer.onerror = (event) => {
      failed = true
      if (event.error === 'network') setOfferLocalSpeech(true)
      if (event.error !== 'aborted') setSpeechError(formatSpeechError(event.error))
      setListening(false)
      recognizerRef.current = null
    }
    recognizer.onend = () => {
      if (!recognized && !failed) setSpeechError('未识别到语音，请重试或使用文字输入。')
      setListening(false)
      recognizerRef.current = null
    }
    try {
      setSpeechError(undefined)
      setOfferLocalSpeech(false)
      recognizer.start()
      recognizerRef.current = recognizer
      setListening(true)
    } catch {
      setSpeechError('无法启动语音识别，请检查麦克风权限。')
    }
  }

  const enableLocalSpeech = async () => {
    if (localSpeechStatus === 'available') {
      setPreferLocalSpeech(true)
      setSpeechError(undefined)
      setOfferLocalSpeech(false)
      return
    }
    const speechWindow = window as typeof window & { SpeechRecognition?: SpeechRecognizerConstructor; webkitSpeechRecognition?: SpeechRecognizerConstructor }
    const Speech = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
    if (!Speech?.install || (localSpeechStatus !== 'downloadable' && localSpeechStatus !== 'downloading')) return
    setInstallingLocalSpeech(true)
    try {
      const installed = await Speech.install({ langs: ['zh-CN'], processLocally: true, quality: localSpeechQuality })
      if (!installed) throw new Error('download failed')
      setLocalSpeechStatus('available')
      setPreferLocalSpeech(true)
      setOfferLocalSpeech(false)
      setSpeechError(undefined)
    } catch {
      setSpeechError('离线中文语音包安装失败，请稍后重试。')
    } finally {
      setInstallingLocalSpeech(false)
    }
  }

  const closePanel = () => {
    if (recognizerRef.current) {
      recognizerRef.current.onend = null
      recognizerRef.current.stop()
      recognizerRef.current = null
      setListening(false)
    }
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const sendGoal = async (goal: string) => {
    const cleanGoal = goal.trim()
    if (!cleanGoal || busy) return
    const createPath = resolveSaiCreateAction(cleanGoal)
    if (createPath) {
      setComposer('')
      navigate(createPath)
      closePanel()
      return
    }
    const uploadPath = resolveSaiUploadAction(currentContext, cleanGoal)
    if (uploadPath) {
      if (uploadPath.startsWith('/knowledge?')) {
        setSending(true)
        setLocalError(undefined)
        try {
          const capabilities = await apiGet<{ upload: boolean; uploadProjectIds: string[] }>('/data-knowledge/capabilities')
          if (!capabilities.upload || capabilities.uploadProjectIds.length === 0) {
            setLocalError('当前账号没有可上传资料的项目。请先确认项目归属和上传权限。')
            return
          }
        } catch (error) {
          setLocalError(formatAgentError(error))
          return
        } finally {
          setSending(false)
        }
      }
      setComposer('')
      navigate(uploadPath)
      closePanel()
      return
    }
    const navigation = resolveSaiNavigationAction(cleanGoal)
    if (navigation) {
      setComposer('')
      if (navigation === 'approvals') openApproval('inbox')
      else navigate(navigation)
      closePanel()
      return
    }
    const prompt = buildSaiAgentPrompt(currentContext, cleanGoal)
      + (['workspace', 'collaboration', 'workflow', 'risk', 'committee'].includes(currentContext.kind) && needsSaiWorkspaceSnapshot(cleanGoal)
        ? buildSaiWorkspaceSnapshot({ projects, todos, meetings, risks, approvals: approvalRequests })
        : '')
      + (currentContext.kind === 'discovery' ? discoverySnapshot : '')
      + (currentContext.kind === 'review' ? reviewSnapshot : '')
      + (currentContext.kind === 'knowledge' ? knowledgeSnapshot : '')
      + (currentContext.kind === 'institution' ? institutionSnapshot : '')
      + (currentContext.kind === 'due-diligence' ? dueDiligenceSnapshot : '')
    const requestScopeKey = conversationScopeKey
    const toolMode = resolveSaiToolMode(currentContext, cleanGoal)
    const currentProject = projects.find((project) => project.id === currentContext.projectId)
    setTurnReceipt({
      ...buildSaiTurnReceipt(currentContext, cleanGoal, currentProject, {
        activeTodos: activeTodoCount,
        upcomingMeetings: upcomingMeetingCount,
        pendingApprovals: pendingApprovalCount,
        highRisks: highRiskCount,
      }),
      assistantBaseline: assistantMessageCount,
    })
    setComposer('')
    setLocalError(undefined)
    setSending(true)
    submittingRef.current = true
    try {
      if (agentId) {
        if (draftConversationRef.current) draftConversationRef.current.used = true
        await agent.sendMessage(prompt, { responseMode: 'compact', toolMode })
      } else {
        const nextAgentId = await ensureConversation()
        if (!nextAgentId || conversationScopeRef.current !== requestScopeKey) return
        if (draftConversationRef.current) draftConversationRef.current.used = true
        await apiPost(`/agent/conversations/${encodeURIComponent(nextAgentId)}/messages`, {
          message: prompt,
          responseMode: 'compact',
          toolMode,
        })
      }
    } catch (error) {
      setLocalError(formatAgentError(error))
    } finally {
      submittingRef.current = false
      setSending(false)
    }
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    void sendGoal(composer)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  const runAction = (action: SaiAgentAction) => {
    if (action.kind === 'navigate') {
      navigate(action.value)
      closePanel()
      return
    }
    if (action.kind === 'approval') {
      openApproval('inbox')
      closePanel()
      return
    }
    void sendGoal(action.value)
  }

  const toggleInteractionAnswer = (questionId: string, label: string, multiSelect: boolean) => {
    setInteractionAnswers((current) => {
      if (!multiSelect) return { ...current, [questionId]: label }
      const selected = Array.isArray(current[questionId]) ? current[questionId] as string[] : []
      return {
        ...current,
        [questionId]: selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label],
      }
    })
  }

  const answerInteraction = async () => {
    if (!agent.interaction) return
    setSending(true)
    setLocalError(undefined)
    try {
      await agent.respondInteraction(agent.interaction.id, 'answer', interactionAnswers)
    } catch (error) {
      setLocalError(formatAgentError(error))
    } finally {
      setSending(false)
    }
  }

  const interactionComplete = agent.interaction?.questions.every((question) => {
    const answer = interactionAnswers[question.id]
    return Array.isArray(answer) ? answer.length > 0 : Boolean(answer)
  }) ?? false

  return (
    <div className={`sai-agent${open ? ' is-open' : ''}${busy ? ' is-busy' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="sai-agent-trigger"
        aria-label={open ? '小赛 Agent 控制台已打开' : '打开小赛 Agent 控制台'}
        aria-controls="sai-agent-panel"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="sai-agent-trigger-glow" aria-hidden="true" />
        <img src="/sai-unicorn-agent.png" alt="" />
        <span className="sai-agent-trigger-status" aria-hidden="true" />
        <span className="sai-agent-trigger-label">问小赛</span>
      </button>

      {open && <button type="button" className="sai-agent-backdrop" aria-label="关闭小赛" onClick={closePanel} />}
      <section
        id="sai-agent-panel"
        className="sai-agent-panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby="sai-agent-title"
        aria-hidden={!open}
      >
        <header className="sai-agent-header">
          <div className="sai-agent-identity">
            <span className="sai-agent-miniature"><img src="/sai-unicorn-agent.png" alt="" /></span>
            <span>
              <span className="sai-agent-eyebrow">赛智 AGENT</span>
              <strong id="sai-agent-title">小赛</strong>
            </span>
          </div>
          <div className="sai-agent-header-actions">
            {agentId && <button type="button" title="开始新对话" aria-label="开始新对话" onClick={() => { discardUnusedConversation(); draftConversationRef.current = null; pendingConversationRef.current = null; setAgentId(undefined); setLocalError(undefined); setTurnReceipt(undefined) }}><RotateCcw /></button>}
            <button ref={closeRef} type="button" aria-label="关闭小赛" onClick={closePanel}><X /></button>
          </div>
        </header>

        <div className="sai-agent-context">
          <span className="sai-agent-context-dot" aria-hidden="true" />
          <span><small>正在看</small><strong>{currentContext.label}</strong><em>{currentContext.detail}</em></span>
          <span className={`sai-agent-state${busy ? ' is-active' : ''}`}>{statusLabel}</span>
        </div>

        <div className="sai-agent-scroll" aria-live="polite">
          {!messages.length && !busy && <div className="sai-agent-welcome">
            <div className="sai-agent-welcome-mark"><Sparkles aria-hidden="true" /></div>
            <h2>我已经读到你当前的工作场景</h2>
            <p>我会先理解、分析和草拟；如果需要改动业务数据，会先说明计划并等你确认。</p>
            <div className="sai-agent-pulse-summary" aria-label="当前工作摘要">
              <span><strong>{activeTodoCount}</strong><small>进行中任务</small></span>
              <span><strong>{upcomingMeetingCount}</strong><small>待开会议</small></span>
              <span><strong>{pendingApprovalCount}</strong><small>审批中</small></span>
              <span><strong>{highRiskCount}</strong><small>高风险</small></span>
            </div>
          </div>}

          {turnReceipt && <section className="sai-agent-receipt" aria-label="小赛处理回执">
            <header>
              <span><CheckCircle2 aria-hidden="true" /></span>
              <div><strong>{turnReceipt.title}</strong><small>{turnReceipt.goal}</small></div>
            </header>
            <div className="sai-agent-receipt-facts">
              {turnReceipt.facts.map((fact) => <span key={fact}>{fact}</span>)}
            </div>
            <ol>{turnReceipt.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            <p>{turnReceipt.clarification}</p>
          </section>}

          {!messages.length && !turnReceipt && <div className="sai-agent-suggestions" aria-label="小赛建议">
            <div className="sai-agent-section-title"><span>现在可以做</span><small>随页面变化</small></div>
            {actions.map((action) => <button key={action.id} type="button" onClick={() => runAction(action)} disabled={busy}>
              <span className="sai-agent-action-icon"><ActionIcon action={action} /></span>
              <span><strong>{action.label}</strong><small>{action.description}</small></span>
              <ChevronRight aria-hidden="true" />
            </button>)}
          </div>}

          {messages.length > 0 && <div className="sai-agent-messages">
            {messages.map((message) => <article key={message.id} className={`sai-agent-message is-${message.role}`}>
              <span className="sai-agent-message-role">{message.role === 'assistant' ? '小赛' : '你'}</span>
              <p>{message.text}</p>
            </article>)}
          </div>}

          {busy && <div className="sai-agent-thinking" role="status">
            <span aria-hidden="true"><i /><i /><i /></span>
            <p><strong>小赛正在整理</strong><small>我会先给结论，再附上依据与下一步</small></p>
          </div>}

          {agent.interaction && <div className="sai-agent-interaction">
            <div className="sai-agent-section-title"><span>唯一一次信息补充</span><small>回答后直接给结果</small></div>
            {agent.interaction.questions.map((question) => <fieldset key={question.id}>
              <legend>{question.question}</legend>
              <div>{question.options.map((option) => {
                const answer = interactionAnswers[question.id]
                const selected = Array.isArray(answer) ? answer.includes(option.label) : answer === option.label
                return <button key={option.label} type="button" aria-pressed={selected} onClick={() => toggleInteractionAnswer(question.id, option.label, question.multiSelect)}>
                  <span>{selected && <Check />}</span><strong>{option.label}</strong><small>{option.description}</small>
                </button>
              })}</div>
            </fieldset>)}
            <button type="button" className="sai-agent-confirm" disabled={!interactionComplete || sending} onClick={() => void answerInteraction()}>确认并继续</button>
          </div>}

          {(localError || agent.error) && <div className="sai-agent-error" role="alert">
            <strong>这次连接没有完成</strong>
            <p>{localError || formatAgentError(agent.error)}</p>
            <button type="button" onClick={() => { setLocalError(undefined); void agent.refresh() }}>重新连接</button>
          </div>}
        </div>

        <footer className="sai-agent-composer">
          <form onSubmit={submit}>
            <textarea
              ref={composerRef}
              rows={2}
              value={composer}
              disabled={busy}
              aria-label="告诉小赛你想做什么"
              placeholder={`在${currentContext.label}里，你想让我帮你做什么？`}
              onChange={(event) => setComposer(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <button type="button" className={`sai-agent-voice${listening ? ' is-listening' : ''}`} aria-label={listening ? '停止语音输入' : '开始语音输入'} aria-pressed={listening} title={listening ? '停止语音输入' : '语音输入'} disabled={busy} onClick={toggleVoiceInput}>
              {listening ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </button>
            {agent.status === 'streaming' || agent.status === 'submitted'
              ? <button type="button" className="sai-agent-send is-stop" aria-label="停止生成" onClick={() => void agent.abort()}><Square /></button>
              : <button type="submit" className="sai-agent-send" aria-label="发送给小赛" disabled={!composer.trim() || busy}><ArrowUp /></button>}
          </form>
          {speechError && <p className="sai-agent-speech-error" role="alert">{speechError}</p>}
          {offerLocalSpeech && ['available', 'downloadable', 'downloading'].includes(localSpeechStatus || '') && !preferLocalSpeech && <button type="button" className="sai-agent-local-speech" disabled={installingLocalSpeech} onClick={() => void enableLocalSpeech()}>{installingLocalSpeech ? '正在安装中文语音包…' : localSpeechStatus === 'available' ? `改用离线中文${localSpeechQuality === 'dictation' ? '听写' : '短指令'}识别` : `安装离线中文${localSpeechQuality === 'dictation' ? '听写' : '短指令'}识别`}</button>}
          {listening && <p className="sai-agent-speech-status" role="status">正在聆听，识别后请确认文字再发送</p>}
          <p><ShieldCheck aria-hidden="true" />默认只读 · 业务写入前会先请你确认 <span>Enter 发送</span></p>
        </footer>
      </section>
    </div>
  )
}
