import '../zeelin-provider.ts';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

// 论文/学术成果专属评分 —— 对应投资中台「项目获取池」中来源为【论文】的早期线索。
// 与通用 score-project 不同：论文类项目通常没有团队/估值/融资信息，故放宽这些要求，
// 重点评估技术本身与转化潜力。5 大维度、总分 100、预测性打分、输出结构与 score-project 同构。
export const route: WorkflowRouteHandler = async (_c, next) => next();

// 论文专属评分标准（结构化，内嵌）：核心看技术实力与落地可能性，容忍团队/估值/融资缺失。
const PAPER_STANDARD = JSON.stringify({
  version: '1.0',
  name: '赛智伯乐论文/学术成果早期项目评分标准',
  total: 100,
  note: '总分=各维度得分之和。这是【论文/学术成果早期项目】评估：团队、估值、融资信息缺失是正常的、不因缺失而额外扣分，重点评估技术本身与转化潜力。评分须严格、有高有低，禁止清一色满分；缺信息按赛道常识合理预测（标注【预测】）。',
  dimensions: [
    {
      key: 'tech_strength', name: '技术实力/创新性', max: 30,
      intro: '论文类项目最核心的评估项，衡量技术方案的原创性、先进性与相对已有工作的突破程度。',
      levels: [
        { score: 30, desc: '提出原创性方法/新范式，较现有 SOTA 有显著提升或开辟新方向，思路新颖、论证扎实，属该细分方向第一梯队工作。' },
        { score: 22, desc: '在主流路线上有明确、可量化的创新与改进，方法可靠，处于国内领先或国际跟随中的优秀水平。' },
        { score: 14, desc: '增量式改进，创新点有限，与同期工作差异不大，属常规跟随性研究。' },
        { score: 6, desc: '技术新意不足或验证薄弱，方法平庸、缺乏说服力。' },
      ],
    },
    {
      key: 'landing', name: '技术落地可能性', max: 28,
      intro: '衡量该学术成果转化为真实产品/工程系统的可行性，包括工程化难度、数据/算力依赖、场景清晰度。',
      levels: [
        { score: 28, desc: '技术路径清晰、工程化门槛可控，已有原型/开源实现或明确的产品化路径，短中期内可落地为可用系统。' },
        { score: 20, desc: '落地方向明确但存在一定工程化/数据/成本挑战，需一定研发投入方可产品化，中期可期。' },
        { score: 12, desc: '距离落地较远，依赖大量额外工程/数据/算力，或场景尚不清晰，转化不确定性高。' },
        { score: 5, desc: '纯理论探索，短中期难以工程化，落地路径高度不明。' },
      ],
    },
    {
      key: 'market', name: '市场空间', max: 20,
      intro: '衡量该技术所对应下游应用的市场规模、增长性与商业价值想象空间。',
      levels: [
        { score: 20, desc: '对应大赛道/高增长市场，需求真实旺盛，一旦落地商业价值与想象空间巨大。' },
        { score: 14, desc: '对应中等规模且稳定增长的市场，有清晰的付费场景与商业价值。' },
        { score: 8, desc: '市场偏细分/早期，规模有限或需求待验证。' },
        { score: 3, desc: '应用场景狭窄或市场需求存疑，商业价值想象空间小。' },
      ],
    },
    {
      key: 'academic', name: '学者/团队学术背景', max: 12,
      intro: '衡量作者的学术声誉与研究实力（顶刊顶会、引用、名校/名实验室背书等）。注意：论文线索常缺完整团队信息，缺失不额外扣分，按已披露的作者/机构信息合理评估。',
      levels: [
        { score: 12, desc: '作者/通讯来自顶尖高校或知名实验室，发表于顶刊顶会（CVPR/NeurIPS/Nature 子刊等），有较强学术影响力与持续产出。' },
        { score: 8, desc: '作者来自知名院校/机构，发表渠道较权威，具备扎实科研背景。' },
        { score: 4, desc: '作者背景一般或信息有限，学术影响力尚不明确（信息缺失时给中低档，不因缺失清零）。' },
        { score: 1, desc: '几乎无可考的学术背书，或发表渠道权威性明显偏弱。' },
      ],
    },
    {
      key: 'commercialization', name: '过往商业化经验', max: 10,
      intro: '衡量作者/团队是否有过技术转化、创业或产业合作经验。论文类早期项目常无此信息，缺失属正常、不额外扣分，按已披露信息合理预测。',
      levels: [
        { score: 10, desc: '核心作者有成功的技术转化/创业/产业落地经历，具备将成果推向市场的实战经验。' },
        { score: 6, desc: '有一定产学研合作或参与过商业化项目的经验。' },
        { score: 3, desc: '以纯学术产出为主，商业化经验有限或不明（信息缺失时给中低档，不因缺失清零）。' },
        { score: 1, desc: '明确无任何商业化/转化相关经历。' },
      ],
    },
  ],
  verdict_bands: [
    { min: 80, label: '强烈推荐', desc: '技术与转化潜力突出，建议优先接触作者、推进立项调研。' },
    { min: 65, label: '推荐', desc: '技术亮点明确，转化潜力较好，建议纳入重点跟踪。' },
    { min: 50, label: '谨慎观察', desc: '存在明显短板或信息不足，建议持续跟踪、补充验证后再判断。' },
    { min: 0, label: '暂不推荐', desc: '技术或落地潜力不足，暂不建议投入资源。' },
  ],
});

