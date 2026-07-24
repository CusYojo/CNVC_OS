#!/usr/bin/env node
/**
 * 共有池线索批量分析器(项目核心功能,固化版)
 * ------------------------------------------------------------
 * 设计目标: 稳定 · 多并发 · 精准 · 幂等(可反复跑/断点续/自动补漏)
 *
 * 用法:
 *   node batch_analyze.mjs                 # 分析所有"未充分分析"的线索(全库补漏)
 *   SCOPE=page1 node batch_analyze.mjs     # 只分析第一页(最新50条)
 *   SCOPE=all FORCE=1 node batch_analyze.mjs  # 强制重分析全部(不管评没评过)
 *   CONCURRENCY=3 node batch_analyze.mjs   # 并发数(默认3,匹配后端 SCORE_QUEUE_CONCURRENCY)
 *
 * "已充分分析"判定(DB真实状态,幂等的基础):
 *   scoring.dimensions 非空 且 scoring 含【预测】标记(新逻辑) 且 score>0
 *   —— 不满足的都会被(重新)分析。FORCE=1 时忽略此判定,全部重跑。
 *
 * 每条线索走后端 /leads/:id/score → doScore 全链路:
 *   联网检索(SearXNG)补全 → Pro模型评分+信源研究 → 回填 team/融资/股东/工商/来源 → 完整度按新口径算
 *
 * 稳定性: 每条失败自动重试1次;单条最多等10分钟(Pro较慢);并发受后端队列约束。
 */
import { pool } from './server-dist/db/client.js';

const base = 'http://127.0.0.1:3100';
const SCOPE = process.env.SCOPE || 'todo';          // todo=补漏 | page1 | all
const FORCE = process.env.FORCE === '1';
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '3', 10));
const MAX_WAIT_MS = parseInt(process.env.MAX_WAIT_MS || '600000', 10);  // 单条最多等10分钟
const RETRY = parseInt(process.env.RETRY || '1', 10);                   // 失败重试次数

function log(...a) { console.log(new Date().toISOString(), ...a); }

// 1) 选出待分析线索(DB真实状态判定,幂等)
const done_cond = `(scoring->'dimensions' IS NOT NULL AND scoring::text LIKE '%【预测】%' AND score > 0)`;
let where, order = 'ORDER BY created_at DESC', limit = '';
if (SCOPE === 'page1') { limit = 'LIMIT 50'; where = FORCE ? 'TRUE' : `NOT ${done_cond}`; }
else if (SCOPE === 'all') { where = FORCE ? 'TRUE' : `NOT ${done_cond}`; }
else { where = `NOT ${done_cond}`; }  // todo: 补漏

// page1+FORCE 特殊: 先取前50id再全评。用子查询限定 page1 范围。
let sql;
if (SCOPE === 'page1') {
  sql = `SELECT id, name FROM (SELECT id, name, scoring, score, created_at FROM leads ORDER BY created_at DESC LIMIT 50) p WHERE ${FORCE ? 'TRUE' : `NOT ${done_cond}`} ORDER BY created_at DESC`;
} else {
  sql = `SELECT id, name FROM leads WHERE ${where} ${order} ${limit}`;
}
const { rows } = await pool.query(sql);
await pool.end();
log(`批量分析 [scope=${SCOPE} force=${FORCE} 并发=${CONCURRENCY}]: 待分析 ${rows.length} 条`);
if (!rows.length) { log('无待分析线索,退出'); process.exit(0); }

// 2) 鉴权:用系统内部密钥(x-internal-secret),不依赖任何用户账号
//    共有池分析是系统主动触发的后台流程,不应受某个用户登录态限制。
const H = { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET || 'cybernaut-internal-2026' };

// 3) 单条分析(含重试)
async function analyzeOne(id, name, attempt = 0) {
  await fetch(`${base}/api/leads/${id}/score`, { method: 'POST', headers: H, body: '{}' });
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await (await fetch(`${base}/api/leads/${id}/score`, { headers: H })).json().catch(() => ({}));
    if (st.status === 'done') return { ok: true, total: (st.scoring || {}).total };
    if (st.status === 'failed') {
      if (attempt < RETRY) { log(`  ${String(name).slice(0,14)} 失败,重试...`); return analyzeOne(id, name, attempt + 1); }
      return { ok: false, reason: 'failed' };
    }
  }
  if (attempt < RETRY) { log(`  ${String(name).slice(0,14)} 超时,重试...`); return analyzeOne(id, name, attempt + 1); }
  return { ok: false, reason: 'timeout' };
}

// 4) N 并发 worker
let ok = 0, fail = 0, cursor = 0;
async function worker(wid) {
  while (cursor < rows.length) {
    const i = cursor++;
    const { id, name } = rows[i];
    try {
      const r = await analyzeOne(id, name);
      if (r.ok) { ok++; log(`[w${wid}] ${i+1}/${rows.length} ${String(name).slice(0,16)} → ${r.total} (ok=${ok} fail=${fail})`); }
      else { fail++; log(`[w${wid}] ${i+1}/${rows.length} ${String(name).slice(0,16)} ${r.reason.toUpperCase()} (ok=${ok} fail=${fail})`); }
    } catch (e) { fail++; log(`[w${wid}] ${i+1} ${name} ERR ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
log(`批量分析完成: ok=${ok} fail=${fail} / 共${rows.length}`);
