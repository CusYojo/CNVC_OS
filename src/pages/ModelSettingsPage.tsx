import {
  Check, ChevronRight, CircleDot, Clock3, Eye, EyeOff, History, Pencil, Plus,
  RefreshCw, RotateCcw, Save, Server, TestTube2, X, XCircle, Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfigurationRevisionPanel, type ConfigurationRevisionTarget } from '../components/ConfigurationRevisionPanel'
import { Modal } from '../components/ui'
import { apiGet, apiPatch, apiPost, apiPut } from '../lib/api'

type Provider = {
  id: string; name: string; protocol: string; baseUrl: string; timeoutMs: number; enabled: boolean;
  version: number; hasCredential: boolean; credentialMasked: string | null;
  lastTestStatus: string | null; lastTestError: string | null; lastTestLatencyMs: number | null;
  lastTestTraceId: string | null; lastTestAt: string | null;
}
type Model = {
  id: string; providerId: string; modelKey: string; displayName: string; contextWindow: number | null;
  capabilityTags: string[]; allowedRoles: string[]; enabled: boolean; isDefault: boolean; version: number;
}
type ModelRoute = { profileKey: string; modelId: string; fallbackModelId: string | null; enabled: boolean; version: number }
type Settings = { providers: Provider[]; models: Model[]; routes: ModelRoute[]; profileKeys: string[] }
type ProviderDraft = { name: string; protocol: string; baseUrl: string; apiKey: string; timeoutMs: string; selectedModelId: string }
type ModelDraft = {
  id?: string; providerId: string; modelKey: string; displayName: string; contextWindow: string;
  capabilityTags: string; allowedRoles: string;
}

const emptySettings: Settings = { providers: [], models: [], routes: [], profileKeys: [] }
const emptyModel = (providerId = ''): ModelDraft => ({
  providerId, modelKey: '', displayName: '', contextWindow: '', capabilityTags: 'chat', allowedRoles: '',
})
const csv = (value: string) => [...new Set(value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))]
const routeLabels: Record<string, string> = {
  interactive: '互动助手', subject: '线索主体', research: '线索研究', screening: '项目初筛',
  enrichment: '信息补全', scoring: '项目评分', document: '文档生成',
}

function Toggle({ value, disabled, onChange, label }: { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled} onClick={(event) => { event.stopPropagation(); onChange(!value) }} className={`jw-switch ${value ? 'is-on' : ''}`}><span /></button>
}

