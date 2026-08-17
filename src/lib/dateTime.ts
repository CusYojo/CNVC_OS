export const BUSINESS_TIME_ZONE = 'Asia/Shanghai'

type DateInput = Date | string | number

function validDate(value: DateInput): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date value')
  return date
}

function shanghaiParts(value: DateInput, includeTime = false): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
  })
  return Object.fromEntries(formatter.formatToParts(validDate(value))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
}

export function shanghaiDateKey(value: DateInput = new Date()): string {
  const parts = shanghaiParts(value)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function shanghaiDateTimeInputValue(value: DateInput = new Date()): string {
  const parts = shanghaiParts(value, true)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function addShanghaiDaysDateKey(days: number, value: DateInput = new Date()): string {
  if (!Number.isInteger(days)) throw new Error('days must be an integer')
  return shanghaiDateKey(new Date(validDate(value).getTime() + days * 86_400_000))
}

export function formatShanghaiDateTime(value: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const defaults: Intl.DateTimeFormatOptions = Object.keys(options).length ? {} : {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    ...defaults,
    hourCycle: 'h23',
    ...options,
  }).format(validDate(value))
}

export function formatShanghaiDate(value: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const defaults: Intl.DateTimeFormatOptions = Object.keys(options).length ? {} : {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    ...defaults,
    ...options,
  }).format(validDate(value))
}
