import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { evolutionError, type EvolutionLeaseIdentity } from '../../services/aiEvolutionPolicyService.js'
import type { EvolutionSourceSnapshot } from './evolutionSourceSnapshot.js'
import { safeEvolutionSourcePath } from './evolutionSourceSnapshot.js'

export const EVOLUTION_NODE_IMAGE = 'node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5'
type DockerResult = { stdout: string; stderr: string; exitCode: number }
export type DockerCommand = (args: string[], timeoutMs: number, input?: Buffer) => Promise<DockerResult>

export const runDockerCommand: DockerCommand = (args, timeoutMs, input) => new Promise((resolve, reject) => {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key]
  const child = spawn('docker', args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => { /* Docker exit/error is handled below. */ })
  child.stdin.end(input)
  let stdout = '', stderr = '', exceeded = false
  const timer = setTimeout(() => { child.kill(); reject(evolutionError(504, 'EVOLUTION_DOCKER_TIMEOUT', '容器管理命令超时，需核对容器状态')) }, timeoutMs)
  const collect = (kind: 'stdout' | 'stderr', bytes: Buffer) => {
    if (stdout.length + stderr.length + bytes.length > 512_000) {
      exceeded = true; child.kill(); return
    }
    if (kind === 'stdout') stdout += bytes.toString('utf8'); else stderr += bytes.toString('utf8')
  }
  child.stdout.on('data', (bytes: Buffer) => collect('stdout', bytes))
  child.stderr.on('data', (bytes: Buffer) => collect('stderr', bytes))
  child.once('error', (error) => { clearTimeout(timer); reject(error) })
  child.once('close', (exitCode) => {
    clearTimeout(timer)
    if (exceeded) reject(evolutionError(413, 'EVOLUTION_OUTPUT_LIMIT', '执行输出超过上限'))
    else resolve({ stdout, stderr, exitCode: exitCode ?? -1 })
  })
})

function containerName(identity: EvolutionLeaseIdentity) {
  if (!/^[a-f0-9-]{36}$/.test(identity.runId) || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1
    || !Number.isSafeInteger(identity.leaseToken) || identity.leaseToken < 1 || !/^[a-f0-9]{64}$/.test(identity.inputHash)) {
    throw evolutionError(400, 'EVOLUTION_INVALID_ENVIRONMENT_ID', '任务环境标识无效')
  }
  return `sbl-evo-${identity.runId}-${identity.attempt}-${identity.leaseToken}`
}

export class DockerEvolutionEnvironment {
  constructor(private readonly command: DockerCommand = runDockerCommand, private readonly image = EVOLUTION_NODE_IMAGE) {
    if (!/^(?:[a-zA-Z0-9_./:-]+@)?sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Evolution image must be immutable')
  }

  async available() {
    const info = await this.command(['info', '--format', '{{.OSType}}'], 10_000)
    if (info.exitCode !== 0 || info.stdout.trim() !== 'linux') return false
    const image = await this.command(['image', 'inspect', this.image, '--format', '{{.Id}}'], 10_000)
    return image.exitCode === 0 && image.stdout.trim().startsWith('sha256:')
  }

  async create(identity: EvolutionLeaseIdentity) {
    const name = containerName(identity)
    const result = await this.command([
      'create', '--name', name, '--label', `sbl.evolution.run=${identity.runId}`,
      '--label', `sbl.evolution.attempt=${identity.attempt}`, '--label', `sbl.evolution.lease=${identity.leaseToken}`,
      '--label', `sbl.evolution.input=${identity.inputHash}`, '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
      '--pids-limit', '128', '--memory', '4g', '--memory-swap', '4g', '--cpus', '2',
      '--log-driver', 'none', '--restart', 'no', '--ulimit', 'nofile=1024:1024',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000',
      '--tmpfs', '/workspace:rw,nosuid,nodev,size=1073741824,uid=1000,gid=1000',
      '--workdir', '/workspace', this.image,
      'node', '-e', 'setInterval(() => {}, 1000)',
    ], 30_000)
    if (result.exitCode !== 0) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_CREATE_FAILED', '无法创建隔离环境，未复用已有同名容器')
    await this.inspectOwned(identity)
    const started = await this.command(['start', name], 30_000)
    if (started.exitCode !== 0) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_START_FAILED', '隔离环境启动失败')
    return name
  }

  private async inspectOwned(identity: EvolutionLeaseIdentity) {
    const result = await this.command(['inspect', containerName(identity)], 10_000)
    if (result.exitCode !== 0) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_INSPECT_FAILED', '无法核验任务容器，不能假定容器已消失')
    const records = JSON.parse(result.stdout) as Array<{ Config: { Labels: Record<string, string> }; State: { Running: boolean } }>
    const record = records[0]
    const labels = record?.Config?.Labels
    if (!labels || labels['sbl.evolution.run'] !== identity.runId || labels['sbl.evolution.attempt'] !== String(identity.attempt)
      || labels['sbl.evolution.lease'] !== String(identity.leaseToken) || labels['sbl.evolution.input'] !== identity.inputHash) {
      throw evolutionError(403, 'EVOLUTION_ENVIRONMENT_OWNERSHIP_MISMATCH', '容器归属不匹配，拒绝操作')
    }
    return record
  }

  async evaluateNode(identity: EvolutionLeaseIdentity, script: string, timeoutMs = 30_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000 || script.length > 128_000) {
      throw evolutionError(400, 'EVOLUTION_COMMAND_LIMIT', '执行命令超出范围')
    }
    await this.inspectOwned(identity)
    try {
      const result = await this.command(['exec', '--user', '1000:1000', '--workdir', '/workspace', containerName(identity), 'node', '-e', script], timeoutMs)
      return result
    } catch (error) {
      // Killing the CLI does not kill docker exec; terminate the entire owned task environment.
      await this.terminate(identity)
      throw error
    }
  }

