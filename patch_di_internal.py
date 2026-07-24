import pathlib
p = pathlib.Path('daily_intake.mjs')
s = p.read_text(encoding='utf-8')

old_login = """let token = '';
try {
  const loginRes = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'lin@cybernaut.com', password: '123456' }) });
  token = (await loginRes.json()).token;
} catch (e) { console.log(new Date().toISOString(), '登录失败(后续分析/雷达跳过):', e.message); }"""
new_login = """// 系统内部密钥:共有池分析是系统主动触发的后台流程,不依赖任何用户登录态
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'cybernaut-internal-2026';
const token = INTERNAL_SECRET;  // 兼容下游变量名"""
assert old_login in s, "登录段没匹配上"
s = s.replace(old_login, new_login, 1)

s = s.replace("Authorization: 'Bearer ' + token", "'x-internal-secret': token")

p.write_text(s, encoding='utf-8')
n = s.count("'x-internal-secret': token")
print("daily_intake 改用 internal-secret OK, header替换", n, "处")
