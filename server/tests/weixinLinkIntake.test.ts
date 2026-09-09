import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { weixinArticleUrl, weixinIntakeCommand, weixinIntakeBindingAuthorized, type LinkIntakeSession } from '../src/contracts/weixinLinkIntakeContract.js'
import { handleWeixinLinkIntake, type LinkIntakeDependencies } from '../src/services/weixinLinkIntakeFlow.js'
import { weixinArticleBodyHtml } from '../src/services/weixinArticleHtml.js'

const url = 'https://mp.weixin.qq.com/s/example'
function fixture() {
  const session: LinkIntakeSession = { receipts: {} }
  const counts = { fetch: 0, knowledge: 0, project: 0 }
  const saved: LinkIntakeSession[] = []
  const deps: LinkIntakeDependencies = {
    save: async value => { saved.push(structuredClone(value)) },
    fetchArticle: async articleUrl => { counts.fetch++; return { url: articleUrl, title: '测试文章', text: '可靠的文章正文', publisher: '测试公众号', contentHash: 'abc' } },
    saveKnowledge: async () => { counts.knowledge++; return 'knowledge-id' },
    importProject: async () => { counts.project++; return { status: 'ready', leadId: 'lead-id' } },
    link: path => `https://platform.example${path}`,
  }
  const send = (id: string, text: string) => handleWeixinLinkIntake(session, id, text, deps)
  return { session, counts, saved, deps, send }
}

test('only accepts exact WeChat article host and strips known tracking fields', () => {
  assert.equal(weixinArticleUrl('https://mp.weixin.qq.com.evil.example/s/a'), null)
  assert.equal(weixinArticleUrl('https://user:pass@mp.weixin.qq.com/s/a'), null)
  assert.equal(weixinArticleUrl('https://mp.weixin.qq.com:123/s/a'), null)
  assert.equal(weixinArticleUrl('http://127.0.0.1/s/a'), null)
  assert.equal(weixinArticleUrl('收藏 https://mp.weixin.qq.com/s?__biz=b&mid=2&idx=1&sn=x&scene=1。'), 'https://mp.weixin.qq.com/s?__biz=b&idx=1&mid=2&sn=x')
  assert.equal(weixinIntakeCommand(' 2 '), 'knowledge')
})

test('knowledge-only never executes the lead pipeline; replay does not write again', async () => {
  const f = fixture()
  assert.match((await f.send('link', url))!, /请选择/)
  assert.equal(f.counts.knowledge, 0)
  const reply = await f.send('choice', '2')
  assert.match(reply!, /知识库已保存/)
  assert.equal(await f.send('choice', '2'), reply)
  assert.deepEqual(f.counts, { fetch: 1, knowledge: 1, project: 0 })
  assert.equal(f.session.task?.status, 'completed')
})

test('project-only uses pipeline, keeps rejection distinct from success', async () => {
  const f = fixture()
  f.deps.importProject = async () => { f.counts.project++; return { status: 'rejected' } }
  await f.send('link', url)
  assert.match((await f.send('choice', '1'))!, /未通过/)
  assert.equal(f.counts.knowledge, 0)
  assert.equal(f.counts.project, 1)
})

test('both preserves successful knowledge when project fails; retry resumes only project', async () => {
  const f = fixture()
  let fail = true
  f.deps.importProject = async task => {
    f.counts.project++
    assert.equal(task.knowledgeId, 'knowledge-id')
    if (fail) throw new Error('temporary model outage')
    return { status: 'ready', leadId: 'lead-id' }
  }
  await f.send('link', url)
  const partial = await f.send('choice', '3')
  assert.match(partial!, /知识库已保存/)
  assert.match(partial!, /尚未全部完成/)
  fail = false
  assert.match((await f.send('retry', '重试'))!, /项目池已收录/)
  assert.deepEqual(f.counts, { fetch: 1, knowledge: 1, project: 2 })
})

