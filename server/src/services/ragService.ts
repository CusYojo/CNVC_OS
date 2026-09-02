import { and, eq, inArray, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db } from '../db/client.js'
import { projectFiles, fileChunks, knowledgeChunks } from '../db/schema.js'
import mammoth from 'mammoth'
import { decodeTextBuffer, inspectTextQuality, normalizeUnicodeText, readableStoredText } from './textQualityService.js'
import { requestAiGatewayVisionText } from './aiGatewayService.js'
import { readProjectFileBuffer } from './projectFileStorageService.js'
import { fileKnowledgeAccessCondition, projectFileAccessCondition } from './projectFileAccessService.js'

// 通过 18081 网关多模态模型 OCR：读图片/扫描件，返回其中文字。用于图片文件与图片型PDF。
const GW_BASE = (process.env.OPENAI_BASE_URL || 'http://127.0.0.1:18081/v1').replace(/\/$/, '')
const GW_KEY = process.env.GATEWAY_IMAGE_API_KEY || process.env.OPENAI_API_KEY || ''
const OCR_MODEL = process.env.OCR_VISION_MODEL || 'gemini-3.1-pro-preview'
async function ocrImage(buffer: Buffer, mime = 'image/png'): Promise<string> {
  if (!GW_KEY) return ''
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
  return requestAiGatewayVisionText({
    baseUrl: GW_BASE,
    apiKey: GW_KEY,
    model: OCR_MODEL,
    prompt: '请把这张图片中的所有文字（含表格、图注、标题）按阅读顺序完整转写成纯文本；无文字则回复空。只输出文字本身，不要解释。',
    imageDataUrls: [dataUrl],
    maxTokens: 4000,
    timeoutMs: 120_000,
  })
}

// 图片型/扫描PDF：pdftoppm 逐页转PNG → 每页走网关OCR → 合并文本
async function pdfOcrPages(buffer: Buffer, maxPages = 30): Promise<string> {
  const { execFileSupervised } = await import('../runtime/supervisedProcessService.js')
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfocr-'))
  try {
    const pdfPath = path.join(dir, 'in.pdf')
    await fs.writeFile(pdfPath, buffer)
    // 转 PNG，150dpi，前 maxPages 页
    await execFileSupervised('pdftoppm', ['-png', '-r', '150', '-l', String(maxPages), pdfPath, path.join(dir, 'p')], { timeout: 120000 })
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
export function isRetryableIngestError(msg: string): boolean {
  if (msg.includes('FILE_SOURCE_CHANGED')) return false
  if (/暂不支持提取该类型|未能从文件中提取到任何文字|OCR未识别|既无文本层/.test(msg)) return false
  if (/data too long|ER_DATA_TOO_LONG|value too long|数据过长|1406/i.test(msg)) return false
  if (/timeout|超时|ECONN|ETIMEDOUT|ENETUNREACH|socket hang up|network|fetch failed|OCR网关|502|503|504|429/i.test(msg)) return true
  // 其余未知错误默认重试一次(可能是瞬时 DB/依赖抖动)
  return true
}

const INGEST_MAX_ATTEMPTS = Number(process.env.INGEST_MAX_ATTEMPTS ?? 3)  // 首次 + 2 次重试
const INGEST_ERROR_MAX_CHARS = 2_000

export function summarizeIngestError(error: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error && current.message) messages.push(current.message)
    if (typeof current === 'object' && current && 'cause' in current) {
      current = (current as { cause?: unknown }).cause
    } else {
      break
    }
  }
  // Drizzle 的外层错误会包含完整 SQL 参数，正文可能被原样写进日志和 parse_error。
  // 优先取最深层数据库根因；没有 cause 时也剥离 params 段并限制到安全长度。
  const raw = messages.at(-1) || (typeof error === 'string' ? error : '未知解析错误')
  const compact = raw.replace(/\s*params:[\s\S]*$/i, '').replace(/\s+/g, ' ').trim()
  return (compact || '未知解析错误').slice(0, INGEST_ERROR_MAX_CHARS)
}

