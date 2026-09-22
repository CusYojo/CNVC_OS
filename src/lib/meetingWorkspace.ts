export type MeetingDraft<T = File> = { text: string; files: T[] }

export function meetingSelection<T extends { id: string }>(meetings: T[], requestedId: string | null | undefined) {
  return requestedId ? meetings.find(meeting => meeting.id === requestedId) : meetings[0]
}

export function updateMeetingDraft<T>(drafts: Record<string, MeetingDraft<T>>, meetingId: string, draft: MeetingDraft<T>) {
  return { ...drafts, [meetingId]: draft }
}

export function clearSentMeetingDraft<T>(drafts: Record<string, MeetingDraft<T>>, meetingId: string, sent: MeetingDraft<T>) {
  if (drafts[meetingId] !== sent) return drafts
  const { [meetingId]: _sent, ...remaining } = drafts
  return remaining
}

export function hasUnreadDirective(item: { directiveId?: string | null; directiveNoticeId?: string | null; status?: string }) {
  return Boolean(item.directiveId && item.directiveNoticeId)
}

export async function acknowledgeNotice(write: () => Promise<unknown>, onRead: () => void) {
  await write()
  onRead()
}
