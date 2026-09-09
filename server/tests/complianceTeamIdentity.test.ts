import assert from 'node:assert/strict'
import test from 'node:test'
import { bindComplianceTeamIdentity } from '../src/services/complianceTeamIdentity.js'
import { buildComplianceSkillContent } from '../src/services/aiDocumentSkillRenderService.js'

test('requires an explicit quoted name/job pair, not unrelated co-occurrence', () => {
  const raw = { person_name: '合成甲', role_title: '技术负责人', identity_quote: '技术负责人合成甲负责系统研发。' }
  const evidence = [raw.identity_quote]
  assert.deepEqual(bindComplianceTeamIdentity(raw, evidence), { personName: '合成甲', roleTitle: '技术负责人', evidenceQuote: raw.identity_quote })
  assert.equal(bindComplianceTeamIdentity({ ...raw, person_name: '合成乙' }, evidence), undefined)
  assert.equal(bindComplianceTeamIdentity(raw, ['未包含该身份信息的资料。']), undefined)
  const unrelated = '合成甲参与访谈。技术负责人合成乙负责研发。'
  assert.equal(bindComplianceTeamIdentity({ ...raw, identity_quote: unrelated }, [unrelated]), undefined)
})
test('supported team metadata reaches native renderer and forged metadata is dropped', () => {
  const quote = '技术负责人合成甲负责系统研发。'
  const identity = { personName: '合成甲', roleTitle: '技术负责人', evidenceQuote: quote }
  const make = (personName: string) => buildComplianceSkillContent({
    projectName: '合成项目', company: '合成机构', generatedAt: new Date('2026-09-07T00:00:00Z'),
    sources: [{ sourceType: 'test', sourceId: 'team', sourceName: '合成访谈', content: quote }],
    content: { title: '', executiveSummary: '', highlights: [], risks: [], missing: [], sections: [{
      title: '核心团队', summary: '', findings: [{ text: quote, status: '资料记载', sourceIndexes: [0], teamIdentity: { ...identity, personName } }],
    }] },
  })
  const block = make('合成甲').sections[0].blocks.find(block => block.type === 'paragraph')!
  assert.ok('person_name' in block && 'role_title' in block)
  assert.equal(block.person_name, '合成甲')
  assert.equal(block.role_title, '技术负责人')
  assert.equal('person_name' in make('合成乙').sections[0].blocks.find(block => block.type === 'paragraph')!, false)
})
