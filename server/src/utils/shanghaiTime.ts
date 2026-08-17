export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'
const SHANGHAI_OFFSET = '+08:00'

function validDate(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error('时间格式无效'), { code: 'INVALID_DATETIME' })
  return date
}

function parts(value: Date | string | number, includeTime = false): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
  }).formatToParts(validDate(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
}

export function formatShanghaiDateKey(value: Date | string | number): string {
  const valueParts = parts(value)
  return `${valueParts.year}-${valueParts.month}-${valueParts.day}`
}

export function formatShanghaiDateTimeInput(value: Date | string | number): string {
  const valueParts = parts(value, true)
  return `${valueParts.year}-${valueParts.month}-${valueParts.day} ${valueParts.hour}:${valueParts.minute}`
}

export function formatShanghaiDate(
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const defaults: Intl.DateTimeFormatOptions = Object.keys(options).length ? {} : {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI_TIME_ZONE,
    ...defaults,
    ...options,
  }).format(validDate(value))
}

export function parseShanghaiDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error('日期格式无效'), { code: 'INVALID_DATE' })
  let parsed: Date
  try { parsed = validDate(`${value}T00:00:00.000${SHANGHAI_OFFSET}`) } catch {
    throw Object.assign(new Error('日期格式无效'), { code: 'INVALID_DATE' })
  }
  if (formatShanghaiDateKey(parsed) !== value) throw Object.assign(new Error('日期格式无效'), { code: 'INVALID_DATE' })
  return parsed
}

export function parseShanghaiDateTime(value: string): Date {
  const normalized = value.trim().replace('T', ' ')
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    throw Object.assign(new Error('日期时间格式无效'), { code: 'INVALID_DATETIME' })
  }
  let parsed: Date
  try { parsed = validDate(`${normalized.replace(' ', 'T')}:00.000${SHANGHAI_OFFSET}`) } catch {
    throw Object.assign(new Error('日期时间格式无效'), { code: 'INVALID_DATETIME' })
  }
  if (formatShanghaiDateTimeInput(parsed) !== normalized) {
    throw Object.assign(new Error('日期时间格式无效'), { code: 'INVALID_DATETIME' })
  }
  return parsed
}
