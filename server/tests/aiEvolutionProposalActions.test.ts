import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('proposal cards expose edit, defer, reject and execute actions', async () => {
  const [panel, editor] = await Promise.all([readFile('src/components/ai-evolution/AiEvolutionPanel.tsx', 'utf8'),
    readFile('src/components/ai-evolution/AiEvolutionProposalEditor.tsx', 'utf8')])
  for (const label of ['稍后处理', '拒绝提案', '开始执行']) assert.match(panel, new RegExp(label))
  assert.match(editor, />修改提案</)
  assert.match(editor, /acceptanceCriteria/)
  for (const detail of ['当前内容基线', '测试样本', '仓库基线', '允许修改', '数据库变更', '权限变更', '隔离页面']) {
    assert.match(panel, new RegExp(detail))
  }
})
