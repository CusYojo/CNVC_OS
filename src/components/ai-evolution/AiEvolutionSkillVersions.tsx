import { useState } from 'react'
import { api } from '../../lib/api'
import { AiEvolutionSkillTrial } from './AiEvolutionSkillTrial'

export function AiEvolutionSkillVersions({ candidateId, candidateHash, canTrial = false }: { candidateId: string; candidateHash: string; canTrial?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [versions, setVersions] = useState<{ side: string; versionId: string }[]>([])
  return <section className="mt-2 min-w-0">
    <button disabled={busy} className="rounded border px-2 py-1 disabled:opacity-50" onClick={async () => {
      setBusy(true); setError(''); setVersions([])
      try {
        const packages = await api<{ candidateHash: string; list: { side: string; artifactIndex: number }[] }>(`/ai/evolution/candidates/${candidateId}/skill-packages`)
        if (packages.candidateHash !== candidateHash) throw Error('候选已变化，请重新读取')
        if (packages.list.length !== 2 || !packages.list.some(row => row.side === 'baseline') || !packages.list.some(row => row.side === 'candidate')) throw Error('候选缺少完整的新旧版本包')
        for (const row of packages.list) {
          const saved = await api<{ versionId: string }>(`/ai/evolution/candidates/${candidateId}/skill-versions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifactIndex: row.artifactIndex, candidateHash }) })
          setVersions(current => [...current, { side: row.side, versionId: saved.versionId }])
        }
      } catch (cause) { setError(cause instanceof Error ? cause.message : '版本登记失败') }
      finally { setBusy(false) }
    }}>{busy ? '正在登记版本…' : '登记技能版本'}</button>
    <p className="text-slate-500">保存候选版本和回退版本，试用发布另行执行。重复登记会返回同一版本。</p>
    {versions.map(row => <p key={row.side} className="break-all" role="status">{row.side === 'baseline' ? '回退版本' : '候选版本'}已登记：{row.versionId}</p>)}
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    {canTrial && versions.some(row => row.side === 'candidate') && versions.some(row => row.side === 'baseline')
      && <AiEvolutionSkillTrial candidateId={candidateId} candidateHash={candidateHash}
        versionId={versions.find(row => row.side === 'candidate')!.versionId} fallbackVersionId={versions.find(row => row.side === 'baseline')!.versionId} />}
  </section>
}
