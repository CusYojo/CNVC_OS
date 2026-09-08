import { useState } from 'react'
import { api } from '../../lib/api'
import type { EvolutionScope } from '../../../server/src/contracts/aiEvolutionContract'
import type { EvolutionCandidateManifest, EvolutionEvaluationReport } from '../../../server/src/contracts/aiEvolutionEvaluationContract'
import { AiEvolutionSkillComparison } from './AiEvolutionSkillComparison'
import { AiEvolutionSkillVersions } from './AiEvolutionSkillVersions'
import { AiEvolutionSkillTrialStatus } from './AiEvolutionSkillTrialStatus'
import { AiEvolutionReevaluation } from './AiEvolutionReevaluation'
import { AiEvolutionCodeRelease } from './AiEvolutionCodeRelease'

type Candidate = { id: string; kind: 'code' | 'skill' | 'experience'; contentHash: string; summary: string; status: string; scope: EvolutionScope;
  manifest: EvolutionCandidateManifest; evaluation: { hash: string; report: EvolutionEvaluationReport } }
type FilePreview = { bytes: number; sha256: string; binary: boolean; text: string; truncated: boolean } | null
type PatchPreview = { sourceHash: string; changes: { path: string; operation: 'add' | 'modify' | 'delete'; before: FilePreview; after: FilePreview }[] }

function FileContent({ file, label }: { file: FilePreview; label: string }) {
  return <div className="mt-2 min-w-0">
    <p className="font-medium">{label}</p>
    {!file ? <p className="text-slate-400">文件不存在</p> : file.binary ? <p className="text-slate-500">二进制文件，{file.bytes.toLocaleString()} 字节</p> : <>
      <pre className="max-h-64 overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-4">{file.text}</pre>
      {file.truncated && <p className="text-amber-700">预览已截断，请下载完整差异后审阅。</p>}
    </>}
  </div>
}

export function AiEvolutionCandidateReview({ proposalId, onProposalCreated }: { proposalId: string; onProposalCreated?: () => void }) {
  // A proposal owns its review state, including requests still in flight.
  return <CandidateReview key={proposalId} proposalId={proposalId} onProposalCreated={onProposalCreated} />
}

