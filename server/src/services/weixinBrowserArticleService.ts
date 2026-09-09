import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { weixinArticleUrl, type LinkArticle } from '../contracts/weixinLinkIntakeContract.js'
import { directSkillPlatformEnvironment } from './directSkillEnvironment.js'

export function parseWeixinBrowserArticle(output: string, url: string): LinkArticle {
  const value = JSON.parse(output)
  if (value.error) throw Object.assign(new Error('微信文章浏览器读取失败'), { code: String(value.error).slice(0, 64) })
  if (value.url !== url || typeof value.title !== 'string' || !value.title.trim()
    || typeof value.text !== 'string' || value.text.trim().length < 20
    || typeof value.markdown !== 'string' || !value.markdown.trim()
    || Math.max(value.text.length, value.markdown.length) > 200000) {
    throw Object.assign(new Error('微信正文结果无效'), { code: 'SOURCE_BROWSER_INVALID' })
  }
  return { url, title: value.title.trim().slice(0, 500), text: value.text.trim(),
    markdown: value.markdown.trim(), publisher: String(value.publisher || '').slice(0, 200),
    contentHash: createHash('sha256').update(value.text.trim()).digest('hex') }
}

export async function fetchWeixinBrowserArticle(input: string): Promise<LinkArticle> {
  const url = weixinArticleUrl(input)
  if (!url) throw Object.assign(new Error('公众号链接无效'), { code: 'SOURCE_URL_REJECTED' })
  const python = process.env.WEIXIN_ARTICLE_PYTHON?.trim()
  if (!python) throw Object.assign(new Error('微信浏览器提取器未配置'), { code: 'SOURCE_BROWSER_NOT_CONFIGURED' })
  const script = path.resolve('server/scripts/weixin-browser-article.py')
  const output = await new Promise<string>((resolve, reject) => {
    execFile(python, [script, url], { windowsHide: true, timeout: 55000, maxBuffer: 2_000_000,
      env: directSkillPlatformEnvironment(process.cwd(), process.platform, process.env),
    }, (error, stdout) => {
      if (error && !stdout.trim()) return reject(Object.assign(new Error('微信浏览器进程失败'), { code: 'SOURCE_BROWSER_FAILED' }))
      if (error) {
        try { parseWeixinBrowserArticle(stdout, url) } catch (cause) { return reject(cause) }
        return reject(Object.assign(new Error('微信浏览器进程异常退出'), { code: 'SOURCE_BROWSER_FAILED' }))
      }
      resolve(stdout)
    })
  })
  return parseWeixinBrowserArticle(output, url)
}
