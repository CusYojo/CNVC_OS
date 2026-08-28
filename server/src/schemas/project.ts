import { z } from 'zod'

const optionalText = z.preprocess(
  (value) => value === null ? undefined : value,
  z.string().optional(),
)

const stringList = z.preprocess(
  (value) => {
    if (value === null || value === undefined) return []
    if (!Array.isArray(value)) return value
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  },
  z.array(z.string()).default([]),
)

export const ProjectCreateSchema = z.object({
  name: z.string().min(1),
  companyName: optionalText,
  industry: optionalText,
  round: optionalText,
  stage: z.string().default('入库'),
  // The API derives the owner from the authenticated session. Keep this
  // optional for compatibility with older clients and lead conversion calls;
  // the project route never trusts a client-supplied owner value.
  owner: optionalText,
  collaborators: stringList,
  source: optionalText,
  financing: optionalText,
  valuation: optionalText,
  investmentFund: z.string().trim().max(128).optional(),
  requirements: z.string().trim().max(8000).optional(),
  riskLevel: z.enum(['高', '中', '低']).default('低'),
  summary: optionalText,
  businessModel: optionalText,
  market: optionalText,
  team: optionalText,
  tags: stringList,
  stageSource: optionalText,
})
