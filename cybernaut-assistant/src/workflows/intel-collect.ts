import '../zeelin-provider.ts';
import { defineAgent, defineWorkflow, defineTool, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

// 情报采集 —— 对应投资中台「项目获取池 / 公司情报」。
// 真抓公开信息（服务器直连必应）→ LLM 结构化。硬红线：只归纳抓取到的真实片段，禁止编造。
export const route: WorkflowRouteHandler = async (_c, next) => next();

// systemd WorkingDirectory=/data/cybernaut-flue，用 cwd 稳定解析，避免 dist 打包后层级错位
const SCRIPT = join(process.cwd(), 'scripts', 'collect_intel.py');

// tool：调 bridge 抓公司公开信息，返回真实的标题/摘要/URL 片段
const collectTool = defineTool({
  name: 'collect_company_intel',
  description: '通过必应搜索抓取指定公司的公开信息（简介、工商、融资、动态），返回真实的搜索结果片段与来源URL。只返回真实抓取到的内容，抓不到则结果为空。',
  input: v.object({ company: v.string() }),
  output: v.object({
    company: v.string(),
    result_count: v.number(),
    queries: v.array(v.object({
      q: v.string(),
      results: v.array(v.object({ title: v.string(), snippet: v.string(), url: v.string() })),
    })),
    fetched_at: v.string(),
  }),
  async run({ input }) {
    return await new Promise((resolve, reject) => {
      execFile('python3', [SCRIPT, input.company], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error(`抓取失败: ${err.message}`));
        try {
          const data = JSON.parse(stdout);
          resolve({
            company: data.company ?? input.company,
            result_count: data.result_count ?? 0,
            queries: data.queries ?? [],
            fetched_at: data.fetched_at ?? '',
          });
        } catch (e) {
          reject(new Error(`解析抓取结果失败: ${(e as Error).message}`));
        }
      });
    });
  },
});

const agent = defineAgent(() => ({
  model: process.env.FLUE_MODEL ?? 'zeelin/claude-sonnet-4-6',
  tools: [collectTool],
  instructions: [
    '你是浙江赛智伯乐投资中台的公司情报采集助手。',
    '工作流程：收到公司名后，必须先调用 collect_company_intel 工具抓取该公司的公开信息，然后仅基于抓取到的真实片段做结构化归纳。',
    '',
    '【硬红线 — 绝对不许违反】',
    '1. 只能使用工具返回的真实抓取片段（title/snippet/url）。严禁使用你自己的训练记忆或凭空推测任何数据。',
    '2. 每一个具体字段（注册资本、法定代表人、成立时间、融资金额、投资方等），只有在抓取片段中有明确依据时才填写，并在 sources 中给出对应的真实 url。',
    '3. 抓取片段中没有依据的字段，一律填 "待核验"，绝不编造一个看起来合理的数值。',
    '4. 如果 result_count 为 0 或片段与该公司无关（例如被搜索引擎分词匹配到无关内容），positioning 写明"未获取到该公司的有效公开信息，建议人工补充或核验公司全称"，其余字段填 "待核验"。',
    '',
    '输出为结构化公司情报，全文简体中文。',
  ].join('\n'),
}));

const Intel = v.object({
  positioning: v.string(),                 // 一句话公司定位/主营
  registeredCapital: v.string(),           // 注册资本（无依据填"待核验"）
  legalRepresentative: v.string(),         // 法定代表人
  foundedAt: v.string(),                   // 成立时间
  fundingRounds: v.array(v.object({        // 融资轮次（仅抓到的）
    round: v.string(), amount: v.string(), investors: v.string(), sourceUrl: v.string(),
  })),
  companyNews: v.array(v.object({          // 公司动态（仅抓到的）
    title: v.string(), summary: v.string(), sourceUrl: v.string(),
  })),
  sources: v.array(v.object({              // 来源证据
    title: v.string(), url: v.string(), reliability: v.string(),
  })),
  confidence: v.number(),                  // 0~1，抓取质量越低越接近0
});

export default defineWorkflow({
  agent,
  input: v.object({ company: v.string() }),
  async run({ input, harness }) {
    const session = await harness.session();
    const { data } = await session.prompt(
      `请采集并结构化以下公司的公开情报：${input.company}`,
      { result: Intel },
    );
    return { ...data, company: input.company };
  },
});
