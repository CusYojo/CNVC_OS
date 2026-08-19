import {
  Bot, Boxes, Check, ChevronDown, ChevronRight, CirclePlus, FlaskConical, Globe2,
  Download, History, Layers3, Plug, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Upload, X, XCircle,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfigurationRevisionPanel, type ConfigurationRevisionTarget } from '../components/ConfigurationRevisionPanel'
import { Modal } from '../components/ui'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'
import { createCapabilityZip, scanCapabilityFolder, scanCapabilityZip, type CapabilityImportCandidate } from '../lib/capabilityPackage'
import { shanghaiDateKey } from '../lib/dateTime'

type Capability = {
  id: string; kind: 'skill' | 'agent' | 'mcp' | 'plugin'; capabilityKey: string; name: string;
  description: string | null; source: string; packageVersion: string; config: Record<string, unknown>;
  toolNames: string[]; dependencyNames: string[]; allowedRoles: string[]; enabled: boolean; version: number;
  lastTestStatus: string | null; lastTestError: string | null; lastTestTraceId: string | null;
  installed?: boolean; runtimeAvailable?: boolean; approvalStatus?: 'approved' | 'not_approved'; configuredEnabled?: boolean;
}
type Binding = {
  id: string; capabilityId: string; scopeType: 'global' | 'department' | 'project'; scopeKey: string;
  department: string | null; projectId: string | null; enabled: boolean; version: number;
}
type Settings = {
  capabilities: Capability[]; bindings: Binding[]; projects: { id: string; name: string }[];
  agentPolicyOptions?: {
    modelRouteKeys: string[];
    limits: { timeoutMs: { min: number; max: number }; maxTurns: { min: number; max: number }; maxBudgetUsd: { min: number; max: number } };
    approvedToolNamesByCapability: Record<string, string[]>;
  };
  pluginInventory?: { records: number; approved: number; installed: number; runtimeEnabled: number; dynamicInstallEnabled: boolean };
}
type AgentPolicyDraft = {
  capabilityId: string; expectedVersion: number; modelRouteKey: string; timeoutMs: string;
  maxTurns: string; maxBudgetUsd: string; toolNames: string[]; allowedRoles: string;
}
const tabs = [
  { key: 'skill', label: 'Skills', short: 'S', icon: Sparkles },
  { key: 'agent', label: 'Agents', short: 'A', icon: Bot },
  { key: 'mcp', label: 'MCP', short: 'M', icon: Plug },
  { key: 'plugin', label: 'Plugins', short: 'P', icon: Boxes },
] as const

