import { CheckCircle2, Clock3, Eye, EyeOff, Link2, RefreshCw, Save, Send, ShieldCheck, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost, apiPut } from '../lib/api'
import { formatShanghaiDateTime } from '../lib/dateTime'

type Settings = {
  id: string
  configured: boolean
  credentialMasked: string | null
  enabled: boolean
  notifySuccess: boolean
  version: number
  lastTestStatus: 'succeeded' | 'failed' | null
  lastTestError: string | null
  lastTestLatencyMs: number | null
  lastTestAt: string | null
  lastDeliveryStatus: 'succeeded' | 'failed' | null
  lastDeliveryError: string | null
  lastDeliveryAt: string | null
  updatedAt: string | null
}

const emptySettings: Settings = {
  id: 'default', configured: false, credentialMasked: null, enabled: false,
  notifySuccess: true, version: 0, lastTestStatus: null, lastTestError: null,
  lastTestLatencyMs: null, lastTestAt: null, lastDeliveryStatus: null,
  lastDeliveryError: null, lastDeliveryAt: null, updatedAt: null,
}

function Toggle({ value, disabled, onChange, label }: { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled} onClick={() => onChange(!value)} className={`jw-switch ${value ? 'is-on' : ''}`}><span /></button>
}

export function RadarDingTalkSettingsPage() {
  const [settings, setSettings] = useState<Settings>(emptySettings)
  const [draft, setDraft] = useState({ webhookUrl: '', signingSecret: '', enabled: false, notifySuccess: true })
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [showWebhook, setShowWebhook] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [editingCredentials, setEditingCredentials] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const result = await apiGet<Settings>('/integrations/radar-dingtalk')
      setSettings(result)
      setDraft((current) => ({ ...current, webhookUrl: '', signingSecret: '', enabled: result.enabled, notifySuccess: result.notifySuccess }))
      setEditingCredentials(!result.configured)
      setShowWebhook(false)
      setShowSecret(false)
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const hasCredentialInput = editingCredentials && Boolean(draft.webhookUrl.trim() || draft.signingSecret.trim())
  const credentialsComplete = Boolean(draft.webhookUrl.trim() && draft.signingSecret.trim().length >= 8)
  const canSave = !busy && (settings.configured ? (!editingCredentials || credentialsComplete) : credentialsComplete)
  const maskedWebhook = `https://oapi.dingtalk.com/robot/send?access_token=${settings.credentialMasked || '••••••••'}`

  async function save() {
    setBusy('save'); setNotice(null)
    try {
      const result = await apiPut<Settings>('/integrations/radar-dingtalk', {
        expectedVersion: settings.version,
        ...(hasCredentialInput ? { webhookUrl: draft.webhookUrl.trim(), signingSecret: draft.signingSecret.trim() } : {}),
        enabled: draft.enabled,
        notifySuccess: draft.notifySuccess,
      })
      setSettings(result)
      setDraft({ webhookUrl: '', signingSecret: '', enabled: result.enabled, notifySuccess: result.notifySuccess })
      setEditingCredentials(false)
      setShowWebhook(false)
      setShowSecret(false)
      setNotice({ tone: 'ok', text: '配置已安全保存。如更换了凭据，请执行一次连接测试。' })
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
    } finally { setBusy('') }
  }

  async function testConnection() {
    setBusy('test'); setNotice(null)
    try {
      const result = await apiPost<{ ok: boolean; latencyMs: number }>('/integrations/radar-dingtalk/test')
      setNotice({ tone: 'ok', text: `测试消息已发送，耗时 ${result.latencyMs} ms。` })
      await refresh()
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
      await refresh()
    } finally { setBusy('') }
  }

  return <div className="jw-admin-page mx-auto w-full max-w-4xl">
    <div className="jw-page-header"><div><h1>Radar 钉钉告警</h1><p>独立配置采集状态通知，不使用 IM 机器人或会话绑定</p></div><button className="jw-icon-btn" title="刷新" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button></div>

    <div className="jw-scroll-content">
      {notice && <div className={`mb-4 flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs ${notice.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>{notice.tone === 'ok' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}{notice.text}</div>}

      <div className="jw-settings-card">
        <div className="jw-info-banner mb-4"><ShieldCheck className="h-4 w-4" /><span>Webhook access_token 与加签密钥会作为一份 AES-256-GCM 密文保存。页面仅回填脱敏值，完整凭据不会返回浏览器。</span></div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="!mb-0">机器人凭据</h3>
          {settings.configured && <button type="button" className="jw-secondary-button" disabled={busy !== ''} onClick={() => {
            setEditingCredentials((value) => !value)
            setDraft((current) => ({ ...current, webhookUrl: '', signingSecret: '' }))
            setShowWebhook(false)
            setShowSecret(false)
          }}><RefreshCw className="h-3.5 w-3.5" />{editingCredentials ? '保留现有配置' : '更换配置'}</button>}
        </div>
        <label className="jw-form-item"><span>Webhook URL <small>{settings.configured && !editingCredentials ? '已安全保存，显示脱敏值' : '请输入完整 Webhook'}</small></span>{settings.configured && !editingCredentials
          ? <input type="text" readOnly aria-label="已配置的 Webhook（脱敏）" value={maskedWebhook} />
          : <div className="jw-input-with-icon"><input type={showWebhook ? 'text' : 'password'} autoComplete="new-password" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." value={draft.webhookUrl} onChange={(event) => setDraft({ ...draft, webhookUrl: event.target.value })} /><button type="button" aria-label={showWebhook ? '隐藏 Webhook' : '显示 Webhook'} onClick={() => setShowWebhook((value) => !value)}>{showWebhook ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>}
        </label>
        <label className="jw-form-item"><span>加签密钥 <small>{settings.configured && !editingCredentials ? '已安全保存，显示脱敏值' : 'SEC 开头的机器人密钥'}</small></span>{settings.configured && !editingCredentials
          ? <input type="text" readOnly aria-label="已配置的加签密钥（脱敏）" value="SEC••••••••••••••••" />
          : <div className="jw-input-with-icon"><input type={showSecret ? 'text' : 'password'} autoComplete="new-password" placeholder="输入钉钉机器人加签密钥" value={draft.signingSecret} onChange={(event) => setDraft({ ...draft, signingSecret: event.target.value })} /><button type="button" aria-label={showSecret ? '隐藏加签密钥' : '显示加签密钥'} onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>}
        </label>
      </div>

      <div className="jw-settings-card">
        <h3>通知策略</h3>
        <label className="jw-switch-row"><span><strong>启用 Radar 钉钉告警</strong><small>启用后，采集任务结束会直接向该 Webhook 发送状态</small></span><Toggle value={draft.enabled} disabled={busy !== ''} label="启用 Radar 钉钉告警" onChange={(enabled) => setDraft({ ...draft, enabled })} /></label>
        <label className="jw-switch-row"><span><strong>成功任务也发送</strong><small>关闭后仅推送“部分成功”和“失败”，减少群消息噪音</small></span><Toggle value={draft.notifySuccess} disabled={busy !== ''} label="成功任务也发送" onChange={(notifySuccess) => setDraft({ ...draft, notifySuccess })} /></label>
      </div>

      <div className="jw-settings-card">
        <h3>连接与运行状态</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button className="jw-primary-button" disabled={busy !== '' || !settings.configured} onClick={() => void testConnection()}><Send className="h-4 w-4" />{busy === 'test' ? '正在发送…' : '发送测试消息'}</button>
          <span className={`jw-connection-chip ${settings.lastTestStatus === 'succeeded' ? 'connected' : ''}`}><span />{!settings.configured ? '未配置' : settings.lastTestStatus === 'succeeded' ? '连接正常' : settings.lastTestStatus === 'failed' ? '测试失败' : '待测试'}</span>
        </div>
        {settings.lastTestAt && <p className="jw-card-hint"><Clock3 className="h-3.5 w-3.5" />最近测试：{formatShanghaiDateTime(settings.lastTestAt)}{settings.lastTestLatencyMs !== null ? ` · ${settings.lastTestLatencyMs} ms` : ''}</p>}
        {settings.lastTestError && <p className="jw-error-text">{settings.lastTestError}</p>}
        {settings.lastDeliveryAt && <p className="jw-card-hint"><Link2 className="h-3.5 w-3.5" />最近采集通知：{formatShanghaiDateTime(settings.lastDeliveryAt)} · {settings.lastDeliveryStatus === 'succeeded' ? '发送成功' : '发送失败'}</p>}
        {settings.lastDeliveryError && <p className="jw-error-text">{settings.lastDeliveryError}</p>}
      </div>
    </div>

    <div className="jw-sticky-footer"><button className="jw-secondary-button" disabled={busy !== ''} onClick={() => {
      setDraft({ webhookUrl: '', signingSecret: '', enabled: settings.enabled, notifySuccess: settings.notifySuccess })
      setEditingCredentials(!settings.configured)
      setShowWebhook(false)
      setShowSecret(false)
    }}><RefreshCw className="h-4 w-4" />取消修改</button><button className="jw-primary-button" disabled={!canSave} onClick={() => void save()}><Save className="h-4 w-4" />{busy === 'save' ? '保存中…' : '保存配置'}</button></div>
  </div>
}
