import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

// 信源 agent 的联网检索工具：自托管 SearXNG(127.0.0.1:8888,免费无key,境内引擎360/搜狗/夸克)。
// 返回结构化结果供 agent 分析，绝不臆造——只回真实检索到的公开信息。
const SEARXNG = process.env.SEARXNG_BASE ?? 'http://127.0.0.1:8888';

export const webSearch = defineTool({
  name: 'web_search',
  description:
    '联网检索公司/项目的公开信息(融资、团队、工商、产品、竞品、新闻)。返回真实网页结果(标题+摘要+来源URL)。研究一个项目前必须先调用本工具，基于真实检索结果分析，不要凭空编造。',
  input: v.object({
    query: v.pipe(v.string(), v.description('检索词，如"纬钛机器人 融资 团队"')),
  }),
  output: v.object({
    count: v.number(),
    results: v.array(v.object({ title: v.string(), content: v.string(), url: v.string() })),
  }),
  async run({ input }) {
    try {
      const url = `${SEARXNG}/search?q=${encodeURIComponent(input.query)}&format=json&engines=360search,sogou,quark`;
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return { count: 0, results: [] };
      const d = (await r.json()) as { results?: Array<{ title?: string; content?: string; url?: string }> };
      const results = (d.results ?? []).slice(0, 10).map((x) => ({
        title: (x.title ?? '').trim(),
        content: (x.content ?? '').trim(),
        url: x.url ?? '',
      })).filter((x) => x.title || x.content);
      return { count: results.length, results };
    } catch {
      return { count: 0, results: [] };
    }
  },
});
