import pathlib
p = pathlib.Path('src/pages/SourcingPage.tsx')
s = p.read_text(encoding='utf-8')
old = "{ id: 'news', label: '公司动态', count: (selected.companyNews ?? []).length },"
new = "{ id: 'news', label: '公司动态', count: (selected.scoring?.structuredNews?.length ?? (selected.companyNews ?? []).length) || undefined },"
assert old in s, "news tab no match"
s = s.replace(old, new, 1)
old2 = "{ id: 'sources', label: '来源证据', count: (selected.sources ?? []).length },"
new2 = "{ id: 'sources', label: '来源证据', count: (selected.sources ?? []).length || undefined },"
assert old2 in s, "sources tab no match"
s = s.replace(old2, new2, 1)
p.write_text(s, encoding='utf-8')
print("news/sources count fixed OK")
