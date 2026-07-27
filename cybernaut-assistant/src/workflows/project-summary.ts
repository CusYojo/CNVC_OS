import '../zeelin-provider.ts';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

// 项目 AI 摘要 —— 对应 cybernaut-mvp 的 POST /api/ai/project-summary
// 结构化输出：valibot schema 强制 positioning/highlights/risks/questions/confidence。
export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent(() => ({
  model: process.env.FLUE_MODEL ?? 'zeelin/claude-sonnet-4-6',
  instructions: [
    '你是浙江赛智伯乐股权投资中台的 AI 投研助手，专为 VC/PE 投决会议输出「项目摘要」。',
    '基于项目档案给出：一句话定位、亮点、风险、尽调问题，以及 0~1 的置信度。',
    '亮点/风险务实具体，尽调问题要能直接向被投企业发问。全文简体中文。',
  ].join('\n'),
}));

const Summary = v.object({
  positioning: v.string(),
  highlights: v.array(v.string()),
  risks: v.array(v.string()),
  questions: v.array(v.string()),
  confidence: v.number(),
});

export default defineWorkflow({
  agent,
  input: v.object({
    projectName: v.string(),
    industry: v.optional(v.string()),
    stage: v.optional(v.string()),
    financing: v.optional(v.string()),
  }),
  async run({ input, harness }) {
    const session = await harness.session();
    const ctx = [
      `项目名称：${input.projectName}`,
      `行业：${input.industry ?? '待补充'}`,
      `阶段：${input.stage ?? '待补充'}`,
      `融资：${input.financing ?? '待补充'}`,
      '请给出结构化项目摘要。',
    ].join('\n');
    const { data } = await session.prompt(ctx, { result: Summary });
    return {
      positioning: data.positioning,
      highlights: data.highlights.slice(0, 6),
      risks: data.risks.slice(0, 6),
      questions: data.questions.slice(0, 4),
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.7,
      sources: ['项目基础信息'],
    };
  },
});
