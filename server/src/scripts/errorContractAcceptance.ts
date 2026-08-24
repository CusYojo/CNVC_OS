import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { errorHandler } from '../middleware/errorHandler.js'
import { apiErrorFromResponse } from '../contracts/apiErrorContract.js'

type CapturedResponse = { status: number; body: Record<string, unknown> }

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[error contract] ${message}`)
}

function invokeError(error: unknown, requestId: string): CapturedResponse {
  let status = 200
  let body: Record<string, unknown> = {}
  const response = {
    locals: { requestId },
    status(value: number) {
      status = value
      return this
    },
    json(value: Record<string, unknown>) {
      body = value
      return this
    },
  } as unknown as Response
  const request = { method: 'GET', path: '/api/error-contract-fixture' } as Request
  const originalError = console.error
  const originalWarn = console.warn
  console.error = () => {}
  console.warn = () => {}
  try {
    errorHandler(error, request, response, (() => {}) as NextFunction)
  } finally {
    console.error = originalError
    console.warn = originalWarn
  }
  return { status, body }
}

async function persistEvidence(report: Record<string, unknown>) {
  const evidenceDir = path.resolve('.runtime/migration-evidence/error-contract')
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await chmod(evidenceDir, 0o700)
  const reportPath = path.join(evidenceDir, 'report.json')
  const summaryPath = path.join(evidenceDir, 'summary.md')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(summaryPath, [
    '# API 与 Agent 错误契约验收',
    '',
    `- 结果：${report.ok ? '通过' : '未通过'}`,
    '- 400、401、403、404、409、500 使用统一 code/message/details/requestId 契约',
    '- 500 只向客户端返回通用中文消息，内部异常和敏感内容不进入响应',
    '- 前端仅在响应头和正文请求编号完全匹配且格式合法时展示追踪编号',
    '- AI Task 失败和界面渲染异常继续显示独立错误编号',
    '',
    '报告不记录错误原文、请求路径、编号值、身份或连接信息。',
    '',
  ].join('\n'), { mode: 0o600 })
  await Promise.all([chmod(reportPath, 0o600), chmod(summaryPath, 0o600)])
}

async function main() {
  const requestId = 'error-contract-acceptance-001'
  const typedCases = [
    { status: 401, code: 'AUTH_REQUIRED', message: '请先登录' },
    { status: 403, code: 'ROLE_FORBIDDEN', message: '没有权限执行此操作' },
    { status: 404, code: 'NOT_FOUND', message: '资源不存在' },
    { status: 409, code: 'STATE_CONFLICT', message: '资源状态冲突' },
  ]
  for (const fixture of typedCases) {
    const result = invokeError(Object.assign(new Error(fixture.message), { status: fixture.status, code: fixture.code }), requestId)
    assertContract(result.status === fixture.status, `${fixture.status} response status mismatch`)
    assertContract(result.body.code === fixture.code && result.body.message === fixture.message, `${fixture.status} safe code/message mismatch`)
    assertContract(result.body.details === null && result.body.requestId === requestId, `${fixture.status} details/requestId mismatch`)
  }
  const zodError = (() => {
    try {
      z.string().uuid().parse('not-a-uuid')
      throw new Error('zod fixture unexpectedly passed')
    } catch (error) {
      return error
    }
  })()
  const invalid = invokeError(zodError, requestId)
  assertContract(invalid.status === 400 && invalid.body.code === 'INVALID_ARGUMENT', '400 validation contract mismatch')
  assertContract(Array.isArray(invalid.body.details) && invalid.body.requestId === requestId, '400 validation details/requestId mismatch')

  const internalMarker = 'internal-database-password-and-path-must-not-leak'
  const internal = invokeError(new Error(internalMarker), requestId)
  assertContract(internal.status === 500, '500 status mismatch')
  assertContract(internal.body.code === 'INTERNAL_ERROR' && internal.body.message === '服务器内部错误', '500 safe response mismatch')
  assertContract(internal.body.details === null && internal.body.requestId === requestId, '500 details/requestId mismatch')
  assertContract(!JSON.stringify(internal.body).includes(internalMarker), '500 response disclosed internal error text')

  for (const fixture of [...typedCases, { status: 500, code: 'INTERNAL_ERROR', message: '服务器内部错误' }]) {
    const frontend = apiErrorFromResponse(
      fixture.status,
      { code: fixture.code, message: fixture.message, details: null, requestId },
      requestId,
    )
    assertContract(frontend.status === fixture.status && frontend.code === fixture.code, `${fixture.status} frontend code/status mismatch`)
    assertContract(frontend.baseMessage === fixture.message && frontend.requestId === requestId, `${fixture.status} frontend base/requestId mismatch`)
    assertContract(frontend.message.includes(fixture.message) && frontend.message.includes(requestId), `${fixture.status} visible message lacks trace ID`)
  }
  const spoofed = apiErrorFromResponse(403, {
    code: 'ROLE_FORBIDDEN', message: '没有权限执行此操作', requestId: 'spoofed-request-id',
  }, requestId)
  assertContract(spoofed.requestId === undefined && !spoofed.message.includes('spoofed-request-id'), 'mismatched body/header request ID was trusted')
  const malformed = apiErrorFromResponse(500, {
    code: 'INTERNAL_ERROR', message: '服务器内部错误', requestId: '<script>alert(1)</script>',
  }, '<script>alert(1)</script>')
  assertContract(malformed.requestId === undefined && !malformed.message.includes('<script>'), 'malformed request ID was trusted')

  const [serverEntry, apiContractSource, clientApiSource, taskCards, taskConversation, errorBoundary, assistantPage] = await Promise.all([
    readFile(path.resolve('server/src/index.ts'), 'utf8'),
    readFile(path.resolve('server/src/contracts/apiErrorContract.ts'), 'utf8'),
    readFile(path.resolve('src/lib/api.ts'), 'utf8'),
    readFile(path.resolve('src/components/AiTaskCards.tsx'), 'utf8'),
    readFile(path.resolve('src/components/AiTaskConversationMessage.tsx'), 'utf8'),
    readFile(path.resolve('src/components/AiErrorBoundary.tsx'), 'utf8'),
    readFile(path.resolve('src/pages/AIAssistantPage.tsx'), 'utf8'),
  ])
  assertContract(/res\.statusCode >= 400/.test(serverEntry) && /requestId: errorBody\.requestId \|\| requestId/.test(serverEntry), 'manual route errors are not centrally enriched')
  assertContract(/bodyRequestId === headerRequestId/.test(apiContractSource) && /\^\[A-Za-z0-9\._:-\]\{8,64\}\$/.test(apiContractSource), 'frontend request ID validation is missing')
  assertContract(/server\/src\/contracts\/apiErrorContract/.test(clientApiSource), 'frontend does not consume the shared error contract')
  assertContract(
    /错误编号：\{task\.errorId\}/.test(taskCards)
      && /错误编号：\{task\.errorId\}/.test(taskConversation),
    'AI task error ID is not rendered in both historical and chat-native views',
  )
  assertContract(/错误编号：\{this\.state\.errorId\}/.test(errorBoundary), 'AI render error ID is not rendered')
  assertContract(
    /发送失败：\$\{\(err as Error\)\.message\}/.test(assistantPage)
      && /agentError\.message/.test(assistantPage),
    'chat-native Agent errors do not retain the safe API message and server trace ID',
  )

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    statuses: [400, 401, 403, 404, 409, 500],
    serverContracts: 6,
    frontendContracts: 6,
    spoofedRequestIdsAccepted: 0,
    internalMarkersDisclosed: 0,
    checks: [
      'uniform-400-401-403-404-409-500-error-shape',
      'internal-500-message-and-detail-redaction',
      'manual-route-error-request-id-enrichment',
      'frontend-header-body-request-id-match',
      'frontend-request-id-format-rejection',
      'visible-safe-message-retains-trace-id',
      'ai-task-and-render-error-id-visible',
      'evidence-excludes-errors-paths-identities-and-request-ids',
    ],
  }
  await persistEvidence(report)
  console.log(JSON.stringify(report))
}

await main()
