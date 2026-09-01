import { Router } from 'express'
import { z } from 'zod'
import type { AuthedRequest } from '../middleware/requireAuth.js'
import { shanghaiToday, weekStartFor } from '../contracts/fdeWeeklyPlanContract.js'
import { actOnLeaderTime, createLeaderTime, listLeaderTimes, readLeaderTimeNotice, saveLeaderTime } from '../services/fdeLeaderTimeService.js'
import { cancelCalendarEvent, listCalendar, writeCalendarEvent, writeTaskCalendarSchedule } from '../services/fdeCalendarService.js'
import { applyAutoSchedule, previewAutoSchedule } from '../services/fdeAutoScheduleService.js'
import { milestoneQueryFlag } from '../contracts/fdeMilestoneSourcesContract.js'

export const leaderTimeRouter = Router(), calendarRouter = Router()
calendarRouter.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next() })
const id = (value: unknown) => z.string().uuid().parse(value)
const week = (value: unknown) => z.string().parse(value ?? weekStartFor(shanghaiToday()))
leaderTimeRouter.get('/', async (req: AuthedRequest, res, next) => { try { res.json(await listLeaderTimes(req.user!.uid, week(req.query.weekStart))) } catch (error) { next(error) } })
leaderTimeRouter.post('/', async (req: AuthedRequest, res, next) => { try { res.status(201).json(await createLeaderTime(req.user!.uid, req.body)) } catch (error) { next(error) } })
leaderTimeRouter.post('/auto-schedule/preview', async (req: AuthedRequest, res, next) => { try { res.json(await previewAutoSchedule(req.user!.uid, req.body)) } catch (error) { next(error) } })
leaderTimeRouter.post('/auto-schedule/apply', async (req: AuthedRequest, res, next) => { try { res.json(await applyAutoSchedule(req.user!.uid, req.body)) } catch (error) { next(error) } })
leaderTimeRouter.post('/:id/save', async (req: AuthedRequest, res, next) => { try { res.json(await saveLeaderTime(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
leaderTimeRouter.post('/:id/actions', async (req: AuthedRequest, res, next) => { try { res.json(await actOnLeaderTime(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
leaderTimeRouter.post('/notices/:id/read', async (req: AuthedRequest, res, next) => { try { res.json(await readLeaderTimeNotice(id(req.params.id), req.user!.uid)) } catch (error) { next(error) } })
calendarRouter.get('/', async (req: AuthedRequest, res, next) => { try { res.json(await listCalendar(req.user!.uid, week(req.query.weekStart), z.enum(['personal', 'company']).parse(req.query.view ?? 'personal'), milestoneQueryFlag.parse(req.query.includeMilestones))) } catch (error) { next(error) } })
calendarRouter.post('/', async (req: AuthedRequest, res, next) => { try { res.status(201).json(await writeCalendarEvent(req.user!.uid, req.body)) } catch (error) { next(error) } })
calendarRouter.post('/:id/save', async (req: AuthedRequest, res, next) => { try { res.json(await writeCalendarEvent(req.user!.uid, req.body, id(req.params.id))) } catch (error) { next(error) } })
calendarRouter.post('/:id/cancel', async (req: AuthedRequest, res, next) => { try { res.json(await cancelCalendarEvent(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
calendarRouter.post('/tasks/:id/schedule', async (req: AuthedRequest, res, next) => { try { res.json(await writeTaskCalendarSchedule(id(req.params.id), req.user!.uid, req.body)) } catch (error) { next(error) } })
