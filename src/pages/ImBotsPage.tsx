import {
  Bot, Check, CirclePlus, Clock3, History, MessageSquareText, RefreshCw,
  QrCode, Send, ShieldCheck, Smartphone, TestTube2, Unplug, UsersRound, X, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfigurationRevisionPanel, type ConfigurationRevisionTarget } from '../components/ConfigurationRevisionPanel'
import { Modal } from '../components/ui'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'

type Platform = 'dingtalk' | 'wechat' | 'feishu'
type BotRow = {
  id: string; platform: Platform; name: string; config: Record<string, unknown>; enabled: boolean;
  connectionStatus: string; lastConnectedAt: string | null; lastError: string | null; version: number;
  hasCredential: boolean; credentialMasked: string;
}
type Binding = {
  id: string; botId: string; externalConversationId: string; userId: string; projectId: string | null;
  conversationId: string | null; department: string | null; enabled: boolean; version: number;
}
type Outbox = { id: string; botId: string; bindingId: string; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null }
type DeliveryLog = { id: string; outboxId: string; attempt: number; status: string; httpStatus: number | null; durationMs: number; error: string | null; createdAt: string }
type Settings = {
  bots: BotRow[]; bindings: Binding[]; outbox: Outbox[]; deliveryLogs: DeliveryLog[];
  users: { id: string; name: string; role: string; department: string; status: string }[];
  projects: { id: string; name: string }[];
  conversations: { id: string; title: string; userId: string; projectId: string | null; status: string; runtimeReady: boolean }[];
}
type WeixinLogin = { sessionKey: string; qrcodeUrl: string; expiresInSeconds: number; message: string }

const emptySettings: Settings = { bots: [], bindings: [], outbox: [], deliveryLogs: [], users: [], projects: [], conversations: [] }
const WECHAT_COLOR = '#07c160'

function Toggle({ value, disabled, onChange, label }: { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled} onClick={(event) => { event.stopPropagation(); onChange(!value) }} className={`jw-switch ${value ? 'is-on' : ''}`}><span /></button>
}

