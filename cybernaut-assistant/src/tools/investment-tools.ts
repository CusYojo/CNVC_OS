import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

// 退休源码只用于行为对照，不再持有或调用共享密钥内部接口。

export const searchProjectDocs = defineTool({
  name: 'search_project_docs',
  description:
    '检索某个项目（或全局知识库）已上传的授权资料片段。任何涉及"这个项目/公司的具体情况、风险、亮点、财务、团队、尽调、资料里写了什么"的问题，都必须先调用本工具拿到真实资料再回答，不要凭空作答。返回命中的资料片段与来源文件名。',
  input: v.object({
    query: v.pipe(v.string(), v.description('检索用的问题或关键词')),
    projectId: v.optional(v.pipe(v.string(), v.description('项目 ID；查全局知识库时留空'))),
  }),
  output: v.object({
    hasEvidence: v.boolean(),
    context: v.string(),
    sources: v.array(v.string()),
  }),
  async run({ input }) {
    void input;
    throw Object.assign(new Error('旧 Assistant 工具 Runtime 已退场'), {
      code: 'RETIRED_ASSISTANT_RUNTIME',
    });
  },
});
