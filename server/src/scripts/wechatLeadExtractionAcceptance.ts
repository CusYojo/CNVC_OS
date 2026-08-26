import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractLeadFinancingFacts } from '../services/leadFinancingFactService.js'
import { resolveLeadBusinessRegion } from '../services/leadRegion.js'
import { buildConvertedProjectFundingPatch } from '../services/leadPublicIntelService.js'
const {
  displayLeadFundingValue,
  isLegalCompanyName,
  verifiedCompanyWebsite,
} = await import(pathToFileURL(resolve(process.cwd(), 'src/lib/leadPresentation.ts')).href)

const article = '消费级家庭具身智能公司诺因智能近期完成天使 ++ 轮融资，单笔金额 5 亿元人民币，本轮融资由经纬创投领投。'
const [fact] = extractLeadFinancingFacts({
  text: article,
  sourceUrl: 'https://mp.weixin.qq.com/s?__biz=MzA3ODk5OTEzOA==&mid=2962188377&idx=2',
})

assert.ok(fact, '诺因智能原文必须产生一条融资事实')
assert.equal(fact.round, '天使++轮')
assert.equal(fact.roundRaw, '天使 ++ 轮')
assert.equal(fact.amount, '5亿元人民币')
assert.equal(fact.amountRaw, '5 亿元人民币')
assert.equal(fact.currency, 'CNY')
assert.deepEqual(fact.leadInvestors, ['经纬创投'])
assert.match(fact.evidenceQuote, /单笔金额 5 亿元人民币/)
assert.equal(displayLeadFundingValue('融资金额待核验', fact.amount), '5亿元人民币')
assert.equal(verifiedCompanyWebsite(fact.sourceUrl), '')
assert.equal(isLegalCompanyName('诺因智能'), false)
assert.equal(resolveLeadBusinessRegion({ subjectName: '银川团队' }), undefined)
assert.equal(resolveLeadBusinessRegion({ subjectName: '创始人李银川' }), undefined)
assert.deepEqual(buildConvertedProjectFundingPatch({
  round: '待核验',
  financing: '5亿元人民币',
  valuation: '未披露',
}, fact).patch, { round: '天使++轮' })

console.log(JSON.stringify({
  ok: true,
  acceptance: 'wechat-lead-extraction',
  facts: [{
    round: fact.round,
    roundRaw: fact.roundRaw,
    amount: fact.amount,
    amountRaw: fact.amountRaw,
    currency: fact.currency,
    leadInvestors: fact.leadInvestors,
    evidenceStatus: fact.evidenceStatus,
    sourceUrl: fact.sourceUrl,
  }],
}, null, 2))
