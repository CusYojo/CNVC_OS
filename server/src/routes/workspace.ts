import { Router } from 'express'
import { promises as fs, createReadStream, existsSync, mkdirSync } from 'node:fs'
import { resolve, sep, extname, relative } from 'node:path'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { getConversation, listConversations } from '../services/conversationService.js'
import { createHash } from 'node:crypto'
import { writeAudit } from '../services/auditService.js'

// 只读工作区浏览：把 assistant 沙箱工作目录(AGENT_WORKSPACE)以文件树 + 预览暴露给前端，
// 让 agent 生成的 PPT/图片/PDF/HTML 直接在页面右侧空白区查看，无需经 OSS 中转。
// 挂在 /api 鉴权网关之后，仅当前登录用户可访问；严格限制在 ROOT 之内，防目录穿越。
const configuredRoot = resolve(process.env.AGENT_WORKSPACE ?? '/data/cybernaut-assistant/workspace')
// 分发包的 .env 通常保留 Linux 生产路径。本地开发时该路径不存在，回退到项目内目录，
// 避免工作区首页因根目录缺失直接返回 404；生产环境仍严格使用显式配置。
const ROOT = process.env.NODE_ENV !== 'production' && !existsSync(configuredRoot)
  ? resolve(process.cwd(), 'server/workspace')
  : configuredRoot

// 根目录本身应始终可浏览（空目录返回 entries: []），上传接口也可直接在其下建目录。
mkdirSync(ROOT, { recursive: true })

// 噪声目录/文件不进文件树
const IGNORE = new Set([
  'node_modules', '.git', '.agents', '.next', 'dist', 'build', '__pycache__',
  '.cache', '.pytest_cache', '.mypy_cache', '.venv', 'venv', 'target', '.DS_Store',
])

// 只展示“结果/交付物”：图片/文档/PPT/表格/网页/媒体/压缩包。
// 中间产物(脚本、临时/测试文本、日志、json/yaml 等)不进文件树。目录仍保留以便下钻。
const RESULT_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.pdf', '.pptx', '.docx', '.xlsx', '.csv', '.html', '.htm', '.md', '.markdown',
  '.mp4', '.mp3', '.wav', '.zip',
])

// 上传文件是用户输入，不是 AI 生成产物；右侧“产物面板”不应混入这些目录。
// 这里不按猜测屏蔽 preview/out 等目录，避免误伤 Agent 真正的交付文件。
const ARTIFACT_IGNORE_DIRS = new Set([...IGNORE, 'uploads'])
const MAX_ARTIFACT_DEPTH = 8
const MAX_ARTIFACT_SCAN = 2_000
const MAX_ARTIFACT_RESULTS = 200

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
}

// 把用户传入的相对路径安全解析到 ROOT 之内；越界返回 null
function safeResolveFrom(root: string, rel: string): string | null {
  const clean = String(rel ?? '').replace(/^[/\\]+/, '')
  const abs = resolve(root, clean)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

function privateRoot(userId: string) {
  return resolve(ROOT, '_users', userId)
}

async function resolveAuthorizedPath(userId: string, rel: string): Promise<string | null> {
  const clean = String(rel ?? '').replace(/^[/\\]+/, '').split(sep).join('/')
  const [scope, ...rest] = clean.split('/').filter(Boolean)
  if (!scope) return null
  let scopeRoot: string
  if (scope === 'private') scopeRoot = privateRoot(userId)
  else {
    if (!(await getConversation(userId, scope))) return null
    scopeRoot = resolve(ROOT, scope)
  }
  const candidate = safeResolveFrom(scopeRoot, rest.join('/'))
  if (!candidate) return null
  // 现有文件/目录必须在 realpath 后仍留在授权会话根内，拒绝通过符号链接跳到其他用户或系统目录。
  const [realScope, realCandidate] = await Promise.all([
    fs.realpath(scopeRoot).catch(() => scopeRoot),
    fs.realpath(candidate).catch(() => null),
  ])
  if (realCandidate && realCandidate !== realScope && !realCandidate.startsWith(realScope + sep)) return null
  return candidate
}

export const workspaceRouter = Router()

type ArtifactEntry = {
  name: string
  path: string
  type: 'file'
  size: number
  mtime: number
  ext: string
}

// 递归收集交付物文件，向前端返回扁平列表。这样右侧不再承担通用文件管理器职责，
// 同时保留预览、下载、刷新所需的路径和元数据。
async function collectArtifacts(
  absDir: string,
  depth: number,
  entries: ArtifactEntry[],
  scanned: { count: number },
): Promise<void> {
  if (depth > MAX_ARTIFACT_DEPTH || scanned.count >= MAX_ARTIFACT_SCAN) return
  const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => [])
  for (const dirent of dirents) {
    if (scanned.count >= MAX_ARTIFACT_SCAN) break
    if (dirent.name.startsWith('.') || ARTIFACT_IGNORE_DIRS.has(dirent.name)) continue
    scanned.count += 1

    const childAbs = resolve(absDir, dirent.name)
    if (dirent.isDirectory()) {
      await collectArtifacts(childAbs, depth + 1, entries, scanned)
      continue
    }
    if (!dirent.isFile()) continue
    const ext = extname(dirent.name).toLowerCase()
    if (!RESULT_EXTS.has(ext)) continue
    const st = await fs.stat(childAbs).catch(() => null)
    if (!st?.isFile()) continue
    entries.push({
      name: dirent.name,
      path: relative(ROOT, childAbs).split(sep).join('/'),
      type: 'file',
      size: st.size,
      mtime: st.mtimeMs,
      ext,
    })
  }
}

