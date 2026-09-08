/** Preserve sub-second remainder so frequent heartbeats cannot erase elapsed time. */
export function accountEvolutionTime(row: { elapsedSeconds: number; timeAccountedAt: Date | null }, now: Date) {
  if (!row.timeAccountedAt) return { elapsedSeconds: row.elapsedSeconds, timeAccountedAt: now }
  const seconds = Math.max(0, Math.floor((now.getTime() - row.timeAccountedAt.getTime()) / 1000))
  return { elapsedSeconds: Math.min(2_147_483_647, row.elapsedSeconds + seconds),
    timeAccountedAt: new Date(row.timeAccountedAt.getTime() + seconds * 1000) }
}
