import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

// 投研工具：走 cybernaut-mvp Express 的内部端点（x-internal-secret 免 JWT），复用既有 RAG 库。
const EXPRESS = process.env.EXPRESS_BASE_URL ?? 'http://127.0.0.1:3100';
const SECRET = process.env.INTERNAL_SECRET ?? 'cybernaut-internal-2026';

export const searchProjectDocs = defineTool({
  name: 'search_project_docs',
  description:
    '检索某个项目（或全局知识库）已上传的授权资料片段。任何涉及"这个项目/公司的具体情况、风险、亮点、财务、团队、尽调、资料里写了什么"的问题，都必须先调用本工具拿到真实资料再回答，不要凭空作答。返回命中的资料片段与来源文件名。',
  input: v.object({
    query: v.pipe(v.string(), v.description('检索用的问题或关键词')),
    projectId: v.optional(v.pipe(v.string(), v.description('项目 ID；查全局知识库时留空'))),
  }),
  output: v.object({
    hasEvidence: v.boolean(),
    context: v.string(),
    sources: v.array(v.string()),
  }),
  async run({ input }) {
    const r = await fetch(`${EXPRESS}/api/internal/search-docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-secret': SECRET },
      body: JSON.stringify({ query: input.query, projectId: input.projectId }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { hasEvidence: false, context: '', sources: [] };
    const d = (await r.json()) as { hasEvidence?: boolean; context?: string; sources?: string[] };
    return { hasEvidence: !!d.hasEvidence, context: d.context ?? '', sources: d.sources ?? [] };
  },
});
