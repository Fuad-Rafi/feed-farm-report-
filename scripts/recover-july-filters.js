// The July export carries no filter footnote, so recover its filters by replay.
// Re-run the dashboard's own farm-condition aggregation over candidate
// (window x company) combinations and keep whichever reproduces the 500 rows.
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const proto = JSON.parse(fs.readFileSync(path.join(FIX, 'prototype.json'), 'utf8'));
const exp = JSON.parse(fs.readFileSync(path.join(FIX, 'july-export.json'), 'utf8'));
const LK = proto.lookups;

const AKIJ = LK.companies.indexOf('AKIJ Agro Feed Limited') + 1;

// The dashboard's aggregation, verbatim in behaviour: skip cond<0, group by farm,
// plain mean, round half away from zero to 1dp, sort by avg desc, cap 500.
function aggregate(visits) {
  const byFarm = new Map();
  for (const v of visits) {
    if (v.cond < 0) continue;
    if (!byFarm.has(v.fid)) byFarm.set(v.fid, { fid: v.fid, fn: v.fn, ft: v.ft, rg: v.rg, tr: v.tr, scores: [] });
    byFarm.get(v.fid).scores.push(v.cond);
  }
  return [...byFarm.values()]
    .map((f) => {
      const mean = f.scores.reduce((a, b) => a + b, 0) / f.scores.length;
      return { ...f, visits: f.scores.length, mean, avg: Math.round(mean * 10) / 10 };
    })
    .sort((a, b) => b.avg - a.avg);
}

function replay(from, to, company) {
  const rows = proto.visits.filter((v) => v.date >= from && v.date <= to && (company === null || v.co === company));
  return aggregate(rows);
}

// Compare the top 500 of a replay against the export, by farm id.
function agreement(rows) {
  const capped = rows.slice(0, 500);
  const mine = new Map(capped.map((r) => [r.fid, r]));
  let idMatch = 0, exact = 0;
  for (const e of exp.rows) {
    const m = mine.get(e.farmId);
    if (!m) continue;
    idMatch++;
    if (m.visits === e.visits && Math.abs(m.avg - e.avg) < 1e-9) exact++;
  }
  return { total: rows.length, idMatch, exact };
}

const windows = [
  ['2026-07-01', '2026-07-31'],
  ['2026-07-01', '2026-07-19'],
  ['2026-07-01', '2026-08-31'],
  ['2026-06-30', '2026-08-01']
];
const companies = [[AKIJ, 'AKIJ Agro Feed Limited'], [null, 'ALL COMPANIES']];

console.log('window                     company                  farms  idMatch  exact/500');
let best = null;
for (const [from, to] of windows) {
  for (const [co, coName] of companies) {
    const rows = replay(from, to, co);
    const a = agreement(rows);
    console.log(
      `${from}..${to}  ${coName.padEnd(22)}  ${String(a.total).padStart(5)}  ${String(a.idMatch).padStart(7)}  ${String(a.exact).padStart(9)}`
    );
    if (!best || a.exact > best.a.exact) best = { from, to, co, coName, rows, a };
  }
}

console.log(`\nBEST: ${best.from}..${best.to} company=${best.coName} -> ${best.a.exact}/500 exact, ${best.rows.length} farms qualify`);
fs.writeFileSync(
  path.join(FIX, 'july-filters.json'),
  JSON.stringify({ from: best.from, to: best.to, company: best.coName, companyIdx: best.co, farmsQualified: best.rows.length, exact: best.a.exact }, null, 1)
);
