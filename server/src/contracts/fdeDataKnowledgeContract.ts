import { z } from 'zod'

export const dataKnowledgeCapabilities = z.object({
  company: z.boolean(), archives: z.boolean(), upload: z.boolean(), input: z.boolean(), meetings: z.boolean(), uploadProjectIds: z.array(z.string().uuid()),
}).strict()
export type DataKnowledgeCapabilities = z.infer<typeof dataKnowledgeCapabilities>
export type ArchiveTool = 'upload' | 'input' | 'meetings'

export function dataKnowledgeSelection(capabilities: DataKnowledgeCapabilities, view: string | null, tool: string | null) {
  const selected = view ?? (capabilities.company ? 'company' : 'archives')
  const validView = selected === 'company' || selected === 'archives'
  const validTool = tool === null || tool === 'upload' || tool === 'input' || tool === 'meetings'
  const allowed = validView && capabilities[selected as 'company' | 'archives'] &&
    (selected !== 'archives' || (validTool && (tool === null || capabilities[tool as ArchiveTool])))
  return { view: selected, tool: selected === 'archives' && validTool ? tool as ArchiveTool | null : null, allowed: Boolean(allowed) }
}
