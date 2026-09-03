import { z } from 'zod'

const password = z.string().min(1).max(128)

export const AccountRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(64),
  email: z.email().max(255),
  role: z.string().trim().min(1).max(64),
  department: z.string().trim().min(1).max(64),
  password,
}).strict()

export const ChangeOwnPasswordSchema = z.object({
  currentPassword: password,
  newPassword: password,
}).strict()
