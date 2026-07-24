import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { projectFiles, fileChunks, knowledgeChunks } from '../db/schema.js'
import mammoth from 'mammoth'
import { decodeTextBuffer, normalizeUnicodeText } from './textQualityService.js'

// 通过 18081 网关多模态模型 OCR：读图片/扫描件，返回其中文字。用于图片文件与图片型PDF。
const GW_BASE = (process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
const GW_KEY = process.env.GATEWAY_IMAGE_API_KEY || process.env.OPENAI_API_KEY || ''
const OCR_MODEL = process.env.OCR_VISION_MODEL || 'gemini-3.1-pro-preview'
async function ocrImage(buffer: Buffer, mime = 'image/png'): Promise<string> {
  if (!GW_KEY) return ''
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
  const body = {
    model: OCR_MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: '请把这张图片中的所有文字（含表格、图注、标题）按阅读顺序完整转写成纯文本；无文字则回复空。只输出文字本身，不要解释。' },
      { type: 'image_url', image_url: { url: dataUrl } },
    ] }],
    max_tokens: 4000,
  }
  const resp = await fetch(`${GW_BASE}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${GW_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  })
  if (!resp.ok) throw new Error(`OCR网关 ${resp.status}`)
  const d = await resp.json() as { choices?: { message?: { content?: string } }[] }
  return (d.choices?.[0]?.message?.content || '').trim()
}

// 图片型/扫描PDF：pdftoppm 逐页转PNG → 每页走网关OCR → 合并文本
async function pdfOcrPages(buffer: Buffer, maxPages = 30): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const run = promisify(execFile)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfocr-'))
  try {
    const pdfPath = path.join(dir, 'in.pdf')
    await fs.writeFile(pdfPath, buffer)
    // 转 PNG，150dpi，前 maxPages 页
    await run('pdftoppm', ['-png', '-r', '150', '-l', String(maxPages), pdfPath, path.join(dir, 'p')], { timeout: 120000 })
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort()
    const out: string[] = []
    for (const f of files) {
      const img = await fs.readFile(path.join(dir, f))
      try {
        const txt = await ocrImage(img, 'image/png')
        if (txt) out.push(txt)
      } catch { /* 单页失败跳过 */ }
    }
    return out.join('\n\n').trim()
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}


// ---------- 正文提取 ----------
export async function extractText(buffer: Buffer, type: string, name: string): Promise<string> {
  const t = (type || name.split('.').pop() || '').toLowerCase()
  // 扩展名优先判定（浏览器传的 type 往往是 MIME，如 text/plain，用 includes 判 txt 会漏）
  const ext = (name.split('.').pop() || '').toLowerCase()
  const isPdf = ext === 'pdf' || t.includes('pdf')
  const isText = ['txt', 'md', 'markdown', 'csv', 'htm', 'html', 'log', 'json'].includes(ext) || t.includes('text/') || t.includes('csv') || t.includes('html') || t === 'text/plain'
  const isDoc = ext === 'doc' || ext === 'docx' || t.includes('word') || t.includes('wordprocessingml')
  const isExcel = ['xls', 'xlsx', 'xlsm'].includes(ext) || t.includes('xls') || t.includes('ms-excel') || t.includes('spreadsheetml')
  const isLegacyXls = ext === 'xls' || (t.includes('ms-excel') && !t.includes('spreadsheetml') && ext !== 'xlsx')
  const isPpt = ext === 'ppt' || ext === 'pptx' || t.includes('presentation') || t.includes('ppt')
  if (isPdf) {
    const data = new Uint8Array(buffer)
    let text = ''
    try {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const doc = await getDocument({ data, useSystemFonts: true }).promise
      const parts: string[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const tc = await page.getTextContent()
        const line = (tc.items as { str?: string }[]).map((x) => x.str || '').join(' ').trim()
        if (line) parts.push(line)
      }
      text = parts.join('\n').trim()
    } catch (err) {
      // pdfjs 解析失败(Invalid PDF structure 等) → 直接走 OCR 兜底，不抛错
      console.warn('[extractText] pdfjs 解析失败，回退 OCR:', (err as Error)?.message)
    }
    // 文本层充足直接用；过少(图片型/扫描件)或解析失败则逐页OCR
    if (text.length >= 100) return text
    let ocr = ''
    try {
      ocr = await pdfOcrPages(buffer)
    } catch (err) {
      console.warn('[extractText] pdfOcrPages 失败:', (err as Error)?.message)
    }
    // 合并文本层(标题等)+OCR结果，去重取更长者
    const merged = ocr.length > text.length ? ocr : text
    if (!merged) throw new Error('该PDF既无文本层，OCR也未识别到文字（可能是纯图形或网关未配置）。')
    return merged
  }
  if (t.includes('png') || t.includes('jpg') || t.includes('jpeg') || t.includes('webp') || t.includes('image') || t.includes('gif') || t.includes('bmp')) {
    const mime = t.includes('jpg') || t.includes('jpeg') ? 'image/jpeg' : t.includes('webp') ? 'image/webp' : 'image/png'
    const text = await ocrImage(buffer, mime)
    if (!text) throw new Error('图片OCR未识别到文字（可能是纯图形/网关未配置）。')
    return text
  }
  if (isText) {
    return normalizeUnicodeText(decodeTextBuffer(buffer).text).trim()
  }
  if (isDoc) {
    const r = await mammoth.extractRawText({ buffer })
    return (r.value || '').trim()
  }
  if (isExcel) {
    // 老式二进制 .xls (application/vnd.ms-excel) 不是 zip，exceljs 的 xlsx.load 读不了 → 用 SheetJS 兜底
    const tryExcelJs = async (): Promise<string> => {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buffer as unknown as ArrayBuffer)
      const out: string[] = []
      wb.eachSheet((ws) => {
        out.push(`# ${ws.name}`)
        ws.eachRow((row) => {
          const vals = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(typeof v === 'object' && v && 'text' in (v as object) ? (v as { text: unknown }).text : v)))
          if (vals.some((x) => x.trim())) out.push(vals.join('\t'))
        })
      })
      return out.join('\n').trim()
    }
    const trySheetJs = async (): Promise<string> => {
      const XLSX = (await import('xlsx')).default as typeof import('xlsx')
      const wb = XLSX.read(buffer, { type: 'buffer' })
      const out: string[] = []
      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName]
        if (!ws) continue
        out.push(`# ${sheetName}`)
        const csv = XLSX.utils.sheet_to_csv(ws)
        if (csv.trim()) out.push(csv.trim())
      }
      return out.join('\n').trim()
    }
    if (isLegacyXls) {
      // 老 xls 优先 SheetJS；失败再尝试 exceljs
      try { return await trySheetJs() }
      catch { return await tryExcelJs() }
    }
    // xlsx(新) 优先 exceljs；失败(极少)再尝试 SheetJS
    try { return await tryExcelJs() }
    catch { return await trySheetJs() }
  }
  if (isPpt) {
    // pptx = zip，抽每张 slide 的 <a:t> 文本
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(buffer)
    const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()
    const out: string[] = []
    for (const name of slideNames) {
      const xml = await zip.files[name].async('string')
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).filter(Boolean)
      if (texts.length) out.push(texts.join(' '))
    }
    return out.join('\n').trim()
  }
  throw new Error(`暂不支持提取该类型正文：${t}（当前支持 PDF/DOCX/TXT/MD/CSV/HTML/XLSX/PPTX；音视频请用转录入库）`)
}

