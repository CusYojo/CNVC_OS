import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/src/db/schema.ts',
  out: './server/drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgres://cybernaut:cyb_mvp_2026@127.0.0.1:5432/cybernaut_mvp',
  },
})
