import { EyeOff } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/useAuthStore'
import { Button } from '../components/ui'
import { useToast } from '../components/Toast'
import './LoginPage.css'

function LoginIcon({ name }: { name: 'user' | 'lock' | 'eye' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'user' && <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>}
      {name === 'lock' && <><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2" /></>}
      {name === 'eye' && <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>}
    </svg>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const { showToast } = useToast()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!identifier.trim() || !password) return showToast('请输入姓名或邮箱和密码', 'error')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password, remember }),
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
    <main className="login-screen">
      <div className="login-frame">
        <section className="login-brand-panel" aria-labelledby="login-brand-title">
          <div className="login-brand-lockup">
            <span className="login-brand-logo"><img src="/fde-company-logo.png" alt="赛智伯乐 Logo" /></span>
            <div><strong>赛智伯乐</strong><span>SAIZHI BOLE</span></div>
          </div>
          <div className="login-brand-copy">
            <span className="login-brand-kicker">内部业务工作台</span>
            <h1 id="login-brand-title">重点项目与<br />投资管理平台</h1>
            <p>让项目推进、材料沉淀、日程协同和审批决策保持在同一工作空间。</p>
            <div className="login-brand-capabilities" aria-label="平台核心能力">
              {['项目推进', '材料归档', '协同排期', '审批办公'].map((item, index) => <span key={item}><b>{String(index + 1).padStart(2, '0')}</b>{item}</span>)}
            </div>
          </div>
        </section>
        <section className="login-entry-panel" aria-labelledby="login-title">
          <div className="login-mobile-lockup">
            <span className="login-brand-logo"><img src="/fde-company-logo.png" alt="赛智伯乐 Logo" /></span>
            <div><strong>赛智伯乐</strong><span>重点项目与投资管理平台</span></div>
          </div>
          <div className="login-card">
            <header className="login-head">
              <span>统一工作空间</span>
              <h2 id="login-title">账号登录</h2>
              <p>使用已开通的姓名账号进入系统</p>
            </header>
            <form onSubmit={submit} className="login-form">
              <label className="login-field" htmlFor="login-identifier">
                <span>账号姓名</span>
                <div>
                  <span aria-hidden="true"><LoginIcon name="user" /></span>
                  <input id="login-identifier" autoFocus type="text" autoComplete="username" maxLength={255} placeholder="例如：陈斌" title="支持姓名或工作邮箱" value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
                </div>
              </label>
              <label className="login-field" htmlFor="login-password">
                <span>登录密码</span>
                <div>
                  <span aria-hidden="true"><LoginIcon name="lock" /></span>
                  <input id="login-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="请输入密码" value={password} onChange={(event) => setPassword(event.target.value)} />
                  <button type="button" className="login-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff aria-hidden="true" /> : <LoginIcon name="eye" />}</button>
                </div>
              </label>
              <label className="login-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />保持登录</label>
              <Button type="submit" loading={loading} className="login-submit"><span>进入工作台</span><span aria-hidden="true">→</span></Button>
            </form>
          </div>
          <div className="login-entry-foot"><span aria-hidden="true" />企业内部数据 · 权限隔离访问</div>
        </section>
      </div>
    </main>
  )
}
