import pathlib
p = pathlib.Path('server/src/services/aiSummaryService.ts')
s = p.read_text(encoding='utf-8')
start = s.index("export async function leadPoolStats")
end = s.index("export async function", start+10)
seg = s[start:end]
seg2 = seg.replace(
  "  }).from(leads)\n",
  "  }).from(leads).where(process.env.SHOW_UNANALYZED === '1' ? undefined : sql`(${leads.scoring}->'dimensions' IS NOT NULL AND jsonb_array_length(${leads.scoring}->'dimensions') > 0)`)\n",
  1)
assert seg != seg2, "leadPoolStats from(leads) no match"
s = s[:start] + seg2 + s[end:]
p.write_text(s, encoding='utf-8')
print("leadPoolStats analyzed-only filter OK")
