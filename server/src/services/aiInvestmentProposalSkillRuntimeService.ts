import { access } from 'node:fs/promises'
import path from 'node:path'
import { getAiSkillDirectory } from './aiSkillService.js'
import { execFileSupervised as execFileAsync } from '../runtime/supervisedProcessService.js'
const SKILL_NAME = 'draft-investment-proposal' as const

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
  const python = await resolvePython()
  const skillDirectory = getAiSkillDirectory(SKILL_NAME)
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
