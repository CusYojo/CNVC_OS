import { pool } from '../db/client.js'
import { rotateUserPassword } from '../services/passwordRotationService.js'

function targetEmail(): string {
  const args = process.argv.slice(2)
  if (args.some((arg) => /^--?(?:new-)?password(?:=|$)/i.test(arg))) {
    throw new Error('禁止通过 argv 传入密码；请使用隐藏交互输入')
  }
  const equals = args.find((arg) => arg.startsWith('--email='))?.slice('--email='.length)
  const index = args.indexOf('--email')
  const separate = index >= 0 ? args[index + 1] : undefined
  const email = (equals || separate || '').trim().toLowerCase()
  const allowed = equals ? 1 : separate ? 2 : 0
  if (!email || args.length !== allowed) throw new Error('用法：npm run rotate:user-password -- --email user@example.com')
  return email
}

async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('当前输入不是交互式终端')
  }
  process.stdout.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          reject(new Error('操作已取消'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('')
        else if (character >= ' ') value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

async function readPasswordPair(): Promise<[string, string]> {
  if (process.stdin.isTTY) {
    return [await readHiddenLine('请输入新密码：'), await readHiddenLine('请再次输入：')]
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (chunks.reduce((total, item) => total + item.length, 0) > 1_024) throw new Error('stdin 密码输入超过限制')
  }
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
  while (lines.at(-1) === '') lines.pop()
  if (lines.length !== 2) throw new Error('非交互输入必须仅包含两行相同密码，且应来自受控密钥管理器')
  return [lines[0], lines[1]]
}

try {
  const email = targetEmail()
  const [password, confirmation] = await readPasswordPair()
  if (password !== confirmation) throw new Error('两次输入的密码不一致')
  const result = await rotateUserPassword({
    email,
    password,
    actor: process.env.USER?.trim() || '离线安全运维',
  })
  console.log(JSON.stringify({ ok: true, ...result }))
} finally {
  await pool.end()
}
