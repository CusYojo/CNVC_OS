import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import type { FdeSourceAccount } from '../../contracts/fdeIdentityImportContract.js'

const fields = ['id', 'username', 'displayName', 'displayRole', 'department', 'policyKey', 'specialty', 'status'] as const

export function parseFdeSeedAccounts(source: string): FdeSourceAccount[] {
  const file = ts.createSourceFile('accounts.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const declarations = file.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
  const initializer = declarations.find(d => ts.isIdentifier(d.name) && d.name.text === 'COMPANY_ACCOUNTS')?.initializer
  if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText(file) !== 'Object.freeze' || initializer.arguments.length !== 1 || !ts.isArrayLiteralExpression(initializer.arguments[0])) throw new Error('无法静态读取 COMPANY_ACCOUNTS；不会执行源系统代码')
  return initializer.arguments[0].elements.map(element => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error('源账号必须为静态对象')
    const account: Record<string, string> = { status: 'active' }
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) throw new Error('源账号不允许动态字段')
      if (!fields.includes(property.name.text as typeof fields[number])) continue
      if (!ts.isStringLiteral(property.initializer)) throw new Error('源账号身份字段必须为静态字符串')
      account[property.name.text] = property.initializer.text
    }
    if (fields.some(f => typeof account[f] !== 'string')) throw new Error('源账号缺少必要身份字段')
    return account as FdeSourceAccount
  })
}

export async function readFdeIdentitySource(sourceRoot: string) {
  const seedFile = path.join(sourceRoot, 'worker/accounts.mjs')
  const databaseFile = path.join(sourceRoot, '.local-data/saizhi.sqlite3')
  const accounts = parseFdeSeedAccounts(await readFile(seedFile, 'utf8'))
  // Read the live SQLite state, not backup files or mock UI organization data.
  // Project content, session tokens and password material never enter reports.
  const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', databaseFile,
    "SELECT version,updated_at,json_extract(payload_json,'$.credentials') AS credentials FROM local_state WHERE state_key='workspace'"],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as { version: number; updated_at: string; credentials: string }[]
  if (rows.length !== 1) throw new Error('源 SQLite workspace 必须唯一存在')
  const credentials: unknown = JSON.parse(rows[0].credentials)
  if (!Array.isArray(credentials)) throw new Error('源 credentials 不是数组')
  for (const value of credentials) {
    if (!value || typeof value !== 'object') throw new Error('源新增账号格式不正确')
    const safe = Object.fromEntries(fields.map(key => [key, value[key] ?? (key === 'status' ? 'active' : undefined)]))
    if (fields.some(f => typeof safe[f] !== 'string')) throw new Error('源新增账号缺少必要身份字段')
    accounts.push(safe as FdeSourceAccount)
  }
  return { accounts, sourceRoot, seedFile, databaseFile, sqliteVersion: rows[0].version, sqliteUpdatedAt: rows[0].updated_at }
}
