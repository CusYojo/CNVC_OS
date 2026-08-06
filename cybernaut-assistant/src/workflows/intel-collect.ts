import '../zeelin-provider.ts';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { verifyCompetitorEvidence, type CompetitorEvidenceRow } from '../lib/competitor-evidence.js';

// 情报采集 —— 对应投资中台「项目获取池 / 公司情报」。
// 真抓公开信息（中文搜索引擎）并返回原始可核验片段，供下游项目模型提炼。
export const route: WorkflowRouteHandler = async (_c, next) => next();

// systemd WorkingDirectory=/data/cybernaut-flue，用 cwd 稳定解析，避免 dist 打包后层级错位
const SCRIPT = join(process.cwd(), 'scripts', 'collect_intel.py');
const COMPETITOR_RESEARCH_MODEL = process.env.INTEL_RESEARCH_MODEL
  ?? process.env.SCORE_MODEL
  ?? 'zeelin-oai/gpt-5.5';
const COMPETITOR_RESEARCH_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.INTEL_RESEARCH_TIMEOUT_MS) || 120_000,
);

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
    '竞对是高风险事实：只能从本次提供的公开检索片段中抽取，不能按行业、赛道或模型常识猜测。',
  ].join('\n'),
}));

const CompetitorRow = v.object({
  name: v.string(),
  is_self: v.boolean(),
  tech: v.string(),
  product: v.string(),
  funding: v.string(),
  differentiation: v.string(),
  matchType: v.picklist(['self', 'direct', 'substitute']),
  sameTargetUser: v.boolean(),
  sameUseCase: v.boolean(),
  sameDeliverable: v.boolean(),
  comparisonBasis: v.string(),
  evidence: v.string(),
  sourceRef: v.string(),
  sourceUrl: v.string(),
  confidence: v.number(),
});

const CompetitorResearch = v.object({
  competitors: v.array(CompetitorRow),
});

function buildEvidenceCorpus(searchEvidence: Array<{
  title: string;
  snippet: string;
  url: string;
}>) {
  return searchEvidence.map((item, index) => [
    `[R${index + 1}]`,
    `标题：${item.title}`,
    `摘要：${item.snippet}`,
    `URL：${item.url}`,
  ].join('\n')).join('\n\n');
}

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
    contextEvidence: v.optional(v.array(v.object({
      title: v.string(),
      snippet: v.string(),
      url: v.string(),
    }))),
  }),
  async run({ input, harness }) {
    const collected = await collectCompanyIntel(input);
    const seenEvidence = new Set<string>();
    const collectedSearchEvidence = collected.queries.flatMap((query) =>
      query.results.flatMap((result) => {
        const url = result.url.trim();
        const evidenceKey = `${url}|${result.snippet.replace(/\s+/g, '').toLocaleLowerCase()}`;
        if (!url || seenEvidence.has(evidenceKey)) return [];
        seenEvidence.add(evidenceKey);
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
    const contextEvidence = (input.contextEvidence ?? []).flatMap((item) => {
      const url = item.url.trim();
      if (!url) return [];
      let publisher = '';
      try {
        publisher = new URL(url).hostname;
      } catch {
        // 交由服务端来源入口再次校验。
      }
      return [{
        query: '线索池已有来源',
        title: item.title,
        snippet: item.snippet,
        url,
        publisher,
        publishedAt: '',
        reliability: '线索池已有来源，需访问原始页面核验',
      }];
    });
    const finalEvidenceKeys = new Set<string>();
    const searchEvidence = [...contextEvidence, ...collectedSearchEvidence].filter((item) => {
      const key = `${item.url}|${item.snippet.replace(/\s+/g, '').toLocaleLowerCase()}`;
      if (finalEvidenceKeys.has(key)) return false;
      finalEvidenceKeys.add(key);
      return true;
    });
    let competitors: ReturnType<typeof verifyCompetitorEvidence> = [];
    // 没有显式“竞争/对比/替代”语义的搜索摘要，不值得调用模型，更不能据此猜竞对。
    const competitorEvidence = searchEvidence.filter((item) =>
      /竞品|竞争|对手|对标|替代|取代|相比|相较|同类|\bvs\.?\b|versus|competitor|alternative|compared?\s+(?:with|to)/i
        .test(`${item.title}\n${item.snippet}`),
    );
    if (competitorEvidence.length) {
      const evidenceCorpus = buildEvidenceCorpus(competitorEvidence);
      const prompt = [
        `研究主体：${input.company}`,
        '',
        '请仅从下方公开检索证据中抽取直接竞对或真正可替代方案，最多 3 个。',
        '硬性要求：',
        '1. 不得使用模型记忆；同属一个行业、技术方向或融资阶段不构成竞对。',
        '2. 必须有证据明确支持：目标客户相同、具体任务/使用场景相同、交付产品可直接替代；三个布尔字段均应据实填写。',
        '3. evidence 必须逐字复制一段包含竞对名称的标题或摘要，不能改写或拼接。',
        '4. sourceRef 必须逐字复制对应来源的完整标题，sourceUrl 必须逐字复制对应 URL。',
        '5. comparisonBasis 要具体说明双方争夺的客户、场景和可替代产品。无法同时证明时不要输出该公司。',
        '6. 不要输出研究主体自身。若没有可靠竞对，返回空数组。',
        '7. tech、product、funding、differentiation 没有证据时返回空字符串，不要填写“未提及”“待核验”等占位语。',
        '',
        '【公开检索证据】',
        evidenceCorpus,
      ].join('\n');
      try {
        const session = await harness.session();
        const { data } = await session.prompt(prompt, {
          result: CompetitorResearch,
          model: COMPETITOR_RESEARCH_MODEL,
          signal: AbortSignal.timeout(COMPETITOR_RESEARCH_TIMEOUT_MS),
        });
        competitors = verifyCompetitorEvidence(
          data.competitors as CompetitorEvidenceRow[],
          evidenceCorpus,
          'project',
        );
        if (data.competitors.length > 0 && competitors.length === 0) {
          console.warn('[intel-collect] model candidates did not pass deterministic evidence verification',
            data.competitors.map((item) => ({
              name: item.name,
              matchType: item.matchType,
              sameTargetUser: item.sameTargetUser,
              sameUseCase: item.sameUseCase,
              sameDeliverable: item.sameDeliverable,
              confidence: item.confidence,
              sourceRef: item.sourceRef,
            })));
        }
      } catch (error) {
        // 竞对研究失败不应让工商、融资等公开信息补充整体失败。
        console.warn(`[intel-collect] competitor research skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
      competitors,
      companyNews: [],
      sources: [...new Map(searchEvidence.map((item) => [item.url, {
        title: item.title,
        url: item.url,
        reliability: item.reliability,
      }])).values()],
      searchEvidence,
      confidence: Math.min(0.8, new Set(searchEvidence.map((item) => item.url)).size / 20),
      fetchedAt: collected.fetched_at,
    };
  },
});
