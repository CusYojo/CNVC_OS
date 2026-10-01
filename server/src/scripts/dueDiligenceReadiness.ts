import { db, pool } from '../db/client.js'
import { digitalTwinPrivateAssets, digitalTwinSkillImports, digitalTwins, dueDiligenceTranscriptionJobs } from '../db/schema.js'
import { resolveAiModelRoute } from '../services/aiModelSettingsService.js'
import { getDueDiligenceAsrCapability } from '../services/dueDiligenceAsrService.js'

type Check = { name: string; ready: boolean; required: boolean; detail: string }
const checks: Check[] = []
const required = (name: string, ready: boolean, detail: string) => checks.push({ name, ready, required: true, detail })
const optional = (name: string, ready: boolean, detail: string) => checks.push({ name, ready, required: false, detail })

try {
  const origins = (process.env.AUTH_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  const productionOriginReady = process.env.NODE_ENV !== 'production' || origins.includes('https://cybernaut.newmin.cn')
  required('production-origin', productionOriginReady, process.env.NODE_ENV !== 'production' ? '非生产环境，不校验生产域名' : productionOriginReady ? '生产域名已加入可信来源' : '需设置 AUTH_ALLOWED_ORIGINS=https://cybernaut.newmin.cn')

  const schemaChecks = await Promise.all([
    db.select({ id: dueDiligenceTranscriptionJobs.id }).from(dueDiligenceTranscriptionJobs).limit(1),
    db.select({ avatarKind: digitalTwins.avatarKind }).from(digitalTwins).limit(1),
    db.select({ id: digitalTwinPrivateAssets.id }).from(digitalTwinPrivateAssets).limit(1),
    db.select({ id: digitalTwinSkillImports.id }).from(digitalTwinSkillImports).limit(1),
  ].map(promise => promise.then(() => true).catch(() => false)))
  required('database-schema-0133', schemaChecks.every(Boolean), schemaChecks.every(Boolean) ? '尽调转写、头像和 Skill 数据表已就绪' : '请先执行数据库迁移至 0133')

  const [documentModel, interactiveModel] = await Promise.all([
    resolveAiModelRoute('ai-document').catch(() => null),
    resolveAiModelRoute('interactive-assistant').catch(() => null),
  ])
  optional('ai-document', Boolean(documentModel), documentModel ? `已配置 ${documentModel.model}` : '未配置；标准尽调清单仍可用')
  optional('interactive-assistant', Boolean(interactiveModel), interactiveModel ? `已配置 ${interactiveModel.model}` : '未配置；分身对话和智能提炼不可用')
  const asr = getDueDiligenceAsrCapability()
  optional('background-asr', asr.configured, asr.configured ? `已配置 ${asr.model}` : '未配置；仍可保存录音和浏览器转写')
} finally {
  await pool.end()
}

console.log(JSON.stringify({ ok: checks.filter(item => item.required).every(item => item.ready), checks }, null, 2))
if (checks.some(item => item.required && !item.ready)) process.exitCode = 1
