#!/usr/bin/env node
// 建储备库表 + 导入 项目1.csv(1万条36氪项目)。储备库只存原始行+顺序+入池标记，入池时才解析。
import { pool } from './server-dist/db/client.js';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

// 1) 建表
await pool.query(`
  CREATE TABLE IF NOT EXISTS lead_reserve (
    id BIGSERIAL PRIMARY KEY,
    seq INTEGER,
    src_id TEXT,
    name TEXT,
    detail_url TEXT,
    detail_json JSONB,
    imported BOOLEAN DEFAULT FALSE,
    imported_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_reserve_imported_seq ON lead_reserve(imported, seq);
`);

// 2) 已导入过就跳过(幂等)
const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS n FROM lead_reserve');
if (cnt[0].n > 0) {
  console.log('储备库已有', cnt[0].n, '条，跳过导入(如需重导先 TRUNCATE lead_reserve)');
  await pool.end();
  process.exit(0);
}

// 3) 解析 CSV
const raw = readFileSync('/data/imports/项目1.csv', 'utf-8');
const records = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
console.log('CSV 行数:', records.length);

// 4) 批量插入
let seq = 0, ok = 0, bad = 0;
const batch = [];
for (const r of records) {
  seq++;
  let dj = null;
  try { dj = r.detail_json ? JSON.parse(r.detail_json) : null; } catch { bad++; }
  batch.push([seq, r.id || null, r.name || (dj && dj.companyName) || '', r.detail_url || null, dj]);
  if (batch.length >= 500) { await flush(batch); ok += batch.length; batch.length = 0; process.stdout.write(`\r已导入 ${ok}`); }
}
if (batch.length) { await flush(batch); ok += batch.length; }

async function flush(rows) {
  const vals = [];
  const ph = rows.map((row, i) => {
    const b = i * 5;
    vals.push(row[0], row[1], row[2], row[3], row[4] ? JSON.stringify(row[4]) : null);
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`;
  }).join(',');
  await pool.query(`INSERT INTO lead_reserve(seq,src_id,name,detail_url,detail_json) VALUES ${ph}`, vals);
}

console.log(`\n导入完成: ${ok} 条, detail_json解析失败 ${bad} 条`);
const { rows: fin } = await pool.query('SELECT COUNT(*)::int AS n FROM lead_reserve');
console.log('储备库总数:', fin[0].n);
await pool.end();
