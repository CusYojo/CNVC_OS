import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';
import '../zeelin-provider.ts';

export const route: WorkflowRouteHandler = async (_c, next) => next();

// 信源研究 agent（供 workflow 使用）
const agent = defineAgent(() => ({
  model: process.env.SOURCING_MODEL ?? 'zeelin-oai/gpt-5.5',
  instructions: [
    '你是投资机构的信源研究员。基于联网检索结果和已有资料，对项目做尽调式信息整理。',
    '★铁律：只输出检索结果或资料中真实存在的信息；未找到的字段一律填"待核验"，绝对禁止编造公司名、注册号、持股比例、金额、人名。宁缺毋造。',
  ].join('\n'),
}));

// —— 信源研究 workflow：公共资源池项目的 联网检索 → 分析 → 6维度结构化输出 ——
// 6维度：公司官网 / 工商信息 / 核心团队 / 股权融资 / 公司动态 / 来源证据
// 铁律：只用真实检索到的信息，缺失字段标"待核验"，绝不编造。

const SEARXNG = process.env.SEARXNG_BASE ?? 'http://127.0.0.1:8888';

async function searxng(query: string): Promise<Array<{ title: string; content: string; url: string }>> {
  try {
    const url = `${SEARXNG}/search?q=${encodeURIComponent(query)}&format=json&engines=360search,sogou,quark`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [];
    const d = (await r.json()) as { results?: Array<{ title?: string; content?: string; url?: string }> };
    return (d.results ?? []).slice(0, 10).map((x) => ({ title: (x.title ?? '').trim(), content: (x.content ?? '').trim(), url: x.url ?? '' }));
  } catch { return []; }
}

const Source = v.object({ title: v.string(), url: v.string(), excerpt: v.string() });
const ResearchResult = v.object({
  projectName: v.string(),       // 真实项目/公司简称，如"纬钛机器人"，不要用新闻长标题
  whatIsIt: v.string(),          // 一句话：这是什么项目、做什么
  officialSite: v.string(),      // 公司官网 URL，未找到填"待核验"
  registry: v.object({           // 工商信息
    companyName: v.string(), foundedAt: v.string(), registeredCapital: v.string(),
    legalRepresentative: v.string(), registrationStatus: v.string(), creditCode: v.string(), regLocation: v.string(),
  }),
  team: v.array(v.object({ name: v.string(), title: v.string(), background: v.string() })),          // 核心团队
  fundingRounds: v.array(v.object({ round: v.string(), date: v.string(), amount: v.string(), valuation: v.string(), investors: v.string() })), // 股权融资
  shareholders: v.array(v.object({ name: v.string(), percentage: v.string(), type: v.string() })),   // 股东结构
  news: v.array(v.object({ date: v.string(), title: v.string(), summary: v.string(), source: v.string() })), // 公司动态
  sources: v.array(Source),      // 来源证据（本次检索用到的真实链接）
  industry: v.string(),
  summary: v.string(),           // 综合研究结论（3-5句）
});

export default defineWorkflow({
  agent,
  input: v.object({
    name: v.pipe(v.string(), v.description('线索/项目名（可能是新闻长标题，用于检索）')),
    hint: v.optional(v.string()),      // 已有资料摘要，辅助
    articleText: v.optional(v.string()), // 原始正文
  }),
  async run({ input, harness }) {
    // 1) 多轮联网检索：项目名、融资、团队、工商
    const queries = [
      `${input.name}`,
      `${input.name} 融资 投资方`,
      `${input.name} 创始人 团队`,
      `${input.name} 公司 官网 工商`,
    ];
    const seen = new Set<string>();
    const hits: Array<{ title: string; content: string; url: string }> = [];
    for (const q of queries) {
      for (const r of await searxng(q)) {
        const key = r.url || r.title;
        if (key && !seen.has(key)) { seen.add(key); hits.push(r); }
      }
    }
    const webBlock = hits.slice(0, 20).map((h) => `· ${h.title}：${h.content}（来源：${h.url}）`).join('\n');

    // 2) 交给模型按 6 维度结构化提炼（缺则标待核验，不编造）
    const session = await harness.session();
    const prompt = [
      '你是投资机构的信源研究员。基于下方【联网检索结果】和【已有资料】，对该项目做尽调式信息整理，按结构化字段输出。',
      '',
      `【项目/线索】${input.name}`,
      input.hint ? `【已有摘要】${input.hint}` : '',
      input.articleText ? `【原始正文】${input.articleText.slice(0, 6000)}` : '',
      '',
      '【联网检索结果】',
      webBlock || '（本次未检索到公开结果）',
      '',
      '输出要求（六维度）：',
      '- projectName：真实公司/项目简称（如"纬钛机器人"），绝不用新闻长标题。',
      '- whatIsIt：一句话说清做什么。',
      '- officialSite：公司官网 URL。',
      '- registry：工商信息（公司全称 companyName / 成立时间 foundedAt / 注册资本 registeredCapital / 法人 legalRepresentative / 登记状态 registrationStatus / 统一社会信用代码 creditCode / 注册地址 regLocation）。',
      '- team：核心团队（姓名/职务/背景）。',
      '- fundingRounds：融资历史（轮次/时间/金额/估值/投资方）。',
      '- shareholders：股东结构（名称/持股/类型）。',
      '- news：公司动态（时间/标题/摘要/来源）。',
      '- sources：本次检索用到的真实来源链接（标题/URL/摘录）。',
      '',
      '★铁律：只写检索结果或资料中真实存在的信息。任何未找到的字段一律填"待核验"，绝对禁止编造公司名、注册号、持股比例、金额、人名等任何事实。宁缺毋造。',
    ].filter(Boolean).join('\n');

    const { data } = await session.prompt(prompt, { result: ResearchResult });
    return { ...data, _webHitCount: hits.length };
  },
});
