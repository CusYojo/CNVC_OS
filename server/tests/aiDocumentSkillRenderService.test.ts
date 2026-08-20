import assert from 'node:assert/strict'
import test from 'node:test'
import type { BusinessContent } from '../src/services/aiBusinessContentService.js'
import { buildComplianceSkillContent } from '../src/services/aiDocumentSkillRenderService.js'

function contentWithConclusion(text: string): BusinessContent {
  return {
    title: '大衍科技合规性说明',
    executiveSummary: '执行摘要。',
    highlights: [],
    risks: [],
    missing: [],
    sections: [
      { title: '公司简介', summary: '', findings: [] },
      { title: '核心团队', summary: '', findings: [] },
      { title: '产品及技术', summary: '', findings: [] },
      { title: '投资理由', summary: '', findings: [] },
      { title: '投资计划', summary: '', findings: [] },
      { title: '投资情形分析', summary: '', findings: [] },
      {
        title: '结论',
        summary: '',
        findings: [{ text, status: '待核验', sourceIndexes: [] }],
      },
    ],
  }
}

test('compliance Skill content normalizes the closing conclusion to one sentence', () => {
  const payload = buildComplianceSkillContent({
    projectName: '大衍科技',
    content: contentWithConclusion('本项目仍有事项需要核对。在完成审批前，不宜作出无保留结论。'),
    sources: [],
    company: '浙江赛智伯乐股权投资管理有限公司',
    generatedAt: new Date('2026-08-19T06:46:00.000Z'),
  }) as {
    sections: Array<{ heading: string; blocks: Array<{ type: string; text: string }> }>
  }
  const analysis = payload.sections.find((section) => section.heading === '投资情形分析')
  const conclusion = analysis?.blocks.find((block) => block.type === 'conclusion')?.text ?? ''

  assert.equal(conclusion, '本项目仍有事项需要核对；在完成审批前，不宜作出无保留结论。')
  assert.equal((conclusion.match(/[。！？]/g) ?? []).length, 1)
})
