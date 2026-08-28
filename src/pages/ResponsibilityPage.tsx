import { FdeResponsibilityPanel } from '../components/FdeResponsibilityPanel'

export function ResponsibilityPage() {
  return <div className="space-y-5"><div><h1 className="text-[22px] font-semibold">责任记录与复核</h1><p className="mt-1 text-sm text-slate-500">本人记录与授权待办分别查看；原始事实和每次修订保留。</p></div><FdeResponsibilityPanel /></div>
}
