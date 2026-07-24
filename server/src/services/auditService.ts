import { mockAuditLogs } from '../mock/db.js'

export function writeAudit(module: string, action: string, target: string) {
  mockAuditLogs.unshift({
    id: crypto.randomUUID(),
    user: '林知远',
    module,
    action,
    target,
    ip: '127.0.0.1',
    createdAt: new Date().toISOString(),
  })
}
