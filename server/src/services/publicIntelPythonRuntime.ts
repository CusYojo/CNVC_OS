import { existsSync } from 'node:fs'
import path from 'node:path'

export type PublicIntelPythonRuntime = {
  executable: string
  argsPrefix: string[]
  source: 'configured' | 'project-venv' | 'platform-fallback'
}

export function resolvePublicIntelPython(input: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  projectRoot?: string
  exists?: (candidate: string) => boolean
} = {}): PublicIntelPythonRuntime {
  const env = input.env ?? process.env
  const platform = input.platform ?? process.platform
  const projectRoot = input.projectRoot ?? process.cwd()
  const exists = input.exists ?? existsSync
  const configured = env.AI_INTEL_PYTHON?.trim()
  if (configured) return { executable: configured, argsPrefix: [], source: 'configured' }

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const projectPython = pathApi.resolve(
    projectRoot,
    'server',
    '.venv',
    platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
  )
  if (exists(projectPython)) {
    return { executable: projectPython, argsPrefix: [], source: 'project-venv' }
  }
  return platform === 'win32'
    ? { executable: 'py', argsPrefix: ['-3'], source: 'platform-fallback' }
    : { executable: 'python3', argsPrefix: [], source: 'platform-fallback' }
}
