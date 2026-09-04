import { z } from 'zod'

export const personalNoteColors = ['default', 'teal', 'blue', 'amber', 'rose', 'violet'] as const
export const personalNoteRun = z.object({
  text: z.string().max(20_000),
  bold: z.boolean().default(false),
  color: z.enum(personalNoteColors).default('default'),
}).strict()

export const personalNoteContent = z.array(personalNoteRun).min(1).max(500)
  .refine((runs) => runs.reduce((length, run) => length + run.text.length, 0) <= 20_000, '笔记正文不能超过 20000 字')
  .refine((runs) => runs.some((run) => run.text.trim()), '请填写笔记内容')

export const personalNoteCreate = z.object({
  title: z.string().trim().min(1).max(120),
  noteDate: z.iso.date(),
  content: personalNoteContent,
}).strict()

export const personalNoteUpdate = personalNoteCreate.extend({
  expectedVersion: z.number().int().positive(),
}).strict()

export const personalNoteDelete = z.object({
  expectedVersion: z.number().int().positive(),
}).strict()

export const personalNoteQuery = z.object({
  keyword: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(18),
}).strict()

export type PersonalNoteRun = z.infer<typeof personalNoteRun>
export type PersonalNoteContent = z.infer<typeof personalNoteContent>

export function personalNotePlainText(content: PersonalNoteContent): string {
  return content.map((run) => run.text).join('').trim()
}
