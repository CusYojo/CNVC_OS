import { reconstructEvolutionSkillRuntime } from '../runtime/evolution/evolutionSkillPackage.js'
import { parseAiSkillFile, type LoadedAiSkill } from './aiSkillService.js'

export function loadEvolutionSkill(bundle: Parameters<typeof reconstructEvolutionSkillRuntime>[0], expectedName: string): LoadedAiSkill {
  const runtime = reconstructEvolutionSkillRuntime(bundle)
  const source = runtime.files.find(file => file.path === 'SKILL.md')
  if (!source) throw Error('冻结技能包缺少 SKILL.md')
  const parsed = parseAiSkillFile(Buffer.from(source.contentBase64, 'base64').toString('utf8'))
  if (parsed.name !== expectedName) throw Error('冻结技能包与任务技能不一致')
  return { name: parsed.name, description: parsed.description, instructions: runtime.version.instructions,
    referenceNames: runtime.version.references.map(ref => ref.name),
    referenceInstructions: runtime.version.references.map(ref => `${ref.name}\n${ref.content}`).join('\n\n'),
    sha256: runtime.contentHash, version: `evolution:${runtime.contentHash}` }
}