const agent = defineAgent(() => ({
  model: process.env.SCORE_MODEL ?? 'zeelin/DeepSeek-V4-Flash',
  instructions: [
    '你是浙江赛智伯乐一级市场投资评审 AI，专门评估【来源于论文/学术成果的早期项目】。严格依据给定的《论文评分标准》对项目打分。',
    '',
    '【重要认知 — 论文类项目的特殊性】',
    '- 这是学术成果早期阶段项目：通常还没有公司、团队、估值、融资轮次等信息，这些信息缺失是完全正常的，绝不因为"没有团队/估值/融资"而扣分，也不要设置交易结构/估值合理性/融资轮次这类维度。',
    '- 评估的重心是【技术本身】和【转化潜力】：技术实力/创新性、技术落地可能性权重最高，其次是市场空间，学术背景与商业化经验为辅助项。',
    '',
    '【硬规则 — 必须遵守】',
    '1. 逐维度打分：每个维度必须落到标准里的某个档位分值区间，给出合理分数（可在档位之间按程度取值，但不得超过该维度 max）。',
    '2. 总分 = 5 个维度得分之和。你必须自己算准，不能出现总分与各维度和不一致。',
    '3. 【预测性打分】信息缺失的维度/子项不要一律取最低档。请基于"已披露信息 + 赛道常识 + 同类学术成果的典型规律"做大概率的合理预测打分：',
    '   - 论文本身能反映技术水平，据此对技术实力/创新性、落地可能性、市场空间做实质判断；',
    '   - 团队学术背景、过往商业化经验若未披露，按该赛道/该发表层次的典型中位表现给中位偏保守的分，不因缺失而清零；',
    '   - 预测必须有依据（可从赛道、发表渠道、方法难度合理外推），依据强给中位、依据弱则偏保守下调；',
    '   - 严禁因为做预测就清一色高分或满分；整体仍克制，有高有低。',
    '4. 每个维度/子项必须给"原因" reason：说明为什么落在这个档位并引用标准档位关键词。基于外推预测的，必须在 reason 开头标注"【预测】基于……推断"，写清推断依据，不得伪装成已核实事实。',
    '5. 总体项目评价 overall_comment：一段结论性文字，点出最强项、最大短板、是否建议推进；并说明本次打分中哪些维度是基于预测的、整体置信度如何（高/中/低）。',
    '6. verdict 依据总分对照 verdict_bands 选择（强烈推荐≥80 / 推荐≥65 / 谨慎观察≥50 / 暂不推荐<50）。',
    '7. 竞品对标表 competitors：列出本项目(is_self=true)+2~3个该技术方向代表性工作/公司(is_self=false)，每行给技术路线、产品/落地阶段、背书情况、差异化/转化潜力判断。用你所知的真实同方向工作；信息不确定处标注"待核验"，不编造精确数字。',
    '',
    '语言：简体中文。务实、克制、不吹捧。',
  ].join('\n'),
}));

// 每个维度的结果（与 score-project 同构，前后端复用同一套渲染）
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
  name: v.string(),
  is_self: v.boolean(),
  tech: v.string(),
  product: v.string(),
  funding: v.string(),
  differentiation: v.string(),
});