// 列目录：GET /api/workspace?path=<相对路径>
workspaceRouter.get('/', async (req: AuthedRequest, res, next) => {
  try {
    const relPath = String(req.query.path ?? '')
    if (!relPath) {
      const conversations = await listConversations(req.user!.uid)
      const entries = await Promise.all(conversations.map(async (conversation) => {
        const abs = resolve(ROOT, conversation.id)
        const st = await fs.stat(abs).catch(() => null)
        return {
          name: conversation.title || conversation.id,
          path: conversation.id,
          type: 'dir' as const,
          size: 0,
          mtime: st?.mtimeMs ?? 0,
          ext: '',
        }
      }))
      res.json({ path: '', parent: null, entries })
      return
    }
    const abs = await resolveAuthorizedPath(req.user!.uid, relPath)
    if (!abs) return res.status(404).json({ code: 'NOT_FOUND', message: '目录不存在或无权访问' })
    const st = await fs.stat(abs).catch(() => null)
    if (!st || !st.isDirectory()) return res.status(404).json({ code: 'NOT_FOUND', message: '目录不存在' })

    const dirents = await fs.readdir(abs, { withFileTypes: true })
    const entries = await Promise.all(
      dirents
        .filter((d) => {
          if (IGNORE.has(d.name) || d.name.startsWith('.')) return false
          if (d.isDirectory()) return true
          return RESULT_EXTS.has(extname(d.name).toLowerCase())
        })
        .map(async (d) => {
          const childAbs = resolve(abs, d.name)
          const cst = await fs.stat(childAbs).catch(() => null)
          const isDir = d.isDirectory()
          return {
            name: d.name,
            path: [relPath.replace(/[/\\]+$/, ''), d.name].filter(Boolean).join('/'),
            type: isDir ? 'dir' : 'file',
            size: cst && !isDir ? cst.size : 0,
            mtime: cst ? cst.mtimeMs : 0,
            ext: isDir ? '' : extname(d.name).toLowerCase(),
          }
        }),
    )
    entries.sort((a, b) =>
      a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : b.mtime - a.mtime || a.name.localeCompare(b.name),
    )

    const here = relPath.replace(/^[/\\]+/, '').split(sep).join('/')
    const parent = here.includes('/') ? here.slice(0, here.lastIndexOf('/')) : ''
    res.json({ path: here, parent, entries })
  } catch (err) {
    next(err)
  }
})

// 生成产物列表：GET /api/workspace/artifacts
// 仅返回可预览/下载的文件，过滤上传输入和所有空目录，并按最近生成时间排序。
workspaceRouter.get('/artifacts', async (req: AuthedRequest, res, next) => {
  try {
    const entries: ArtifactEntry[] = []
    const scanned = { count: 0 }
    const conversations = await listConversations(req.user!.uid)
    for (const conversation of conversations) {
      const conversationRoot = resolve(ROOT, conversation.id)
      const st = await fs.stat(conversationRoot).catch(() => null)
      if (st?.isDirectory()) await collectArtifacts(conversationRoot, 0, entries, scanned)
    }
    entries.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    const limited = entries.slice(0, MAX_ARTIFACT_RESULTS)
    res.json({
      entries: limited,
      total: entries.length,
      truncated: entries.length > limited.length || scanned.count >= MAX_ARTIFACT_SCAN,
    })
  } catch (err) {
    next(err)
  }
})

