import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './server/src/db/schema.ts',
  out: './server/drizzle',
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DB_HOST ?? '',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_DATABASE ?? '',
    user: process.env.DB_USERNAME ?? '',
    password: process.env.DB_PASSWORD ?? '',
  },
})
