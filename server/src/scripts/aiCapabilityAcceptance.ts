import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import {
  adminConfigurationRevisions, agentConversations, aiCapabilities, aiCapabilityBindings, aiConversationCapabilities,
  auditLogs, projects, roles, userRoles, users,
} from '../db/schema.js'
import {
  assertAiCapabilityAdmin,
  createCapabilityBinding,
  deleteCapability,
  deleteSkill,
  ensureBuiltinCapabilityCatalog,
  getConversationCapabilities,
  importUploadedCapability,
  importUploadedSkill,
  installUploadedPlugin,
  listCapabilitySettings,
  listAvailableCapabilities,
  resolveSelectedRuntimeCapabilities,
  resolveAgentRuntimePolicy,
  setConversationCapabilities,
  syncBuiltinCapabilities,
  testCapability,
  updateAgentCapabilityPolicy,
  updateCapability,
  updateCapabilityBinding,
  type AiCapabilityActor,
} from '../services/aiCapabilityService.js'
import { selectedSkillsAllowAiTask } from '../runtime/jwAgentRuntime.js'

const marker = randomUUID().slice(0, 8)
const ids = {
  admin: randomUUID(), owner: randomUUID(), outsider: randomUUID(), project: randomUUID(), conversation: randomUUID(),
  global: randomUUID(), department: randomUUID(), projectCap: randomUUID(), forbidden: randomUUID(), forbiddenBinding: randomUUID(),
}
const admin: AiCapabilityActor = { userId: ids.admin, userName: '能力验收管理员', role: '系统管理员', department: '平台部' }
const owner: AiCapabilityActor = { userId: ids.owner, userName: '能力验收用户', role: '投资经理', department: '投资一部' }
const outsider: AiCapabilityActor = { userId: ids.outsider, userName: '能力验收外部用户', role: '投资经理', department: '投资二部' }
const checks: string[] = []
let originalInteractive: typeof aiCapabilities.$inferSelect | null = null
let uploadedPluginId = ''
let uploadedSkillId = ''
let uploadedAgentId = ''
let uploadedMcpId = ''

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function rejects(action: () => unknown | Promise<unknown>, code: string) {
  try { await action() } catch (error) { return (error as { code?: string }).code === code }
  return false
}
async function check(name: string, action: () => unknown | Promise<unknown>) {
  await action(); checks.push(name)
}

