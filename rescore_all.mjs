#!/usr/bin/env node
// 全量重评(3并发版,配合后端 SCORE_QUEUE_CONCURRENCY=3):
// 所有 scoring 无【预测】标记的线索用最新 doScore(联网补全→分析→回填独立列)重跑。
// 3 个 worker 并发触发+轮询;断点续跑(每条落库,重启接着来,已带预测标记的自动跳过)。
import { pool } from './server-dist/db/client.js';

const base = 'http://127.0.0.1:4100';
const CONCURRENCY = parseInt(process.env.RESCORE_CONCURRENCY || '3', 10);
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'lin@cybernaut.com', password: '123456' }),
});
const token = (await login.json()).token;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

const { rows } = await pool.query(
  `SELECT id, name, COALESCE((scoring->>'total')::int, -1) AS old
   FROM leads WHERE scoring::text NOT LIKE '%【预测】%'
   ORDER BY created_at DESC`
);
await pool.end();
console.log(new Date().toISOString(), `全量重评启动:待处理 ${rows.length} 条,${CONCURRENCY} 并发`);

let done = 0, failed = 0, up = 0, down = 0, same = 0, cursor = 0;
async function worker(wid) {
  while (cursor < rows.length) {
    const i = cursor++;
    const { id, name, old } = rows[i];
    try {
      await fetch(`${base}/api/leads/${id}/score`, { method: 'POST', headers: H, body: '{}' });
      let ok = false;
      for (let w = 0; w < 45; w++) {
        await new Promise((r) => setTimeout(r, 10000));
        const st = await (await fetch(`${base}/api/leads/${id}/score`, { headers: H })).json();
        if (st.status === 'done') {
          const nt = (st.scoring || {}).total;
          if (old >= 0) { if (nt > old) up++; else if (nt < old) down++; else same++; }
          done++; ok = true;
          console.log(new Date().toISOString(), `[w${wid}] ${i + 1}/${rows.length} ${String(name).slice(0, 16)} ${old < 0 ? '新评' : old + '→'}${nt} (ok=${done} fail=${failed} ↑${up}↓${down}=${same})`);
          break;
        }
        if (st.status === 'failed') { failed++; ok = true; break; }
      }
      if (!ok) failed++;
    } catch (e) { failed++; }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
console.log(new Date().toISOString(), `全量重评完成:ok=${done} fail=${failed} 涨=${up} 降=${down} 平=${same}`);