// ---------- 切块（按段落聚合到 ~500 字） ----------
export function chunkText(text: string, target = 500): string[] {
  const paras = text.split(/\n{2,}|\r\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const chunks: string[] = []
  let buf = ''
  for (const p of paras) {
    if ((buf + p).length > target && buf) { chunks.push(buf.trim()); buf = '' }
    buf += (buf ? '\n' : '') + p
    while (buf.length > target * 2) { chunks.push(buf.slice(0, target * 2).trim()); buf = buf.slice(target * 2) }
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks.length ? chunks : (text.trim() ? [text.trim().slice(0, target * 2)] : [])
}

// ---------- 提取 + 切块 + 入库 ----------
// 判定错误是否值得重试：瞬时错误(OCR网关抖动/超时/网络/EADDR/ECONN 等)重试有意义；
// 确定性错误(不支持的类型/未提取到文字/损坏结构)重试也是同样结果，直接失败不浪费。
function isRetryableIngestError(msg: string): boolean {
  if (/暂不支持提取该类型|未能从文件中提取到任何文字|OCR未识别|既无文本层/.test(msg)) return false
  if (/timeout|超时|ECONN|ETIMEDOUT|ENETUNREACH|socket hang up|network|fetch failed|OCR网关|502|503|504|429/i.test(msg)) return true
  // 其余未知错误默认重试一次(可能是瞬时 DB/依赖抖动)
  return true
}

const INGEST_MAX_ATTEMPTS = Number(process.env.INGEST_MAX_ATTEMPTS ?? 3)  // 首次 + 2 次重试

export async function ingestFile(fileId: string, projectId: string, fileName: string, buffer: Buffer, type: string) {
  const t0 = Date.now()
  const tag = `[ingestFile] id=${fileId} name=${fileName} type=${type} size=${(buffer.length / 1024).toFixed(0)}KB`
  let lastErr = ''
  for (let attempt = 1; attempt <= INGEST_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) console.log(`${tag} 重试第 ${attempt - 1} 次…`)
      const text = await extractText(buffer, type, fileName)
      if (!text) throw new Error('未能从文件中提取到任何文字（可能是扫描件图片，需 OCR）')
      const chunks = chunkText(text)
      await db.delete(fileChunks).where(eq(fileChunks.fileId, fileId))
      if (chunks.length) {
        await db.insert(fileChunks).values(chunks.map((content, i) => ({ fileId, projectId, fileName, chunkIndex: i, content })))
      }
      await db.update(projectFiles).set({ parseStatus: '成功', contentText: text.slice(0, 200000), parseError: null }).where(eq(projectFiles.id, fileId))
      // 双写统一知识库（scope=project）
      try { await ingestToKnowledge({ scope: 'project', refId: projectId, sourceType: 'file', sourceId: fileId, sourceName: fileName, text }) } catch (ke) { console.warn(`${tag} 知识库双写失败(不阻断): ${(ke as Error).message}`) }
      console.log(`${tag} ✅ 解析成功 attempt=${attempt} chars=${text.length} chunks=${chunks.length} 耗时=${Date.now() - t0}ms`)
      return { ok: true, chars: text.length, chunks: chunks.length }
    } catch (e) {
      lastErr = (e as Error).message
      const retryable = isRetryableIngestError(lastErr)
      console.error(`${tag} ❌ 解析失败 attempt=${attempt}/${INGEST_MAX_ATTEMPTS} retryable=${retryable} err=${lastErr}`)
      if (!retryable || attempt >= INGEST_MAX_ATTEMPTS) break
      // 指数退避：1s、2s
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  // 全部尝试用尽，落失败态
  await db.update(projectFiles).set({ parseStatus: '失败', parseError: lastErr }).where(eq(projectFiles.id, fileId))
  console.error(`${tag} ☠ 最终失败 已试 ${INGEST_MAX_ATTEMPTS} 次 耗时=${Date.now() - t0}ms err=${lastErr}`)
  return { ok: false, error: lastErr }
}

// ---------- 检索（中文友好的关键词打分，无需 embedding） ----------
function tokenize(q: string): string[] {
  // 抽中文 2-gram + 英文/数字词，去停用词
  const stop = new Set(['的','了','是','在','和','与','这个','那个','什么','如何','怎么','项目','公司','请','帮我','一下','有哪些','吗','呢'])
  const cn = q.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const grams: string[] = []
  for (const seg of cn) {
    if (seg.length <= 3) grams.push(seg)
    else for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2))
  }
  const en = (q.toLowerCase().match(/[a-z0-9]{2,}/g) || [])
  return [...new Set([...grams, ...en])].filter((t) => !stop.has(t))
}

