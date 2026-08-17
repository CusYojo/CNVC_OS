import { ArrowRight, CheckCircle2, Eye, EyeOff, ShieldCheck, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/useAuthStore'
import { Button } from '../components/ui'
import { useToast } from '../components/Toast'

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const { showToast } = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!email || !password) return showToast('请输入邮箱和密码', 'error')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember }),
      })
      const body = await res.json()
      if (!res.ok || !body.user) throw new Error(body.message || '登录失败')
      setAuth({ user: body.user })
      showToast('登录成功，欢迎回到智投中台')
      navigate('/')
    } catch (err) {
      showToast((err as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid min-h-screen grid-cols-[1.05fr_.95fr] bg-white">
      <section className="relative flex overflow-hidden bg-[#102a56] p-16 text-white">
        <div className="absolute -left-20 -top-24 h-80 w-80 rounded-full border border-blue-300/10" />
        <div className="absolute -left-6 -top-10 h-80 w-80 rounded-full border border-blue-300/10" />
        <div className="absolute bottom-[-160px] right-[-140px] h-[520px] w-[520px] rounded-full border border-blue-300/10" />
        <div className="relative z-10 flex max-w-[580px] flex-col">
          <div className="flex items-center gap-3">
            <div><p className="text-lg font-semibold text-white">浙江赛智伯乐股权投资管理有限公司</p><p className="mt-1 text-sm font-medium tracking-[.24em] text-blue-100">投资中台</p><p className="mt-1 text-[9px] tracking-[.12em] text-blue-200/60">ZHEJIANG SAIZHI CYBERNAUT EQUITY INVESTMENT MANAGEMENT CO., LTD.</p></div>
          </div>
          <div className="my-auto py-16">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-blue-300/20 bg-blue-300/10 px-3 py-1.5 text-xs text-blue-100"><Sparkles className="h-3.5 w-3.5" />AI 驱动的一级市场投资工作台</div>
            <h1 className="text-[42px] font-semibold leading-[1.18] tracking-tight">让每一个投资判断<br />都有据可循</h1>
            <p className="mt-6 max-w-lg text-base leading-8 text-blue-100/70">统一项目档案、沉淀机构知识，用 AI 完成资料摘要、智能问答、上会材料与会议纪要，让投资团队把时间留给真正重要的判断。</p>
            <div className="mt-10 grid grid-cols-2 gap-x-8 gap-y-5">
              {['项目全周期协同', '答案来源可追溯', '上会材料快速生成', '企业级权限审计'].map((item) => <div key={item} className="flex items-center gap-2.5 text-sm text-blue-50/90"><CheckCircle2 className="h-4 w-4 text-sky-300" />{item}</div>)}
            </div>
          </div>
          <p className="text-xs text-blue-200/45">© 2026 浙江赛智伯乐股权投资管理有限公司 · 内部系统</p>
        </div>
      </section>
      <section className="flex items-center justify-center p-12">
        <div className="w-full max-w-[420px]">
          <div className="mb-9">
            <div className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><ShieldCheck className="h-5 w-5" /></div>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">欢迎回来</h2>
            <p className="mt-2 text-sm text-slate-500">登录公司投资中台，继续今天的投资工作。</p>
          </div>
          <form onSubmit={submit} className="space-y-5">
            <label><span className="label">工作邮箱</span><input autoFocus type="email" className="input h-11" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label><span className="label">密码</span><div className="relative"><input type={showPassword ? 'text' : 'password'} className="input h-11 pr-11" value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" aria-label="显示密码" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label>
            <div className="flex items-center text-sm"><label className="flex items-center gap-2 text-slate-600"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="rounded border-slate-300 text-brand-600" />保持登录</label></div>
            <Button type="submit" loading={loading} className="h-11 w-full">登录系统 <ArrowRight className="h-4 w-4" /></Button>
          </form>
        </div>
      </section>
    </div>
  )
}
