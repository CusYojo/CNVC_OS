import { z } from 'zod'

// Keep the email field for existing API clients; the UI uses identifier.
export const LoginSchema = z.object({
  identifier: z.string().trim().min(1).max(255).optional(),
  email: z.string().trim().email().max(255).optional(),
  password: z.string().min(1).max(128),
  remember: z.boolean().optional().default(false),
}).refine((input) => Boolean(input.identifier || input.email), {
  message: '请输入姓名或邮箱', path: ['identifier'],
}).refine((input) => !input.identifier || !input.email || input.identifier.toLowerCase() === input.email.toLowerCase(), {
  message: '不能同时提供不同的登录账号', path: ['identifier'],
}).transform((input) => ({
  identifier: input.identifier || input.email!, password: input.password, remember: input.remember,
}))