export async function retrieve(projectId: string, question: string, topK = 5) {
  const rows = await db.select().from(fileChunks).where(eq(fileChunks.projectId, projectId))
  if (!rows.length) return []
  const terms = tokenize(question)
  if (!terms.length) return []
  const scored = rows.map((r) => {
    const content = r.content
    const lc = content.toLowerCase()
    let score = 0
    for (const t of terms) {
      let idx = 0, c = 0
      const hay = /[a-z0-9]/.test(t) ? lc : content
      while ((idx = hay.indexOf(t, idx)) !== -1) { c++; idx += t.length; if (c > 20) break }
      score += c
    }
    return { ...r, score }
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, topK)
  return scored
}

// 列出某项目已成功解析、可检索的文件
export async function listIndexedFiles(projectId: string) {
  const rows = await db.select().from(projectFiles).where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.parseStatus, '成功')))
  return rows
}


// ========== 统一知识库 RAG（scope: project|lead|org） ==========

// 统一入库：任意来源(文件/纪要/线索画像/音视频转录)切块写入 knowledge_chunks
export async function ingestToKnowledge(opts: {
  scope: 'project' | 'lead' | 'org'
  refId: string
  sourceType: string
  sourceId?: string
  sourceName?: string
  text: string
}) {
  const { scope, refId, sourceType, sourceId, sourceName = '', text } = opts
  const chunks = chunkText(text || '')
  // 先删同源旧块（幂等重入）
  if (sourceId) {
    await db.delete(knowledgeChunks).where(and(eq(knowledgeChunks.scope, scope), eq(knowledgeChunks.refId, refId), eq(knowledgeChunks.sourceId, sourceId)))
  }
  if (chunks.length) {
    await db.insert(knowledgeChunks).values(chunks.map((content, i) => ({ scope, refId, sourceType, sourceId: sourceId ?? null, sourceName, chunkIndex: i, content })))
  }
  return { chunks: chunks.length }
}

// 多 scope 检索：scope + refId(可选，lead池比对时传空查全部线索)
export async function retrieveKnowledge(scope: 'project' | 'lead' | 'org', refId: string | undefined, question: string, topK = 5) {
  const where = refId
    ? and(eq(knowledgeChunks.scope, scope), eq(knowledgeChunks.refId, refId))
    : eq(knowledgeChunks.scope, scope)
  const rows = await db.select().from(knowledgeChunks).where(where)
  if (!rows.length) return []
  const terms = tokenize(question)
  if (!terms.length) return []
  const scored = rows.map((r) => {
    const content = r.content
    const lc = content.toLowerCase()
    let score = 0
    for (const t of terms) {
      let idx = 0, c = 0
      const hay = /[a-z0-9]/.test(t) ? lc : content
      while ((idx = hay.indexOf(t, idx)) !== -1) { c++; idx += t.length; if (c > 20) break }
      score += c
    }
    return {
      fileName: r.sourceName,
      content,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      chunkIndex: r.chunkIndex,
      refId: r.refId,
      score,
    }
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, topK)
  return scored
}
