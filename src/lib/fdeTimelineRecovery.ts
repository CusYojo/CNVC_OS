type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const timelineRecoveryKey = (userId: string, projectId: string) => {
  if (!uuid.test(userId) || !uuid.test(projectId)) throw new Error('流程行动恢复身份无效')
  return `fde-timeline:v1:${userId}:${projectId}`
}
export function readTimelineRecovery(storage: StoragePort, key: string) {
  const value = storage.getItem(key)
  if (value !== null && !uuid.test(value)) throw new Error('流程行动恢复标识损坏，已停止新提交，请先核对原操作')
  return value
}
export function saveTimelineRecovery(storage: StoragePort, key: string, requestId: string) {
  if (!uuid.test(requestId) || readTimelineRecovery(storage, key)) throw new Error('已有流程行动请求待核对，不能覆盖')
  storage.setItem(key, requestId)
  if (readTimelineRecovery(storage, key) !== requestId) throw new Error('流程行动恢复标识保存失败，未发送请求')
}
export function clearTimelineRecovery(storage: StoragePort, key: string, requestId: string) {
  if (readTimelineRecovery(storage, key) !== requestId) throw new Error('恢复标识已变化，不能清除另一个请求')
  storage.removeItem(key)
  if (storage.getItem(key) !== null) throw new Error('恢复标识清除失败，请重新核对')
}
