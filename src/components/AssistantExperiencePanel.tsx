import { useCallback, useEffect, useState } from 'react'
import { Brain, Check, ChevronDown, ChevronRight, Trash2, X } from 'lucide-react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api'

type Settings = { autoSummaryEnabled: boolean; revision: number }
type Candidate = { id: string; rule: string; evidence: string; example: string | null; suggestedScope: 'global' | 'project'; status: string; version: number; startTurn: number | null; endTurn: number | null }
type Experience = { id: string; rule: string; scopeType: 'global' | 'project'; status: 'active' | 'disabled'; version: number }

export function AssistantExperiencePanel({ conversationId, projectId, refreshKey, onNotify }: {
  conversationId: string; projectId?: string; refreshKey: string | number; onNotify: (message: string, type?: 'success' | 'error') => void
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [experiences, setExperiences] = useState<Experience[]>([])
  const [open, setOpen] = useState(true)
  const [saving, setSaving] = useState('')

  const reload = useCallback(async () => {
    if (!conversationId) return
    try {
      const [nextSettings, nextCandidates, nextExperiences] = await Promise.all([
        apiGet<Settings>('/assistant-experiences/settings'),
        apiGet<Candidate[]>(`/assistant-experiences/candidates?status=pending&conversationId=${encodeURIComponent(conversationId)}`),
        apiGet<Experience[]>(`/assistant-experiences${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
      ])
      setSettings(nextSettings); setCandidates(nextCandidates); setExperiences(nextExperiences)
    } catch (error) { onNotify(`经验加载失败：${(error as Error).message}`, 'error') }
  }, [conversationId, projectId, onNotify])

  useEffect(() => { void reload() }, [reload, refreshKey])
  useEffect(() => {
    if (!conversationId) return
    const timer = window.setInterval(() => { void reload() }, 5_000)
    return () => window.clearInterval(timer)
  }, [conversationId, reload])

  const toggle = async () => {
    if (!settings || saving) return
    const previous = settings
    const next = !settings.autoSummaryEnabled
    setSettings({ ...settings, autoSummaryEnabled: next }); setSaving('settings')
    try { setSettings(await apiPatch<Settings>('/assistant-experiences/settings', { autoSummaryEnabled: next, revision: previous.revision })) }
    catch (error) { setSettings(previous); onNotify(`开关保存失败：${(error as Error).message}`, 'error') }
    finally { setSaving('') }
  }

  const decide = async (candidate: Candidate, action: 'adopt' | 'reject') => {
    setSaving(candidate.id)
    try {
      await apiPost(`/assistant-experiences/candidates/${candidate.id}/decision`, { action, version: candidate.version, idempotencyKey: crypto.randomUUID(), scopeType: candidate.suggestedScope, ...(action === 'adopt' ? { editedRule: candidate.rule } : {}) })
      onNotify(action === 'adopt' ? '经验已采用，将从下一轮开始生效' : '已忽略这条经验', 'success')
      await reload()
    } catch (error) { onNotify(`处理失败：${(error as Error).message}`, 'error') }
    finally { setSaving('') }
  }

  const toggleExperience = async (experience: Experience) => {
    setSaving(experience.id)
    try { await apiPatch(`/assistant-experiences/${experience.id}`, { version: experience.version, status: experience.status === 'active' ? 'disabled' : 'active' }); await reload() }
    catch (error) { onNotify(`更新失败：${(error as Error).message}`, 'error') }
    finally { setSaving('') }
  }

  const removeExperience = async (experience: Experience) => {
    setSaving(experience.id)
    try { await apiDelete(`/assistant-experiences/${experience.id}`, { version: experience.version }); await reload() }
    catch (error) { onNotify(`删除失败：${(error as Error).message}`, 'error') }
    finally { setSaving('') }
  }

  return <section className="border-b border-slate-200 bg-white" data-assistant-experience-panel="true">
    <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between px-3 py-3 text-left">
      <span className="flex items-center gap-2 text-sm font-medium text-slate-700"><Brain className="h-4 w-4 text-brand-600" />经验{candidates.length ? <span className="rounded-full bg-amber-100 px-1.5 text-xs text-amber-700">{candidates.length}</span> : null}</span>
      {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
    </button>
    {open && <div className="space-y-3 px-3 pb-3">
      <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 p-2.5">
        <span><span className="block text-xs font-medium text-slate-700">自动总结经验</span><span className="text-[11px] text-slate-400">每 5 轮总结一次，采用后才生效</span></span>
        <input aria-label="自动总结经验" type="checkbox" checked={settings?.autoSummaryEnabled ?? true} disabled={!settings || saving === 'settings'} onChange={() => { void toggle() }} className="h-4 w-4 accent-brand-600" />
      </label>
      {candidates.map((candidate) => <article key={candidate.id} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
        <p className="text-xs font-semibold text-amber-800">待确认经验</p>
        <textarea aria-label="经验内容" value={candidate.rule} onChange={(event) => setCandidates((rows) => rows.map((row) => row.id === candidate.id ? { ...row, rule: event.target.value } : row))} className="mt-1 w-full resize-y rounded border border-amber-200 bg-white p-2 text-sm leading-5 text-slate-800" rows={3} />
        <p className="mt-2 text-xs leading-4 text-slate-500">依据：{candidate.evidence}</p>
        {candidate.example && <p className="mt-1 text-xs leading-4 text-slate-500">示例：{candidate.example}</p>}
        <select aria-label="经验范围" value={candidate.suggestedScope} onChange={(event) => setCandidates((rows) => rows.map((row) => row.id === candidate.id ? { ...row, suggestedScope: event.target.value as 'global' | 'project' } : row))} className="mt-2 w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs">
          <option value="global">所有项目</option>{projectId && <option value="project">当前项目</option>}
        </select>
        <div className="mt-2 flex gap-2"><button disabled={saving === candidate.id} onClick={() => { void decide(candidate, 'adopt') }} className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-brand-600 px-2 py-1.5 text-xs text-white"><Check className="h-3 w-3" />采用</button><button disabled={saving === candidate.id} onClick={() => { void decide(candidate, 'reject') }} className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600"><X className="h-3 w-3" />不采用</button></div>
      </article>)}
      {!candidates.length && <p className="text-center text-xs text-slate-400">暂无待确认经验</p>}
      {experiences.length > 0 && <div><p className="mb-1.5 text-xs font-medium text-slate-500">已采用经验</p>{experiences.map((experience) => <div key={experience.id} className="mb-1.5 flex items-start gap-2 rounded border border-slate-100 bg-white p-2 text-xs"><button title={experience.status === 'active' ? '停用' : '启用'} onClick={() => { void toggleExperience(experience) }} className={`mt-0.5 h-3 w-3 shrink-0 rounded-full ${experience.status === 'active' ? 'bg-emerald-500' : 'bg-slate-300'}`} /><span className={experience.status === 'active' ? 'flex-1 text-slate-600' : 'flex-1 text-slate-400 line-through'}>{experience.rule}</span><button title="删除经验" onClick={() => { void removeExperience(experience) }}><Trash2 className="h-3.5 w-3.5 text-slate-400 hover:text-rose-500" /></button></div>)}</div>}
    </div>}
  </section>
}
