import pathlib
p = pathlib.Path('batch_analyze.mjs')
s = p.read_text(encoding='utf-8')

# 去掉用户登录,改用 x-internal-secret(系统内部调用,不依赖任何用户账号)
old = """// 2) 登录
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lin@cybernaut.com', password: '123456' }),
});
const token = (await login.json()).token;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };"""
new = """// 2) 鉴权:用系统内部密钥(x-internal-secret),不依赖任何用户账号
//    共有池分析是系统主动触发的后台流程,不应受某个用户登录态限制。
const H = { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET || 'cybernaut-internal-2026' };"""
assert old in s, "batch_analyze 登录段没匹配上"
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print("batch_analyze 改用 internal-secret OK")
