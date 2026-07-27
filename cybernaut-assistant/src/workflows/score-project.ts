import '../zeelin-provider.ts';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 一级市场项目评分 —— 对应投资中台「项目获取池」的评分/多维度评分模块。
// 喂甲方评分标准 + 项目信息 → LLM 按标准逐维严格打分（总分=各维度之和，有原因，有高有低禁满分）。
export const route: WorkflowRouteHandler = async (_c, next) => next();

// 评分标准（结构化）随 workflow 一起读；标准文件放 scripts/ 便于统一管理
const STANDARD = readFileSync(join(process.cwd(), 'scripts', 'scoring_standard.json'), 'utf-8');

const agent = defineAgent(() => ({
  model: process.env.SCORE_MODEL ?? 'zeelin/DeepSeek-V4-Flash',
  instructions: [
    '你是浙江赛智伯乐一级市场投资评审 AI，严格依据给定的《评分标准》对项目打分。',
    '',
    '【硬规则 — 必须遵守】',
    '1. 逐维度、逐子项打分：每个子项必须落到标准里的某个档位，取该档位的分值，不得自创中间分。',
    '2. 总分 = 7 个维度得分之和（各维度 = 其子项之和）。你必须自己算准，不能出现维度分与子项和不一致。',
    '3. 【预测性打分】信息缺失的子项不要一律取最低档。请基于"已有信息 + 行业常识 + 同赛道典型规律"做大概率的合理预测打分：',
    '   - 若已知赛道/团队/技术有明确亮点，允许对未披露的子项按"该类项目的典型中位表现"给中位档位；',
    '   - 预测必须有依据(可从赛道、团队背景、已披露信息合理外推)，依据强给中位、依据弱则偏保守下调一档；',
    '   - 严禁因为做预测就清一色高分或满分；整体仍克制，有高有低。仅当某子项确实毫无任何可推断依据时，才取低档。',
    '   - 唯"信息可信度"维度例外：该维度衡量资料的真实充分度，信息缺失就应如实给低档，不做乐观预测。',
    '4. 【区分事实与预测】每个子项必须给"原因"：说明为什么落在这个档位并引用标准档位关键词。',
    '   - 基于已披露资料核实的，正常陈述事实；',
    '   - 基于外推预测的，必须在 reason 开头标注"【预测】基于……推断"，写清推断依据(如"基于该赛道头部团队普遍配置"),不得伪装成已核实事实。',
    '5. 总体项目评价 overall_comment：一段结论性文字，点出最强项、最大短板、是否建议推进；并说明本次打分中哪些维度/子项是基于预测的、整体置信度如何(高/中/低)。',
    '6. verdict 依据总分对照 verdict_bands 选择。',
    '7. 竞品对标表 competitors：列出本项目(is_self=true)+2~3个该赛道代表性竞品(is_self=false)，每行给技术路线、产品阶段、融资背书、差异化/可投资性判断。竞品用你所知的真实同赛道公司；信息不确定处标注"待核验"，不编造精确数字。用于直观体现技术差异化与一级市场可投资性。',
    '',
    '语言：简体中文。务实、克制、不吹捧。',
  ].join('\n'),
}));

// 每个维度的结果
const DimResult = v.object({
  key: v.string(),
  name: v.string(),
  score: v.number(),
  max: v.number(),
  items: v.array(v.object({
    name: v.string(),
    score: v.number(),
    max: v.number(),
    reason: v.string(),
  })),
});

const CompetitorRow = v.object({
  name: v.string(),          // 竞品/本项目名称
  is_self: v.boolean(),      // 是否本项目
  tech: v.string(),          // 技术路线/核心指标
  product: v.string(),       // 产品与落地阶段
  funding: v.string(),       // 融资/估值/背书
  differentiation: v.string(), // 差异化/可投资性判断
});
const ScoreResult = v.object({
  total: v.number(),
  verdict: v.string(),
  overall_comment: v.string(),
  dimensions: v.array(DimResult),
  competitors: v.array(CompetitorRow),  // 竞品对标表:本项目+2~3个真实/代表性竞品
});

export default defineWorkflow({
  agent,
  input: v.object({
    projectName: v.string(),
    industry: v.optional(v.string()),
    round: v.optional(v.string()),
    valuation: v.optional(v.string()),
    financing: v.optional(v.string()),
    summary: v.optional(v.string()),
    highlights: v.optional(v.array(v.string())),
    risks: v.optional(v.array(v.string())),
    team: v.optional(v.string()),
    sources: v.optional(v.array(v.string())),
  }),
  async run({ input, harness }) {
    const session = await harness.session();
    const projectInfo = [
      `项目名称：${input.projectName}`,
      `行业/赛道：${input.industry ?? '未提供'}`,
      `融资轮次：${input.round ?? '未提供'}`,
      `估值：${input.valuation ?? '未提供'}`,
      `融资信息：${input.financing ?? '未提供'}`,
      `项目摘要：${input.summary ?? '未提供'}`,
      `团队：${input.team ?? '未提供'}`,
      input.highlights?.length ? `亮点：${input.highlights.join('；')}` : '亮点：未提供',
      input.risks?.length ? `风险：${input.risks.join('；')}` : '风险：未提供',
      input.sources?.length ? `信息来源：${input.sources.join('；')}` : '信息来源：未提供',
    ].join('\n');

    const prompt = [
      '《评分标准》(JSON)：',
      STANDARD,
      '',
      '【待评分项目信息】',
      projectInfo,
      '',
      '请严格按标准输出结构化评分：每个维度、每个子项的得分与原因，总分=各维度之和，并给出 verdict 与总体评价。',
    ].join('\n');

    const { data } = await session.prompt(prompt, { result: ScoreResult });
    // 【批次3·审查AUTO-FIX·需求F】LLM 输出信任边界:valibot 仅校验类型(number),不保证
    // 分值不超上限、也不保证 total=各维度之和。预测性打分放开后 LLM 可能返回超 max 的分
    // 或 total 与子项和不一致,会污染下游排名(doScore 直接用 result.total 算分位)与前端进度条。
    // 故在此做一次确定性归一:子项分 clamp 到 [0,max]、维度分=子项和(clamp 到维度 max)、
    // total=各维度和(clamp 到 [0,100])。以本地重算为准,不信任 LLM 自报的聚合值。
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0));
    const dimensions = (data.dimensions ?? []).map((dim) => {
      const items = (dim.items ?? []).map((it) => {
        const mx = clamp(it.max, 0, 100);
        return { ...it, max: mx, score: clamp(it.score, 0, mx) };
      });
      const dimMax = clamp(dim.max, 0, 100);
      const itemSum = items.reduce((a, it) => a + it.score, 0);
      return { ...dim, max: dimMax, items, score: clamp(itemSum, 0, dimMax) };
    });
    const total = clamp(dimensions.reduce((a, d) => a + d.score, 0), 0, 100);
    return { ...data, dimensions, total, projectName: input.projectName };
  },
});
