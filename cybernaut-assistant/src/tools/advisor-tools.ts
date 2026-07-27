import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

// assistant agent 的工具集 —— 让 agent 自主决策调用，而不是 Express 正则硬分流。
// 全部走 cybernaut-mvp Express 的内部端点（x-internal-secret 免 JWT），
// 这样 flue 进程不必自己管 pg 密码，且复用既有的 RAG / 情报编排逻辑。

const EXPRESS = process.env.EXPRESS_BASE_URL ?? 'http://127.0.0.1:3100';
const SECRET = process.env.INTERNAL_SECRET ?? 'cybernaut-internal-2026';

async function post(path: string, body: unknown, timeoutMs = 20000): Promise<any> {
  const r = await fetch(`${EXPRESS}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-secret': SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// 1) 项目资料检索（RAG）—— agent 需要基于已授权资料回答时调用
export const searchProjectDocs = defineTool({
  name: 'search_project_docs',
  description: [
    '检索当前项目（或全局知识库）已上传的授权资料片段，用于基于真实文档回答问题。',
    '任何涉及“这个项目/公司的具体情况、风险、亮点、财务、团队、尽调、资料里写了什么”的问题，',
    '都必须先调用本工具拿到资料再回答，不要凭空作答。返回命中的资料片段和来源文件名。',
  ].join(''),
  input: v.object({
    query: v.pipe(v.string(), v.description('检索用的问题或关键词')),
    projectId: v.optional(v.pipe(v.string(), v.description('项目ID；查全局知识库时留空'))),
    compareLeadPool: v.optional(v.pipe(v.boolean(), v.description('是否同时检索共有线索池做横向比对，涉及竞品/对比/赛道时传true'))),
  }),
  output: v.object({
    hasEvidence: v.boolean(),
    context: v.string(),
    sources: v.array(v.string()),
  }),
  async run({ input }) {
    const d = await post('/api/internal/search-docs', {
      query: input.query,
      projectId: input.projectId,
      compareLeadPool: input.compareLeadPool ?? false,
    });
    return { hasEvidence: !!d.hasEvidence, context: d.context ?? '', sources: d.sources ?? [] };
  },
});

// 2) 情报采集 —— agent 判断用户想采集/抓取某公司公开情报时调用
export const collectIntel = defineTool({
  name: 'collect_intel',
  description: [
    '当用户想采集、抓取、搜集某个公司的公开情报/最新动态/融资新闻时调用。',
    '输入公司名，返回结构化的公开情报摘要。耗时可能较长。',
  ].join(''),
  input: v.object({
    company: v.pipe(v.string(), v.description('目标公司名称')),
  }),
  output: v.object({
    ok: v.boolean(),
    report: v.string(),
  }),
  async run({ input }) {
    const d = await post('/api/internal/collect-intel', { company: input.company }, 120000);
    return { ok: !!d.report, report: d.report ?? '' };
  },
});