export function ModelSettingsPage() {
  const [settings, setSettings] = useState<Settings>(emptySettings)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [section, setSection] = useState<'provider' | 'routes'>('provider')
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModel())
  const [showProviderModal, setShowProviderModal] = useState(false)
  const [showModelModal, setShowModelModal] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [revisionTarget, setRevisionTarget] = useState<ConfigurationRevisionTarget | null>(null)
  const [providerForm, setProviderForm] = useState({ name: '', protocol: 'openai-compatible', baseUrl: '', apiKey: '', timeoutMs: '120000' })

  const refresh = useCallback(async (preferredProviderId?: string) => {
    setLoading(true)
    try {
      const result = await apiGet<Settings>('/ai/model-settings')
      setSettings(result)
      setSelectedProviderId((current) => {
        const desired = preferredProviderId || current
        return result.providers.some((item) => item.id === desired) ? desired : result.providers[0]?.id || ''
      })
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message })
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const selectedProvider = settings.providers.find((item) => item.id === selectedProviderId) || null
  const providerModels = useMemo(() => settings.models.filter((item) => item.providerId === selectedProviderId), [settings.models, selectedProviderId])
  const modelNames = useMemo(() => new Map(settings.models.map((item) => [item.id, item.displayName])), [settings.models])

  useEffect(() => {
    if (!selectedProvider) { setDraft(null); return }
    const defaultModel = providerModels.find((item) => item.isDefault)
    setDraft({
      name: selectedProvider.name,
      protocol: selectedProvider.protocol,
      baseUrl: selectedProvider.baseUrl,
      apiKey: '',
      timeoutMs: String(selectedProvider.timeoutMs),
      selectedModelId: defaultModel?.id || '',
    })
  }, [selectedProvider, providerModels])

  async function mutate(key: string, action: () => Promise<unknown>, success: string, preferredProviderId?: string) {
    setBusy(key); setNotice(null)
    try { await action(); setNotice({ tone: 'ok', text: success }); await refresh(preferredProviderId); return true }
    catch (error) { setNotice({ tone: 'error', text: (error as Error).message }); return false }
    finally { setBusy('') }
  }

  async function createProvider() {
    let created: { id?: string } | undefined
    const ok = await mutate('provider-create', async () => {
      created = await apiPost<{ id?: string }>('/ai/model-settings/providers', {
        ...providerForm, timeoutMs: Number(providerForm.timeoutMs), enabled: true,
      })
    }, '模型提供商已添加，密钥已加密保存。')
    if (ok) {
      setShowProviderModal(false)
      setProviderForm({ name: '', protocol: 'openai-compatible', baseUrl: '', apiKey: '', timeoutMs: '120000' })
      if (created?.id) { setSelectedProviderId(created.id); await refresh(created.id) }
    }
  }

  async function saveProvider() {
    if (!selectedProvider || !draft) return
    await mutate('provider-save', async () => {
      await apiPatch(`/ai/model-settings/providers/${selectedProvider.id}`, {
        expectedVersion: selectedProvider.version,
        name: draft.name, protocol: draft.protocol, baseUrl: draft.baseUrl,
        timeoutMs: Number(draft.timeoutMs), ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      })
      const chosen = providerModels.find((item) => item.id === draft.selectedModelId)
      if (chosen && !chosen.isDefault) {
        await apiPatch(`/ai/model-settings/models/${chosen.id}`, { expectedVersion: chosen.version, isDefault: true, enabled: true })
      }
    }, '提供商配置与默认模型已保存。', selectedProvider.id)
  }

  async function saveModel() {
    const payload = {
      providerId: modelDraft.providerId,
      modelKey: modelDraft.modelKey,
      displayName: modelDraft.displayName,
      contextWindow: modelDraft.contextWindow ? Number(modelDraft.contextWindow) : null,
      capabilityTags: csv(modelDraft.capabilityTags), allowedRoles: csv(modelDraft.allowedRoles),
    }
    const existing = modelDraft.id ? settings.models.find((item) => item.id === modelDraft.id) : null
    const ok = await mutate('model-save', () => existing
      ? apiPatch(`/ai/model-settings/models/${existing.id}`, { expectedVersion: existing.version, ...payload })
      : apiPost('/ai/model-settings/models', { ...payload, enabled: true, isDefault: providerModels.length === 0 }),
    existing ? '模型配置已保存。' : '模型已添加。', modelDraft.providerId)
    if (ok) { setShowModelModal(false); setModelDraft(emptyModel(selectedProviderId)) }
  }

  function resetDraft() {
    if (!selectedProvider) return
    const defaultModel = providerModels.find((item) => item.isDefault)
    setDraft({ name: selectedProvider.name, protocol: selectedProvider.protocol, baseUrl: selectedProvider.baseUrl, apiKey: '', timeoutMs: String(selectedProvider.timeoutMs), selectedModelId: defaultModel?.id || '' })
  }

  if (loading && !settings.providers.length) return <div className="grid min-h-[50vh] place-items-center text-sm text-slate-500">正在读取模型配置…</div>

  return <div className="jw-admin-page">
    <div className="jw-page-header">
      <div><h1>模型管理</h1><p>管理模型提供商、访问凭据、可用模型与任务路由</p></div>
      <button className="jw-icon-btn" title="刷新" aria-label="刷新模型配置" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button>
    </div>
    {notice && <div className={`jw-notice ${notice.tone}`}><span>{notice.tone === 'ok' ? <Check className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}</span>{notice.text}<button aria-label="关闭提示" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button></div>}

    <div className="jw-split-workbench">
      <aside className="jw-object-panel">
        <div className="jw-panel-header"><span>模型提供商</span><button className="jw-round-add" title="添加第三方提供商" aria-label="添加模型提供商" onClick={() => setShowProviderModal(true)}><Plus className="h-4 w-4" /></button></div>
        <div className="jw-object-list">
          {settings.providers.map((provider, index) => <div role="button" tabIndex={0} key={provider.id} className={`jw-object-item ${selectedProviderId === provider.id ? 'active' : ''}`} onClick={() => { setSelectedProviderId(provider.id); setSection('provider') }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelectedProviderId(provider.id); setSection('provider') } }}>
            <span className="jw-provider-mark" style={{ background: ['#0ea5e9', '#7c3aed', '#10b981', '#f97316'][index % 4] }}><Server className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1 text-left"><strong className="block truncate">{provider.name}</strong><small className="block truncate">{provider.protocol}</small></span>
            <Toggle value={provider.enabled} disabled={busy !== ''} label={`${provider.name}${provider.enabled ? '停用' : '启用'}`} onChange={(enabled) => void mutate(`provider-toggle-${provider.id}`, () => apiPatch(`/ai/model-settings/providers/${provider.id}`, { expectedVersion: provider.version, enabled }), enabled ? '提供商已启用。' : '提供商已停用。', provider.id)} />
          </div>)}
          {!settings.providers.length && <div className="jw-empty-compact"><Server className="h-7 w-7" /><span>暂无模型提供商</span></div>}
        </div>
        <div className="jw-side-nav">
          <button className={section === 'routes' ? 'active' : ''} onClick={() => setSection('routes')}><Zap className="h-4 w-4" /><span>任务模型路由</span><ChevronRight className="ml-auto h-3.5 w-3.5" /></button>
        </div>
      </aside>

      <section className="jw-detail-panel">
        {section === 'routes' ? <div className="flex h-full min-h-0 flex-col">
          <div className="jw-detail-heading"><div><h2>任务模型路由</h2><p>为各类 JW Agent 任务配置主模型与故障回退模型</p></div></div>
          <div className="jw-scroll-content">
            <div className="jw-info-banner"><Zap className="h-4 w-4" /><span>主模型不可用时自动切换备用模型；两者均不可用时才使用迁移期网关兜底。</span></div>
            <div className="jw-list-card">
              {settings.profileKeys.map((profileKey) => {
                const route = settings.routes.find((item) => item.profileKey === profileKey)
                return <div key={profileKey} className="jw-route-row">
                  <div className="jw-route-name"><span className="jw-provider-mark"><CircleDot className="h-4 w-4" /></span><span><strong>{routeLabels[profileKey] || profileKey}</strong><small>{profileKey}</small></span></div>
                  <label>主模型<select value={route?.modelId || ''} onChange={(event) => { const modelId = event.target.value; if (!modelId) return; void mutate(`route-${profileKey}`, () => apiPut(`/ai/model-settings/routes/${profileKey}`, { profileKey, modelId, fallbackModelId: route?.fallbackModelId || null, enabled: true, expectedVersion: route?.version }), '主模型路由已保存。') }}><option value="">选择主模型</option>{settings.models.filter((item) => item.enabled).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
                  <label>备用模型<select value={route?.fallbackModelId || ''} disabled={!route} onChange={(event) => route && void mutate(`fallback-${profileKey}`, () => apiPut(`/ai/model-settings/routes/${profileKey}`, { profileKey, modelId: route.modelId, fallbackModelId: event.target.value || null, enabled: route.enabled, expectedVersion: route.version }), '备用模型路由已保存。')}><option value="">无备用模型</option>{settings.models.filter((item) => item.enabled && item.id !== route?.modelId).map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>
                  <span className="jw-route-current">{route ? modelNames.get(route.modelId) : '未配置'}</span>
                  <button className="jw-icon-btn" title="查看历史" disabled={!route} onClick={() => route && setRevisionTarget({ basePath: '/ai/model-settings', resourceType: 'route', resourceId: profileKey, resourceLabel: `模型路由：${profileKey}`, currentVersion: route.version })}><History className="h-4 w-4" /></button>
                </div>
              })}
            </div>
          </div>
        </div> : selectedProvider && draft ? <>
          <div className="jw-detail-heading"><div><h2>{selectedProvider.name}</h2><p>{selectedProvider.credentialMasked || '尚未配置凭据'} · 配置版本 v{selectedProvider.version}</p></div><button className="jw-icon-btn" title="配置历史" onClick={() => setRevisionTarget({ basePath: '/ai/model-settings', resourceType: 'provider', resourceId: selectedProvider.id, resourceLabel: `Provider：${selectedProvider.name}`, currentVersion: selectedProvider.version })}><History className="h-4 w-4" /></button></div>
          <div className="jw-scroll-content">
            <div className="jw-form-grid two">
              <label className="jw-form-item"><span>提供商名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="jw-form-item"><span>协议</span><select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value })}><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic-compatible">Anthropic 兼容</option></select></label>
            </div>
            <label className="jw-form-item"><span>API Key <small>留空表示不替换当前密钥</small></span><div className="jw-input-with-icon"><input type={showApiKey ? 'text' : 'password'} autoComplete="new-password" placeholder={selectedProvider.hasCredential ? selectedProvider.credentialMasked || '已配置' : '输入 API Key'} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><button type="button" aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label>
            <div className="jw-form-grid timeout">
              <label className="jw-form-item"><span>API Base URL</span><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
              <label className="jw-form-item"><span>连接超时（毫秒）</span><input inputMode="numeric" value={draft.timeoutMs} onChange={(event) => setDraft({ ...draft, timeoutMs: event.target.value })} /></label>
            </div>
            <button className="jw-test-button" disabled={busy !== '' || !selectedProvider.hasCredential} onClick={() => void mutate(`test-${selectedProvider.id}`, () => apiPost(`/ai/model-settings/providers/${selectedProvider.id}/test`), '连接测试已完成。', selectedProvider.id)}><TestTube2 className="h-4 w-4" />{busy === `test-${selectedProvider.id}` ? '正在连接…' : '测试连接'}</button>
            {selectedProvider.lastTestAt && <div className={`jw-connection-result ${selectedProvider.lastTestStatus === 'succeeded' ? 'ok' : 'error'}`}><Clock3 className="h-4 w-4" /><span>最近测试：{selectedProvider.lastTestStatus === 'succeeded' ? '连接成功' : '连接失败'} · {selectedProvider.lastTestLatencyMs ?? 0}ms</span>{selectedProvider.lastTestError && <small>{selectedProvider.lastTestError}</small>}</div>}

            <div className="jw-section-heading"><div><h3>可用模型</h3><p>点击模型设为该提供商的默认模型</p></div><button onClick={() => { setModelDraft(emptyModel(selectedProvider.id)); setShowModelModal(true) }}><Plus className="h-4 w-4" />添加模型</button></div>
            <div className="jw-model-list">
              {providerModels.map((model) => <div role="button" tabIndex={0} key={model.id} className={`jw-model-item ${draft.selectedModelId === model.id ? 'active' : ''} ${!model.enabled ? 'disabled' : ''}`} onClick={() => model.enabled && setDraft({ ...draft, selectedModelId: model.id })} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && model.enabled) setDraft({ ...draft, selectedModelId: model.id }) }}>
                <span className="jw-radio-dot">{draft.selectedModelId === model.id && <span />}</span>
                <span className="min-w-0 flex-1 text-left"><strong>{model.displayName}</strong><small>{model.modelKey}</small><em>{[...model.capabilityTags, ...model.allowedRoles].join(' · ') || '未限制能力与角色'}</em></span>
                <Toggle value={model.enabled} disabled={busy !== ''} label={`${model.displayName}${model.enabled ? '停用' : '启用'}`} onChange={(enabled) => void mutate(`model-toggle-${model.id}`, () => apiPatch(`/ai/model-settings/models/${model.id}`, { expectedVersion: model.version, enabled }), enabled ? '模型已启用。' : '模型已停用。', selectedProvider.id)} />
                <span role="button" tabIndex={0} className="jw-item-action" title="编辑模型" onClick={(event) => { event.stopPropagation(); setModelDraft({ id: model.id, providerId: model.providerId, modelKey: model.modelKey, displayName: model.displayName, contextWindow: model.contextWindow ? String(model.contextWindow) : '', capabilityTags: model.capabilityTags.join(', '), allowedRoles: model.allowedRoles.join(', ') }); setShowModelModal(true) }}><Pencil className="h-4 w-4" /></span>
                <span role="button" tabIndex={0} className="jw-item-action" title="模型历史" onClick={(event) => { event.stopPropagation(); setRevisionTarget({ basePath: '/ai/model-settings', resourceType: 'model', resourceId: model.id, resourceLabel: `模型：${model.displayName}`, currentVersion: model.version }) }}><History className="h-4 w-4" /></span>
              </div>)}
              {!providerModels.length && <div className="jw-empty-compact"><CircleDot className="h-7 w-7" /><span>该提供商尚未添加模型</span></div>}
            </div>
          </div>
          <div className="jw-sticky-footer"><button className="jw-secondary-button" disabled={busy !== ''} onClick={resetDraft}><RotateCcw className="h-4 w-4" />取消</button><button className="jw-primary-button" disabled={busy !== '' || !draft.name || !draft.baseUrl} onClick={() => void saveProvider()}><Save className="h-4 w-4" />保存</button></div>
        </> : <div className="jw-empty-panel"><Server className="h-12 w-12" /><p>请选择一个模型提供商</p></div>}
      </section>
    </div>

    <Modal open={showProviderModal} title="添加第三方提供商" onClose={() => setShowProviderModal(false)} footer={<><button className="jw-secondary-button" onClick={() => setShowProviderModal(false)}>取消</button><button className="jw-primary-button" disabled={busy !== '' || !providerForm.name || !providerForm.baseUrl || providerForm.apiKey.length < 8} onClick={() => void createProvider()}>添加</button></>}>
      <div className="space-y-4"><label className="jw-form-item"><span>提供商名称</span><input placeholder="例如：企业模型网关" value={providerForm.name} onChange={(event) => setProviderForm({ ...providerForm, name: event.target.value })} /></label><label className="jw-form-item"><span>协议</span><select value={providerForm.protocol} onChange={(event) => setProviderForm({ ...providerForm, protocol: event.target.value })}><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic-compatible">Anthropic 兼容</option></select></label><label className="jw-form-item"><span>API Base URL</span><input placeholder="https://gateway.example.com/v1" value={providerForm.baseUrl} onChange={(event) => setProviderForm({ ...providerForm, baseUrl: event.target.value })} /></label><label className="jw-form-item"><span>API Key</span><input type="password" autoComplete="new-password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} /></label><label className="jw-form-item"><span>连接超时（毫秒）</span><input inputMode="numeric" value={providerForm.timeoutMs} onChange={(event) => setProviderForm({ ...providerForm, timeoutMs: event.target.value })} /></label></div>
    </Modal>

    <Modal open={showModelModal} title={modelDraft.id ? '编辑模型' : '添加模型'} onClose={() => setShowModelModal(false)} footer={<><button className="jw-secondary-button" onClick={() => setShowModelModal(false)}>取消</button><button className="jw-primary-button" disabled={busy !== '' || !modelDraft.providerId || !modelDraft.modelKey || !modelDraft.displayName} onClick={() => void saveModel()}>{modelDraft.id ? '保存' : '添加'}</button></>}>
      <div className="space-y-4"><label className="jw-form-item"><span>模型提供商</span><select disabled={!!modelDraft.id} value={modelDraft.providerId} onChange={(event) => setModelDraft({ ...modelDraft, providerId: event.target.value })}>{settings.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label className="jw-form-item"><span>模型 ID</span><input placeholder="例如：gpt-5.6-sol" value={modelDraft.modelKey} onChange={(event) => setModelDraft({ ...modelDraft, modelKey: event.target.value })} /></label><label className="jw-form-item"><span>模型名称</span><input placeholder="用于界面展示" value={modelDraft.displayName} onChange={(event) => setModelDraft({ ...modelDraft, displayName: event.target.value })} /></label><label className="jw-form-item"><span>上下文窗口</span><input inputMode="numeric" placeholder="可选" value={modelDraft.contextWindow} onChange={(event) => setModelDraft({ ...modelDraft, contextWindow: event.target.value })} /></label><label className="jw-form-item"><span>能力标签</span><input placeholder="多个标签用逗号分隔" value={modelDraft.capabilityTags} onChange={(event) => setModelDraft({ ...modelDraft, capabilityTags: event.target.value })} /></label><label className="jw-form-item"><span>授权角色</span><input placeholder="留空表示全部授权角色" value={modelDraft.allowedRoles} onChange={(event) => setModelDraft({ ...modelDraft, allowedRoles: event.target.value })} /></label></div>
    </Modal>
    {revisionTarget && <ConfigurationRevisionPanel target={revisionTarget} onClose={() => setRevisionTarget(null)} onRolledBack={refresh} />}
  </div>
}
