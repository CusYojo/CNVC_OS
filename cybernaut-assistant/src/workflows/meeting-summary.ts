import '../zeelin-provider.ts';
import { defineAgent, defineWorkflow, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

// 会议纪要 —— 对应 cybernaut-mvp 的 POST /api/ai/meeting-summary
// 输入会议逐字文本，产出结构化纪要 + 结论 + 待办清单。
export const route: WorkflowRouteHandler = async (_c, next) => next();

const agent = defineAgent(() => ({
  model: process.env.FLUE_MODEL ?? 'zeelin/claude-sonnet-4-6',
  instructions: [
    '你是投资中台的会议纪要助手。把会议逐字文本整理为结构化纪要。',
    '产出：一段简明纪要正文、若干条关键结论、若干条可执行待办（含负责人线索时保留）。',
    '全文简体中文，忠实原文，不臆造未提及的事实。',
  ].join('\n'),
}));

const Minutes = v.object({
  summary: v.string(),
  conclusions: v.array(v.string()),
  todos: v.array(v.string()),
  confidence: v.number(),
});

export default defineWorkflow({
  agent,
  input: v.object({ transcript: v.string() }),
  async run({ input, harness }) {
    const session = await harness.session();
    const { data } = await session.prompt(
      `请将以下会议文本整理为结构化纪要：\n\n${input.transcript}`,
      { result: Minutes },
    );
    return {
      summary: data.summary,
      conclusions: data.conclusions.slice(0, 8),
      todos: data.todos.slice(0, 8),
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.75,
    };
  },
});
