#!/usr/bin/env node
// 每日入池：从储备库(lead_reserve, 36氪1万条)按 seq 取 N 个未入池 → 映射成 leads。
// scoring 写 6 维度结构(前端详情 tab 认的字段名)。入池后逐条触发 AI 分析；
// 再抓取其他信源(机构/高校/创投/论文)并同样走 AI 分析。
import { pool } from './server-dist/db/client.js';
import { randomUUID } from 'node:crypto';

const DAILY = parseInt(process.env.DAILY_INTAKE || '50', 10);

function fmtDate(v) {
  if (!v) return '待核验';
  if (/^\d{12,}$/.test(String(v))) { try { return new Date(Number(v)).toISOString().slice(0, 10); } catch { return '待核验'; } }
  return String(v);
}

const { rows } = await pool.query(
  'SELECT id, seq, name, detail_url, detail_json FROM lead_reserve WHERE imported = FALSE AND detail_json IS NOT NULL ORDER BY seq ASC LIMIT $1',
  [DAILY]
);

const insertedIds = [];

if (!rows.length) {
  console.log(new Date().toISOString(), '储备库已无未入池项目');
} else {
  let ok = 0;
  for (const row of rows) {
    const d = row.detail_json || {};
    const biz = d.business || {};
    const name = d.name || row.name || '未命名项目';
    const companyName = d.companyName || biz.name || name;
    const industry = (Array.isArray(d.industryList) && d.industryList.length)
      ? d.industryList.map((x) => x.name).filter(Boolean).join('、')
      : (Array.isArray(d.tagList) ? d.tagList.join('、') : '待核验');
    const oneLiner = d.oneWord || d.intro || '';
    const detailUrl = row.detail_url || (d.companyId ? `https://pitchhub.36kr.com/company/${d.companyId}` : '');

    // 股东
    const shareholders = Array.isArray(biz.shareholder)
      ? biz.shareholder.map((s) => ({ name: s.name, percent: s.percent || '', amount: s.amomon || '', date: s.time || '' })) : [];
    // 融资轮次
    const fundingRounds = Array.isArray(d.financingList)
      ? d.financingList.map((f) => ({
          round: f.roundTxt || '未披露',
          amount: f.amount || '未披露',
          valuation: '未披露',
          investors: (Array.isArray(f.investorList) ? f.investorList.map((i) => i.name).filter((n) => n && n !== 'null').join('、') : '') || (f.vc && f.vc !== 'null' ? f.vc : '待核验'),
          date: fmtDate(f.date),
          sourceUrl: detailUrl,
        })) : [];

    const scoring = {
      projectName: name,
      whatIsIt: oneLiner,
      registry: {
        companyName,
        registeredCapital: (Array.isArray(biz.shareholder) && biz.shareholder[0]?.amomon) || '待核验',
        legalRepresentative: biz.legalPersonName || '待核验',
        establishDate: fmtDate(biz.estiblishTime || d.setupDate),
        address: biz.regLocation || '待核验',
        province: d.provinceName || '待核验',
      },
      structuredTeam: [],
      structuredShareholders: shareholders,
      fundingRoundsResearched: fundingRounds,
      structuredNews: [],
    };

    const radarProfile = {
      channel: '36氪',
      sourceName: '36氪',
      sourceGroup: '36氪项目库',
      profile: {
        projectName: name,
        projectRound: (d.currentFinancing && d.currentFinancing.name) || (fundingRounds[0]?.round) || '未披露',
        industry,
      },
    };

    const leadId = randomUUID();
    await pool.query(
      `INSERT INTO leads (id, name, company_name, industry, source, pool_status, score, summary, highlights, risks, team, funding_rounds, risk_tags, sources, scoring, radar_profile, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())`,
      [
        leadId, name, companyName, String(industry).slice(0, 64),
        '36氪项目库', '成功', 0, String(oneLiner).slice(0, 1000),
        JSON.stringify([]),
        JSON.stringify([]),
        '待核验',
        JSON.stringify(fundingRounds),
        JSON.stringify([]),
        JSON.stringify(detailUrl ? [{ title: name, url: detailUrl, reliability: '中', category: '36氪', excerpt: String(oneLiner).slice(0, 200) }] : []),
        JSON.stringify(scoring),
        JSON.stringify(radarProfile),
      ]
    );
    await pool.query('UPDATE lead_reserve SET imported = TRUE WHERE id = $1', [row.id]);
    insertedIds.push(leadId);
    ok++;
  }
  const { rows: rem } = await pool.query('SELECT count(*)::int AS n FROM lead_reserve WHERE imported = FALSE');
  console.log(new Date().toISOString(), `本次入池 ${ok} 个；储备库剩余未入池 ${rem[0].n} 个`);
}

await pool.end();

// ============================================================
// 统一 AI 分析:对一批 leadId 逐条触发评分(小并发,轮询到完成)
// ============================================================
async function analyzeLeads(base, token, ids, tag) {
  if (!ids.length) return;
  const CONCURRENCY = parseInt(process.env.SCORE_CONCURRENCY || '3', 10);
  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        await fetch(`${base}/api/leads/${id}/score`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': token }, body: '{}' });
        for (let w = 0; w < 120; w++) {
          await new Promise((r) => setTimeout(r, 5000));
          const st = await (await fetch(`${base}/api/leads/${id}/score`, { headers: { 'x-internal-secret': token } })).json();
          if (st.status === 'done' || st.status === 'failed') { done++; break; }
        }
      } catch (e) { console.log(new Date().toISOString(), `[${tag}] score触发失败`, id, e.message); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()));
  console.log(new Date().toISOString(), `[${tag}] 自动分析完成 ${done}/${ids.length}`);
}

const base = 'http://127.0.0.1:3100';
// 系统内部密钥:共有池分析是系统主动触发的后台流程,不依赖任何用户登录态
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'cybernaut-internal-2026';
const token = INTERNAL_SECRET;  // 兼容下游变量名

// —— 第一步: 36氪入池的线索走 AI 分析 ——
if (token && insertedIds.length && process.env.AUTO_SCORE !== '0') {
  await analyzeLeads(base, token, insertedIds, '36氪');
}

// —— 第二步: 抓取其他信源(机构/高校/创投/论文),新增的也走 AI 分析 ——
if (token && process.env.RADAR_SYNC !== '0') {
  const limit = parseInt(process.env.RADAR_LIMIT || '50', 10);
  try {
    const r = await fetch(`${base}/api/leads/sync-radar`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': token }, body: JSON.stringify({ limit, source: 'all' }) });
    const j = await r.json();
    const radarIds = Array.isArray(j.createdIds) ? j.createdIds : [];
    console.log(new Date().toISOString(), `雷达同步完成：新增 ${j.created ?? 0} 条（跳过 ${j.skipped ?? 0}）`);
    if (radarIds.length && process.env.AUTO_SCORE !== '0') {
      await analyzeLeads(base, token, radarIds, '雷达');
    }
  } catch (e) { console.log(new Date().toISOString(), '雷达同步失败:', e.message); }
}
