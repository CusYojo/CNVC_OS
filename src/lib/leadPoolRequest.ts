export type LeadPoolRequestOutcome<T> =
  | { status: 'success'; response: T }
  | { status: 'error'; message: string }
  | { status: 'stale' }

export async function executeLeadPoolRequest<T>(
  load: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<LeadPoolRequestOutcome<T>> {
  try {
    const response = await load()
    return isCurrent() ? { status: 'success', response } : { status: 'stale' }
  } catch (cause) {
    if (!isCurrent()) return { status: 'stale' }
    return {
      status: 'error',
      message: cause instanceof Error ? cause.message : '共享线索读取失败',
    }
  }
}
