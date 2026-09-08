import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { EvolutionCandidateManifest } from '../contracts/aiEvolutionEvaluationContract.js'
import { evolutionError } from './aiEvolutionPolicyService.js'

type Artifact = EvolutionCandidateManifest['artifacts'][number]
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex')
const keyPattern = /^([a-f0-9-]{36})\/([a-f0-9]{64})\.bin$/

/** Only the host writes this directory. No candidate container ever receives a mount to it. */
export class AiEvolutionArtifactStore {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('Evolution artifact root must be absolute')
  }

  private async taskDirectory(runId: string, create: boolean) {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw evolutionError(400, 'EVOLUTION_ARTIFACT_KEY', '产物任务标识无效')
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    const root = await realpath(this.root)
    const dir = path.join(root, runId)
    if (create) await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw evolutionError(403, 'EVOLUTION_ARTIFACT_PATH', '产物目录不安全')
    return dir
  }

  async put(runId: string, content: Buffer, kind: Artifact['kind']): Promise<Artifact> {
    if (content.length > 128 * 1024 * 1024) throw evolutionError(413, 'EVOLUTION_ARTIFACT_LIMIT', '单个产物超出大小限制')
    const sha256 = hash(content)
    const dir = await this.taskDirectory(runId, true)
    const file = path.join(dir, `${sha256}.bin`)
    const temporary = path.join(dir, `${randomUUID()}.tmp`)
    const artifact = { storageKey: `${runId}/${sha256}.bin`, sha256, bytes: content.length, kind }
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      // Atomic no-overwrite publication: concurrent readers never observe a partial final file.
      await link(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Existing content-addressed files must be intact; never overwrite corruption.
      await this.read(runId, artifact)
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
    return artifact
  }

  async read(runId: string, artifact: Artifact): Promise<Buffer> {
    const match = keyPattern.exec(artifact.storageKey)
    if (!match || match[1] !== runId || match[2] !== artifact.sha256 || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 0 || artifact.bytes > 128 * 1024 * 1024) throw evolutionError(403, 'EVOLUTION_ARTIFACT_KEY', '产物与任务或哈希不匹配')
    const dir = await this.taskDirectory(runId, false)
    const file = path.join(dir, `${artifact.sha256}.bin`)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '产物大小或类型异常')
    const handle = await open(file, 'r')
    try {
      const opened = await handle.stat()
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== artifact.bytes) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '产物读取期间发生变化')
      const content = await handle.readFile()
      if (hash(content) !== artifact.sha256) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '产物哈希校验失败')
      return content
    } finally { await handle.close() }
  }

  async verifyManifest(runId: string, manifest: EvolutionCandidateManifest): Promise<void> {
    if (!manifest.artifacts.length || manifest.artifacts.length > 5000
      || new Set(manifest.artifacts.map((item) => item.storageKey)).size !== manifest.artifacts.length) {
      throw evolutionError(409, 'EVOLUTION_ARTIFACTS_INCOMPLETE', '产物清单为空、重复或超出限制')
    }
    // Sequential reads bound memory even when a manifest contains large build outputs.
    for (const artifact of manifest.artifacts) await this.read(runId, artifact)
  }
}
