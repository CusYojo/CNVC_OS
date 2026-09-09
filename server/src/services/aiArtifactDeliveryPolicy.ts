// Format policy only. Callers must still enforce ownership, readability,
// quality status and the authorized storage path before serving a file.
export function isAiArtifactDeliveryFormat(taskType: string, format: string) {
  return taskType !== 'investment_proposal' || format === 'docx' || format === 'pdf'
}