const ScoreResult = v.object({
  total: v.number(),
  verdict: v.string(),
  overall_comment: v.string(),
  dimensions: v.array(DimResult),
  competitors: v.array(CompetitorRow),
});

export default defineWorkflow({
  agent,
  input: v.object({
    projectName: v.string(),
    industry: v.optional(v.string()),
    summary: v.optional(v.string()),
    // 论文专属字段（可选）
    title: v.optional(v.string()),
    authors: v.optional(v.array(v.string())),
    firstAuthor: v.optional(v.string()),
    categories: v.optional(v.array(v.string())),
    venue: v.optional(v.string()),
    abstract: v.optional(v.string()),
    pdfUrl: v.optional(v.string()),
    highlights: v.optional(v.array(v.string())),
    risks: v.optional(v.array(v.string())),
    sources: v.optional(v.array(v.string())),
    // 论文全文和已入库工商/结构化资料由主系统拼进 articleText 传入。
    articleText: v.optional(v.string()),
  }),
  async run({ input, harness }) {
    const session = await harness.session();
    const paperInfo = [
      `项目名称：${input.projectName}`,
      `论文标题：${input.title ?? input.projectName ?? '未提供'}`,
      `行业/技术方向：${input.industry ?? (input.categories?.length ? input.categories.join('、') : '未提供')}`,
      `作者：${input.authors?.length ? input.authors.join('、') : '未提供'}`,
      `第一作者：${input.firstAuthor ?? '未提供'}`,
      `发表渠道/会议：${input.venue ?? '未提供'}`,
      `摘要：${input.abstract ?? '未提供'}`,
      `项目摘要：${input.summary ?? '未提供'}`,
      `PDF：${input.pdfUrl ?? '未提供'}`,
      input.highlights?.length ? `亮点：${input.highlights.join('；')}` : '亮点：未提供',
      input.risks?.length ? `风险：${input.risks.join('；')}` : '风险：未提供',
      input.sources?.length ? `信息来源：${input.sources.join('；')}` : '信息来源：未提供',
      input.articleText ? `\n【已入库补充资料（论文全文/工商结构化，需二次核验）】\n${input.articleText}` : '',
    ].join('\n');

    const prompt = [
      '《论文评分标准》(JSON)：',
      PAPER_STANDARD,
      '',
      '【待评分论文/学术成果项目信息】',
      paperInfo,
      '',
      '请严格按标准输出结构化评分：每个维度的得分与原因（items 可放该维度的细化说明），总分=各维度之和，并给出 verdict 与总体评价、竞品对标表。切记：团队/估值/融资缺失属正常，不额外扣分；重点评估技术本身与转化潜力。',
    ].join('\n');

    const { data } = await session.prompt(prompt, { result: ScoreResult });
    // 确定性归一：以本地重算为准，不信任 LLM 自报的聚合值（与 score-project 同策略）。
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0));
    // 【review P2 修复】权威 max 以 PAPER_STANDARD 为准,不信任 LLM 自报的 dim.max
    // (LLM 可能谎报 max:200 被 clamp 成 100 而非标准 30 → 前端进度条/占比失真)。按 key 对齐覆盖。
    const STD_MAX: Record<string, number> = { tech_strength: 30, landing: 28, market: 20, academic: 12, commercialization: 10 };
    const dimensions = (data.dimensions ?? []).map((dim) => {
      const dimMax = STD_MAX[dim.key] ?? clamp(dim.max, 0, 100);
      const items = (dim.items ?? []).map((it) => {
        const mx = clamp(it.max, 0, dimMax);
        return { ...it, max: mx, score: clamp(it.score, 0, mx) };
      });
      // 论文维度可能不细分 items；若无 items 则用维度自身 score（clamp 到 max），否则取子项和
      const dimScore = items.length
        ? clamp(items.reduce((a, it) => a + it.score, 0), 0, dimMax)
        : clamp(dim.score, 0, dimMax);
      return { ...dim, max: dimMax, items, score: dimScore };
    });
    const total = clamp(dimensions.reduce((a, d) => a + d.score, 0), 0, 100);
    return { ...data, dimensions, total, projectName: input.projectName };
  },
});
