import { ArrowLeft, CheckCircle2, Link2Off, LoaderCircle, QrCode, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { apiGet, apiPost } from '../lib/api'

type PersonalWeixinAiView = {
  connected: boolean
  eligible: boolean
  botId: string | null
  version: number | null
  lastConnectedAt: string | null
  accountHint: string
  reason: string | null
}

type LoginSession = {
  sessionKey: string
  qrcodeUrl: string
  expiresInSeconds: number
  message: string
}

const endpoint = '/integrations/im/weixin/self'

export function PersonalWeixinAiPage() {
  const navigate = useNavigate()
  const waitController = useRef<AbortController | null>(null)
  const [view, setView] = useState<PersonalWeixinAiView | null>(null)
  const [login, setLogin] = useState<LoginSession | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [busy, setBusy] = useState<'loading' | 'starting' | 'waiting' | 'disconnecting' | ''>('loading')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try { setView(await apiGet<PersonalWeixinAiView>(endpoint)) }
    catch (cause) { setError((cause as Error).message) }
    finally { setBusy('') }
  }, [])

  useEffect(() => {
    void refresh()
    return () => waitController.current?.abort()
  }, [refresh])

  useEffect(() => {
    if (!login || remaining <= 0) return
    const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [login, remaining])

  async function startLogin() {
    waitController.current?.abort()
    setBusy('starting')
    setError('')
    try {
      const session = await apiPost<LoginSession>(`${endpoint}/login/start`)
      setLogin(session)
      setRemaining(session.expiresInSeconds)
      setBusy('waiting')
      const controller = new AbortController()
      waitController.current = controller
      const result = await apiPost<{ connected: true; bot: PersonalWeixinAiView }>(
        `${endpoint}/login/wait`, { sessionKey: session.sessionKey }, { signal: controller.signal },
      )
      setView(result.bot)
      setLogin(null)
      setBusy('')
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') return
      setError((cause as Error).message)
      setLogin(null)
      setBusy('')
    }
  }

  async function disconnect() {
    if (!view?.version) return
    setBusy('disconnecting')
    setError('')
    try {
      const updated = await apiPost<PersonalWeixinAiView>(`${endpoint}/disconnect`, {
        expectedVersion: view.version,
        idempotencyKey: crypto.randomUUID(),
      })
      setView(updated)
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy('') }
  }

  const minutes = Math.floor(remaining / 60)
  const seconds = String(remaining % 60).padStart(2, '0')

  return <section className="fde-personal-weixin-page" aria-labelledby="personal-weixin-title">
    <button className="fde-personal-weixin-back" onClick={() => navigate(-1)}><ArrowLeft />返回</button>
    <header className="fde-personal-weixin-header">
      <div><span className="fde-personal-weixin-mark"><QrCode /></span><div><h1 id="personal-weixin-title">微信 AI</h1><p>连接你本人的微信，在聊天窗口直接使用投资中台 AI。</p></div></div>
      {view?.connected && <span className="fde-personal-weixin-connected"><CheckCircle2 />已连接</span>}
    </header>

    {error && <div className="fde-personal-weixin-error" role="alert">{error}<button onClick={() => void refresh()}><RefreshCw />刷新状态</button></div>}

    <div className="fde-personal-weixin-card">
      {busy === 'loading' ? <div className="fde-personal-weixin-loading"><LoaderCircle />正在读取连接状态…</div>
        : !view?.eligible ? <div className="fde-personal-weixin-empty"><Link2Off /><h2>当前账号不能连接</h2><p>{view?.reason || '请确认账号已启用并具有业务角色。'}</p></div>
          : login ? <div className="fde-personal-weixin-qr-stage">
              <div className="fde-personal-weixin-qr"><img src={login.qrcodeUrl} alt="个人微信 AI 登录二维码" /></div>
              <div><span className="fde-personal-weixin-step">扫码连接</span><h2>请使用本人微信扫码</h2><p>{login.message}</p><p>扫码后在微信中确认，页面会自动更新。</p><strong>二维码剩余 {minutes}:{seconds}</strong><span className="fde-personal-weixin-wait"><LoaderCircle />正在等待扫码结果</span><button className="fde-personal-weixin-secondary" onClick={() => { waitController.current?.abort(); setLogin(null); setBusy('') }}>取消扫码</button></div>
            </div>
            : view?.connected ? <div className="fde-personal-weixin-status">
                <span className="fde-personal-weixin-success"><CheckCircle2 /></span><div><h2>你的微信 AI 已连接</h2><p>微信账号 {view.accountHint || '已验证'}，消息会进入你的个人会话。</p>{view.lastConnectedAt && <small>连接时间：{new Date(view.lastConnectedAt).toLocaleString('zh-CN')}</small>}</div>
                <div className="fde-personal-weixin-actions"><button className="fde-personal-weixin-primary" disabled={Boolean(busy)} onClick={() => void startLogin()}><RefreshCw />重新连接</button><button className="fde-personal-weixin-secondary" disabled={Boolean(busy)} onClick={() => void disconnect()}><Link2Off />{busy === 'disconnecting' ? '正在断开…' : '断开连接'}</button></div>
              </div>
              : <div className="fde-personal-weixin-empty"><span className="fde-personal-weixin-empty-icon"><QrCode /></span><h2>连接你的个人微信 AI</h2><p>生成二维码后，用你本人的微信扫码并确认即可使用。</p><button className="fde-personal-weixin-primary" disabled={Boolean(busy)} onClick={() => void startLogin()}><QrCode />{busy === 'starting' ? '正在生成…' : '生成二维码'}</button></div>}
    </div>

    <aside className="fde-personal-weixin-notes"><ShieldCheck /><div><strong>连接说明</strong><p>连接后消息只进入你的独立 AI 会话。</p><p>扫码不会增加项目或知识库权限，AI 仍按你在平台中的原有权限工作。</p></div></aside>
  </section>
}
