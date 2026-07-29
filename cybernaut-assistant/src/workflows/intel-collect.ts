import '../zeelin-provider.ts';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

// 情报采集 —— 对应投资中台「项目获取池 / 公司情报」。
// 真抓公开信息（中文搜索引擎）并返回原始可核验片段，供下游项目模型提炼。
export const route: WorkflowRouteHandler = async (_c, next) => next();

// systemd WorkingDirectory=/data/cybernaut-flue，用 cwd 稳定解析，避免 dist 打包后层级错位
const SCRIPT = join(process.cwd(), 'scripts', 'collect_intel.py');

type CollectedIntel = {
  company: string;
  result_count: number;
  queries: Array<{
    q: string;
    results: Array<{ title: string; snippet: string; url: string }>;
  }>;
  fetched_at: string;
};

const agent = defineAgent(() => ({
  model: process.env.FLUE_MODEL ?? 'zeelin/claude-sonnet-4-6',
  instructions: [
    '你是浙江赛智伯乐投资中台的公司情报采集助手。',
    '联网证据由工作流中的确定性采集器提供；不得使用训练记忆或凭空补充事实。',
  ].join('\n'),
}));

// 直接执行抓取桥并返回原始证据。旧链路需要两轮模型响应（决定调用工具、
// 再复制工具结果），容易在抓取完成后因第二轮超时让整项任务失败。章节
// Generator 仍会使用项目模型提炼这些证据，因此这里不再增加中间模型等待。
async function collectCompanyIntel(input: {
  company: string;
  topics?: string[];
}): Promise<CollectedIntel> {
  return await new Promise((resolve, reject) => {
    execFile(
      'python3',
      ['-B', SCRIPT, input.company, JSON.stringify(input.topics ?? [])],
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`抓取失败: ${err.message}`));
        try {
          const data = JSON.parse(stdout) as Partial<CollectedIntel>;
          resolve({
            company: data.company ?? input.company,
            result_count: data.result_count ?? 0,
            queries: Array.isArray(data.queries) ? data.queries : [],
            fetched_at: data.fetched_at ?? '',
          });
        } catch (e) {
          reject(new Error(`解析抓取结果失败: ${(e as Error).message}`));
        }
      },
    );
  });
}

export default defineWorkflow({
  agent,
  input: v.object({
    company: v.string(),
    topics: v.optional(v.array(v.string())),
  }),
  async run({ input }) {
    const collected = await collectCompanyIntel(input);
    const seen = new Set<string>();
    const searchEvidence = collected.queries.flatMap((query) =>
      query.results.flatMap((result) => {
        const url = result.url.trim();
        if (!url || seen.has(url)) return [];
        seen.add(url);
        let publisher = '';
        try {
          publisher = new URL(url).hostname;
        } catch {
          // URL 会在服务端证据入口再次校验；这里不猜测发布主体。
        }
        return [{
          query: query.q,
          title: result.title,
          snippet: result.snippet,
          url,
          publisher,
          publishedAt: '',
          reliability: '公开搜索结果摘要，需访问原始页面核验',
        }];
      }),
    );
    return {
      company: input.company,
      positioning: searchEvidence.length
        ? `已取得${searchEvidence.length}条公开检索线索，具体事实以原始页面和后续章节核验为准。`
        : '未获取到有效公开信息，建议核验公司全称或补充一手材料。',
      registeredCapital: '待核验',
      legalRepresentative: '待核验',
      foundedAt: '待核验',
      region: '待核验',
      registeredAddress: '待核验',
      fundingRounds: [],
      shareholders: [],
      competitors: [],
      companyNews: [],
      sources: searchEvidence.map((item) => ({
        title: item.title,
        url: item.url,
        reliability: item.reliability,
      })),
      searchEvidence,
      confidence: Math.min(0.8, searchEvidence.length / 20),
      fetchedAt: collected.fetched_at,
    };
  },
});
