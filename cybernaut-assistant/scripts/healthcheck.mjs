const baseUrl = (
  process.env.FLUE_BASE_URL || 'http://127.0.0.1:3584'
).replace(/\/+$/, '')

const response = await fetch(`${baseUrl}/health`, {
  signal: AbortSignal.timeout(5000),
})
if (!response.ok) {
  throw new Error(`Agent Runtime health check failed: HTTP ${response.status}`)
}

const health = await response.json()
if (health?.ok !== true || health?.agent !== 'assistant') {
  throw new Error(`Unexpected Agent Runtime response: ${JSON.stringify(health)}`)
}

console.log(
  `Agent Runtime healthy: ${health.service} (${health.agent}), `
  + `${health.workflows?.length ?? 0} workflows at ${baseUrl}`,
)
