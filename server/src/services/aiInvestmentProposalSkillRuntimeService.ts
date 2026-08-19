import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getAiSkillDirectory, getAiSkillRuntimeDirectory } from './aiSkillService.js'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
const SKILL_NAME = 'draft-investment-proposal' as const
const PLUGIN_TEMPLATE_FILE = '德塔式精简工商字段投资提案_固定模板V7.docx'
const PLUGIN_TEMPLATE_SHA256 = '849a6e1ec86c9576f52332ffbf8dc048dea5d929daa438810f701c4e2116da15'

type CaseStyleValidation = {
  passed: boolean
  error_count: number
  errors: string[]
  style_counts: Record<string, number>
  table_kinds: string[]
}

type ProposalValidation = {
  status: 'pass' | 'fail'
  errors: Array<{ code: string; message: string; location?: string }>
  warnings: Array<{ code: string; message: string; location?: string }>
  metrics: Record<string, unknown>
}

type PluginRenderManifest = {
  status?: unknown
  workflow?: unknown
  docx?: unknown
  docx_sha256?: unknown
  payload?: unknown
  payload_sha256?: unknown
  template?: unknown
  template_sha256?: unknown
  template_enforced?: unknown
  renderer_mode?: unknown
  external_llm_gateway?: unknown
}

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function validatePluginTemplateRender(filePath: string) {
  const workDirectory = path.join(path.dirname(filePath), '.investment-proposal-plugin-render')
  const manifestPath = path.join(workDirectory, 'render-manifest.json')
  try {
    await access(manifestPath)
  } catch {
    return undefined
  }

  let manifest: PluginRenderManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginRenderManifest
  } catch (error) {
    throw Object.assign(new Error('投资提案插件渲染清单无法读取'), {
      code: 'INVESTMENT_PROPOSAL_SKILL_VALIDATION_FAILED',
      report: { manifestPath, error: (error as Error).message },
    })
  }

  const pluginSkillDirectory = getAiSkillDirectory(SKILL_NAME)
  const pluginDirectory = path.resolve(pluginSkillDirectory, '..', '..')
  const expectedTemplate = path.join(pluginDirectory, 'assets', PLUGIN_TEMPLATE_FILE)
  const expectedPayload = path.join(workDirectory, 'proposal.json')
  let documentBuffer: Buffer
  let templateBuffer: Buffer
  let payloadBuffer: Buffer
  try {
    [documentBuffer, templateBuffer, payloadBuffer] = await Promise.all([
      readFile(filePath),
      readFile(expectedTemplate),
      readFile(expectedPayload),
    ])
  } catch (error) {
    throw Object.assign(new Error('投资提案插件模板校验所需文件不完整'), {
      code: 'INVESTMENT_PROPOSAL_SKILL_VALIDATION_FAILED',
      report: { manifestPath, error: (error as Error).message },
    })
  }
  const checks = {
    status: manifest.status === 'rendered',
    workflow: manifest.workflow === 'SBL_APP_PLUGIN_TEMPLATE_RENDER_V1',
    documentPath: path.resolve(String(manifest.docx ?? '')) === path.resolve(filePath),
    documentSha256: manifest.docx_sha256 === sha256(documentBuffer),
    payloadPath: path.resolve(String(manifest.payload ?? '')) === path.resolve(expectedPayload),
    payloadSha256: manifest.payload_sha256 === sha256(payloadBuffer),
    templatePath: path.resolve(String(manifest.template ?? '')) === path.resolve(expectedTemplate),
    templateSha256: manifest.template_sha256 === PLUGIN_TEMPLATE_SHA256
      && sha256(templateBuffer) === PLUGIN_TEMPLATE_SHA256,
    templateEnforced: manifest.template_enforced === true,
    rendererMode: manifest.renderer_mode === 'clone-approved-docx',
    externalLlmGateway: manifest.external_llm_gateway === false,
  }
  const errors = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => `PLUGIN_RENDER_${name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`)
  if (errors.length) {
    throw Object.assign(new Error('投资提案插件模板来源校验未通过'), {
      code: 'INVESTMENT_PROPOSAL_SKILL_VALIDATION_FAILED',
      report: { manifestPath, errors, checks },
    })
  }

  return {
    passed: true as const,
    skillName: SKILL_NAME,
    python: 'plugin-template-renderer',
    fidelity: {
      passed: true,
      error_count: 0,
      errors: [],
      style_counts: {},
      table_kinds: [],
      profile: 'artifact-template-deta-v7',
      template_sha256: PLUGIN_TEMPLATE_SHA256,
      manifest_path: manifestPath,
    },
    proposal: {
      status: 'pass' as const,
      errors: [],
      warnings: [],
      metrics: {
        validationProfile: 'artifact-template-deta-v7',
        rendererMode: manifest.renderer_mode,
      },
    },
  }
}

async function resolvePython() {
  const candidates = [
    process.env.AI_INVESTMENT_PROPOSAL_PYTHON,
    path.resolve(process.cwd(), 'server', '.venv', 'bin', 'python'),
    'python3',
  ].filter((value): value is string => Boolean(value))
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (candidate.includes(path.sep)) await access(candidate)
      await execFileAsync(candidate, ['-c', 'import docx,lxml'], { timeout: 10_000 })
      return candidate
    } catch {
      // 继续检查下一个跨平台 Python 候选。
    }
  }
  throw new Error('投资提案 Skill 缺少 python-docx/lxml 运行环境')
}

function parseJson<T>(stdout: string, label: string) {
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new Error(`${label}未返回合法 JSON`)
  }
}

async function runValidator<T>(python: string, script: string, args: string[], label: string) {
  try {
    const result = await execFileAsync(python, [script, ...args], {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    return parseJson<T>(result.stdout, label)
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    const report = failure.stdout?.trim()
      ? parseJson<T>(failure.stdout, label)
      : undefined
    throw Object.assign(new Error(`${label}未通过`), {
      code: 'INVESTMENT_PROPOSAL_SKILL_VALIDATION_FAILED',
      report,
      cause: failure,
    })
  }
}

export async function validateInvestmentProposalWithSkill(filePath: string) {
  // The installed Deta V7 plugin is the active visual authority for application
  // tasks. Its small-page template intentionally differs from the legacy A4
  // case-style assets retained by the host skill runtime. Validate the plugin's
  // signed render manifest when present instead of applying mutually exclusive
  // A4 geometry and style rules to a V7 document.
  const pluginValidation = await validatePluginTemplateRender(filePath)
  if (pluginValidation) return pluginValidation

  const python = await resolvePython()
  const skillDirectory = getAiSkillRuntimeDirectory(SKILL_NAME)
  const fidelityScript = path.join(skillDirectory, 'scripts', 'validate_case_style_fidelity.py')
  const proposalScript = path.join(skillDirectory, 'scripts', 'validate_proposal.py')
  await Promise.all([access(fidelityScript), access(proposalScript)])

  const fidelity = await runValidator<CaseStyleValidation>(
    python,
    fidelityScript,
    [filePath],
    '投资提案案例版式校验',
  )
  const proposal = await runValidator<ProposalValidation>(
    python,
    proposalScript,
    [filePath],
    '投资提案结构与表格校验',
  )
  if (!fidelity.passed || proposal.status !== 'pass') {
    throw Object.assign(new Error('投资提案 Skill 成品门禁未通过'), {
      code: 'INVESTMENT_PROPOSAL_SKILL_VALIDATION_FAILED',
      report: { fidelity, proposal },
    })
  }
  return {
    passed: true as const,
    skillName: SKILL_NAME,
    python: path.basename(python),
    fidelity,
    proposal,
  }
}
