import { useState } from 'react'
import type { EvolutionKind } from '../../../server/src/contracts/aiEvolutionContract'
import { useAiEvolution } from '../../hooks/useAiEvolution'
import { AiEvolutionCandidateReview } from './AiEvolutionCandidateReview'
import { AiEvolutionRuns } from './AiEvolutionRuns'
import { AiEvolutionQuestions } from './AiEvolutionQuestions'

const kinds = { experience: '经验', skill: '技能', code: '系统功能' }
const statuses = { draft: '草稿', needs_input: '待补充信息', ready: '待开始', approved: '已提交执行', rejected: '已拒绝', superseded: '已替代' }

export function AiEvolutionPanel({ conversationId }: { conversationId: string }) {
  const { proposals, experiences, loading, error, refresh, execute, saveExperience, disableExperience, saveAnswers } = useAiEvolution(conversationId)
  const [kind, setKind] = useState<EvolutionKind | 'all'>('all')
  const [busyId, setBusyId] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  return <section aria-label="自进化工作台" className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
    <div className="mb-3 flex items-center justify-between gap-2">
      <select aria-label="进化类型" className="rounded border border-slate-200 bg-white p-1.5" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
        <option value="all">全部类型</option>{Object.entries(kinds).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select>
      <button className="text-brand-600 disabled:opacity-50" disabled={loading} onClick={() => void refresh()}>刷新</button>
    </div>
    <p className="mb-3 text-xs leading-5 text-slate-500">在聊天中提出长期要求、技能改进或功能需求，助手会整理为提案。执行结果经验证和确认后才能生效。</p>
    {error && <p role="alert" className="mb-3 rounded bg-amber-50 p-3 text-amber-800">{error}</p>}
    {actionError && <p role="alert" className="mb-3 rounded bg-rose-50 p-3 text-rose-700">{actionError}</p>}
    {notice && <p role="status" className="mb-3 rounded bg-emerald-50 p-3 text-emerald-800">{notice}</p>}
    {loading && <p role="status">正在读取提案…</p>}
    {(kind === 'all' || kind === 'experience') && <details className="mb-4 rounded border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer font-medium">我的经验（{experiences.length}）</summary>
      <p className="mt-2 text-xs text-slate-500">这里展示本人各会话保存的经验。停用后，新任务不再加载；已开始的任务保留原快照。</p>
      {!loading && !error && experiences.length === 0 && <p className="mt-2 text-slate-500">尚未保存个人经验</p>}
      {experiences.map((experience) => <article key={experience.id} className="mt-3 border-t border-slate-100 pt-3">
        <h3 className="font-medium">{experience.spec?.title ?? '来源不可访问的经验'}</h3>
        <p className="mt-1 whitespace-pre-wrap text-xs">{experience.spec?.target.type === 'experience' ? experience.spec.target.rule : '内容已隐藏，不会加载到新任务；你仍可停用这条经验。'}</p>
        <p className="mt-1 text-xs text-slate-500">{experience.status === 'disabled' ? '已停用' : experience.access === 'revoked' ? '来源权限已失效' : experience.spec?.target.type === 'experience' && experience.spec.target.expiresAt && new Date(experience.spec.target.expiresAt).getTime() <= Date.now() ? '已过期' : '已启用'} · 版本 {experience.revision}</p>
        {experience.status === 'active' && <button disabled={Boolean(busyId)} className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-50" onClick={async () => {
          setBusyId(experience.id); setActionError(''); setNotice('')
          try { await disableExperience(experience); setNotice('经验已停用，后续新任务不再加载。') }
          catch (error) { setActionError(error instanceof Error ? error.message : '停用失败') }
          finally { setBusyId('') }
        }}>{busyId === experience.id ? '正在停用…' : '停用经验'}</button>}
      </article>)}
    </details>}
    {!loading && !error && !proposals.length && <p className="py-6 text-center text-slate-500">当前会话还没有进化提案</p>}
    <div className="space-y-3">{proposals.filter((proposal) => kind === 'all' || proposal.spec.kind === kind).map((proposal) => <article key={proposal.id} className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex justify-between gap-2 text-xs text-slate-500"><span>{kinds[proposal.spec.kind]}</span><span>{proposal.spec.kind === 'experience' && proposal.status === 'approved' ? '已保存经验版本' : statuses[proposal.status]}</span></div>
      <h3 className="font-medium text-slate-900">{proposal.spec.title}</h3>
      <p className="mt-2 whitespace-pre-wrap text-slate-600">{proposal.spec.objective}</p>
      <p className="mt-2 text-xs text-slate-500">作用范围：{proposal.spec.scope.type === 'user' ? '本人' : proposal.spec.scope.key}</p>
      {proposal.spec.target.type === 'experience' && <div className="mt-3 rounded bg-slate-50 p-2 text-xs leading-5">
        <p className="whitespace-pre-wrap">规则：{proposal.spec.target.rule}</p>
        <p>适用任务：{proposal.spec.target.taskTypes.join('、')}</p>
        <p>有效期：{proposal.spec.target.expiresAt ? new Date(proposal.spec.target.expiresAt).toLocaleString() : '长期有效，直到停用或替代'}</p>
        {proposal.spec.target.exceptions.length > 0 && <p>例外：{proposal.spec.target.exceptions.join('；')}</p>}
        {proposal.spec.target.replacesVersionIds.length > 0 && <p>将替代已有经验版本：{proposal.spec.target.replacesVersionIds.join('、')}</p>}
      </div>}
      <details className="mt-3 text-xs"><summary className="cursor-pointer text-brand-600">验收条件与预算</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">{proposal.spec.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
        <p className="mt-2">最多 {Math.ceil(proposal.spec.budget.maxDurationSeconds / 60)} 分钟，{proposal.spec.budget.maxModelTokens.toLocaleString()} Token，{proposal.spec.budget.maxRepairRounds} 轮修复。</p>
        <p className="mt-2">来源：{proposal.spec.sourceRefs.length} 条已授权引用</p>
      </details>
      <AiEvolutionQuestions key={`${proposal.id}:${proposal.revision}`} proposal={proposal} save={saveAnswers} />
      {proposal.status === 'ready' && <button disabled={Boolean(busyId)} className="mt-3 rounded bg-brand-600 px-3 py-1.5 text-white disabled:opacity-50" onClick={async () => {
        setBusyId(proposal.id); setActionError(''); setNotice('')
        try {
          if (proposal.spec.kind === 'experience') {
            await saveExperience(proposal)
            setNotice('经验版本已保存，将在适用的新任务中加载。已开始的任务继续使用原快照。')
          } else await execute(proposal)
        } catch (error) { setActionError(error instanceof Error ? error.message : '执行请求失败') }
        finally { setBusyId('') }
      }}>{busyId === proposal.id ? '正在提交…' : proposal.spec.kind === 'experience' ? '确认保存为个人经验' : '开始执行'}</button>}
      {proposal.spec.kind !== 'experience' && proposal.status === 'approved' && <AiEvolutionCandidateReview proposalId={proposal.id} onProposalCreated={() => void refresh()} />}
      {proposal.spec.kind !== 'experience' && proposal.status === 'approved' && <AiEvolutionRuns proposalId={proposal.id} kind={proposal.spec.kind} />}
    </article>)}</div>
  </section>
}
