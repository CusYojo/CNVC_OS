import { CheckCircle2, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/useAuthStore'
import { Button } from '../components/ui'
import { useToast } from '../components/Toast'
import './LoginPage.css'

function LoginIcon({ name }: { name: 'user' | 'lock' | 'eye' | 'mail' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'user' && <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>}
      {name === 'lock' && <><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2" /></>}
      {name === 'eye' && <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>}
      {name === 'mail' && <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>}
    </svg>
  )
}

type RegistrationOptions = { roles: string[]; departments: string[] }

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((state) => state.setAuth)
  const { showToast } = useToast()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [loginForm, setLoginForm] = useState({ identifier: '', password: '', remember: true })
  const [registration, setRegistration] = useState({ name: '', email: '', role: '', department: '', password: '', confirmPassword: '' })
  const [options, setOptions] = useState<RegistrationOptions>({ roles: [], departments: [] })
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [registrationDone, setRegistrationDone] = useState(false)

  const openRegistration = async () => {
    setMode('register')
    setShowPassword(false)
    setRegistrationDone(false)
    if (options.roles.length && options.departments.length) return
    setLoading(true)
    try {
      const response = await fetch('/api/auth/registration-options', { credentials: 'include' })
      const body = await response.json() as Partial<RegistrationOptions> & { message?: string }
      if (!response.ok) throw new Error(body.message || '暂时无法读取岗位信息')
      const next = { roles: body.roles ?? [], departments: body.departments ?? [] }
      if (!next.roles.length || !next.departments.length) throw new Error('暂时没有可申请的岗位或部门')
      setOptions(next)
      setRegistration((current) => ({
        ...current,
        role: current.role || next.roles[0],
        department: current.department || next.departments[0],
      }))
    } catch (error) {
      showToast((error as Error).message, 'error')
    } finally { setLoading(false) }
  }

  const submitLogin = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!loginForm.identifier.trim() || !loginForm.password) return showToast('请输入姓名或邮箱和密码', 'error')
    setLoading(true)
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: loginForm.identifier.trim(), password: loginForm.password, remember: loginForm.remember }),
      })
      const body = await response.json()
      if (!response.ok || !body.user) throw new Error(body.message || '登录失败')
      setAuth({ user: body.user })
      navigate('/')
    } catch (error) {
      showToast((error as Error).message, 'error')
    } finally { setLoading(false) }
  }

  const submitRegistration = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!registration.name.trim() || !registration.email.trim() || !registration.role || !registration.department || !registration.password) {
      return showToast('请完整填写注册信息', 'error')
    }
    if (registration.password !== registration.confirmPassword) return showToast('两次输入的密码不一致', 'error')
    setLoading(true)
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: registration.name.trim(),
          email: registration.email.trim(),
          role: registration.role,
          department: registration.department,
          password: registration.password,
        }),
      })
      const body = await response.json() as { message?: string }
      if (!response.ok) throw new Error(body.message || '注册申请提交失败')
      setRegistrationDone(true)
    } catch (error) {
      showToast((error as Error).message, 'error')
    } finally { setLoading(false) }
  }

  return (
    <main className="login-screen">
      <div className={`login-frame${mode === 'register' ? ' is-registering' : ''}`}>
        <section className="login-brand-panel" aria-labelledby="login-brand-title">
          <div className="login-brand-lockup">
            <span className="login-brand-logo"><img src="/fde-company-logo.png" alt="赛智伯乐 Logo" /></span>
            <div><strong>赛智伯乐</strong><span>Cybernaut</span></div>
          </div>
          <div className="login-brand-copy">
            <h1 id="login-brand-title">做精品创投，<br />与伟大企业同行</h1>
            <p>赛智伯乐投资管理系统</p>
          </div>
          <div className="login-brand-signature">投早 · 投小 · 投硬科技</div>
        </section>

        <section className="login-entry-panel" aria-labelledby="login-title">
          <div className="login-mobile-lockup">
            <span className="login-brand-logo"><img src="/fde-company-logo.png" alt="赛智伯乐 Logo" /></span>
            <div><strong>赛智伯乐</strong><span>Cybernaut</span></div>
          </div>
          <div className="login-card">
            <div className="login-mode-switch" role="tablist" aria-label="账号入口">
              <button role="tab" aria-selected={mode === 'login'} onClick={() => { setMode('login'); setShowPassword(false) }}>登录</button>
              <button role="tab" aria-selected={mode === 'register'} onClick={() => void openRegistration()}>申请账号</button>
            </div>

            {mode === 'login' ? <>
              <header className="login-head">
                <h2 id="login-title">欢迎回来</h2>
                <p>登录赛智伯乐工作台</p>
              </header>
              <form onSubmit={submitLogin} className="login-form">
                <label className="login-field" htmlFor="login-identifier">
                  <span>姓名或工作邮箱</span>
                  <div><span aria-hidden="true"><LoginIcon name="user" /></span><input id="login-identifier" autoFocus type="text" autoComplete="username" maxLength={255} placeholder="请输入姓名或邮箱" value={loginForm.identifier} onChange={(event) => setLoginForm({ ...loginForm, identifier: event.target.value })} /></div>
                </label>
                <label className="login-field" htmlFor="login-password">
                  <span>密码</span>
                  <div><span aria-hidden="true"><LoginIcon name="lock" /></span><input id="login-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="请输入密码" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} /><button type="button" className="login-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff aria-hidden="true" /> : <LoginIcon name="eye" />}</button></div>
                </label>
                <label className="login-remember"><input type="checkbox" checked={loginForm.remember} onChange={(event) => setLoginForm({ ...loginForm, remember: event.target.checked })} />保持登录</label>
                <Button type="submit" loading={loading} className="login-submit"><span>进入系统</span><span aria-hidden="true">→</span></Button>
              </form>
            </> : registrationDone ? <div className="login-registration-done">
              <CheckCircle2 aria-hidden="true" />
              <h2 id="login-title">申请已提交</h2>
              <p>系统管理员通过后即可登录。</p>
              <button onClick={() => setMode('login')}>返回登录</button>
            </div> : <>
              <header className="login-head">
                <h2 id="login-title">申请账号</h2>
                <p>填写本人信息并选择岗位</p>
              </header>
              <form onSubmit={submitRegistration} className="login-form login-registration-form">
                <div className="login-field-row">
                  <label className="login-field"><span>姓名</span><div><span aria-hidden="true"><LoginIcon name="user" /></span><input autoFocus autoComplete="name" maxLength={64} placeholder="真实姓名" value={registration.name} onChange={(event) => setRegistration({ ...registration, name: event.target.value })} /></div></label>
                  <label className="login-field"><span>工作邮箱</span><div><span aria-hidden="true"><LoginIcon name="mail" /></span><input type="email" autoComplete="email" maxLength={255} placeholder="name@company.com" value={registration.email} onChange={(event) => setRegistration({ ...registration, email: event.target.value })} /></div></label>
                </div>
                <div className="login-field-row">
                  <label className="login-field"><span>职务岗位</span><div><select value={registration.role} disabled={loading || !options.roles.length} onChange={(event) => setRegistration({ ...registration, role: event.target.value })}>{!options.roles.length && <option value="">读取中…</option>}{options.roles.map((role) => <option key={role}>{role}</option>)}</select></div></label>
                  <label className="login-field"><span>所属部门</span><div><select value={registration.department} disabled={loading || !options.departments.length} onChange={(event) => setRegistration({ ...registration, department: event.target.value })}>{!options.departments.length && <option value="">读取中…</option>}{options.departments.map((department) => <option key={department}>{department}</option>)}</select></div></label>
                </div>
                <label className="login-field"><span>设置密码</span><div><span aria-hidden="true"><LoginIcon name="lock" /></span><input type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="至少 14 位安全密码" value={registration.password} onChange={(event) => setRegistration({ ...registration, password: event.target.value })} /><button type="button" className="login-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff aria-hidden="true" /> : <LoginIcon name="eye" />}</button></div></label>
                <label className="login-field"><span>确认密码</span><div><span aria-hidden="true"><LoginIcon name="lock" /></span><input type="password" autoComplete="new-password" placeholder="再次输入密码" value={registration.confirmPassword} onChange={(event) => setRegistration({ ...registration, confirmPassword: event.target.value })} /></div></label>
                <p className="login-password-rule">密码需包含大小写字母、数字和符号。</p>
                <Button type="submit" loading={loading} disabled={!options.roles.length || !options.departments.length} className="login-submit"><span>提交申请</span><span aria-hidden="true">→</span></Button>
              </form>
            </>}
          </div>
          <div className="login-entry-foot"><span aria-hidden="true" />赛智伯乐内部系统</div>
        </section>
      </div>
    </main>
  )
}
