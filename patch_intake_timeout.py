import pathlib
p = pathlib.Path('daily_intake.mjs')
s = p.read_text(encoding='utf-8')

s = s.replace(
  "const CONCURRENCY = parseInt(process.env.SCORE_CONCURRENCY || '2', 10);",
  "const CONCURRENCY = parseInt(process.env.SCORE_CONCURRENCY || '3', 10);", 1)

old = """        await fetch(`${base}/api/leads/${id}/score`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}' });
        for (let w = 0; w < 30; w++) {
          await new Promise((r) => setTimeout(r, 5000));
          const st = await (await fetch(`${base}/api/leads/${id}/score`, { headers: { Authorization: 'Bearer ' + token } })).json();
          if (st.status === 'done' || st.status === 'failed') { done++; break; }
        }"""
new = """        await fetch(`${base}/api/leads/${id}/score`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}' });
        for (let w = 0; w < 120; w++) {
          await new Promise((r) => setTimeout(r, 5000));
          const st = await (await fetch(`${base}/api/leads/${id}/score`, { headers: { Authorization: 'Bearer ' + token } })).json();
          if (st.status === 'done' || st.status === 'failed') { done++; break; }
        }"""
assert old in s, "analyzeLeads 轮询段没匹配上"
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print("daily_intake 超时150s->600s, 并发2->3 OK")