export async function ingestFile(fileId: string, projectId: string, fileName: string, buffer: Buffer, type: string) {
  const sourceHash = createHash('sha256').update(buffer).digest('hex')
  const t0 = Date.now()
  const tag = `[ingestFile] id=${fileId} name=${fileName} type=${type} size=${(buffer.length / 1024).toFixed(0)}KB`
  let lastErr = ''
  let attempts = 0
  for (let attempt = 1; attempt <= INGEST_MAX_ATTEMPTS; attempt++) {
    attempts = attempt
    try {
      if (attempt > 1) console.log(`${tag} 重试第 ${attempt - 1} 次…`)
      const extractedText = await extractText(buffer, type, fileName)
      if (!extractedText) throw new Error('未能从文件中提取到任何文字（可能是扫描件图片，需 OCR）')
      const quality = inspectTextQuality(extractedText)
      if (quality.corrupted) throw new Error('文件正文存在无法识别的文字，请重新导出原文件后上传')
      const text = quality.text.trim()
      const chunks = chunkText(text)
      // 文件分块、统一知识分块和解析成功状态必须同时提交。任何一步失败都回滚，
      // 避免页面显示“解析成功”但 Agent 实际检索不到文件内容。
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT ${projectFiles.id} FROM ${projectFiles} WHERE ${projectFiles.id}=${fileId} FOR UPDATE`)
        const [current] = await tx.select().from(projectFiles).where(eq(projectFiles.id, fileId))
        if (!current || current.projectId !== projectId || current.lifecycle !== 'active' || current.sha256 && current.sha256 !== sourceHash) throw new Error('FILE_SOURCE_CHANGED: 文件已删除或内容版本已变化，本次旧解析结果不保存')
        await tx.delete(fileChunks).where(eq(fileChunks.fileId, fileId))
        if (chunks.length) {
          await tx.insert(fileChunks).values(chunks.map((content, i) => ({ fileId, projectId, fileName, chunkIndex: i, content })))
        }
        await tx.delete(knowledgeChunks).where(and(
          eq(knowledgeChunks.scope, 'project'),
          eq(knowledgeChunks.refId, projectId),
          eq(knowledgeChunks.sourceId, fileId),
        ))
        if (chunks.length) {
          await tx.insert(knowledgeChunks).values(chunks.map((content, i) => ({
            scope: 'project', refId: projectId, sourceType: 'file', sourceId: fileId,
            sourceName: fileName, chunkIndex: i, content,
          })))
        }
        await tx.update(projectFiles)
          .set({ parseStatus: '成功', contentText: text.slice(0, 200000), parseError: null })
          .where(eq(projectFiles.id, fileId))
      })
      console.log(`${tag} ✅ 解析成功 attempt=${attempt} chars=${text.length} chunks=${chunks.length} 耗时=${Date.now() - t0}ms`)
      return { ok: true, chars: text.length, chunks: chunks.length }
    } catch (e) {
      lastErr = summarizeIngestError(e)
      const retryable = isRetryableIngestError(lastErr)
      console.error(`${tag} ❌ 解析失败 attempt=${attempt}/${INGEST_MAX_ATTEMPTS} retryable=${retryable} err=${lastErr}`)
      if (!retryable || attempt >= INGEST_MAX_ATTEMPTS) break
      // 指数退避：1s、2s
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  // 全部尝试用尽，落失败态
  if (!lastErr.includes('FILE_SOURCE_CHANGED')) await db.update(projectFiles).set({ parseStatus: '失败', parseError: lastErr }).where(and(eq(projectFiles.id, fileId), eq(projectFiles.lifecycle, 'active'), sql`(${projectFiles.sha256} IS NULL OR ${projectFiles.sha256}=${sourceHash})`))
  console.error(`${tag} ☠ 最终失败 已试 ${attempts} 次 耗时=${Date.now() - t0}ms err=${lastErr}`)
  return { ok: false, error: lastErr }
}

type InterruptedProjectFile = Pick<typeof projectFiles.$inferSelect, 'id' | 'projectId' | 'name' | 'type' | 'storagePath'>

async function recoverInterruptedProjectFileRows(rows: InterruptedProjectFile[]) {
  let recovered = 0
  let failed = 0
  for (const file of rows) {
    try {
      if (!file.storagePath) throw new Error('原始文件不存在，无法在服务重启后继续解析')
      const buffer = await readProjectFileBuffer(file.storagePath)
      const result = await ingestFile(file.id, file.projectId, file.name, buffer, file.type)
      if (result.ok) recovered += 1
      else failed += 1
    } catch (error) {
      const message = summarizeIngestError(error)
      await db.update(projectFiles)
        .set({ parseStatus: '失败', parseError: message })
        .where(and(eq(projectFiles.id, file.id), eq(projectFiles.parseStatus, '解析中')))
      console.error(`[project-file-recovery] id=${file.id} name=${file.name} failed=${message}`)
      failed += 1
    }
  }
  console.log(`[project-file-recovery] completed queued=${rows.length} recovered=${recovered} failed=${failed}`)
}

// HTTP 就绪前固定住待恢复快照，随后后台顺序执行，既避免与新上传竞争，也不让 OCR 阻塞启动健康检查。
export async function scheduleInterruptedProjectFileRecovery(): Promise<number> {
  const rows = await db.select({
    id: projectFiles.id,
    projectId: projectFiles.projectId,
    name: projectFiles.name,
    type: projectFiles.type,
    storagePath: projectFiles.storagePath,
  }).from(projectFiles).where(eq(projectFiles.parseStatus, '解析中'))
  if (!rows.length) return 0
  setImmediate(() => {
    void recoverInterruptedProjectFileRows(rows).catch((error) => {
      console.error(`[project-file-recovery] batch failed=${summarizeIngestError(error)}`)
    })
  })
  return rows.length
}

// ---------- 检索（中文友好的关键词打分，无需 embedding） ----------
function normalizeSearchText(value: string): string {
  return normalizeUnicodeText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenize(q: string): string[] {
  // 抽中文 2-gram + 英文/数字词，去停用词
  const stop = new Set(['的','了','是','在','和','与','这个','那个','什么','如何','怎么','项目','公司','请','帮我','一下','有哪些','吗','呢'])
  const normalized = normalizeSearchText(q)
  const cn = normalized.match(/[\u3400-\u9fff]{2,}/g) || []
  const grams: string[] = []
  for (const seg of cn) {
    if (seg.length <= 3) grams.push(seg)
    else for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2))
  }
  const en = normalized.match(/[a-z0-9]{2,}/g) || []
  return [...new Set([...grams, ...en])].filter((t) => !stop.has(t))
}

function retrievalScore(content: string, sourceName: string, question: string, terms: string[]): number {
  const haystack = normalizeSearchText(`${sourceName}\n${content}`)
  const phrase = normalizeSearchText(question)
  let occurrences = 0
  let matchedTerms = 0
  for (const term of terms) {
    let offset = 0
    let matches = 0
    while ((offset = haystack.indexOf(term, offset)) !== -1) {
      matches += 1
      offset += term.length
      if (matches >= 20) break
    }
    if (matches > 0) matchedTerms += 1
    occurrences += matches
  }
  const exactPhraseBonus = phrase.length >= 2 && haystack.includes(phrase) ? 24 : 0
  return occurrences * 4 + matchedTerms * 8 + exactPhraseBonus
}

function compareRetrievalRows(
  left: { score: number; sourceName: string; chunkIndex: number; id: string },
  right: { score: number; sourceName: string; chunkIndex: number; id: string },
): number {
  if (left.score !== right.score) return right.score - left.score
  if (left.sourceName !== right.sourceName) return left.sourceName < right.sourceName ? -1 : 1
  if (left.chunkIndex !== right.chunkIndex) return left.chunkIndex - right.chunkIndex
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export async function retrieve(projectId: string, question: string, topK = 5, userId?: string) {
  const rows = await db.select().from(fileChunks).where(and(eq(fileChunks.projectId, projectId), inArray(fileChunks.fileId, db.select({ id: projectFiles.id }).from(projectFiles).where(userId ? projectFileAccessCondition(userId) : and(eq(projectFiles.lifecycle, 'active'), eq(projectFiles.accessMode, 'project'))))))
  if (!rows.length) return []
  const terms = tokenize(question)
  if (!terms.length) return []
  const scored = rows.map((r) => {
    const content = readableStoredText(r.content)
    return { ...r, content, sourceName: r.fileName, score: content ? retrievalScore(content, r.fileName, question, terms) : 0 }
  }).filter((r) => r.score > 0).sort(compareRetrievalRows).slice(0, topK)
  return scored.map(({ sourceName: _sourceName, ...row }) => row)
}

// 列出某项目已成功解析、可检索的文件
export async function listIndexedFiles(projectId: string, userId?: string) {
  const rows = await db.select().from(projectFiles).where(and(eq(projectFiles.projectId, projectId), eq(projectFiles.parseStatus, '成功'), userId ? projectFileAccessCondition(userId) : and(eq(projectFiles.lifecycle, 'active'), eq(projectFiles.accessMode, 'project'))))
  return rows
}


// ========== 统一知识库 RAG（scope: project|lead|org） ==========

// 统一入库：任意来源(文件/纪要/线索画像/音视频转录)切块写入 knowledge_chunks
export async function ingestToKnowledge(opts: {
  scope: 'project' | 'lead' | 'org'
  refId: string
  sourceType: string
  sourceId: string
  sourceName?: string
  text: string
}) {
  const { scope, refId, sourceType, sourceId, sourceName = '', text } = opts
  const chunks = chunkText(text || '')
  // 删除旧投影与写入新投影必须原子提交。若新内容违反约束，旧的可检索版本继续保留。
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeChunks).where(and(
      eq(knowledgeChunks.scope, scope),
      eq(knowledgeChunks.refId, refId),
      eq(knowledgeChunks.sourceId, sourceId),
    ))
    if (chunks.length) {
      await tx.insert(knowledgeChunks).values(chunks.map((content, i) => ({
        scope, refId, sourceType, sourceId, sourceName, chunkIndex: i, content,
      })))
    }
  })
  return { chunks: chunks.length }
}

// 多 scope 检索：scope + refId(可选，lead池比对时传空查全部线索)
export async function retrieveKnowledge(scope: 'project' | 'lead' | 'org', refId: string | undefined, question: string, topK = 5, userId?: string) {
  const where = refId
    ? and(eq(knowledgeChunks.scope, scope), eq(knowledgeChunks.refId, refId))
    : eq(knowledgeChunks.scope, scope)
  const rows = await db.select().from(knowledgeChunks).where(and(where, scope === 'lead' ? undefined : fileKnowledgeAccessCondition(userId)))
  if (!rows.length) return []
  const terms = tokenize(question)
  if (!terms.length) return []
  const scored = rows.map((r) => {
    const content = readableStoredText(r.content)
    return {
      id: r.id,
      fileName: r.sourceName,
      content,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      chunkIndex: r.chunkIndex,
      refId: r.refId,
      sourceName: r.sourceName,
      score: content ? retrievalScore(content, r.sourceName, question, terms) : 0,
    }
  }).filter((r) => r.score > 0).sort(compareRetrievalRows).slice(0, topK)
  return scored.map(({ id: _id, sourceName: _sourceName, ...row }) => row)
}