async function main() {
  await db.insert(users).values([
    { id: ids.admin, email: `cap-admin-${marker}@example.invalid`, name: admin.userName, role: admin.role, department: admin.department, passwordHash: 'not-used' },
    { id: ids.owner, email: `cap-owner-${marker}@example.invalid`, name: owner.userName, role: owner.role, department: owner.department, passwordHash: 'not-used' },
    { id: ids.outsider, email: `cap-outsider-${marker}@example.invalid`, name: outsider.userName, role: outsider.role, department: outsider.department, passwordHash: 'not-used' },
  ])
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, 'SYSTEM_ADMIN')).limit(1)
  assert(adminRole, '隔离验收库缺少系统管理员角色')
  await db.insert(userRoles).values({ userId: ids.admin, roleId: adminRole.id, isPrimary: true })
  await db.insert(projects).values({ id: ids.project, name: `能力验收项目-${marker}`, owner: owner.userName, ownerUserId: ids.owner, createdBy: ids.owner })
  await db.insert(agentConversations).values({ id: ids.conversation, userId: ids.owner, projectId: ids.project, title: '能力验收会话' })
  await db.insert(aiCapabilities).values([
    { id: ids.global, kind: 'agent', capabilityKey: `accept-global-${marker}`, name: '全局验收能力', source: 'acceptance', allowedRoles: ['投资经理'], createdBy: ids.admin, updatedBy: ids.admin },
    { id: ids.department, kind: 'skill', capabilityKey: `accept-department-${marker}`, name: '部门验收能力', source: 'acceptance', createdBy: ids.admin, updatedBy: ids.admin },
    { id: ids.projectCap, kind: 'mcp', capabilityKey: `accept-project-${marker}`, name: '项目验收能力', source: 'acceptance', createdBy: ids.admin, updatedBy: ids.admin },
    {
      id: ids.forbidden, kind: 'plugin', capabilityKey: `accept-forbidden-${marker}`, name: '未授权验收能力',
      source: 'acceptance', packageVersion: '0.0.0-unapproved', dependencyNames: ['unapproved-dependency'],
      enabled: true, createdBy: ids.admin, updatedBy: ids.admin,
    },
  ])

  await check('builtin-catalog-idempotent-and-four-document-plugins', async () => {
    const first = await ensureBuiltinCapabilityCatalog(); const second = await ensureBuiltinCapabilityCatalog()
    assert(first.capabilities === second.capabilities && first.capabilities > 10, '内置目录数量不稳定')
    const builtins = await db.select().from(aiCapabilities).where(eq(aiCapabilities.source, 'builtin'))
    const documentPlugins = builtins.filter((item) => item.kind === 'plugin')
    assert(documentPlugins.length === 4, `内置文档 Plugin 数量错误：${documentPlugins.length}`)
  })
  await check('admin-service-boundary', async () => {
    assert(await rejects(() => Promise.resolve(assertAiCapabilityAdmin(owner)), 'ROLE_FORBIDDEN'), '普通用户可管理能力')
  })
  await check('unapproved-plugin-is-visible-as-uninstalled-but-cannot-enable-bind-or-run', async () => {
    const settings = await listCapabilitySettings(admin)
    const plugin = settings.capabilities.find((item) => item.id === ids.forbidden)
    assert(plugin && plugin.kind === 'plugin', '未批准 Plugin 未进入管理员盘点')
    assert(plugin.configuredEnabled === true && plugin.enabled === false, '旁路启用 Plugin 未被降级为有效停用')
    assert(plugin.installed === false && plugin.runtimeAvailable === false && plugin.approvalStatus === 'not_approved', '未批准 Plugin 安装态错误')
    assert(plugin.packageVersion === '0.0.0-unapproved' && plugin.dependencyNames[0] === 'unapproved-dependency', 'Plugin 版本或依赖不可见')
    assert(settings.pluginInventory.records >= 5 && settings.pluginInventory.approved >= 4 && settings.pluginInventory.installed >= 4, 'Plugin 汇总状态错误')
    assert(await rejects(() => updateCapability(ids.forbidden, { expectedVersion: 1, enabled: true }, admin), 'PLUGIN_NOT_APPROVED'), '未批准 Plugin 可被启用')
    assert(await rejects(() => createCapabilityBinding({ capabilityId: ids.forbidden, scopeType: 'global' }, admin), 'PLUGIN_NOT_APPROVED'), '未批准 Plugin 可创建授权')
    const testResult = await testCapability(ids.forbidden, admin)
    assert(!testResult.ok && testResult.status === 'failed', '未批准 Plugin 服务端测试未失败关闭')
    await db.insert(aiCapabilityBindings).values({
      id: ids.forbiddenBinding, capabilityId: ids.forbidden, scopeType: 'global', scopeKey: '*', enabled: true,
      createdBy: ids.admin, updatedBy: ids.admin,
    })
    assert(!(await listAvailableCapabilities(owner)).some((item) => item.id === ids.forbidden), '旁路 Plugin 授权进入用户可用能力')
  })
  await check('uploaded-plugin-is-installed-and-runtime-selectable', async () => {
    const installed = await installUploadedPlugin({
      capabilityKey: `accept-uploaded-${marker}`,
      name: '上传验收 Plugin',
      description: '仅使用批准宿主工具的上传 Plugin',
      packageVersion: '1.0.0',
      config: { prompt: '只使用证据支持的结论。' },
      toolNames: ['search_project_docs', 'custom_uploaded_tool'],
    }, admin)
    uploadedPluginId = installed.id
    assert(installed.source === 'uploaded' && installed.enabled, '上传 Plugin 未安装启用')
    assert(installed.toolNames.includes('custom_uploaded_tool'), '上传 Plugin 工具声明被批准目录过滤')
    const settings = await listCapabilitySettings(admin)
    const view = settings.capabilities.find((item) => item.id === installed.id)
    assert(view?.installed && view.runtimeAvailable && view.approvalStatus === 'approved', '上传 Plugin 安装态错误')
    assert(settings.pluginInventory.installed >= 5 && settings.pluginInventory.dynamicInstallEnabled, '上传 Plugin 汇总状态错误')
    assert((await listAvailableCapabilities(owner)).some((item) => item.id === installed.id), '上传 Plugin 未进入用户可用能力')
    await setConversationCapabilities(owner, ids.conversation, [installed.id])
    const runtime = await resolveSelectedRuntimeCapabilities(owner, ids.conversation)
    assert(runtime.some((item) => item.id === installed.id && item.kind === 'plugin'), '上传 Plugin 未进入 Runtime')
  })
  await check('uploaded-skill-imports-without-code-catalog-approval', async () => {
    const input = {
      capabilityKey: `accept-uploaded-skill-${marker}`,
      name: '上传验收 Skill',
      description: '无需代码目录预批准的上传 Skill',
      instructions: '# 上传验收 Skill\n\n只输出有证据支持的结论。',
      allowedRoles: ['投资经理'],
    }
    assert(await rejects(() => importUploadedSkill(input, owner), 'ROLE_FORBIDDEN'), '普通用户可导入 Skill')
    const imported = await importUploadedSkill(input, admin)
    uploadedSkillId = imported.id
    assert(imported.source === 'uploaded' && imported.enabled, '上传 Skill 未直接导入启用')
    assert(imported.config.runtime === 'uploaded-skill' && typeof imported.config.instructions === 'string', '上传 Skill 指令未保存')
    const settings = await listCapabilitySettings(admin)
    assert(settings.capabilities.some((item) => item.id === imported.id), '上传 Skill 未进入管理目录')
    assert((await testCapability(imported.id, admin)).ok, '上传 Skill 服务端测试失败')
    await setConversationCapabilities(owner, ids.conversation, [imported.id])
    const runtime = await resolveSelectedRuntimeCapabilities(owner, ids.conversation)
    assert(runtime.some((item) => item.id === imported.id && item.kind === 'skill'), '上传 Skill 未进入 Runtime')
  })
  await check('uploaded-agent-and-mcp-import-without-code-catalog-approval', async () => {
    const agent = await importUploadedCapability({
      kind: 'agent', capabilityKey: `accept-uploaded-agent-${marker}`, name: '上传验收 Agent',
      description: '直接上传 Agent', config: {
        modelRouteKey: 'interactive-assistant', maxTurns: 4,
        instructions: '作为上传 Agent 处理当前会话。',
      }, toolNames: ['search_project_docs', 'custom_agent_tool'], allowedRoles: ['投资经理'],
    }, admin)
    uploadedAgentId = agent.id
    const mcp = await importUploadedCapability({
      kind: 'mcp', capabilityKey: `accept-uploaded-mcp-${marker}`, name: '上传验收 MCP',
      description: '直接上传 MCP', config: { prompt: '使用上传 MCP 工具。' },
      toolNames: ['search_project_docs', 'custom_mcp_tool'], allowedRoles: ['投资经理'],
    }, admin)
    uploadedMcpId = mcp.id
    assert(agent.source === 'uploaded' && agent.enabled && agent.toolNames.includes('custom_agent_tool'), '上传 Agent 未直接导入')
    assert(mcp.source === 'uploaded' && mcp.enabled && mcp.toolNames.includes('custom_mcp_tool'), '上传 MCP 未直接导入')
    assert((await testCapability(agent.id, admin)).ok, '上传 Agent 服务端测试失败')
    assert((await testCapability(mcp.id, admin)).ok, '上传 MCP 服务端测试失败')
    await setConversationCapabilities(owner, ids.conversation, [agent.id, mcp.id])
    const runtime = await resolveSelectedRuntimeCapabilities(owner, ids.conversation)
    assert(runtime.some((item) => item.id === agent.id && item.kind === 'agent'), '上传 Agent 未进入 Runtime')
    assert(runtime.some((item) => item.id === mcp.id && item.kind === 'mcp'), '上传 MCP 未进入 Runtime')
  })
  await check('structured-agent-policy-is-admin-only-and-code-bounded', async () => {
    const [interactive] = await db.select().from(aiCapabilities).where(and(
      eq(aiCapabilities.kind, 'agent'), eq(aiCapabilities.capabilityKey, 'interactive-assistant'),
    )).limit(1)
    assert(interactive, '互动 Agent 未同步')
    originalInteractive = interactive
    const input = {
      expectedVersion: interactive.version,
      modelRouteKey: 'lead-research' as const,
      timeoutMs: 60_000,
      maxTurns: 3,
      maxBudgetUsd: 0.5,
      toolNames: ['search_project_docs'],
      allowedRoles: ['投资经理'],
    }
    assert(await rejects(() => updateAgentCapabilityPolicy(interactive.id, input, owner), 'ROLE_FORBIDDEN'), '普通用户可修改 Agent 策略')
    const updated = await updateAgentCapabilityPolicy(interactive.id, input, admin)
    const runtimePolicy = await resolveAgentRuntimePolicy('interactive-assistant')
    assert(runtimePolicy.modelRouteKey === 'lead-research', '模型路由策略未进入 Runtime 解析')
    assert(runtimePolicy.timeoutMs === 60_000 && runtimePolicy.maxTurns === 3 && runtimePolicy.maxBudgetUsd === 0.5, '预算或超时上限未进入 Runtime 解析')
    assert(runtimePolicy.toolNames.length === 1 && runtimePolicy.toolNames[0] === 'search_project_docs', '工具收窄未进入 Runtime 解析')
    assert(await rejects(() => updateAgentCapabilityPolicy(interactive.id, { ...input, expectedVersion: updated.version, toolNames: ['Bash'] }, admin), 'AGENT_TOOL_NOT_APPROVED'), '未批准工具可进入 Agent 策略')
    assert(await rejects(() => updateAgentCapabilityPolicy(interactive.id, { ...input, expectedVersion: interactive.version }, admin), 'CAPABILITY_VERSION_CONFLICT'), '过期版本覆盖 Agent 策略')
    assert(await rejects(() => updateAgentCapabilityPolicy(ids.department, { ...input, expectedVersion: 1 }, admin), 'CAPABILITY_KIND_INVALID'), '非 Agent 可写入 Agent 策略')
  })
  await check('builtin-sync-preserves-structured-agent-policy', async () => {
    await syncBuiltinCapabilities(admin)
    const runtimePolicy = await resolveAgentRuntimePolicy('interactive-assistant')
    assert(runtimePolicy.modelRouteKey === 'lead-research' && runtimePolicy.maxTurns === 3, '同步内置目录覆盖了管理员策略')
    assert(runtimePolicy.toolNames.length === 1, '同步内置目录扩张了已收窄工具')
  })
  let globalBindingId = ''
  await check('global-department-project-bindings', async () => {
    const global = await createCapabilityBinding({ capabilityId: ids.global, scopeType: 'global' }, admin)
    globalBindingId = global.id
    await createCapabilityBinding({ capabilityId: ids.department, scopeType: 'department', department: owner.department }, admin)
    await createCapabilityBinding({ capabilityId: ids.projectCap, scopeType: 'project', projectId: ids.project }, admin)
    const list = await listAvailableCapabilities(owner, ids.project)
    const effective = new Set(list.map((item) => item.id))
    assert(effective.has(ids.global) && effective.has(ids.department) && effective.has(ids.projectCap), '授权并集不完整')
    assert(!effective.has(ids.forbidden), '无绑定能力被授权')
  })
  await check('department-and-project-isolation', async () => {
    const outsiderList = await listAvailableCapabilities(outsider)
    assert(outsiderList.some((item) => item.id === ids.global), '全局授权未生效')
    assert(!outsiderList.some((item) => new Set<string>([ids.department, ids.projectCap]).has(item.id)), '部门或项目授权串域')
    assert(await rejects(() => listAvailableCapabilities(outsider, ids.project), 'PROJECT_FORBIDDEN'), '外部用户可探测项目能力')
  })
  await check('conversation-selection-cannot-grant', async () => {
    const selected = await setConversationCapabilities(owner, ids.conversation, [ids.global, ids.projectCap])
    assert(selected.selectedIds.length === 2, '会话选择未保存')
    assert(await rejects(() => setConversationCapabilities(owner, ids.conversation, [ids.forbidden]), 'CAPABILITY_FORBIDDEN'), '会话选择产生了授权')
    assert(await rejects(() => getConversationCapabilities(outsider, ids.conversation), 'CONVERSATION_FORBIDDEN'), '外部用户读取了会话能力')
  })
  await check('runtime-selection-is-approved-code-only', async () => {
    await setConversationCapabilities(owner, ids.conversation, [ids.global, ids.projectCap])
    const runtime = await resolveSelectedRuntimeCapabilities(owner, ids.conversation)
    assert(!runtime.some((item) => new Set<string>([ids.global, ids.projectCap]).has(item.id)), '非代码目录能力进入 Runtime')
  })
  await check('all-capability-kinds-delete-is-admin-only-versioned-and-cascades-selections', async () => {
    const deletions = [
      { id: uploadedSkillId, kind: 'skill' },
      { id: uploadedAgentId, kind: 'agent' },
      { id: uploadedMcpId, kind: 'mcp' },
      { id: uploadedPluginId, kind: 'plugin' },
    ] as const
    await setConversationCapabilities(owner, ids.conversation, deletions.map((item) => item.id))
    assert(await rejects(() => deleteCapability(uploadedSkillId, 1, owner), 'ROLE_FORBIDDEN'), '普通用户可删除能力')
    assert(await rejects(() => deleteSkill(ids.projectCap, 1, admin), 'CAPABILITY_KIND_INVALID'), 'Skill 删除接口可删除其他能力')
    assert(await rejects(() => deleteCapability(uploadedSkillId, 2, admin), 'CAPABILITY_VERSION_CONFLICT'), '过期版本可删除能力')
    for (const deletion of deletions) {
      const result = await deleteCapability(deletion.id, 1, admin)
      assert(result.deleted && result.id === deletion.id && result.kind === deletion.kind, `${deletion.kind} 删除结果错误`)
      const [deletedCapabilities, deletedBindings, deletedSelections] = await Promise.all([
        db.select().from(aiCapabilities).where(eq(aiCapabilities.id, deletion.id)),
        db.select().from(aiCapabilityBindings).where(eq(aiCapabilityBindings.capabilityId, deletion.id)),
        db.select().from(aiConversationCapabilities).where(eq(aiConversationCapabilities.capabilityId, deletion.id)),
      ])
      assert(!deletedCapabilities.length, `${deletion.kind} 记录未删除`)
      assert(!deletedBindings.length, `${deletion.kind} 作用域授权未级联删除`)
      assert(!deletedSelections.length, `${deletion.kind} 会话选择未级联删除`)
    }
  })
  await check('document-task-requires-selected-skill', () => {
    assert(selectedSkillsAllowAiTask(new Set(['draft-investment-proposal']), 'investment_proposal'), '已选 Skill 未放行对应任务')
    assert(!selectedSkillsAllowAiTask(new Set(['draft-investment-proposal']), 'due_diligence_report'), '未选 Skill 的任务被放行')
  })
  await check('disable-capability-effective-immediately', async () => {
    const [capability] = await db.select().from(aiCapabilities).where(eq(aiCapabilities.id, ids.global)).limit(1)
    await updateCapability(ids.global, { expectedVersion: capability.version, enabled: false }, admin)
    assert(!(await listAvailableCapabilities(owner, ids.project)).some((item) => item.id === ids.global), '停用能力仍可用')
  })
  await check('disable-binding-effective-immediately', async () => {
    const [binding] = await db.select().from(aiCapabilityBindings).where(eq(aiCapabilityBindings.id, globalBindingId)).limit(1)
    await updateCapabilityBinding(binding.id, { expectedVersion: binding.version, enabled: false }, admin)
    assert(binding.enabled, '验收前授权状态异常')
  })
  await check('approved-skill-server-test-and-trace', async () => {
    const [skill] = await db.select().from(aiCapabilities).where(and(
      eq(aiCapabilities.kind, 'skill'), eq(aiCapabilities.capabilityKey, 'draft-investment-qa'),
    )).limit(1)
    assert(skill, '批准 Skill 未同步')
    const result = await testCapability(skill.id, admin)
    assert(result.ok && Boolean(result.traceId), `Skill 测试失败：${result.error}`)
  })
  await check('deleted-builtin-capability-kinds-stay-hidden-on-startup-ensure-and-can-be-manually-synced', async () => {
    const builtins = await db.select().from(aiCapabilities).where(eq(aiCapabilities.source, 'builtin'))
    const targets = (['skill', 'agent', 'mcp', 'plugin'] as const).map((kind) => {
      const target = builtins.find((item) => item.kind === kind && (kind !== 'agent' || item.capabilityKey !== 'interactive-assistant'))
      assert(target, `删除验收内置 ${kind} 不存在`)
      return target
    })
    for (const target of targets) await deleteCapability(target.id, target.version, admin)
    await ensureBuiltinCapabilityCatalog()
    const hiddenSettings = await listCapabilitySettings(admin)
    for (const target of targets) {
      assert(!hiddenSettings.capabilities.some((item) => item.id === target.id), `已删除内置 ${target.kind} 在启动目录确保后重新出现`)
      const [tombstone] = await db.select().from(aiCapabilities).where(eq(aiCapabilities.id, target.id)).limit(1)
      assert(tombstone?.source === 'deleted' && !tombstone.enabled, `内置 ${target.kind} 删除标记未保留`)
    }
    await syncBuiltinCapabilities(admin)
    for (const target of targets) {
      const [restored] = await db.select().from(aiCapabilities).where(eq(aiCapabilities.id, target.id)).limit(1)
      const [restoredBinding] = await db.select().from(aiCapabilityBindings).where(and(
        eq(aiCapabilityBindings.capabilityId, target.id), eq(aiCapabilityBindings.scopeType, 'global'),
      )).limit(1)
      assert(restored?.source === 'builtin' && restored.enabled && restoredBinding?.enabled, `手动同步未恢复内置 ${target.kind} 及全局授权`)
    }
  })
  await check('audit-recorded-without-runtime-secret', async () => {
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, ids.admin), eq(auditLogs.module, '能力管理')))
    assert(rows.length >= 5, '管理操作未审计')
    assert(!JSON.stringify(rows).toLowerCase().includes('api_key'), '审计包含疑似密钥字段')
  })

  console.log(JSON.stringify({ ok: true, checks, count: checks.length }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  await db.delete(adminConfigurationRevisions).where(eq(adminConfigurationRevisions.createdBy, ids.admin)).catch(() => undefined)
  if (originalInteractive) await db.update(aiCapabilities).set({
    name: originalInteractive.name,
    description: originalInteractive.description,
    config: originalInteractive.config,
    toolNames: originalInteractive.toolNames,
    dependencyNames: originalInteractive.dependencyNames,
    allowedRoles: originalInteractive.allowedRoles,
    enabled: originalInteractive.enabled,
    version: originalInteractive.version,
    updatedBy: originalInteractive.updatedBy,
    updatedAt: originalInteractive.updatedAt,
  }).where(eq(aiCapabilities.id, originalInteractive.id)).catch(() => undefined)
  await db.delete(auditLogs).where(inArray(auditLogs.userId, [ids.admin, ids.owner, ids.outsider])).catch(() => undefined)
  await db.delete(aiConversationCapabilities).where(eq(aiConversationCapabilities.conversationId, ids.conversation)).catch(() => undefined)
  if (uploadedPluginId) await db.delete(aiCapabilityBindings).where(eq(aiCapabilityBindings.capabilityId, uploadedPluginId)).catch(() => undefined)
  if (uploadedPluginId) await db.delete(aiCapabilities).where(eq(aiCapabilities.id, uploadedPluginId)).catch(() => undefined)
  if (uploadedSkillId) await db.delete(aiCapabilityBindings).where(eq(aiCapabilityBindings.capabilityId, uploadedSkillId)).catch(() => undefined)
  if (uploadedSkillId) await db.delete(aiCapabilities).where(eq(aiCapabilities.id, uploadedSkillId)).catch(() => undefined)
  if (uploadedAgentId) await db.delete(aiCapabilityBindings).where(eq(aiCapabilityBindings.capabilityId, uploadedAgentId)).catch(() => undefined)
  if (uploadedAgentId) await db.delete(aiCapabilities).where(eq(aiCapabilities.id, uploadedAgentId)).catch(() => undefined)
  if (uploadedMcpId) await db.delete(aiCapabilityBindings).where(eq(aiCapabilityBindings.capabilityId, uploadedMcpId)).catch(() => undefined)
  if (uploadedMcpId) await db.delete(aiCapabilities).where(eq(aiCapabilities.id, uploadedMcpId)).catch(() => undefined)
  await db.delete(agentConversations).where(eq(agentConversations.id, ids.conversation)).catch(() => undefined)
  await db.delete(aiCapabilities).where(inArray(aiCapabilities.id, [ids.global, ids.department, ids.projectCap, ids.forbidden])).catch(() => undefined)
  await db.delete(projects).where(eq(projects.id, ids.project)).catch(() => undefined)
  await db.delete(users).where(inArray(users.id, [ids.admin, ids.owner, ids.outsider])).catch(() => undefined)
  await pool.end()
})
