import {
  AlertTriangle,
  BookOpenText,
  Bot,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  ShieldAlert,
  User,
} from 'lucide-react'

export type ProjectQaFindingStatus = '已核验事实' | '企业自述' | 'AI推断' | '待核验'
export type ProjectQaConfidence = '高' | '中' | '低' | '证据不足'

export type ProjectQaAnswer = {
  id: string
  projectId: string
  conversationId: string
  category: string
  question: string
  directAnswer: string
  keyPoints: Array<{
    text: string
    status: ProjectQaFindingStatus
    citations: string[]
  }>
  risksOrUncertainties: string[]
  verificationActions: string[]
  sources: Array<{
    id: string
    title: string
    locator: string
    versionOrDate?: string
  }>
  evidenceCount: number
  confidenceStatus: ProjectQaConfidence
  disclaimer: string
  skillName: 'answer-project-qa' | 'write-investment-qa' | 'generate-project-qa-report'
  skillVersion: string
  skillSha256: string
  templateVersion: string
  referenceTemplates: string[]
  sourceCutoffDate: string
  createdAt: string
}

const STATUS_CLASS: Record<ProjectQaFindingStatus, string> = {
  已核验事实: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  企业自述: 'border-sky-200 bg-sky-50 text-sky-700',
  AI推断: 'border-violet-200 bg-violet-50 text-violet-700',
  待核验: 'border-amber-200 bg-amber-50 text-amber-700',
}

const CONFIDENCE_CLASS: Record<ProjectQaConfidence, string> = {
  高: 'bg-emerald-50 text-emerald-700',
  中: 'bg-sky-50 text-sky-700',
  低: 'bg-amber-50 text-amber-700',
  证据不足: 'bg-rose-50 text-rose-700',
}

function QaAnswerCard({ answer }: { answer: ProjectQaAnswer }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-3">
        <div className="max-w-[82%] rounded-2xl rounded-tr-sm bg-brand-600 px-4 py-2.5 text-sm leading-6 text-white">
          <div className="mb-1 text-[10px] text-brand-100">{answer.category}</div>
          问题：{answer.question}
        </div>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
          <User className="h-4 w-4" />
        </span>
      </div>

      <div className="flex gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
          <Bot className="h-4 w-4" />
        </span>
        <article className="min-w-0 max-w-[88%] overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-800">答复</h3>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${CONFIDENCE_CLASS[answer.confidenceStatus]}`}>
                置信状态：{answer.confidenceStatus}
              </span>
              <span className="text-[10px] text-slate-400">去重证据 {answer.evidenceCount} 条</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-700">
              <span className="font-semibold text-slate-800">答复：</span>
              {answer.directAnswer}
            </p>
          </div>

          {answer.keyPoints.length > 0 && (
            <section className="px-4 py-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                <CheckCircle2 className="h-3.5 w-3.5 text-brand-500" />
                关键要点
              </h4>
              <ul className="space-y-2">
                {answer.keyPoints.map((point, index) => (
                  <li key={`${answer.id}-point-${index}`} className="border-l-2 border-slate-200 py-1 pl-3 text-xs leading-6 text-slate-700">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[point.status]}`}>
                        {point.status}
                      </span>
                      {point.citations.map((citation) => (
                        <span key={citation} className="font-mono text-[10px] text-brand-600">[{citation}]</span>
                      ))}
                    </div>
                    {point.text}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="grid gap-3 border-t border-slate-100 px-4 py-3 md:grid-cols-2">
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                风险与不确定性
              </h4>
              <ul className="list-disc space-y-1 pl-4 text-[11px] leading-5 text-slate-600">
                {answer.risksOrUncertainties.map((item, index) => <li key={`${answer.id}-risk-${index}`}>{item}</li>)}
              </ul>
            </section>
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                <CircleHelp className="h-3.5 w-3.5 text-sky-500" />
                建议核验动作
              </h4>
              <ul className="list-disc space-y-1 pl-4 text-[11px] leading-5 text-slate-600">
                {answer.verificationActions.map((item, index) => <li key={`${answer.id}-verify-${index}`}>{item}</li>)}
              </ul>
            </section>
          </div>

          <section className="border-t border-slate-100 bg-slate-50/70 px-4 py-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
              <BookOpenText className="h-3.5 w-3.5 text-brand-500" />
              引用来源
            </h4>
            {answer.sources.length > 0 ? (
              <ol className="space-y-1 text-[11px] leading-5 text-slate-600">
                {answer.sources.map((source) => (
                  <li key={source.id}>
                    <span className="mr-1 font-mono font-medium text-brand-600">[{source.id}]</span>
                    {source.title} · {source.locator}
                    {source.versionOrDate ? ` · ${source.versionOrDate}` : ''}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[11px] text-rose-600">当前无可引用的项目证据，结论不能视为项目事实。</p>
            )}
            <div className="mt-2 flex flex-wrap gap-x-3 text-[10px] text-slate-400">
              <span>资料截止日：{answer.sourceCutoffDate}</span>
              <span>回答格式：公司项目 Q&amp;A 标准</span>
            </div>
          </section>

          <div className="flex gap-2 border-t border-amber-100 bg-amber-50 px-4 py-2.5 text-[10px] leading-5 text-amber-800">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{answer.disclaimer}</span>
          </div>
        </article>
      </div>
    </div>
  )
}

export function AiQaCards({
  answers,
  loading = false,
}: {
  answers: ProjectQaAnswer[]
  loading?: boolean
}) {
  return (
    <>
      {loading && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          正在恢复项目 Q&amp;A…
        </div>
      )}
      {answers.map((answer) => <QaAnswerCard key={answer.id} answer={answer} />)}
    </>
  )
}
