import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { createPersonalNote, deletePersonalNote, listPersonalNotes, updatePersonalNote } from '../services/personalNoteService.js'

export const personalNotesRouter = Router()
const noteId = (value: string | string[]) => z.string().uuid().parse(value)

personalNotesRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store')
  next()
})

personalNotesRouter.get('/', async (req: AuthedRequest, res, next) => {
  try { res.json(await listPersonalNotes(req.user!.uid, req.query)) } catch (error) { next(error) }
})

personalNotesRouter.post('/', async (req: AuthedRequest, res, next) => {
  try { res.status(201).json(await createPersonalNote(req.user!.uid, req.body)) } catch (error) { next(error) }
})

personalNotesRouter.patch('/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await updatePersonalNote(noteId(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) }
})

personalNotesRouter.delete('/:id', async (req: AuthedRequest, res, next) => {
  try { res.json(await deletePersonalNote(noteId(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) }
})