function Toggle({ value, disabled, onChange, label }: { value: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={value} aria-label={label} disabled={disabled} onClick={(event) => { event.stopPropagation(); onChange(!value) }} className={`jw-switch ${value ? 'is-on' : ''}`}><span /></button>
}

export function CapabilitySettingsPage() {
  const [settings, setSettings] = useState<Settings>({ capabilities: [], bindings: [], projects: [] })
  const [tab, setTab] = useState<Capability['kind']>('skill')
  const [view, setView] = useState<'catalog' | 'bindings'>('catalog')
  const [search, setSearch] = useState('')
  const [expandedSources, setExpandedSources] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [showBindingModal, setShowBindingModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [importStep, setImportStep] = useState<1 | 2 | 3>(1)
  const [importCandidates, setImportCandidates] = useState<CapabilityImportCandidate[]>([])
  const [selectedImportKeys, setSelectedImportKeys] = useState<string[]>([])
  const [importSourceLabel, setImportSourceLabel] = useState('')
  const [importError, setImportError] = useState('')
  const [importResult, setImportResult] = useState<{ imported: string[]; skipped: string[]; errors: string[] }>({ imported: [], skipped: [], errors: [] })
  const [bindingDraft, setBindingDraft] = useState({ capabilityId: '', scopeType: 'global', department: '', projectId: '' })
  const [agentDraft, setAgentDraft] = useState<AgentPolicyDraft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Capability | null>(null)
  const [revisionTarget, setRevisionTarget] = useState<ConfigurationRevisionTarget | null>(null)

  const refresh = useCallback(async () => {
    try { setSettings(await apiGet<Settings>('/ai/capabilities')) }
    catch (error) { setNotice({ tone: 'error', text: (error as Error).message }) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  async function mutate(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key); setNotice(null)
    try { await action(); setNotice({ tone: 'ok', text: message }); await refresh(); return true }
    catch (error) { setNotice({ tone: 'error', text: (error as Error).message }); return false }
    finally { setBusy('') }
  }

  const visible = useMemo(() => settings.capabilities.filter((item) => item.kind === tab && `${item.name}${item.capabilityKey}${item.description || ''}${item.source}`.toLowerCase().includes(search.trim().toLowerCase())), [settings.capabilities, tab, search])
  const groups = useMemo(() => {
    const map = new Map<string, Capability[]>()
    visible.forEach((item) => { const key = item.source || '内置目录'; map.set(key, [...(map.get(key) || []), item]) })
    return [...map.entries()]
  }, [visible])
  const names = useMemo(() => new Map(settings.capabilities.map((item) => [item.id, item.name])), [settings.capabilities])
  const projectNames = useMemo(() => new Map(settings.projects.map((item) => [item.id, item.name])), [settings.projects])

  useEffect(() => { setExpandedSources(groups.map(([source]) => source)) }, [tab, groups.length])

  const scopeLabel = (binding: Binding) => binding.scopeType === 'global' ? '全局可用'
    : binding.scopeType === 'department' ? `部门 · ${binding.department}`
      : `项目 · ${projectNames.get(binding.projectId || '') || binding.projectId}`

  function editAgent(item: Capability) {
    setAgentDraft({
      capabilityId: item.id, expectedVersion: item.version,
      modelRouteKey: String(item.config.modelRouteKey || item.capabilityKey),
      timeoutMs: String(item.config.timeoutMs || 120000), maxTurns: String(item.config.maxTurns || 1),
      maxBudgetUsd: String(item.config.maxBudgetUsd || 1), toolNames: [...item.toolNames], allowedRoles: item.allowedRoles.join('，'),
    })
  }

  async function saveAgentPolicy() {
    if (!agentDraft) return
    const saved = await mutate(`agent-policy-${agentDraft.capabilityId}`, () => apiPatch(`/ai/capabilities/agents/${agentDraft.capabilityId}/policy`, {
      expectedVersion: agentDraft.expectedVersion, modelRouteKey: agentDraft.modelRouteKey,
      timeoutMs: Number(agentDraft.timeoutMs), maxTurns: Number(agentDraft.maxTurns), maxBudgetUsd: Number(agentDraft.maxBudgetUsd),
      toolNames: agentDraft.toolNames, allowedRoles: agentDraft.allowedRoles.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
    }), 'Agent 运行策略已保存。')
    if (saved) setAgentDraft(null)
  }

  async function createBinding() {
    const ok = await mutate('binding-create', () => apiPost('/ai/capabilities/bindings', {
      ...bindingDraft, department: bindingDraft.department || null, projectId: bindingDraft.projectId || null, enabled: true,
    }), '能力授权已创建。')
    if (ok) { setShowBindingModal(false); setBindingDraft({ capabilityId: '', scopeType: 'global', department: '', projectId: '' }) }
  }

  async function deletePendingSkill() {
    if (!pendingDelete || pendingDelete.kind !== 'skill') return
    const deleted = await mutate(
      `delete-${pendingDelete.id}`,
      () => apiDelete(`/ai/capabilities/skills/${pendingDelete.id}?expectedVersion=${pendingDelete.version}`),
      `Skill「${pendingDelete.name}」已删除。`,
    )
    if (deleted) setPendingDelete(null)
  }

  async function exportCapabilities() {
    const capabilities = settings.capabilities.filter((item) => item.kind === tab).map((item) => ({
      capabilityKey: item.capabilityKey, kind: item.kind, name: item.name, description: item.description,
      enabled: item.enabled, allowedRoles: item.allowedRoles, config: item.config, toolNames: item.toolNames,
    }))
    setBusy('export'); setNotice(null)
    try {
      const url = URL.createObjectURL(await createCapabilityZip(tab, capabilities))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `jw-${tab}-capabilities-${shanghaiDateKey()}.zip`; anchor.click()
      URL.revokeObjectURL(url)
      setNotice({ tone: 'ok', text: `${capabilities.length} 项 ${activeTab.label} 已按 JW 目录结构导出为 ZIP。` })
    } catch (error) { setNotice({ tone: 'error', text: (error as Error).message }) }
    finally { setBusy('') }
  }

  function openImport() {
    setImportStep(1); setImportCandidates([]); setSelectedImportKeys([]); setImportSourceLabel(''); setImportError('')
    setImportResult({ imported: [], skipped: [], errors: [] }); setShowImportModal(true)
  }

  async function validateImportSource(sourceType: 'folder' | 'zip', files: File[]) {
    setImportError('')
    const relativePath = (files[0] as File & { webkitRelativePath?: string } | undefined)?.webkitRelativePath || files[0]?.name || ''
    setImportSourceLabel(sourceType === 'zip' ? files[0]?.name || '' : relativePath.split('/')[0])
    try {
      const candidates = sourceType === 'zip' ? await scanCapabilityZip(tab, files[0]) : await scanCapabilityFolder(tab, files)
      const importableKeys = candidates.map((candidate) => candidate.capabilityKey)
      setImportCandidates(candidates); setSelectedImportKeys(importableKeys); setImportStep(2)
    } catch (error) {
      setImportCandidates([]); setSelectedImportKeys([]); setImportError((error as Error).message); setImportStep(2)
    }
  }

  async function applyImport() {
    const entries = importCandidates.filter((entry) => selectedImportKeys.includes(entry.capabilityKey))
    if (!entries.length) return
    setBusy('import'); setNotice(null)
    const result = { imported: [] as string[], skipped: [] as string[], errors: [] as string[] }
    try {
      for (const entry of entries) {
        const configTools = Array.isArray(entry.config?.toolNames)
          ? entry.config.toolNames.filter((name): name is string => typeof name === 'string')
          : []
        await apiPost('/ai/capabilities/import', {
          kind: entry.kind, capabilityKey: entry.capabilityKey,
          name: entry.name || entry.capabilityKey, description: entry.description ?? null,
          packageVersion: 'uploaded', config: entry.config || {}, instructions: entry.instructions,
          toolNames: entry.toolNames || configTools, dependencyNames: entry.dependencyNames || [],
          allowedRoles: entry.allowedRoles || [], enabled: entry.enabled ?? true,
        })
        result.imported.push(entry.capabilityKey)
      }
      await refresh(); setImportResult(result); setImportStep(3)
    } catch (error) {
      await refresh(); result.errors.push((error as Error).message); setImportResult(result); setImportStep(3)
    } finally { setBusy('') }
  }

  const activeTab = tabs.find((item) => item.key === tab)!

  return <div className="jw-admin-page">
    <div className="jw-page-header"><div><h1>能力管理</h1><p>按 JW 工作台方式管理 Skills、Agents、MCP 与 Plugins</p></div></div>
    {notice && <div className={`jw-notice ${notice.tone}`}><span>{notice.tone === 'ok' ? <Check className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}</span>{notice.text}<button aria-label="关闭提示" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button></div>}

    <div className="jw-capability-workbench">
      <nav className="jw-letter-tabs" aria-label="能力类型">
        {tabs.map((item) => <button key={item.key} className={tab === item.key ? 'active' : ''} title={item.label} aria-label={item.label} onClick={() => { setTab(item.key); setView('catalog'); setSearch('') }}><span>{item.short}</span><small>{settings.capabilities.filter((capability) => capability.kind === item.key).length}</small></button>)}
        <div className="jw-letter-tabs-spacer" />
        <button className={view === 'bindings' ? 'active' : ''} title="作用域授权" aria-label="作用域授权" onClick={() => setView('bindings')}><ShieldCheck className="h-4 w-4" /><small>{settings.bindings.length}</small></button>
      </nav>

      <section className="jw-capability-content">
        {view === 'catalog' ? <>
          <div className="jw-tab-header"><div><activeTab.icon className="h-4 w-4" /><strong>{activeTab.label} ({visible.length})</strong></div><button className="jw-icon-btn" title="刷新" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /></button></div>
          <div className="jw-tab-toolbar">
            <label><Search className="h-4 w-4" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`搜索 ${activeTab.label}`} /><button aria-label="清空搜索" className={search ? '' : 'invisible'} onClick={() => setSearch('')}><X className="h-3.5 w-3.5" /></button></label>
            <div className="jw-toolbar-button-group"><button title={`导入 ${activeTab.label}`} aria-label={`导入 ${activeTab.label}`} onClick={openImport}><Upload className="h-4 w-4" /></button><button title={`导出 ${activeTab.label}`} aria-label={`导出 ${activeTab.label}`} disabled={busy !== ''} onClick={() => void exportCapabilities()}><Download className="h-4 w-4" /></button></div>
            <button className="jw-secondary-button" disabled={busy !== ''} onClick={() => void mutate('sync', () => apiPost('/ai/capabilities/sync'), '内置能力目录已同步。')}><RefreshCw className="h-4 w-4" />同步内置目录</button>
          </div>

          {tab === 'plugin' && <div className="jw-plugin-strip"><span><b>{settings.pluginInventory?.records ?? 0}</b>数据库记录</span><span><b>{settings.pluginInventory?.installed ?? 0}</b>可用</span><span><b>{settings.pluginInventory?.runtimeEnabled ?? 0}</b>运行启用</span><em>支持直接上传安装</em></div>}

          <div className="jw-tab-scroll">
            {!groups.length ? <div className="jw-empty-panel"><activeTab.icon className="h-12 w-12" /><p>当前没有 {activeTab.label}</p><small>可使用上方导入按钮直接添加</small></div> : groups.map(([source, items]) => {
              const expanded = expandedSources.includes(source)
              return <div className="jw-capability-group" key={source}>
                <button className="jw-group-header" onClick={() => setExpandedSources((current) => expanded ? current.filter((item) => item !== source) : [...current, source])}>{expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}<Layers3 className="h-4 w-4" /><strong>{source}</strong><span>({items.length})</span></button>
                {expanded && <div className="jw-group-items">{items.map((item) => <div className={`jw-capability-item ${!item.enabled ? 'disabled' : ''}`} key={item.id}>
                  <span className={`jw-capability-glyph ${item.kind}`}><activeTab.icon className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1"><div className="jw-capability-name"><strong>{item.name}</strong><span>/{item.capabilityKey}</span><em>v{item.packageVersion}</em></div><p>{item.description || '暂无能力说明'}</p><small>{item.kind === 'plugin' ? `依赖：${item.dependencyNames.join('、') || '无'}` : `工具：${item.toolNames.join('、') || '无直接工具'}`} · 角色：{item.allowedRoles.join('、') || '全部已授权角色'}</small>{item.lastTestError && <small className="error">{item.lastTestError}</small>}</div>
                  <div className="jw-inline-actions">
                    {item.kind === 'agent' && <button title="配置运行策略" onClick={() => editAgent(item)}><Settings2 className="h-4 w-4" /></button>}
                    <button title="服务端测试" disabled={busy !== '' || (item.kind === 'plugin' && !item.installed)} onClick={() => void mutate(`test-${item.id}`, () => apiPost(`/ai/capabilities/${item.id}/test`), '能力测试已完成。')}><FlaskConical className="h-4 w-4" /></button>
                    <button title="配置历史" onClick={() => setRevisionTarget({ basePath: '/ai/capabilities', resourceType: 'capability', resourceId: item.id, resourceLabel: `能力：${item.name}`, currentVersion: item.version })}><History className="h-4 w-4" /></button>
                    {item.kind === 'skill' && <button className="danger" title="删除 Skill" aria-label={`删除 ${item.name}`} disabled={busy !== ''} onClick={() => setPendingDelete(item)}><Trash2 className="h-4 w-4" /></button>}
                  </div>
                  {item.kind === 'plugin' && !item.installed ? <span className="jw-readonly-pill">未批准</span> : <Toggle value={item.enabled} disabled={busy !== ''} label={`${item.name}${item.enabled ? '停用' : '启用'}`} onChange={(enabled) => void mutate(`toggle-${item.id}`, () => apiPatch(`/ai/capabilities/${item.id}`, { expectedVersion: item.version, enabled }), enabled ? '能力已启用。' : '能力已停用。')} />}
                </div>)}</div>}
              </div>
            })}
          </div>
        </> : <>
          <div className="jw-tab-header"><div><ShieldCheck className="h-4 w-4" /><strong>作用域授权 ({settings.bindings.length})</strong></div><button className="jw-primary-button" onClick={() => setShowBindingModal(true)}><CirclePlus className="h-4 w-4" />新增授权</button></div>
          <div className="jw-info-banner compact"><Globe2 className="h-4 w-4" /><span>全局、部门、项目授权取并集；角色限制与项目成员关系仍由服务端复核。</span></div>
          <div className="jw-tab-scroll">
            <div className="jw-binding-list">{settings.bindings.map((binding) => <div className="jw-binding-item" key={binding.id}>
              <span className="jw-capability-glyph"><ShieldCheck className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1"><strong>{names.get(binding.capabilityId) || binding.capabilityId}</strong><p>{scopeLabel(binding)}</p><small>配置版本 v{binding.version}</small></div>
              <button className="jw-icon-btn" title="配置历史" onClick={() => setRevisionTarget({ basePath: '/ai/capabilities', resourceType: 'capability_binding', resourceId: binding.id, resourceLabel: `能力授权：${names.get(binding.capabilityId) || binding.capabilityId}`, currentVersion: binding.version })}><History className="h-4 w-4" /></button>
              <Toggle value={binding.enabled} disabled={busy !== ''} label={`${names.get(binding.capabilityId) || '能力'}授权${binding.enabled ? '停用' : '启用'}`} onChange={(enabled) => void mutate(`binding-${binding.id}`, () => apiPatch(`/ai/capabilities/bindings/${binding.id}`, { expectedVersion: binding.version, enabled }), enabled ? '授权已启用。' : '授权已停用。')} />
            </div>)}{!settings.bindings.length && <div className="jw-empty-panel"><ShieldCheck className="h-12 w-12" /><p>尚未创建作用域授权</p></div>}</div>
          </div>
        </>}
      </section>
    </div>

    <Modal open={!!agentDraft} title="Agent 运行策略" onClose={() => setAgentDraft(null)} width="max-w-2xl" footer={<><button className="jw-secondary-button" onClick={() => setAgentDraft(null)}>取消</button><button className="jw-primary-button" disabled={busy !== ''} onClick={() => void saveAgentPolicy()}>保存</button></>}>
      {agentDraft && <div className="space-y-4"><div className="jw-info-banner compact"><Settings2 className="h-4 w-4" /><span>上传 Agent 可直接使用清单中的模型策略与工具声明。</span></div><div className="jw-form-grid two"><label className="jw-form-item"><span>模型路由</span><select value={agentDraft.modelRouteKey} onChange={(event) => setAgentDraft({ ...agentDraft, modelRouteKey: event.target.value })}>{(settings.agentPolicyOptions?.modelRouteKeys || []).map((key) => <option key={key} value={key}>{key}</option>)}</select></label><label className="jw-form-item"><span>超时（毫秒）</span><input inputMode="numeric" value={agentDraft.timeoutMs} onChange={(event) => setAgentDraft({ ...agentDraft, timeoutMs: event.target.value })} /></label><label className="jw-form-item"><span>最大轮数</span><input inputMode="numeric" value={agentDraft.maxTurns} onChange={(event) => setAgentDraft({ ...agentDraft, maxTurns: event.target.value })} /></label><label className="jw-form-item"><span>单次预算上限（USD）</span><input inputMode="decimal" value={agentDraft.maxBudgetUsd} onChange={(event) => setAgentDraft({ ...agentDraft, maxBudgetUsd: event.target.value })} /></label></div><label className="jw-form-item"><span>允许角色</span><input placeholder="多个角色用逗号分隔" value={agentDraft.allowedRoles} onChange={(event) => setAgentDraft({ ...agentDraft, allowedRoles: event.target.value })} /></label><div className="jw-checkbox-list"><span>工具</span>{[...new Set([...(settings.agentPolicyOptions?.approvedToolNamesByCapability[settings.capabilities.find((item) => item.id === agentDraft.capabilityId)?.capabilityKey || ''] || []), ...agentDraft.toolNames])].map((toolName) => <label key={toolName}><input type="checkbox" checked={agentDraft.toolNames.includes(toolName)} onChange={(event) => setAgentDraft({ ...agentDraft, toolNames: event.target.checked ? [...agentDraft.toolNames, toolName] : agentDraft.toolNames.filter((name) => name !== toolName) })} />{toolName}</label>)}</div></div>}
    </Modal>

    <Modal open={!!pendingDelete} title="确认删除 Skill" onClose={() => { if (!busy.startsWith('delete-')) setPendingDelete(null) }} footer={<><button className="jw-secondary-button" disabled={busy !== ''} onClick={() => setPendingDelete(null)}>取消</button><button className="jw-danger-button" disabled={busy !== ''} onClick={() => void deletePendingSkill()}><Trash2 className="h-4 w-4" />确认删除</button></>}>
      <p className="text-sm leading-6 text-slate-600">确认删除 Skill「{pendingDelete?.name}」？它的作用域授权和会话选择将同时清除，此操作不可恢复。</p>
    </Modal>

    <Modal open={showBindingModal} title="新增作用域授权" onClose={() => setShowBindingModal(false)} footer={<><button className="jw-secondary-button" onClick={() => setShowBindingModal(false)}>取消</button><button className="jw-primary-button" disabled={busy !== '' || !bindingDraft.capabilityId || (bindingDraft.scopeType === 'department' && !bindingDraft.department) || (bindingDraft.scopeType === 'project' && !bindingDraft.projectId)} onClick={() => void createBinding()}>添加</button></>}>
      <div className="space-y-4"><label className="jw-form-item"><span>能力</span><select value={bindingDraft.capabilityId} onChange={(event) => setBindingDraft({ ...bindingDraft, capabilityId: event.target.value })}><option value="">选择能力</option>{settings.capabilities.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.kind} · {item.name}</option>)}</select></label><label className="jw-form-item"><span>授权范围</span><select value={bindingDraft.scopeType} onChange={(event) => setBindingDraft({ ...bindingDraft, scopeType: event.target.value })}><option value="global">全局</option><option value="department">部门</option><option value="project">项目</option></select></label>{bindingDraft.scopeType === 'department' && <label className="jw-form-item"><span>部门名称</span><input value={bindingDraft.department} onChange={(event) => setBindingDraft({ ...bindingDraft, department: event.target.value })} /></label>}{bindingDraft.scopeType === 'project' && <label className="jw-form-item"><span>项目</span><select value={bindingDraft.projectId} onChange={(event) => setBindingDraft({ ...bindingDraft, projectId: event.target.value })}><option value="">选择项目</option>{settings.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}</div>
    </Modal>
    <Modal open={showImportModal} title={`导入 ${activeTab.label}`} onClose={() => setShowImportModal(false)} width="max-w-2xl" footer={<div className="flex w-full items-center justify-between">{importStep === 2 ? <button className="jw-secondary-button" onClick={() => { setImportStep(1); setImportCandidates([]); setImportError('') }}>上一步</button> : <span />}<div className="flex gap-2"><button className="jw-secondary-button" onClick={() => setShowImportModal(false)}>{importStep === 3 ? '关闭' : '取消'}</button>{importStep === 2 && !importError && <button className="jw-primary-button" disabled={busy !== '' || !selectedImportKeys.length} onClick={() => void applyImport()}><Upload className="h-4 w-4" />确认导入</button>}</div></div>}>
      <div className="jw-import-flow">
        {importStep === 1 && <><p className="jw-import-step-title">选择导入来源</p><div className="jw-import-source-buttons"><label><Upload className="h-5 w-5" /><strong>从文件夹导入</strong><small>{tab === 'skill' ? '选择包含 SKILL.md 的目录' : tab === 'agent' ? '选择包含 Agent Markdown 的目录' : '选择包含能力 JSON 的目录'}</small><input type="file" multiple {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) void validateImportSource('folder', files); event.currentTarget.value = '' }} /></label><label><Download className="h-5 w-5" /><strong>从 ZIP 导入</strong><small>支持单个或批量能力包</small><input type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void validateImportSource('zip', [file]); event.currentTarget.value = '' }} /></label></div><div className="jw-info-banner compact"><Upload className="h-4 w-4" /><span>{activeTab.label} 校验通过后可直接导入并启用，不要求预先加入服务端批准目录。</span></div></>}
        {importStep === 2 && <><p className="jw-import-step-title">校验结果与导入选择</p>{importSourceLabel && <p className="jw-selected-source">已选择：{importSourceLabel}</p>}{importError ? <div className="jw-import-error"><XCircle className="h-4 w-4" />{importError}</div> : <><p className="jw-validation-success"><Check className="h-4 w-4" />发现 {importCandidates.length} 项 {activeTab.label}</p><div className="jw-import-preview">{importCandidates.map((candidate) => <label key={candidate.capabilityKey}><input type="checkbox" checked={selectedImportKeys.includes(candidate.capabilityKey)} onChange={(event) => setSelectedImportKeys((current) => event.target.checked ? [...current, candidate.capabilityKey] : current.filter((key) => key !== candidate.capabilityKey))} /><span><strong>{candidate.capabilityKey}</strong><small>{candidate.name || candidate.sourcePath}</small></span><em className="matched">可导入</em></label>)}</div></>}</>}
        {importStep === 3 && <><p className="jw-import-step-title">导入结果</p><div className="jw-import-result"><section className="success"><strong>成功导入 {importResult.imported.length} 项</strong>{importResult.imported.map((item) => <span key={item}>{item}</span>)}</section>{importResult.skipped.length > 0 && <section className="warning"><strong>跳过 {importResult.skipped.length} 项</strong>{importResult.skipped.map((item) => <span key={item}>{item}</span>)}</section>}{importResult.errors.length > 0 && <section className="error"><strong>错误 {importResult.errors.length} 项</strong>{importResult.errors.map((item) => <span key={item}>{item}</span>)}</section>}</div></>}
      </div>
    </Modal>
    {revisionTarget && <ConfigurationRevisionPanel target={revisionTarget} onClose={() => setRevisionTarget(null)} onRolledBack={refresh} />}
  </div>
}
