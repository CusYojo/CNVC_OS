import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { reconstructEvolutionSkillRuntime } from '../runtime/evolution/evolutionSkillPackage.js'
import { parseAiSkillFile } from './aiSkillService.js'
import type { AiTemplateDefinition } from './aiTemplateCatalog.js'

/** Materialize verified bytes into a fresh private directory; never copy the live package. */
export async function materializeEvolutionTemplate(template: AiTemplateDefinition, skillDirectory: string, bundle: unknown) {
  const runtime = reconstructEvolutionSkillRuntime(bundle)
  const source = runtime.files.find(file => file.path === 'SKILL.md')!
  if (parseAiSkillFile(Buffer.from(source.contentBase64, 'base64').toString('utf8')).name !== template.skillName) throw Error('冻结模板技能名称不一致')
  const relative = (filename: string) => {
    const name = path.relative(path.resolve(skillDirectory), path.resolve(filename)).split(path.sep).join('/')
    if (!name || name.startsWith('../') || path.isAbsolute(name) || !runtime.files.some(file => file.path === name)) throw Error('模板引用不在冻结技能包内')
    return name
  }
  const primary = relative(template.referencePath)
  const references = template.referencePaths?.map(relative)
  const core = template.coreRulesPath ? relative(template.coreRulesPath) : undefined
  const temporaryRoot = await realpath(os.tmpdir())
  const directory = await mkdtemp(path.join(temporaryRoot, 'evolution-frozen-template-'))
  const dispose = async () => {
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('evolution-frozen-template-')) throw Error('Invalid template cleanup path')
    await rm(resolved, { recursive: true, force: true })
  }
  try {
    for (const file of runtime.files) {
      const destination = path.resolve(directory, file.path)
      if (!destination.startsWith(directory + path.sep)) throw Error('Invalid frozen template path')
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, Buffer.from(file.contentBase64, 'base64'), { flag: 'wx', mode: 0o600 })
    }
    return { directory, dispose, template: { ...template, referencePath: path.join(directory, primary),
      referencePaths: references?.map(name => path.join(directory, name)), coreRulesPath: core ? path.join(directory, core) : undefined } }
  } catch (error) { await dispose(); throw error }
}
