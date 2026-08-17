import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { auditLogs, users } from '../db/schema.js'
import {
  assertJwAgentGatewayAllowed,
  classifyJwAgentBoundary,
  denyJwAgentToolCall,
  JW_AGENT_ALLOWED_TOOLS,
  jwAgentToolAllowed,
  resolveJwAgentWorkspace,
  restrictedJwAgentEnvironment,
} from '../runtime/jwAgentRuntime.js'
import { runWithRequestLogContext } from '../runtime/structuredLogger.js'
import { hashPassword } from '../services/authService.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const marker = randomUUID()
  const requestId = `jw-boundary-${marker}`
  const [user] = await db.insert(users).values({
    email: `jw-boundary-${marker}@example.invalid`,
    name: 'Runtime边界验收用户',
    role: '投资经理',
    department: '验收部',
    passwordHash: await hashPassword(randomUUID()),
  }).$returningId()
  try {
    const attacks = [
      { toolName: 'Read', boundary: 'file' },
      { toolName: 'Bash', boundary: 'subprocess' },
      { toolName: 'WebFetch', boundary: 'network' },
      { toolName: 'mcp__mysql__query', boundary: 'database' },
      { toolName: 'Skill', boundary: 'dynamic-load' },
    ] as const
    const results = await runWithRequestLogContext(requestId, () => Promise.all(attacks.map(({ toolName }) => (
      denyJwAgentToolCall({ toolName, userId: user.id, userName: 'Runtime边界验收用户', conversationId: marker })
    ))))
    assert(results.every((result) => result.behavior === 'deny'), 'one or more out-of-allowlist tools were not denied')
    const rows = await db.select({ target: auditLogs.target, result: auditLogs.result, requestId: auditLogs.requestId })
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, user.id), eq(auditLogs.action, '拒绝 Agent Runtime 越界访问')))
    assert(rows.length === attacks.length, 'runtime boundary denial audit count mismatch')
    const auditedBoundaries = new Set(rows.map((row) => {
      assert(typeof row.target === 'string', 'runtime boundary audit target is missing')
      const target = JSON.parse(row.target) as { boundary?: string }
      assert(row.result === 'denied', 'runtime boundary audit result is not denied')
      assert(row.requestId === requestId, 'runtime boundary audit request ID mismatch')
      return target.boundary
    }))
    for (const { toolName, boundary } of attacks) {
      assert(classifyJwAgentBoundary(toolName) === boundary, `runtime boundary classification mismatch: ${boundary}`)
      assert(auditedBoundaries.has(boundary), `runtime boundary audit is missing: ${boundary}`)
    }
    assert(JW_AGENT_ALLOWED_TOOLS.every((toolName) => jwAgentToolAllowed(toolName)), 'approved tool was rejected')
    assert(!jwAgentToolAllowed('Bash') && !jwAgentToolAllowed('mcp__mysql__query'), 'unapproved tool entered allowlist')

    const fakeSecret = 'fixture-database-secret-never-in-agent-env'
    const restricted = restrictedJwAgentEnvironment({
      baseUrl: 'https://gateway.example.invalid/api', apiKey: 'fixture-model-key', model: 'fixture-model',
    }, `/tmp/jw-${marker}`, {
      PATH: '/usr/bin', LANG: 'C.UTF-8', DB_PASSWORD: fakeSecret, INTERNAL_SECRET: fakeSecret,
    })
    assert(restricted.ANTHROPIC_API_KEY === 'fixture-model-key', 'model credential missing from restricted environment')
    assert(!('DB_PASSWORD' in restricted) && !('INTERNAL_SECRET' in restricted), 'database or internal secret leaked into Agent environment')
    assert(!JSON.stringify(restricted).includes(fakeSecret), 'restricted Agent environment contains a host secret')

    const workspace = resolveJwAgentWorkspace('/tmp/jw-runtime-acceptance', marker)
    assert(workspace.endsWith(marker), 'valid conversation workspace resolution failed')
    let traversalRejected = false
    try { resolveJwAgentWorkspace('/tmp/jw-runtime-acceptance', '../escape') } catch { traversalRejected = true }
    assert(traversalRejected, 'workspace traversal identifier was accepted')

    assertJwAgentGatewayAllowed('https://gateway.example.invalid/api', {
      NODE_ENV: 'production', MODEL_PROVIDER_ALLOWED_HOSTS: 'gateway.example.invalid',
    })
    let gatewayRejected = false
    try {
      assertJwAgentGatewayAllowed('https://outside.example.invalid/api', {
        NODE_ENV: 'production', MODEL_PROVIDER_ALLOWED_HOSTS: 'gateway.example.invalid',
      })
    } catch { gatewayRejected = true }
    assert(gatewayRejected, 'out-of-allowlist Agent gateway was accepted')

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'file-subprocess-network-database-dynamic-load-denied',
        'denials-persist-actor-result-and-request-id',
        'approved-tool-exact-allowlist',
        'agent-subprocess-environment-excludes-database-and-internal-secrets',
        'conversation-workspace-traversal-rejected',
        'model-gateway-host-allowlist-enforced',
      ],
    }))
  } finally {
    await db.delete(auditLogs).where(eq(auditLogs.userId, user.id)).catch(() => {})
    await db.delete(users).where(inArray(users.id, [user.id])).catch(() => {})
  }
}

await main().finally(async () => pool.end())
