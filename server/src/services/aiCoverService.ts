import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

const PPTSKILL_SCRIPT = '/data/pptskill/GordenSuperPPTSkills-main/GordenImagePPTGen/scripts/generate_gateway_slide_image.py'
const generatedDir = path.resolve(process.cwd(), 'server/generated')

// 调 pptskill 生成一张 AI 精美幻灯片图（投委会封面/单页），返回 /generated 下的可访问 URL
export async function generateAiSlide(prompt: string, size = '2560x1440'): Promise<{ url: string; file: string }> {
  await mkdir(generatedDir, { recursive: true })
  const apiKey = process.env.GATEWAY_IMAGE_API_KEY || process.env.OPENAI_API_KEY || ''
  const baseUrl = process.env.GATEWAY_IMAGE_BASE_URL || 'https://getways-jumu.zeelin.cn'
  if (!apiKey) throw new Error('未配置图片生成网关密钥（GATEWAY_IMAGE_API_KEY）')

  const before = new Set(await safeList(generatedDir))
  await new Promise<void>((resolve, reject) => {
    execFile('python3', [
      PPTSKILL_SCRIPT,
      '--prompt', prompt,
      '--size', size,
      '--quality', 'high',
      '--base-url', baseUrl,
      '--api-key', apiKey,
      '--out-dir', generatedDir,
    ], { timeout: 340000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`幻灯片生成失败：${stderr?.slice(0, 200) || err.message}`))
      resolve()
    })
  })
  const after = await safeList(generatedDir)
  const created = after.filter((f) => !before.has(f) && f.toLowerCase().endsWith('.png'))
  if (!created.length) throw new Error('幻灯片生成未产出图片文件')
  const file = created.sort().reverse()[0]
  return { url: `/generated/${file}`, file }
}

async function safeList(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}