// 读文件/预览：GET /api/workspace/file?path=<相对路径>[&download=1]
workspaceRouter.get('/file', async (req: AuthedRequest, res, next) => {
  try {
    const abs = await resolveAuthorizedPath(req.user!.uid, String(req.query.path ?? ''))
    if (!abs) return res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在或无权访问' })
    const st = await fs.stat(abs).catch(() => null)
    if (!st || !st.isFile()) return res.status(404).json({ code: 'NOT_FOUND', message: '文件不存在' })

    const ext = extname(abs).toLowerCase()
    const type = MIME[ext] ?? 'application/octet-stream'
    const name = abs.split(sep).pop() ?? 'file'
    const download = String(req.query.download ?? '') === '1'
    const pathHash = createHash('sha256').update(relative(ROOT, abs)).digest('hex')
    await writeAudit({
      userId: req.user!.uid, userName: req.user!.name, module: 'Agent 工作区',
      action: download ? '下载Agent产物' : '预览Agent产物',
      target: `workspace-file:${pathHash};bytes:${st.size}`,
      ip: req.ip,
    })
    res.setHeader('Content-Type', type)
    res.setHeader('Content-Length', String(st.size))
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    )
    createReadStream(abs).pipe(res)
  } catch (err) {
    next(err)
  }
})

// 把文件名清洗成安全的单段名（去路径分隔符/控制字符/首尾点），空则给默认名
function safeName(raw: string): string {
  const base = String(raw ?? '').split(/[/\\]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/^\.+/, '').trim()
  return clean || `file-${Date.now()}`
}

// 写入上传：POST /api/workspace/file  { name, dataBase64, subdir? }
// 把用户在 AI 助手页上传的文件落进 assistant 沙箱工作目录的 uploads/<subdir>/ 下，
// 使 agent 能用 read/bash 直接读取（配合 pdf / spreadsheet 技能）。返回相对沙箱路径。
workspaceRouter.post('/file', async (req: AuthedRequest, res, next) => {
  try {
    const { name, dataBase64, subdir } = (req.body ?? {}) as { name?: string; dataBase64?: string; subdir?: string }
    if (!dataBase64 || typeof dataBase64 !== 'string') return res.status(400).json({ code: 'BAD_REQUEST', message: '缺少 dataBase64' })
    // 允许带 data URL 前缀（data:...;base64,xxxx）
    const b64 = dataBase64.includes(',') ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64
    const buffer = Buffer.from(b64, 'base64')
    if (!buffer.length) return res.status(400).json({ code: 'BAD_REQUEST', message: '文件内容为空或非法 base64' })

    // 目标目录固定在 uploads/ 之下（subdir 仅取安全单段，如会话id）
    const userId = req.user!.uid
    const sub = subdir ? safeName(subdir) : ''
    if (sub && !(await getConversation(userId, sub))) {
      return res.status(403).json({ code: 'CONVERSATION_FORBIDDEN', message: '会话不存在或无权访问' })
    }
    const dirAbs = sub
      ? safeResolveFrom(resolve(ROOT, sub), 'uploads')
      : safeResolveFrom(privateRoot(userId), 'uploads')
    if (!dirAbs) return res.status(400).json({ code: 'BAD_PATH', message: '非法目标目录' })
    await fs.mkdir(dirAbs, { recursive: true })

    // 同名则加时间戳后缀避免覆盖
    let fname = safeName(name ?? '')
    let absFile = resolve(dirAbs, fname)
    if (await fs.stat(absFile).then(() => true).catch(() => false)) {
      const ext = extname(fname)
      fname = `${fname.slice(0, fname.length - ext.length)}-${Date.now()}${ext}`
      absFile = resolve(dirAbs, fname)
    }
    if (!absFile.startsWith(ROOT + sep)) return res.status(400).json({ code: 'BAD_PATH', message: '越界路径' })
    await fs.writeFile(absFile, buffer)

    const relPath = sub
      ? relative(ROOT, absFile).split(sep).join('/')
      : `private/${relative(privateRoot(userId), absFile).split(sep).join('/')}`
    res.status(201).json({ code: 0, message: 'success', path: relPath, name: fname, size: buffer.length })
  } catch (err) {
    next(err)
  }
})
