const KR36_GATEWAY = 'https://gateway.36kr.com'
const LIST_PATH = '/api/pms/project/list'
const DETAIL_PATH = '/api/mis/page/project'
const LEGACY_DETAIL_PATH = '/api/pms/project/detail'

export const KR36_PROJECT_PAGE_SIZE = 20
export const KR36_ALL_TRADE_IDS: readonly number[] = []

export type Kr36ProjectRecord = Record<string, unknown>
export type Kr36Fetch = typeof fetch
let requestThrottleTail: Promise<void> = Promise.resolve()
let nextRequestStartAt = 0

export type Kr36ProjectListPage = {
  items: Kr36ProjectRecord[]
  total: number
  pageNo: number
  pageSize: number
  hasMore: boolean
  raw: Kr36ProjectRecord
}

function objectValue(value: unknown): Kr36ProjectRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Kr36ProjectRecord : {}
}

function finiteNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return 0
}

function arrayValue(...values: unknown[]): Kr36ProjectRecord[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(objectValue).filter((item) => Object.keys(item).length)
  }
  return []
}

function responseData(payload: Kr36ProjectRecord): Kr36ProjectRecord {
  const data = objectValue(payload.data)
  return Object.keys(data).length ? data : payload
}

function detailData(payload: Kr36ProjectRecord): Kr36ProjectRecord {
  const data = responseData(payload)
  for (const candidate of [data.project, data.projectInfo, data.item, data.detail, data]) {
    const object = objectValue(candidate)
    if (Object.keys(object).length) return object
  }
  return {}
}

function wrapper(param: Record<string, unknown>) {
  return {
    partner_id: 'web',
    timestamp: Date.now(),
    partner_version: '1.0.0',
    param: { siteId: 1, platformId: 2, ...param },
  }
}

async function waitForRequestSlot(minimumDelayMs: number) {
  if (minimumDelayMs <= 0) return
  const previous = requestThrottleTail
  let release!: () => void
  requestThrottleTail = new Promise<void>((resolve) => { release = resolve })
  await previous.catch(() => {})
  const waitMs = Math.max(0, nextRequestStartAt - Date.now())
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs))
  nextRequestStartAt = Date.now() + minimumDelayMs + Math.floor(Math.random() * Math.min(250, minimumDelayMs))
  release()
}

async function requestKr36(
  path: string,
  param: Record<string, unknown>,
  options: { fetchImpl?: Kr36Fetch; signal?: AbortSignal; attempts?: number; minimumDelayMs?: number } = {},
): Promise<Kr36ProjectRecord> {
  const fetchImpl = options.fetchImpl ?? fetch
  const configuredAttempts = Number(process.env.KR36_PROJECT_MAX_RETRIES)
  const attempts = Math.max(1, options.attempts
    ?? (options.fetchImpl ? 1 : (Number.isSafeInteger(configuredAttempts) ? configuredAttempts : 3)))
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const configuredDelay = Number(process.env.KR36_PROJECT_REQUEST_MIN_DELAY_MS)
      await waitForRequestSlot(options.minimumDelayMs
        ?? (options.fetchImpl ? 0 : (Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 350)))
      const timeout = AbortSignal.timeout(20_000)
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      const response = await fetchImpl(`${KR36_GATEWAY}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          origin: 'https://pitchhub.36kr.com',
          referer: 'https://pitchhub.36kr.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
        body: JSON.stringify(wrapper(param)),
        signal,
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok || !contentType.toLowerCase().includes('json')) {
        const message = (await response.text()).slice(0, 300)
        const error = Object.assign(new Error(`36氪接口异常 ${response.status}: ${message}`), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        })
        throw error
      }
      const payload = objectValue(await response.json())
      const code = payload.code ?? payload.errCode ?? payload.status
      if (code !== undefined && ![0, 200, '0', '200', 'success'].includes(code as never)) {
        throw Object.assign(new Error(`36氪接口返回业务错误: ${String(code)} ${String(payload.msg ?? payload.message ?? '')}`), {
          retryable: false,
        })
      }
      return payload
    } catch (error) {
      lastError = error
      const retryable = (error as Error & { retryable?: boolean }).retryable
        ?? ['AbortError', 'TimeoutError'].includes((error as Error).name)
      if (!retryable || attempt >= attempts) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 250 * 2 ** (attempt - 1))))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('36氪接口请求失败')
}

export async function fetchKr36ProjectListPage(input: {
  pageNo: number
  year: number
  sort?: 1 | 2 | 3
  tradeIds?: readonly number[]
  fetchImpl?: Kr36Fetch
  signal?: AbortSignal
  minimumDelayMs?: number
}): Promise<Kr36ProjectListPage> {
  const pageNo = Math.max(1, Math.floor(input.pageNo))
  const payload = await requestKr36(LIST_PATH, {
    pageNo,
    pageSize: KR36_PROJECT_PAGE_SIZE,
    sort: input.sort ?? 1,
    establishYearList: [input.year],
    tradeIdList: [...(input.tradeIds ?? KR36_ALL_TRADE_IDS)],
  }, input)
  const data = responseData(payload)
  const items = arrayValue(data.projectList, data.items, data.list, data.records, data.data)
  const page = objectValue(data.page)
  const total = finiteNumber(page.totalCount, data.total, data.totalCount, page.total, items.length)
  if (!Array.isArray(data.projectList) && !Array.isArray(data.items) && !Array.isArray(data.list)
    && !Array.isArray(data.records) && !Array.isArray(data.data)) {
    throw Object.assign(new Error('36氪项目列表响应结构已变化：未找到项目数组'), {
      code: 'KR36_CONTRACT_DRIFT', retryable: false,
    })
  }
  return {
    items,
    total,
    pageNo,
    pageSize: KR36_PROJECT_PAGE_SIZE,
    hasMore: pageNo * KR36_PROJECT_PAGE_SIZE < total || items.length === KR36_PROJECT_PAGE_SIZE,
    raw: payload,
  }
}

export async function fetchKr36ProjectDetail(input: {
  projectId: string | number
  fetchImpl?: Kr36Fetch
  signal?: AbortSignal
  minimumDelayMs?: number
}): Promise<Kr36ProjectRecord> {
  const projectId = String(input.projectId).trim()
  if (!projectId) throw new Error('36氪 projectId 不能为空')
  let payload: Kr36ProjectRecord
  try {
    payload = await requestKr36(DETAIL_PATH, { projectId }, input)
  } catch (error) {
    const status = (error as Error & { status?: number }).status
    if (status !== 404) throw error
    payload = await requestKr36(LEGACY_DETAIL_PATH, { id: projectId }, input)
  }
  const detail = detailData(payload)
  if (!Object.keys(detail).length || !String(detail.name ?? detail.projectName ?? '').trim()) {
    throw Object.assign(new Error('36氪项目详情响应结构已变化：未找到项目主体'), {
      code: 'KR36_CONTRACT_DRIFT', retryable: false,
    })
  }
  return detail
}

export function kr36ProjectId(value: unknown): string {
  const item = objectValue(value)
  return String(item.projectId ?? item.id ?? item.project_id ?? '').trim()
}

export function kr36ProjectUrl(projectId: string | number): string {
  return `https://pitchhub.36kr.com/project/${encodeURIComponent(String(projectId).trim())}`
}
