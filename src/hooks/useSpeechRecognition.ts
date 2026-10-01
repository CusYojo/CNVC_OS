import { useCallback, useEffect, useRef, useState } from 'react'

export type SpeechInputState = 'idle' | 'requesting' | 'listening' | 'paused' | 'error' | 'complete'
type RecognitionResultLike = { 0: { transcript: string }; isFinal?: boolean }
type RecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort?: () => void
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  onresult: ((event: { results: ArrayLike<RecognitionResultLike> }) => void) | null
}
type RecognitionConstructor = new () => RecognitionLike

function recognitionConstructor() {
  const speechWindow = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
}

function speechErrorMessage(error: string) {
  if (error === 'not-allowed' || error === 'service-not-allowed') return '麦克风或语音识别权限被拒绝，请在浏览器地址栏允许后重试。'
  if (error === 'audio-capture') return '未检测到可用麦克风。'
  if (error === 'network') return '浏览器语音识别网络不可用。'
  if (error === 'no-speech') return '暂未识别到语音，可继续录入或手工输入。'
  return `语音识别未完成：${error}`
}

export function useSpeechRecognition(options: {
  continuous?: boolean
  onFinal: (text: string) => void
  onInterim?: (text: string) => void
}) {
  const [state, setState] = useState<SpeechInputState>('idle')
  const [error, setError] = useState('')
  const recognizer = useRef<RecognitionLike | null>(null)
  const shouldListen = useRef(false)
  const intentionalStop = useRef(false)
  const lastInterim = useRef('')
  const optionsRef = useRef(options)
  optionsRef.current = options

  const flushInterim = useCallback(() => {
    const text = lastInterim.current.trim()
    if (text) optionsRef.current.onFinal(text)
    lastInterim.current = ''
    optionsRef.current.onInterim?.('')
  }, [])

  const createAndStart = useCallback(() => {
    const Speech = recognitionConstructor()
    if (!Speech) {
      setState('error'); setError('当前浏览器不支持实时语音识别，可继续录音或手工输入。'); return
    }
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      setState('error'); setError('语音输入需要 HTTPS 安全连接。'); return
    }
    const item = new Speech()
    item.lang = 'zh-CN'; item.continuous = Boolean(optionsRef.current.continuous); item.interimResults = true
    item.onstart = () => { setState('listening'); setError('') }
    item.onresult = event => {
      let confirmed = ''; let interim = ''
      Array.from(event.results).forEach(result => { const text = result[0]?.transcript || ''; if (result.isFinal) confirmed += text; else interim += text })
      if (confirmed.trim()) optionsRef.current.onFinal(confirmed.trim())
      lastInterim.current = interim
      optionsRef.current.onInterim?.(interim)
    }
    item.onerror = event => {
      if (intentionalStop.current && event.error === 'aborted') return
      if (event.error === 'no-speech' && shouldListen.current && optionsRef.current.continuous) return
      setState('error'); setError(speechErrorMessage(event.error))
    }
    item.onend = () => {
      recognizer.current = null
      if (shouldListen.current && optionsRef.current.continuous) {
        window.setTimeout(() => { if (shouldListen.current) createAndStart() }, 150)
      } else if (!intentionalStop.current) setState('complete')
    }
    recognizer.current = item
    try { item.start() } catch (cause) { setState('error'); setError(cause instanceof Error ? cause.message : '语音识别启动失败') }
  }, [])

  const start = useCallback(() => {
    intentionalStop.current = false; shouldListen.current = true; setState('requesting'); setError('')
    recognizer.current?.abort?.(); recognizer.current = null; createAndStart()
  }, [createAndStart])

  const pause = useCallback(() => {
    shouldListen.current = false; intentionalStop.current = true; flushInterim(); recognizer.current?.stop(); setState('paused')
  }, [flushInterim])

  const stop = useCallback(() => {
    shouldListen.current = false; intentionalStop.current = true; flushInterim(); recognizer.current?.stop(); setState('complete')
  }, [flushInterim])

  const reset = useCallback(() => { shouldListen.current = false; intentionalStop.current = true; recognizer.current?.abort?.(); recognizer.current = null; lastInterim.current = ''; optionsRef.current.onInterim?.(''); setError(''); setState('idle') }, [])

  useEffect(() => () => { shouldListen.current = false; intentionalStop.current = true; recognizer.current?.abort?.() }, [])

  return { state, error, supported: Boolean(recognitionConstructor()), start, pause, stop, reset, flushInterim }
}