test('failed article never enters either store; restart uses persisted task', async () => {
  const f = fixture()
  f.deps.fetchArticle = async () => { throw new Error('verification page') }
  assert.match((await f.send('link', url))!, /尚未入库/)
  assert.equal(f.session.task?.status, 'failed')
  assert.deepEqual(f.counts, { fetch: 0, knowledge: 0, project: 0 })
  const restored = structuredClone(f.saved.at(-1)!)
  const deps = fixture().deps
  assert.match((await handleWeixinLinkIntake(restored, 'retry', '重试', deps))!, /请选择/)
})

test('pending task cannot be overwritten; cancellation and unrelated chat are supported', async () => {
  const f = fixture()
  assert.equal(await f.send('hello', '你好'), null)
  await f.send('link', url)
  assert.match((await f.send('second', `${url}2`))!, /还有一篇/)
  assert.equal(f.session.task?.url, url)
  await f.send('cancel', '取消')
  assert.equal(f.session.task?.status, 'cancelled')
  assert.match((await f.send('third', `${url}2`))!, /请选择/)
})

test('sessions do not share tasks or accept choices from another user', async () => {
  const a = fixture(), b = fixture()
  await a.send('link', url)
  assert.equal(await b.send('choice', '2'), null)
  assert.equal(b.session.task, undefined)
  assert.equal(a.session.task?.status, 'awaiting_choice')
})

test('legacy automatic owner bindings cannot authorize other senders to write business data', () => {
  const input = { senderId: 'someone', accountUserId: 'scanner', botOwnerId: 'admin', bindingUserId: 'admin', bindingVersion: 1 }
  assert.equal(weixinIntakeBindingAuthorized(input), false)
  assert.equal(weixinIntakeBindingAuthorized({ ...input, senderId: 'scanner' }), true)
  assert.equal(weixinIntakeBindingAuthorized({ ...input, bindingUserId: 'explicit-user' }), true)
  assert.equal(weixinIntakeBindingAuthorized({ ...input, bindingVersion: 3 }), true)
})

test('a new submission preserves the previous task and keeps receipts task-scoped', async () => {
  const f = fixture()
  const history = new Map<string, LinkIntakeSession>()
  f.deps.save = async value => { if (value.task) history.set(value.task.id, structuredClone(value)) }
  await f.send('first-link', url)
  const firstId = f.session.task!.id
  const firstReply = await f.send('first-choice', '2')
  await f.send('second-link', `${url}2`)
  const secondId = f.session.task!.id
  assert.notEqual(firstId, secondId)
  assert.equal(history.size, 2)
  assert.equal(history.get(firstId)!.task!.status, 'completed')
  assert.equal(history.get(secondId)!.task!.initialMessageId, 'second-link')
  assert.equal(f.session.receipts['first-choice'], undefined)
  assert.equal(await handleWeixinLinkIntake(history.get(firstId)!, 'first-choice', '2', f.deps), firstReply)
  assert.equal(history.get(secondId)!.task!.status, 'awaiting_choice')
  assert.equal(f.counts.knowledge, 1)
})

test('WeChat HTML extractor preserves nested paragraphs and excludes page footer', () => {
  assert.equal(weixinArticleBodyHtml('<div id="js_content"><div>甲</div><section>乙</section>丙</div><div>页脚</div>'), '<div>甲</div><section>乙</section>丙')
  assert.throws(() => weixinArticleBodyHtml('<html>请完成验证后访问</html>'), /正文不可用/)
  assert.throws(() => weixinArticleBodyHtml('<div id="js_content">broken'), /不完整/)
})

test('migration creates only the intake table and leaves all existing table structures unchanged', async () => {
  const sql = await readFile(new URL('../drizzle/0102_add_weixin_link_intakes.sql', import.meta.url), 'utf8')
  assert.equal((sql.match(/CREATE TABLE/g) || []).length, 1)
  assert.match(sql, /CREATE TABLE `sbl_weixin_link_intakes`/)
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|TRUNCATE|UPDATE|DELETE)\b/i)
})
