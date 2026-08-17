const REQUIRED_MYSQL_ENV = [
  'DB_HOST',
  'DB_PORT',
  'DB_DATABASE',
  'DB_USERNAME',
  'DB_PASSWORD',
  'DB_FREFIX',
] as const

function requiredEnv(name: typeof REQUIRED_MYSQL_ENV[number]): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`[mysql config] required environment variable ${name} is missing`)
  }
  return value
}

function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('[mysql config] DB_PORT must be an integer between 1 and 65535')
  }
  return port
}

function parsePoolSize(raw: string): number {
  const size = Number(raw)
  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw new Error('[mysql config] DB_POOL_SIZE must be an integer between 1 and 100')
  }
  return size
}

function parseBoundedInteger(raw: string, name: string, minimum: number, maximum: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`[mysql config] ${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

const tablePrefix = requiredEnv('DB_FREFIX')
if (!/^[A-Za-z0-9_]+$/.test(tablePrefix)) {
  throw new Error('[mysql config] DB_FREFIX may only contain letters, numbers and underscores')
}

const connectionLimit = parsePoolSize(process.env.DB_POOL_SIZE ?? '10')

// mysql2 的 charset 选项实际接受“字符集/排序规则”名。只写 utf8mb4 会退回
// utf8mb4_general_ci，导致连接级比较规则与目标库 utf8mb4_0900_ai_ci 漂移。
export const MYSQL_CONNECTION_COLLATION = 'utf8mb4_0900_ai_ci'

export const mysqlConfig = Object.freeze({
  host: requiredEnv('DB_HOST'),
  port: parsePort(requiredEnv('DB_PORT')),
  database: requiredEnv('DB_DATABASE'),
  user: requiredEnv('DB_USERNAME'),
  password: requiredEnv('DB_PASSWORD'),
  tablePrefix,
  connectionLimit,
  queueLimit: parseBoundedInteger(process.env.DB_POOL_QUEUE_LIMIT ?? String(connectionLimit * 4), 'DB_POOL_QUEUE_LIMIT', 1, 10_000),
  connectTimeoutMs: parseBoundedInteger(process.env.DB_CONNECT_TIMEOUT_MS ?? '10000', 'DB_CONNECT_TIMEOUT_MS', 1_000, 60_000),
})

export function mysqlTableName(baseName: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(baseName)) {
    throw new Error(`[mysql config] unsafe table name: ${baseName}`)
  }
  return `${mysqlConfig.tablePrefix}${baseName}`
}

export function quoteMysqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`[mysql config] unsafe identifier: ${identifier}`)
  }
  return `\`${identifier}\``
}

export { REQUIRED_MYSQL_ENV }
