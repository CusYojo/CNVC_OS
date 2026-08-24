import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { apiGet, apiPost } from '../lib/api'

type JwAgentStatus = 'connecting' | 'idle' | 'submitted' | 'streaming' | 'error'

export type JwRuntimeState = {
  model: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    totalInputTokens: number
    totalTokens: number
  } | null
  totalCostUsd: number | null
  numTurns: number | null
  durationMs: number | null
  contextCompaction: {
    state: 'idle' | 'compacting' | 'failed'
    count: number
    lastTrigger: 'manual' | 'auto' | null
    lastPreTokens: number | null
    lastPostTokens: number | null
    lastDurationMs: number | null
    lastCompletedAt: string | null
    lastResult: 'success' | 'failed' | null
    lastError: string | null
  }
}

export type JwPendingInteraction = {
  id: string
  toolName: 'AskUserQuestion'
  requestedAt: string
  questions: Array<{
    id: string
    header: string
    question: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
}

export type JwQuickSkillName =
  | 'draft-investment-proposal'
  | 'generate-investment-compliance-note'
  | 'investment-committee-ppt'
  | 'draft-investment-qa'
  | 'draft-due-diligence-report'
  | 'generate-document-from-template'

export type JwSendMessageOptions = {
  skillName?: JwQuickSkillName
  attachmentFileIds?: string[]
  attachmentFileNames?: string[]
  customTemplateId?: string
  customTemplateName?: string
  outputFormat?: 'DOCX' | 'PPTX' | 'PDF'
}

type JwSnapshot = {
  id: string
  status: string
  error: string | null
  interaction: JwPendingInteraction | null
  runtime: JwRuntimeState
  messages: unknown[]
  updatedAt: string
}

export function useJwAgent(agentId?: string) {
  const [messages, setMessages] = useState<unknown[]>([])
  const [status, setStatus] = useState<JwAgentStatus>(agentId ? 'connecting' : 'idle')
  const [error, setError] = useState<Error | null>(null)
  const [runtime, setRuntime] = useState<JwRuntimeState | null>(null)
  const [interaction, setInteraction] = useState<JwPendingInteraction | null>(null)
  const generationRef = useRef(0)

  const applySnapshot = useCallback((snapshot: JwSnapshot, generation = generationRef.current) => {
    if (generation !== generationRef.current) return
    setMessages(snapshot.messages ?? [])
    setRuntime(snapshot.runtime ?? null)
    setInteraction(snapshot.interaction ?? null)
    setError(snapshot.error ? new Error(snapshot.error) : null)
    setStatus(snapshot.status === 'streaming'
      ? 'streaming'
      : snapshot.status === 'error'
        ? 'error'
        : 'idle')
  }, [])

  const refresh = useCallback(async () => {
    if (!agentId) return
    const generation = generationRef.current
    try {
      const snapshot = await apiGet<JwSnapshot>(`/agent/conversations/${encodeURIComponent(agentId)}`)
      if (generation !== generationRef.current) return
      applySnapshot(snapshot, generation)
    } catch (cause) {
      if (generation !== generationRef.current) return
      setError(cause instanceof Error ? cause : new Error(String(cause)))
      setStatus('error')
    }
  }, [agentId, applySnapshot])

  useEffect(() => {
    generationRef.current += 1
    setMessages([])
    setRuntime(null)
    setInteraction(null)
    setError(null)
    setStatus(agentId ? 'connecting' : 'idle')
    if (!agentId) return
    const generation = generationRef.current
    void refresh()
    const socket = io({
      path: '/socket.io',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
    })
    socket.on('connect', () => {
      socket.emit('agent:subscribe', { agentId }, (result: {
        ok?: boolean
        snapshot?: JwSnapshot
        error?: { message?: string }
      }) => {
        if (generation !== generationRef.current) return
        if (result?.ok && result.snapshot) applySnapshot(result.snapshot, generation)
        else if (result?.error?.message) {
          setError(new Error(result.error.message))
          setStatus('error')
        }
      })
    })
    socket.on('agent:snapshot', (snapshot: JwSnapshot) => applySnapshot(snapshot, generation))
    socket.on('agent:error', (event: { message?: string }) => {
      if (generation !== generationRef.current) return
      setError(new Error(event?.message || '实时连接异常'))
      setStatus('error')
    })
    // Socket 断线期间低频读取 MySQL 快照；重连成功后恢复实时事件。
    const recoveryTimer = window.setInterval(() => {
      if (!socket.connected) void refresh()
    }, 5_000)
    return () => {
      window.clearInterval(recoveryTimer)
      if (socket.connected) socket.emit('agent:unsubscribe', { agentId })
      socket.disconnect()
    }
  }, [agentId, refresh, applySnapshot])

  const sendMessage = useCallback(async (message: string, options: JwSendMessageOptions = {}) => {
    if (!agentId) throw new Error('请先创建或选择会话')
    setStatus('submitted')
    setError(null)
    try {
      await apiPost(`/agent/conversations/${encodeURIComponent(agentId)}/messages`, {
        message,
        ...(options.skillName ? { skillName: options.skillName } : {}),
        ...(options.attachmentFileIds?.length ? { attachmentFileIds: options.attachmentFileIds } : {}),
        ...(options.attachmentFileNames?.length ? { attachmentFileNames: options.attachmentFileNames } : {}),
        ...(options.customTemplateId ? { customTemplateId: options.customTemplateId } : {}),
        ...(options.customTemplateName ? { customTemplateName: options.customTemplateName } : {}),
        ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
      })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)))
      setStatus('error')
      throw cause
    }
  }, [agentId, refresh])

  const abort = useCallback(async () => {
    if (!agentId) return
    await apiPost(`/agent/conversations/${encodeURIComponent(agentId)}/abort`)
    await refresh()
  }, [agentId, refresh])

  const respondInteraction = useCallback(async (
    interactionId: string,
    action: 'answer' | 'cancel',
    answers?: Record<string, string | string[]>,
  ) => {
    if (!agentId) throw new Error('请先创建或选择会话')
    await apiPost(`/agent/conversations/${encodeURIComponent(agentId)}/interactions/${encodeURIComponent(interactionId)}/respond`, {
      action,
      answers,
    })
    await refresh()
  }, [agentId, refresh])

  return { messages, status, error, runtime, interaction, sendMessage, abort, respondInteraction, refresh }
}
