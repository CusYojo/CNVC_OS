export type ComplianceSupplementChoice = {
  action: 'supplement' | 'continue_with_gaps'
  snapshotId: string
  supplementText?: string
}

export type ComplianceSupplementSnapshot = {
  taskId: string
  projectId: string
  snapshotId: string
  missingItems: string[]
  blockingIssues: string[]
}
