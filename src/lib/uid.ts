// 生成唯一 id。crypto.randomUUID 仅在安全上下文（HTTPS / localhost）可用；
// 公网 HTTP（如 http://101.126.131.28:5180）下 crypto.randomUUID 不存在，会抛
// "crypto.randomUUID is not a function"。此处做降级：能用原生就用，否则用 fallback。
export function uid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* fall through */ }
  // Fallback：RFC4122 v4 形式，非加密强度但足够做前端临时 id
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
