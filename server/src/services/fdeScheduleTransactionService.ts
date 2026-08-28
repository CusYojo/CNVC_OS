import { db } from '../db/client.js'
import { retryScheduleTransaction } from '../contracts/fdeScheduleTransactionContract.js'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Options = Parameters<typeof db.transaction>[1]

// The closure must contain database work only. A retry reruns authorization,
// versions, occupancy checks and transactional events from a fresh transaction.
// Notifications/RAG/network calls remain outside this boundary after commit.
export function scheduleTransaction<T>(operation: (tx: Tx) => Promise<T>, options?: Options): Promise<T> {
  return retryScheduleTransaction(() => db.transaction(operation, options))
}