function CandidateReview({ proposalId, onProposalCreated }: { proposalId: string; onProposalCreated?: () => void }) {
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [patch, setPatch] = useState<PatchPreview | null>(null)
  const [pagePreview, setPagePreview] = useState<{ url: string; expiresAt: string } | null>(null)
  const load = async () => {
    setCandidate(null); setPatch(null); setPagePreview(null)
    const result = await api<{ candidate: Candidate | null }>(`/ai/evolution/proposals/${proposalId}/candidate`)
    if (result.candidate?.manifest.artifacts.some((item) => item.kind === 'patch')) {
      const preview = await api<PatchPreview>(`/ai/evolution/candidates/${result.candidate.id}/patch`)
      if (preview.sourceHash !== result.candidate.manifest.sourceHash) throw new Error('候选已变化，请重新读取')
      setPatch(preview)
    }
    setCandidate(result.candidate); setOpened(true)
  }
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!candidate) return
    setBusy(true); setError('')
    try {
      await api(`/ai/evolution/candidates/${candidate.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateHash: candidate.contentHash, evaluationHash: candidate.evaluation.hash,
          scope: candidate.scope, environment: candidate.manifest.environment, decision }) })
      await load()
    } catch (error) { setError(error instanceof Error ? error.message : '验收提交失败') }
    finally { setBusy(false) }
  }
  return <div className="mt-3 border-t border-slate-100 pt-2">
    <button disabled={busy} className="text-xs text-brand-600 disabled:opacity-50" onClick={async () => {
      setBusy(true); setError('')
      try { await load() } catch (error) { setError(error instanceof Error ? error.message : '读取候选失败') }
      finally { setBusy(false) }
    }}>{busy ? '正在读取…' : '查看候选与验收'}</button>
    {error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
    {opened && !candidate && <p className="mt-2 text-xs text-slate-500">尚无通过独立评估的候选，请查看执行进度。</p>}
    {candidate && <div className="mt-2 text-xs leading-5">
      <p className="whitespace-pre-wrap">{candidate.summary}</p>
      <ul className="mt-2 space-y-1">{candidate.evaluation.report.checks.map((check) => <li key={check.id}>
        <details><summary>{check.id}：{check.verdict}</summary><p className="whitespace-pre-wrap break-words text-slate-500">{check.evidence}</p></details>
      </li>)}</ul>
      <p className="mt-2 break-all text-slate-500">候选版本：{candidate.contentHash.slice(0, 16)}</p>
      {candidate.kind === 'skill' && <AiEvolutionSkillComparison key={candidate.id} candidateId={candidate.id} sourceHash={candidate.manifest.sourceHash} />}
      {candidate.kind === 'skill' && <AiEvolutionSkillTrialStatus key={`${candidate.id}:${candidate.contentHash}`} candidateId={candidate.id} candidateHash={candidate.contentHash} />}
      {candidate.kind === 'skill' && ['awaiting_approval', 'approved', 'active', 'rolled_back'].includes(candidate.status)
        && <AiEvolutionSkillVersions key={`${candidate.id}:${candidate.contentHash}`} candidateId={candidate.id} candidateHash={candidate.contentHash} canTrial={candidate.status === 'approved'} />}
      {candidate.manifest.artifacts.some((item) => item.kind === 'web') && !['retired', 'failed'].includes(candidate.status) && <div className="mt-2">
        <button disabled={busy} className="rounded border px-2 py-1 disabled:opacity-50" onClick={async () => {
          setBusy(true); setError(''); setPagePreview(null)
          try {
            const preview = await api<{ url: string; expiresAt: string; candidateHash: string }>(`/ai/evolution/candidates/${candidate.id}/preview`, { method: 'POST' })
            const url = new URL(preview.url)
            if (preview.candidateHash !== candidate.contentHash || url.protocol !== 'http:' || url.hostname !== '127.0.0.2') throw Error('预览与当前候选不一致')
            setPagePreview(preview)
          } catch (cause) { setError(cause instanceof Error ? cause.message : '创建预览失败') }
          finally { setBusy(false) }
        }}>创建本机页面预览</button>
        {pagePreview && <p className="mt-1"><a className="text-brand-600 underline" href={pagePreview.url} target="_blank" rel="noopener noreferrer">打开隔离候选页面</a><span className="ml-1 text-slate-500">仅含测试数据，{new Date(pagePreview.expiresAt).toLocaleTimeString()} 失效</span></p>}
      </div>}
      {candidate.kind === 'code' && <AiEvolutionReevaluation key={candidate.contentHash} candidateId={candidate.id} candidateHash={candidate.contentHash} busy={busy} setBusy={setBusy} onCreated={onProposalCreated} />}
      {candidate.kind === 'code' && <AiEvolutionCodeRelease key={`release:${candidate.contentHash}`} candidateId={candidate.id}
        candidateHash={candidate.contentHash} evaluationHash={candidate.evaluation.hash} status={candidate.status}
        busy={busy} setBusy={setBusy} onChanged={load} />}
      {patch && <details className="mt-2 rounded border border-slate-200 p-2">
        <summary className="cursor-pointer">文件差异（{patch.changes.length}）</summary>
        <a className="mt-2 inline-block text-brand-600 underline" href={`/api/ai/evolution/candidates/${candidate.id}/artifacts/${candidate.manifest.artifacts.findIndex((item) => item.kind === 'patch' && item.sha256 === candidate.manifest.patchHash)}`} download>下载完整差异</a>
        {patch.changes.map((change) => <details key={change.path} className="mt-2 border-t border-slate-100 pt-2">
          <summary className="cursor-pointer break-all">{({ add: '新增', modify: '修改', delete: '删除' })[change.operation]}：{change.path}</summary>
          <FileContent label="修改前" file={change.before} />
          <FileContent label="修改后" file={change.after} />
        </details>)}
      </details>}
      {candidate.status === 'awaiting_approval' ? <div className="mt-2">
        <p className="text-slate-500">确认仅记录本候选的验收决定，发布另行执行。</p>
        <button disabled={busy} className="mr-2 mt-2 rounded bg-brand-600 px-2 py-1 text-white disabled:opacity-50" onClick={() => void decide('approved')}>验收通过</button>
        <button disabled={busy} className="mt-2 rounded border px-2 py-1 disabled:opacity-50" onClick={() => void decide('rejected')}>拒绝候选</button>
      </div> : <p className="mt-2">{candidate.status === 'approved' ? '已验收通过，尚未发布' : candidate.status === 'retired' ? '候选已拒绝或退役' : candidate.status}</p>}
    </div>}
  </div>
}
