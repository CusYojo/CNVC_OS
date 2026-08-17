import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSupervised } from '../runtime/supervisedProcessService.js'

const PPTSKILL_SCRIPT = '/data/pptskill/GordenSuperPPTSkills-main/GordenImagePPTGen/scripts/generate_gateway_slide_image.py'
const generatedRoot = path.resolve(process.cwd(), 'server/generated')

// 调 pptskill 生成一张 AI 精美幻灯片图（投委会封面/单页），返回 /generated 下的可访问 URL
export async function generateAiSlide(prompt: string, size = '2560x1440', userId: string): Promise<{ url: string; file: string }> {
  const generatedDir = path.resolve(generatedRoot, userId)
  await mkdir(generatedDir, { recursive: true })
  const apiKey = process.env.GATEWAY_IMAGE_API_KEY || process.env.OPENAI_API_KEY || ''
  const baseUrl = process.env.GATEWAY_IMAGE_BASE_URL || 'https://getways-jumu.zeelin.cn'
  if (!apiKey) throw new Error('未配置图片生成网关密钥（GATEWAY_IMAGE_API_KEY）')

  const before = new Set(await safeList(generatedDir))
  const promptDir = await mkdtemp(path.join(tmpdir(), 'cybernaut-cover-'))
  const promptPath = path.join(promptDir, 'prompt.txt')
  try {
    await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 })
    await execFileSupervised('python3', [
      PPTSKILL_SCRIPT,
      '--prompt', `@${promptPath}`,
      '--size', size,
      '--quality', 'high',
      '--base-url', baseUrl,
      '--out-dir', generatedDir,
    ], {
      timeout: 340000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GATEWAY_IMAGE_API_KEY: apiKey },
    })
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    throw new Error(`幻灯片生成失败：${failure.stderr?.slice(0, 200) || failure.message}`)
  } finally {
    await rm(promptDir, { recursive: true, force: true })
  }
  const after = await safeList(generatedDir)
  const created = after.filter((f) => !before.has(f) && f.toLowerCase().endsWith('.png'))
  if (!created.length) throw new Error('幻灯片生成未产出图片文件')
  const file = created.sort().reverse()[0]
  return { url: `/api/generated/${encodeURIComponent(file)}`, file }
}

async function safeList(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}
