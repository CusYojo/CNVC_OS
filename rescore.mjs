#!/usr/bin/env node
// 批量重评存量虚低分线索:用新预测打分逻辑(flue score-project)重跑所有
// <60分 且 无【预测】标记(=旧逻辑评的)的线索。小并发,轮询到完成,带进度日志。
import { pool } from './server-dist/db/client.js';

const CONCURRENCY = parseInt(process.env.RESCORE_CONCURRENCY || '2', 10);
const THRESHOLD = parseInt(process.env.RESCORE_MAX || '60', 10);  // 只重评 <此分 的
const base = 'http://127.0.0.1:4100';

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lin@cybernaut.com', password: '123456' }),
});
const token = (await login.json()).token;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

// 拉待重评:已评分(有dimensions) 且 total<THRESHOLD 且 scoring里无【预测】标记(旧逻辑)
const { rows } = await pool.query(
  `SELECT id, name, (scoring->>'total')::int AS old
   FROM leads
   WHERE scoring->'dimensions' IS NOT NULL
     AND (scoring->>'total')::int < $1
     AND scoring::text NOT LIKE '%【预测】%'
   ORDER BY created_at DESC`,
  [THRESHOLD]
);
await pool.end();
console.log(new Date().toISOString(), `待重评 ${rows.length} 条(<${THRESHOLD}分且旧逻辑评的),并发=${CONCURRENCY}`);

let done = 0, failed = 0, cursor = 0, up = 0, down = 0, same = 0;
async function worker(wid) {
  while (cursor < rows.length) {
    const idx = cursor++;
    const { id, name, old } = rows[idx];
    try {
      await fetch(`${base}/api/leads/${id}/score`, { method: 'POST', headers: H, body: '{}' });
      // 轮询最多 5 分钟
      for (let w = 0; w < 30; w++) {
        await new Promise((r) => setTimeout(r, 10000));
        const st = await (await fetch(`${base}/api/leads/${id}/score`, { headers: H })).json();
        if (st.status === 'done') {
          const nt = (st.scoring || {}).total;
          if (nt > old) up++; else if (nt < old) down++; else same++;
          done++;
          console.log(new Date().toISOString(), `[w${wid}] ${(idx + 1)}/${rows.length} ${String(name).slice(0, 16)} ${old}→${nt} (done=${done} fail=${failed} ↑${up}↓${down}=${same})`);
          break;
        }
        if (st.status === 'failed') { failed++; console.log(new Date().toISOString(), `[w${wid}] ${(idx + 1)} ${name} FAILED`); break; }
      }
    } catch (e) { failed++; console.log(new Date().toISOString(), `[w${wid}] ${name} ERR ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
console.log(new Date().toISOString(), `重评完成: done=${done} failed=${failed} 涨=${up} 降=${down} 平=${same}`);
