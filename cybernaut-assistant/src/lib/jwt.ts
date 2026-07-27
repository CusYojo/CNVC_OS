import { createHmac, timingSafeEqual } from 'node:crypto';

// 轻量 HS256 JWT 校验（不引第三方库）。与 Express 端 authService 同一个 SECRET，
// 用于 advisor 的 route 中间件：前端经 nginx /flue-api 直连 agent 时校验登录态。
const SECRET = process.env.JWT_SECRET || 'cybernaut-dev-secret-change-me';

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function verifyJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const expected = createHmac('sha256', SECRET).update(`${h}.${p}`).digest();
    const got = b64urlToBuf(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    const payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // 过期
    return payload;
  } catch {
    return null;
  }
}