  async readOutputFiles(identity: EvolutionLeaseIdentity, files: { path: string; bytes: number; sha256: string }[], assertCanContinue: () => Promise<void>) {
    if (!files.length || files.length > 100 || files.some((file) => !safeEvolutionSourcePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
      || files.reduce((sum, file) => sum + file.bytes, 0) > 192 * 1024) throw evolutionError(400, 'EVOLUTION_ARTIFACT_KEY', '候选输出批次无效或过大')
    await assertCanContinue()
    const result = await this.evaluateNode(identity, `
      const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
      const files=${JSON.stringify(files)};
      const output=files.map(file=>{
        let current='/workspace/output';
        for(const part of ['',...file.path.split('/')]){if(part)current=path.join(current,part);assert.equal(fs.lstatSync(current).isSymbolicLink(),false);}
        const fd=fs.openSync(current,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        try{const info=fs.fstatSync(fd);assert.equal(info.isFile(),true);assert.equal(info.size,file.bytes);
          const bytes=Buffer.alloc(file.bytes);assert.equal(fs.readSync(fd,bytes,0,bytes.length,0),bytes.length);return bytes.toString('base64');
        }finally{fs.closeSync(fd)}
      });process.stdout.write(JSON.stringify(output));
    `)
    if (result.exitCode !== 0) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '候选输出批次读取失败')
    const output: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(output) || output.length !== files.length) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '候选输出批次不完整')
    return output.map((value, index) => {
      if (typeof value !== 'string') throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '候选输出格式无效')
      const bytes = Buffer.from(value, 'base64')
      if (bytes.length !== files[index].bytes || createHash('sha256').update(bytes).digest('hex') !== files[index].sha256) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '候选输出批次哈希不一致')
      return bytes
    })
  }

  async readOutputFile(identity: EvolutionLeaseIdentity, file: { path: string; bytes: number; sha256: string }, assertCanContinue: () => Promise<void>) {
    if (!safeEvolutionSourcePath(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 128 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw evolutionError(400, 'EVOLUTION_ARTIFACT_KEY', '候选输出路径、大小或哈希无效')
    const chunks: Buffer[] = []
    for (let offset = 0; offset < Math.max(1, file.bytes); offset += 192 * 1024) {
      await assertCanContinue()
      const length = Math.min(192 * 1024, file.bytes - offset)
      const result = await this.evaluateNode(identity, `
        const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
        const relative = ${JSON.stringify(file.path)}, root = '/workspace/output';
        let current = root;
        for (const part of ['', ...relative.split('/')]) {
          if (part) current = path.join(current, part);
          assert.equal(fs.lstatSync(current).isSymbolicLink(), false);
        }
        const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const info = fs.fstatSync(fd);
          assert.equal(info.isFile(), true); assert.equal(info.size, ${file.bytes});
          const bytes = Buffer.alloc(${length});
          assert.equal(fs.readSync(fd, bytes, 0, bytes.length, ${offset}), bytes.length);
          process.stdout.write(bytes.toString('base64'));
        } finally { fs.closeSync(fd) }
      `)
      if (result.exitCode !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.stdout)) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '无法读取候选输出')
      const chunk = Buffer.from(result.stdout, 'base64')
      if (chunk.length !== length) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '候选输出不完整')
      chunks.push(chunk)
    }
    const content = Buffer.concat(chunks)
    if (createHash('sha256').update(content).digest('hex') !== file.sha256) throw evolutionError(409, 'EVOLUTION_ARTIFACT_INTEGRITY', '候选输出哈希不一致')
    return content
  }

  async importSnapshot(identity: EvolutionLeaseIdentity, snapshot: EvolutionSourceSnapshot, directory: 'source' | 'candidate' | 'platform' = 'source') {
    if (!['source', 'candidate', 'platform'].includes(directory) || snapshot.files.length > 10_000
      || snapshot.files.reduce((sum, file) => sum + file.bytes, 0) > 128 * 1024 * 1024) {
      throw evolutionError(413, 'EVOLUTION_SOURCE_LIMIT', '源码快照超出环境限制')
    }
    await this.inspectOwned(identity)
    const script = `
      const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
      const chunks = []; let bytes = 0;
      process.stdin.on('data', chunk => { bytes += chunk.length; if(bytes > 200 * 1024 * 1024) process.exit(2); chunks.push(chunk); });
      process.stdin.on('end', () => {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const root = '/workspace/' + ${JSON.stringify(directory)};
        fs.mkdirSync(root); // Never merge into an existing task checkout.
        for (const file of input.files) {
          const target = path.resolve(root, file.path);
          if (!target.startsWith(root + '/') || file.path.includes('\\\\')) throw Error('invalid snapshot path');
          const content = Buffer.from(file.contentBase64, 'base64');
          if (content.length !== file.bytes || crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) throw Error('snapshot hash mismatch');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
        }
        console.log(JSON.stringify({ imported: input.files.length }));
      });
    `
    try {
      const result = await this.command(['exec', '-i', '--user', '1000:1000', containerName(identity), 'node', '-e', script], 120_000, Buffer.from(JSON.stringify(snapshot)))
      if (result.exitCode !== 0) throw evolutionError(422, 'EVOLUTION_SOURCE_IMPORT_FAILED', '容器源码导入失败')
      return JSON.parse(result.stdout) as { imported: number }
    } catch (error) {
      await this.terminate(identity)
      throw error
    }
  }

  async writeInputFile(identity: EvolutionLeaseIdentity, name: string, content: Buffer) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name) || content.length > 2 * 1024 * 1024) {
      throw evolutionError(413, 'EVOLUTION_INPUT_LIMIT', '渲染输入编号或大小无效')
    }
    await this.inspectOwned(identity)
    const script = `const fs=require('node:fs'),assert=require('node:assert/strict');
      let size=0;const chunks=[];process.stdin.on('data',chunk=>{size+=chunk.length;if(size>2097152)process.exit(2);chunks.push(chunk)});
      process.stdin.on('end',()=>{const root='/workspace/input';fs.mkdirSync(root,{recursive:true});
        assert.equal(fs.lstatSync(root).isSymbolicLink(),false);
        fs.writeFileSync(root+'/'+${JSON.stringify(name)},Buffer.concat(chunks),{flag:'wx',mode:0o600});});`
    const result = await this.command(['exec', '-i', '--user', '1000:1000', containerName(identity), 'node', '-e', script], 30_000, content)
    if (result.exitCode !== 0) throw evolutionError(409, 'EVOLUTION_INPUT_WRITE_FAILED', '渲染输入写入失败，未覆盖既有输入')
  }

  async terminate(identity: EvolutionLeaseIdentity) {
    const listed = await this.command(['container', 'ls', '-a', '--filter', `name=^/${containerName(identity)}$`, '--format', '{{.ID}}'], 10_000)
    if (listed.exitCode !== 0) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_INSPECT_FAILED', '无法核验任务容器，不能假定容器已消失')
    if (!listed.stdout.trim()) return { terminated: true as const }
    const record = await this.inspectOwned(identity)
    if (record.State.Running) {
      const killed = await this.command(['kill', containerName(identity)], 10_000)
      if (killed.exitCode !== 0) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_STOP_FAILED', '任务环境终止失败')
    }
    if ((await this.inspectOwned(identity)).State.Running) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_STILL_RUNNING', '任务环境仍在运行')
    const removed = await this.command(['rm', containerName(identity)], 10_000)
    if (removed.exitCode !== 0) throw evolutionError(503, 'EVOLUTION_ENVIRONMENT_REMOVE_FAILED', '任务环境清理失败')
    return { terminated: true as const }
  }
}
