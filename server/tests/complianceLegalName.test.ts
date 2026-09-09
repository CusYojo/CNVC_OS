import assert from 'node:assert/strict'
import test from 'node:test'
import { supportedComplianceLegalName } from '../src/services/complianceLegalName.js'

const source = (content: string) => ({ sourceType: 'test', sourceName: '合成材料', content })

test('uses a declared legal name only when project evidence supports it', () => {
  assert.equal(supportedComplianceLegalName('合成科技有限公司', [source('企业名称为合成科技有限公司。')]), '合成科技有限公司')
  assert.equal(supportedComplianceLegalName('虚构科技有限公司', [source('企业名称为合成科技有限公司。')]), '合成科技有限公司')
})

test('extracts a unique repeated legal name but rejects an ambiguous tie', () => {
  assert.equal(supportedComplianceLegalName('', [source('大衍科技（桐乡）有限公司'), source('大衍科技（桐乡）有限公司')]), '大衍科技（桐乡）有限公司')
  assert.equal(supportedComplianceLegalName('', [source('甲方科技有限公司'), source('乙方科技有限公司')]), undefined)
})

test('uses the project-name stem to disambiguate an evidence-backed legal entity', () => {
  assert.equal(supportedComplianceLegalName('大衍科技（新）', [
    source('交易主体包括大衍科技（桐乡）有限公司。'),
    source('材料另行提到甲方科技有限公司。'),
  ]), '大衍科技（桐乡）有限公司')
})