export function ImBotsPage() {
  const [settings, setSettings] = useState<Settings>(emptySettings)
  const [selectedBotId, setSelectedBotId] = useState('')
  const [section, setSection] = useState<'config' | 'bindings' | 'delivery'>('config')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [showBindingModal, setShowBindingModal] = useState(false)
  const [sendBinding, setSendBinding] = useState<Binding | null>(null)
  const [sendMessage, setSendMessage] = useState('')
  const [bindingForm, setBindingForm] = useState({ botId: '', externalConversationId: '', userId: '', projectId: '', conversationId: '' })
  const [revisionTarget, setRevisionTarget] = useState<ConfigurationRevisionTarget | null>(null)
  const [weixinLogin, setWeixinLogin] = useState<WeixinLogin | null>(null)

  const refresh = useCallback(async (preferredBotId?: string) => {
    try {
      const result = await apiGet<Settings>('/integrations/im')
      setSettings(result)
      setSelectedBotId((current) => {
        const desired = preferredBotId || current
        if (result.bots.some((item) => item.id === desired && item.platform === 'wechat')) return desired
        return result.bots.find((item) => item.platform === 'wechat')?.id || ''
      })
    } catch (error) { setNotice({ tone: 'error', text: (error as Error).message }) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const platformBots = settings.bots.filter((item) => item.platform === 'wechat')
  const selectedBot = platformBots.find((item) => item.id === selectedBotId) || platformBots[0] || null
  const botBindings = settings.bindings.filter((item) => selectedBot && item.botId === selectedBot.id)
  const botOutbox = settings.outbox.filter((item) => selectedBot && item.botId === selectedBot.id)
  const userNames = useMemo(() => new Map(settings.users.map((item) => [item.id, item.name])), [settings.users])
  const projectNames = useMemo(() => new Map(settings.projects.map((item) => [item.id, item.name])), [settings.projects])
  const botNames = useMemo(() => new Map(settings.bots.map((item) => [item.id, item.name])), [settings.bots])
  const filteredConversations = settings.conversations.filter((item) => (!bindingForm.userId || item.userId === bindingForm.userId) && (!bindingForm.projectId || item.projectId === bindingForm.projectId) && item.runtimeReady)

  useEffect(() => {
    setBindingForm((current) => ({ ...current, botId: selectedBot?.id || '' }))
  }, [selectedBot])

  async function mutate(key: string, action: () => Promise<unknown>, message: string, preferredBotId?: string) {
    setBusy(key); setNotice(null)
    try { await action(); setNotice({ tone: 'ok', text: message }); await refresh(preferredBotId); return true }
    catch (error) { setNotice({ tone: 'error', text: (error as Error).message }); return false }
    finally { setBusy('') }
  }

  async function toggleBot(bot: BotRow, enabled: boolean) {
    const hasActiveBindings = !enabled && settings.bindings.some((item) => item.botId === bot.id && item.enabled)
    if (hasActiveBindings && !window.confirm('该机器人仍有启用绑定。停用后新的入站和出站消息将被阻断，是否继续？')) return
    await mutate(`bot-toggle-${bot.id}`, () => apiPatch(`/integrations/im/bots/${bot.id}`, { expectedVersion: bot.version, enabled, confirmDisableImpact: hasActiveBindings }), enabled ? '机器人已启用，请执行连接测试。' : '机器人已断开并停用。', bot.id)
  }

  async function startWeixinLogin() {
    setBusy('weixin-start'); setNotice(null); setWeixinLogin(null)
    try {
      const login = await apiPost<WeixinLogin>('/integrations/im/weixin/login/start')
      setWeixinLogin(login)
      setBusy('weixin-wait')
      const result = await apiPost<{ connected: boolean; bot: BotRow }>('/integrations/im/weixin/login/wait', { sessionKey: login.sessionKey })
      setWeixinLogin(null)
      setSelectedBotId(result.bot.id)
      setNotice({ tone: 'ok', text: '微信扫码授权成功，机器人已连接。' })
      await refresh(result.bot.id)
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
      setWeixinLogin(null)
    } finally { setBusy('') }
  }

  async function createBinding() {
    const ok = await mutate('binding-create', () => apiPost('/integrations/im/bindings', {
      ...bindingForm, projectId: bindingForm.projectId || null, conversationId: bindingForm.conversationId || null, enabled: true,
    }), '授权绑定已创建。', selectedBot?.id)
    if (ok) { setShowBindingModal(false); setBindingForm({ botId: selectedBot?.id || '', externalConversationId: '', userId: '', projectId: '', conversationId: '' }) }
  }

  async function queueTestMessage() {
    if (!sendBinding || !sendMessage.trim()) return
    const ok = await mutate(`send-${sendBinding.id}`, () => apiPost('/integrations/im/outbox', { botId: sendBinding.botId, bindingId: sendBinding.id, idempotencyKey: `ui-${crypto.randomUUID()}`, message: sendMessage.trim() }), '消息已加入 Outbox。', selectedBot?.id)
    if (ok) { setSendBinding(null); setSendMessage(''); setSection('delivery') }
  }

  return <div className="jw-admin-page">
    <div className="jw-page-header"><div><h1>IM 机器人</h1><p>配置和管理微信机器人</p></div><button className="jw-icon-btn" title="刷新" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button></div>
    {notice && <div className={`jw-notice ${notice.tone}`}><span>{notice.tone === 'ok' ? <Check className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}</span>{notice.text}<button aria-label="关闭提示" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button></div>}

    <div className="jw-split-workbench im">
      <aside className="jw-object-panel">
        <div className="jw-panel-header"><span>机器人</span></div>
        <div className="jw-object-list">
          <div className="jw-object-item active">
            <span className="jw-provider-mark" style={{ background: WECHAT_COLOR }}><Bot className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1 text-left"><strong className="block truncate">WeChat</strong><small className="block truncate">{platformBots.length ? `${platformBots[0].name}${platformBots.length > 1 ? ` 等 ${platformBots.length} 个` : ''}` : '未配置'}</small></span>
            <span className={`jw-status-dot ${platformBots.some((item) => item.connectionStatus === 'connected') ? 'connected' : ''}`} title={platformBots.some((item) => item.connectionStatus === 'connected') ? '已连接' : '未连接'} />
          </div>
        </div>
      </aside>

      <section className="jw-detail-panel">
        <div className="jw-detail-heading"><div><h2>{selectedBot?.name || 'WeChat'}</h2><p>微信通知 · {selectedBot ? `${selectedBot.connectionStatus === 'connected' ? '已连接' : '未连接'} · 配置版本 v${selectedBot.version}` : '尚未配置，请扫码授权'}</p></div><div className="flex items-center gap-2">{platformBots.length > 1 && <select className="jw-compact-select" value={selectedBot?.id || ''} onChange={(event) => setSelectedBotId(event.target.value)}>{platformBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>}{selectedBot && <button className="jw-icon-btn" title="配置历史" onClick={() => setRevisionTarget({ basePath: '/integrations/im', resourceType: 'im_bot', resourceId: selectedBot.id, resourceLabel: `IM 机器人：${selectedBot.name}`, currentVersion: selectedBot.version, confirmImpact: true })}><History className="h-4 w-4" /></button>}</div></div>
        <div className="jw-subtabs"><button className={section === 'config' ? 'active' : ''} onClick={() => setSection('config')}><Bot className="h-4 w-4" />基础配置</button><button disabled={!selectedBot} className={section === 'bindings' ? 'active' : ''} onClick={() => setSection('bindings')}><UsersRound className="h-4 w-4" />授权绑定 <span>{botBindings.length}</span></button><button disabled={!selectedBot} className={section === 'delivery' ? 'active' : ''} onClick={() => setSection('delivery')}><MessageSquareText className="h-4 w-4" />投递记录 <span>{botOutbox.length}</span></button></div>

        {section === 'config' && <>
          <div className="jw-scroll-content">
            <div className="jw-info-banner"><QrCode className="h-4 w-4" /><span>微信机器人使用 JW 相同的扫码授权方式，不需要填写 Webhook 或签名密钥。</span></div>
            <div className="jw-settings-card jw-weixin-login-card">
              <h3>扫码添加微信机器人</h3>
              {weixinLogin ? <div className="jw-weixin-qr-stage">
                <div className="jw-weixin-qr-frame"><img src={weixinLogin.qrcodeUrl} alt="微信机器人登录二维码" /></div>
                <div><strong>请使用微信扫码</strong><p>{weixinLogin.message}</p><small>二维码约 {Math.round(weixinLogin.expiresInSeconds / 60)} 分钟内有效，扫码后请在微信中确认授权。</small><span className="jw-weixin-waiting"><span />正在等待扫码结果</span></div>
              </div> : <div className="jw-weixin-login-empty"><span><Smartphone className="h-9 w-9" /></span><div><strong>通过微信扫码完成授权</strong><p>点击后生成登录二维码。确认授权后，账号会自动加入下方列表并加密保存凭据。</p></div><button className="jw-primary-button" disabled={busy !== ''} onClick={() => void startWeixinLogin()}><QrCode className="h-4 w-4" />{platformBots.length ? '添加微信机器人' : '生成二维码'}</button></div>}
            </div>
            <div className="jw-settings-card"><div className="jw-section-heading"><div><h3>已授权账号</h3><p>已连接 {platformBots.filter((bot) => bot.connectionStatus === 'connected').length} 个微信机器人</p></div></div><div className="jw-weixin-account-list">
              {platformBots.map((bot) => <button type="button" key={bot.id} className={`jw-weixin-account ${selectedBot?.id === bot.id ? 'active' : ''}`} onClick={() => setSelectedBotId(bot.id)}><span className="jw-provider-mark" style={{ background: WECHAT_COLOR }}><Bot className="h-4 w-4" /></span><span><strong>{bot.name}</strong><small>账号 {String(bot.config.accountId || bot.id).slice(0, 18)} · {bot.connectionStatus === 'connected' ? '已连接' : '未连接'}</small></span><span className={`jw-status-dot ${bot.connectionStatus === 'connected' ? 'connected' : ''}`} /></button>)}
              {!platformBots.length && <div className="jw-empty-panel compact"><QrCode className="h-10 w-10" /><p>尚未添加微信机器人，请先生成二维码并扫码授权</p></div>}
            </div></div>
            {selectedBot && <div className="jw-settings-card"><h3>账号控制</h3><label className="jw-switch-row"><span><strong>启用机器人</strong><small>停用后会阻断该账号的新消息</small></span><Toggle value={selectedBot.enabled} disabled={busy !== ''} label={`${selectedBot.name}${selectedBot.enabled ? '停用' : '启用'}`} onChange={(enabled) => void toggleBot(selectedBot, enabled)} /></label><div className="flex flex-wrap items-center gap-2"><button className="jw-secondary-button" disabled={busy !== ''} onClick={() => void startWeixinLogin()}><RefreshCw className="h-4 w-4" />重新扫码授权</button><button className="jw-secondary-button" disabled={busy !== '' || !selectedBot.enabled} onClick={() => void toggleBot(selectedBot, false)}><Unplug className="h-4 w-4" />断开</button><span className={`jw-connection-chip ${selectedBot.connectionStatus === 'connected' ? 'connected' : ''}`}><span />{selectedBot.connectionStatus === 'connected' ? '连接正常' : selectedBot.connectionStatus}</span></div>{selectedBot.lastConnectedAt && <p className="jw-card-hint"><Clock3 className="h-3.5 w-3.5" />授权时间：{formatShanghaiDateTime(selectedBot.lastConnectedAt)}</p>}</div>}
          </div>
        </>}

        {section === 'bindings' && selectedBot && <div className="jw-scroll-content with-toolbar"><div className="jw-section-heading sticky"><div><h3>用户、项目与 Agent 会话绑定</h3><p>外部群聊必须映射到稳定用户，可选限定项目与已就绪 Agent 会话</p></div><button onClick={() => setShowBindingModal(true)}><CirclePlus className="h-4 w-4" />新增绑定</button></div><div className="jw-binding-list">{botBindings.map((binding) => <div className={`jw-binding-item ${!binding.enabled ? 'disabled' : ''}`} key={binding.id}><span className="jw-capability-glyph"><ShieldCheck className="h-4 w-4" /></span><div className="min-w-0 flex-1"><strong>{binding.externalConversationId}</strong><p>{userNames.get(binding.userId) || binding.userId} · {binding.projectId ? projectNames.get(binding.projectId) : '未限定项目'}</p><small>{binding.conversationId ? settings.conversations.find((item) => item.id === binding.conversationId)?.title || binding.conversationId : '仅出站'} · v{binding.version}</small></div><button className="jw-icon-btn" title="测试发送" onClick={() => { setSendBinding(binding); setSendMessage('') }}><Send className="h-4 w-4" /></button><button className="jw-icon-btn" title="配置历史" onClick={() => setRevisionTarget({ basePath: '/integrations/im', resourceType: 'im_binding', resourceId: binding.id, resourceLabel: `IM 绑定：${botNames.get(binding.botId) || binding.id}`, currentVersion: binding.version })}><History className="h-4 w-4" /></button><Toggle value={binding.enabled} disabled={busy !== ''} label={`绑定${binding.enabled ? '停用' : '启用'}`} onChange={(enabled) => void mutate(`binding-${binding.id}`, () => apiPatch(`/integrations/im/bindings/${binding.id}`, { expectedVersion: binding.version, enabled }), enabled ? '绑定已启用。' : '绑定已停用。', selectedBot.id)} /><button className="jw-delete-text" onClick={() => window.confirm('确定删除该 IM 绑定吗？') && void mutate(`delete-${binding.id}`, () => apiDelete(`/integrations/im/bindings/${binding.id}`), '绑定已删除。', selectedBot.id)}>删除</button></div>)}{!botBindings.length && <div className="jw-empty-panel"><UsersRound className="h-12 w-12" /><p>该机器人尚未创建授权绑定</p></div>}</div></div>}

        {section === 'delivery' && selectedBot && <div className="jw-scroll-content with-toolbar"><div className="jw-section-heading sticky"><div><h3>Outbox 与投递日志</h3><p>失败任务按指数退避重试，超过上限后进入死信</p></div><button className="jw-secondary-button" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />刷新</button></div><div className="jw-delivery-list">{botOutbox.map((row) => { const log = settings.deliveryLogs.find((item) => item.outboxId === row.id); return <div className="jw-delivery-item" key={row.id}><span className={`jw-delivery-status ${['sent', 'dispatched'].includes(row.status) ? 'ok' : ['failed', 'dead_letter'].includes(row.status) ? 'error' : 'pending'}`}><Send className="h-4 w-4" /></span><div className="min-w-0 flex-1"><strong>{row.status}</strong><p>任务 {row.id.slice(0, 8)} · 已尝试 {row.attempts} 次</p><small>{log ? `HTTP ${log.httpStatus ?? '-'} · ${log.durationMs}ms · ${formatShanghaiDateTime(log.createdAt)}` : '等待调度'}</small>{(row.lastError || log?.error) && <em>{row.lastError || log?.error}</em>}</div></div> })}{!botOutbox.length && <div className="jw-empty-panel"><MessageSquareText className="h-12 w-12" /><p>暂无投递记录</p></div>}</div></div>}
      </section>
    </div>

    <Modal open={showBindingModal} title="新增 IM 授权绑定" onClose={() => setShowBindingModal(false)} footer={<><button className="jw-secondary-button" onClick={() => setShowBindingModal(false)}>取消</button><button className="jw-primary-button" disabled={busy !== '' || !bindingForm.botId || !bindingForm.userId || !bindingForm.externalConversationId} onClick={() => void createBinding()}>添加</button></>}><div className="space-y-4"><label className="jw-form-item"><span>机器人</span><select value={bindingForm.botId} onChange={(event) => setBindingForm({ ...bindingForm, botId: event.target.value })}>{platformBots.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="jw-form-item"><span>内部用户</span><select value={bindingForm.userId} onChange={(event) => setBindingForm({ ...bindingForm, userId: event.target.value, conversationId: '' })}><option value="">选择用户</option>{settings.users.filter((item) => item.status === '启用').map((item) => <option key={item.id} value={item.id}>{item.name} · {item.department}</option>)}</select></label><label className="jw-form-item"><span>项目</span><select value={bindingForm.projectId} onChange={(event) => setBindingForm({ ...bindingForm, projectId: event.target.value, conversationId: '' })}><option value="">不限定项目</option>{settings.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="jw-form-item"><span>Agent 会话</span><select value={bindingForm.conversationId} onChange={(event) => setBindingForm({ ...bindingForm, conversationId: event.target.value })}><option value="">不接入 Agent（仅出站）</option>{filteredConversations.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label className="jw-form-item"><span>外部群聊 / 会话 ID</span><input value={bindingForm.externalConversationId} onChange={(event) => setBindingForm({ ...bindingForm, externalConversationId: event.target.value })} /></label></div></Modal>
    <Modal open={!!sendBinding} title="测试发送" onClose={() => setSendBinding(null)} footer={<><button className="jw-secondary-button" onClick={() => setSendBinding(null)}>取消</button><button className="jw-primary-button" disabled={busy !== '' || !sendMessage.trim()} onClick={() => void queueTestMessage()}><Send className="h-4 w-4" />加入 Outbox</button></>}><div className="space-y-4"><div className="jw-info-banner compact"><TestTube2 className="h-4 w-4" /><span>目标：{sendBinding?.externalConversationId}</span></div><label className="jw-form-item"><span>测试消息</span><textarea rows={5} value={sendMessage} onChange={(event) => setSendMessage(event.target.value)} placeholder="输入要发送的测试内容" /></label></div></Modal>
    {revisionTarget && <ConfigurationRevisionPanel target={revisionTarget} onClose={() => setRevisionTarget(null)} onRolledBack={refresh} />}
  </div>
}
