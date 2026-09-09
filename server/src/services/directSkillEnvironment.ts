import path from 'node:path'

export function directSkillPlatformEnvironment(root: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const inheritedPath = env.PATH || env.Path || (windows ? '' : '/usr/local/bin:/usr/bin:/bin')
  return {
    PATH: [paths.resolve(root, 'server', '.venv', windows ? 'Scripts' : 'bin'), inheritedPath].filter(Boolean).join(windows ? ';' : ':'),
    ...(windows ? { SystemRoot: env.SystemRoot || env.SYSTEMROOT, COMSPEC: env.COMSPEC || env.ComSpec, PATHEXT: env.PATHEXT, TEMP: env.TEMP, TMP: env.TMP } : {}),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  }
}
