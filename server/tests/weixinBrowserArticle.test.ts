import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWeixinBrowserArticle } from '../src/services/weixinBrowserArticleService.js'

const url = 'https://mp.weixin.qq.com/s/example'
const article = { url, title: '公众号文章', publisher: '来源', text: '这里是从文章页面提取的真实正文，包含足够的有效文字。', markdown: '## 正文\n\n这里是从文章页面提取的真实正文。' }
test('browser output preserves Markdown and hashes cleaned text', () => {
  const result = parseWeixinBrowserArticle(JSON.stringify(article), url)
  assert.equal(result.markdown, article.markdown)
  assert.equal(result.text, article.text)
  assert.equal(result.contentHash.length, 64)
})
test('verification, empty content, wrong source and oversized output cannot become articles', () => {
  for (const value of [{ error: 'SOURCE_WEIXIN_BODY_UNAVAILABLE' }, { ...article, text: '' },
    { ...article, url: 'https://example.com' }, { ...article, markdown: 'x'.repeat(200001) }]) {
    assert.throws(() => parseWeixinBrowserArticle(JSON.stringify(value), url))
  }
})
