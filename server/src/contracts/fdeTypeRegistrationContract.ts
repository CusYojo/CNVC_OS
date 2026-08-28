import { z } from 'zod'
import { fdeDate } from './fdeTaskContract.js'
import { previewTypePlan, typePolicyDefinition, type TypePolicyDefinition } from './fdeTypePolicyContract.js'

export const typeRegistrationCommand = z.object({
  commandId: z.string().uuid(), policyId: z.string().uuid(), versionId: z.string().uuid(),
  expectedPolicyVersion: z.number().int().positive(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(128), targetDate: fdeDate, cycleDays: z.number().int(),
  reason: z.string().trim().min(5).max(2000),
}).strict()
export type TypeRegistrationCommand = z.infer<typeof typeRegistrationCommand>
export const typeRegistrationReceipt = z.object({ commandId: z.string().uuid(), projectId: z.string().uuid(), policyId: z.string().uuid(), versionId: z.string().uuid(), version: z.literal(1) }).strict()
export type TypeRegistrationReceipt = z.infer<typeof typeRegistrationReceipt>
export const typeRegistrationRecovery = z.object({ commandId: z.string().uuid() }).strict()
export const typeRegistrationOption = z.object({ policyId: z.string().uuid(), versionId: z.string().uuid(), policyVersion: z.number().int().positive(), sha256: z.string(), name: z.string(), configuration: typePolicyDefinition })
export const typeRegistrationOptions = z.object({ policies: z.array(typeRegistrationOption) }).strict()

export function typeBoundVersionMayAdvance(configuration: TypePolicyDefinition, headEnabled: boolean, hasActivationEvidence: boolean) {
  return configuration.registration ? configuration.registration.onDisable === 'continue_bound_version' && hasActivationEvidence : headEnabled
}

// Only an explicitly reviewed registration policy can create a new project.
// Current implementation supports self-owned registration and continuation of
// the bound version; it does not silently pick either rule for old definitions.
export function prepareTypeRegistration(configuration: TypePolicyDefinition, input: { cycleDays: number; targetDate: string }, actorRoleIds: string[]) {
  const parsed = typePolicyDefinition.parse(configuration)
  if (!parsed.registration || !parsed.planApprovals?.length) throw new Error('模板缺少独立审核的登记或计划审批规则')
  if (!parsed.registration.roleIds.some(id => actorRoleIds.includes(id))) throw new Error('当前有效角色未获该模板的登记授权')
  const preview = previewTypePlan({ configuration: parsed, cycleDays: input.cycleDays, targetDate: input.targetDate })
  return { stage: parsed.stages[0].name, classification: parsed.registration.classification, targetDate: preview.targetDate, cycleDays: preview.cycleDays }
}
