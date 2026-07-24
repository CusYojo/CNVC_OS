import pathlib

# 1. sync-radar 入库 score=0
p1 = pathlib.Path('server/src/routes/meta.ts')
s1 = p1.read_text(encoding='utf-8')
old1 = "        score: typeof it.attention_score === 'number' ? it.attention_score : 0,"
new1 = "        score: 0,  // 入库不给分:必须等 AI 分析完成才有真实评分(未分析的前端不显示)"
assert old1 in s1, "sync-radar score 行没匹配上"
s1 = s1.replace(old1, new1, 1)
p1.write_text(s1, encoding='utf-8')
print("1. sync-radar 入库 score=0 OK")

# 2. listLeads 只显示已分析的
p2 = pathlib.Path('server/src/services/aiSummaryService.ts')
s2 = p2.read_text(encoding='utf-8')
old2 = "  const conds: ReturnType<typeof sql>[] = []\n  if (channel) conds.push(sql`${leads.radarProfile}->>'channel' = ${channel}`)"
new2 = """  const conds: ReturnType<typeof sql>[] = []
  // 规则: 任何渠道来的线索必须先过 AI 分析,分析完成(scoring.dimensions 非空)才在前端显示。
  // 未分析的入库但不展示,分析完自动出现。SHOW_UNANALYZED=1 临时看全部(调试)。
  if (process.env.SHOW_UNANALYZED !== '1') {
    conds.push(sql`(${leads.scoring}->'dimensions' IS NOT NULL AND jsonb_array_length(${leads.scoring}->'dimensions') > 0)`)
  }
  if (channel) conds.push(sql`${leads.radarProfile}->>'channel' = ${channel}`)"""
assert old2 in s2, "conds 初始化段没匹配上"
s2 = s2.replace(old2, new2, 1)
p2.write_text(s2, encoding='utf-8')
print("2. listLeads 仅显示已分析 OK")
