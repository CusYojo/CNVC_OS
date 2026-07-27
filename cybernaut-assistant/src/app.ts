import './zeelin-provider.ts';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

const app = new Hono();
const flueApp = flue();

app.get('/health', (c) => c.json({
  ok: true,
  service: 'cybernaut-assistant',
  agent: 'assistant',
  workflows: [
    'intel-collect',
    'meeting-summary',
    'project-summary',
    'research-project',
    'score-paper',
    'score-project',
  ],
}));

// 内部根路径：供 Express(3100) 直接调用 workflows/agents。
app.all('/workflows/*', (c) => flueApp.fetch(c.req.raw));
app.all('/agents/*', (c) => flueApp.fetch(c.req.raw));

// —— 兼容层 + 前缀保留 ——
// @flue/sdk(beta.9) sendMessage 发 { message:{kind,body} }（对象），runtime 只认 { message: string }。
// 同时：flue 从原始请求 URL 生成 streamUrl，必须让它看到 /ai/api 前缀，否则 SDK 连不上流。
// 做法：拦 /ai/api/*，把 body 拍平，并把请求 pathname 去掉 /ai/api 前缀后交给 flueApp，
// 但通过 x-forwarded-prefix 头告知前缀……beta.9 不认该头，改为：直接返回 flue 结果并在
// streamUrl 上补回前缀（SDK 会用返回的 streamUrl 去连）。
async function forwardToFlue(c: { req: { raw: Request } }, bodyOverride?: string) {
  const orig = new URL(c.req.raw.url);
  const inner = new URL(orig.toString());
  inner.pathname = orig.pathname.replace(/^\/ai\/api/, '') || '/';
  const headers = new Headers(c.req.raw.headers);
  if (bodyOverride !== undefined) headers.delete('content-length');
  const init: RequestInit = {
    method: c.req.raw.method,
    headers,
    body: bodyOverride !== undefined ? bodyOverride : (c.req.raw.method === 'GET' || c.req.raw.method === 'HEAD' ? undefined : c.req.raw.body),
  };
  if (init.body && !bodyOverride) (init as { duplex?: string }).duplex = 'half';
  const res = await flueApp.fetch(new Request(inner.toString(), init));
  // flue 返回体里的 streamUrl 缺 /ai/api 前缀，补回，SDK 才能连对流地址
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const text = await res.text();
    const fixed = text.replace(/("streamUrl"\s*:\s*")(https?:\/\/[^/]+)(\/agents\/)/g, `$1$2/ai/api$3`);
    return new Response(fixed, { status: res.status, headers: res.headers });
  }
  return res;
}

app.post('/ai/api/agents/:name/:id', async (c) => {
  try {
    const ct = c.req.header('content-type') ?? '';
    if (ct.includes('application/json')) {
      const raw = await c.req.raw.clone().json();
      const m = raw?.message;
      if (m && typeof m === 'object' && typeof m.body === 'string') {
        const rewritten: Record<string, unknown> = { message: m.body };
        if (Array.isArray(m.attachments)) rewritten.images = m.attachments;
        else if (Array.isArray(raw.images)) rewritten.images = raw.images;
        return forwardToFlue(c, JSON.stringify(rewritten));
      }
    }
  } catch { /* 原样透传 */ }
  return forwardToFlue(c);
});

// 其余 /ai/api/*（含流式 GET view=updates）交给 flue
app.all('/ai/api/*', (c) => forwardToFlue(c));

// 前端静态资源：/ai/ 下（vite base=/ai/），把 /ai 前缀映射到 dist/client 根
app.use('/ai/*', serveStatic({ root: './dist/client', rewriteRequestPath: (p) => p.replace(/^\/ai/, '') }));
app.get('/ai', (c) => c.redirect('/ai/'));
app.get('/ai/*', serveStatic({ path: './dist/client/index.html' }));

export default app;
