const DEFAULT_FLUE_BASE_URL = 'http://127.0.0.1:3584'

export const FLUE_BASE_URL = (
  process.env.FLUE_BASE_URL || DEFAULT_FLUE_BASE_URL
).replace(/\/+$/, '')

export const FLUE_AGENT_NAME = process.env.FLUE_AGENT_NAME || 'assistant'
