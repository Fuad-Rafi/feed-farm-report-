// July 2026 shed-condition run.
//
// Window  2026-07-01 .. 2026-07-31, company AKIJ Agro Feed Limited -- recovered
// by replay against Farm_Condition_Scores_july.xlsx (scripts/recover-july-filters.js),
// which reproduces its 500 rows exactly.
//
// Source is the frozen dashboard snapshot while the warehouse is unreachable.
// Visit scores in it are precomputed prototype scores; this run does the farm
// rollup, banding and reporting with our own engine.
const fs = require('fs');
const path = require('path');
const { loadConfig, scoreFarm, bandFor, roundHalfAwayFromZero, recoverExactVisitScore } = require('./score');
const { fromSnapshot } = require('./extract');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'july-2026');
const LOGS = path.join(ROOT, 'logs');

const WINDOW = { from: '2026-07-01', to: '2026-07-31' };
const COMPANY = 'AKIJ Agro Feed Limited';

function csv(rows, headers) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n') + '\n';
}

function tally(rows, key) {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function bandCounts(farms) {
  const c = { Green: 0, Yellow: 0, Red: 0 };
  for (const f of farms) c[f.band.colour]++;
  return c;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });

  const config = loadConfig('prototype');

  // --- extract -----------------------------------------------------------
  const visits = fromSnapshot({ ...WINDOW, company: COMPANY });
  const scorable = visits.filter((v) => v.precomputedScore !== null);
  const unscorable = visits.filter((v) => v.precomputedScore === null);

  // --- roll up per farm with our engine ----------------------------------
  // The snapshot holds each visit score already rounded to 1dp. Recover the exact
  // value first, so the farm mean is an average of raw scores rather than of
  // rounded ones. `dash` keeps the dashboard's double-rounded method for contrast.
  const byFarm = new Map();
  for (const v of scorable) {
    if (!byFarm.has(v.farmId)) byFarm.set(v.farmId, { meta: v, scores: [], rounded: [], dates: [] });
    const f = byFarm.get(v.farmId);
    f.scores.push(recoverExactVisitScore(v.precomputedScore, 8));
    f.rounded.push(v.precomputedScore);
    f.dates.push(v.date);
  }

  const farms = [...byFarm.entries()]
    .map(([farmId, f]) => {
      const s = scoreFarm(f.scores, config);
      const dashMean = f.rounded.reduce((a, b) => a + b, 0) / f.rounded.length;
      const dash = { mean: dashMean, display: Math.round(dashMean * 10) / 10, band: bandFor(dashMean, config) };
      return {
        farmId,
        farmName: f.meta.farmName,
        farmType: f.meta.farmType,
        region: f.meta.region,
        territory: f.meta.territory,
        visits: s.visits,
        mean: s.mean,
        display: s.display,
        band: s.band,
        dash,
        best: Math.max(...f.scores),
        worst: Math.min(...f.scores),
        firstVisit: f.dates.slice().sort()[0],
        lastVisit: f.dates.slice().sort().pop(),
        riskyVisits: f.scores.filter((x) => x === 0).length
      };
    })
    .sort((a, b) => b.mean - a.mean || a.farmId - b.farmId);

  const roundingDiffs = farms.filter((f) => Math.abs(f.display - f.dash.display) > 1e-9);
  const roundingBandDiffs = farms.filter((f) => f.band.colour !== f.dash.band.colour);

  // --- reconcile against the artifact export ------------------------------
  const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'july-export.json'), 'utf8'));
  const mine = new Map(farms.map((f) => [f.farmId, f]));
  const expIds = new Set(exp.rows.map((r) => r.farmId));

  const recon = exp.rows.map((e) => {
    const m = mine.get(e.farmId);
    const sameVisits = m && m.visits === e.visits;
    return {
      farmId: e.farmId,
      farmName: e.farmName,
      exportVisits: e.visits,
      ourVisits: m ? m.visits : '',
      exportAvg: e.avg,
      ourAvg: m ? m.display : '',
      exportBand: e.band,
      ourBand: m ? m.band.label : '',
      dashAvg: m ? m.dash.display : '',
      visitsMatch: sameVisits ? 'YES' : 'NO',
      scoreMatch: m && Math.abs(m.display - e.avg) < 1e-9 ? 'YES' : 'NO',
      bandMatch: m && m.band.label === e.band ? 'YES' : 'NO',
      note: !m ? ''
        : Math.abs(m.dash.display - e.avg) > 1e-9 ? 'export disagrees with its own method (float error in Math.round)'
        : Math.abs(m.display - e.avg) > 1e-9 ? 'export averaged already-rounded visit scores'
        : ''
    };
  });
  const dashSelfDisagree = recon.filter((r) => r.note.startsWith('export disagrees'));
  const exact = recon.filter((r) => r.visitsMatch === 'YES' && r.scoreMatch === 'YES' && r.bandMatch === 'YES').length;
  const visitsExact = recon.filter((r) => r.visitsMatch === 'YES').length;
  const bandExact = recon.filter((r) => r.bandMatch === 'YES').length;
  const hidden = farms.filter((f) => !expIds.has(f.farmId));

  // --- write -------------------------------------------------------------
  const farmRows = farms.map((f, i) => ({
    rank: i + 1,
    farmId: f.farmId,
    farmName: f.farmName,
    farmType: f.farmType,
    region: f.region,
    territory: f.territory,
    visitsScored: f.visits,
    avgScore: f.display.toFixed(1),
    band: f.band.label,
    bestVisit: f.best,
    worstVisit: f.worst,
    riskyAmmoniaVisits: f.riskyVisits,
    firstVisit: f.firstVisit,
    lastVisit: f.lastVisit,
    inArtifactExport: expIds.has(f.farmId) ? 'yes' : 'NO - hidden by 500 cap'
  }));

  fs.writeFileSync(path.join(OUT, 'farms.csv'), csv(farmRows, Object.keys(farmRows[0])));

  const visitRows = scorable
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.farmId - b.farmId)
    .map((v) => ({
      date: v.date, farmId: v.farmId, farmName: v.farmName, farmType: v.farmType,
      region: v.region, territory: v.territory, ageDays: v.ageDays, mortality: v.mortality,
      fcr: v.fcr, visitScore: v.precomputedScore, band: bandFor(v.precomputedScore, config).label
    }));
  fs.writeFileSync(path.join(OUT, 'visits.csv'), csv(visitRows, Object.keys(visitRows[0])));
  fs.writeFileSync(path.join(OUT, 'reconciliation.csv'), csv(recon, Object.keys(recon[0])));

  const belowGreen = farms.filter((f) => f.band.colour !== 'Green');
  fs.writeFileSync(path.join(OUT, 'below-green.csv'), csv(
    belowGreen.map((f) => ({
      farmId: f.farmId, farmName: f.farmName, farmType: f.farmType, region: f.region,
      territory: f.territory, visitsScored: f.visits, avgScore: f.display.toFixed(1),
      band: f.band.label, worstVisit: f.worst, riskyAmmoniaVisits: f.riskyVisits
    })),
    ['farmId', 'farmName', 'farmType', 'region', 'territory', 'visitsScored', 'avgScore', 'band', 'worstVisit', 'riskyAmmoniaVisits']
  ));

  // --- summary -----------------------------------------------------------
  const counts = bandCounts(farms);
  const summary = {
    window: WINDOW,
    company: COMPANY,
    mode: 'prototype',
    source: 'dashboard.html snapshot (frozen 2026-07-19)',
    dataSpan: { first: visitRows[0].date, last: visitRows[visitRows.length - 1].date },
    visitsInWindow: visits.length,
    visitsScorable: scorable.length,
    visitsUnscorable: unscorable.length,
    farmsScored: farms.length,
    bands: counts,
    bandPct: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, +(100 * v / farms.length).toFixed(1)])),
    belowGreen: belowGreen.length,
    meanOfFarmScores: +(farms.reduce((s, f) => s + f.mean, 0) / farms.length).toFixed(2),
    medianFarmScore: farms[Math.floor(farms.length / 2)].display,
    farmsWithOneVisit: farms.filter((f) => f.visits === 1).length,
    riskyAmmoniaVisits: scorable.filter((v) => v.precomputedScore === 0).length,
    perfect100Farms: farms.filter((f) => f.mean === 100).length,
    floor50Farms: farms.filter((f) => f.mean === 50).length,
    reconciliation: {
      exportRows: exp.rows.length,
      exactMatches: exact,
      visitCountMatches: visitsExact,
      bandMatches: bandExact,
      hiddenByCap: hidden.length,
      roundingDiffFarms: roundingDiffs.length,
      roundingBandChanges: roundingBandDiffs.length,
      exportFloatErrors: dashSelfDisagree.length
    },
    byFarmType: Object.fromEntries(tally(farms, 'farmType')),
    byRegion: Object.fromEntries(tally(farms, 'region'))
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

  // --- console -----------------------------------------------------------
  const pct = (n) => `${(100 * n / farms.length).toFixed(1)}%`;
  console.log(`\nJULY 2026 SHED CONDITION - ${COMPANY}`);
  console.log(`window ${WINDOW.from} .. ${WINDOW.to}   mode prototype   source ${summary.source}`);
  console.log(`data actually spans ${summary.dataSpan.first} .. ${summary.dataSpan.last}\n`);
  console.log(`visits in window      ${visits.length}  (scorable ${scorable.length}, unscorable ${unscorable.length})`);
  console.log(`farms scored          ${farms.length}`);
  console.log(`  Green  A  >=80      ${counts.Green}  ${pct(counts.Green)}`);
  console.log(`  Yellow B  65-79.9   ${counts.Yellow}  ${pct(counts.Yellow)}`);
  console.log(`  Red    C  <65       ${counts.Red}  ${pct(counts.Red)}`);
  console.log(`below Green (report)  ${belowGreen.length}`);
  console.log(`mean of farm scores   ${summary.meanOfFarmScores}`);
  console.log(`farms on one visit    ${summary.farmsWithOneVisit}`);
  console.log(`Risky-ammonia visits  ${summary.riskyAmmoniaVisits}`);
  console.log(`\nRECONCILIATION vs Farm_Condition_Scores_july.xlsx`);
  console.log(`  export rows ${exp.rows.length}`);
  console.log(`  visit counts match  ${visitsExact}/${exp.rows.length}`);
  console.log(`  bands match         ${bandExact}/${exp.rows.length}`);
  console.log(`  fully exact         ${exact}/${exp.rows.length}`);
  console.log(`  farms where averaging raw vs rounded visit scores differs: ${roundingDiffs.length} (band changes: ${roundingBandDiffs.length})`);
  console.log(`  farms where the export disagrees with its own method (float error): ${dashSelfDisagree.length}`);
  dashSelfDisagree.forEach((r) => console.log(`    ${r.farmId}  ${r.farmName}: export ${r.exportAvg}, its own method ${r.dashAvg}, exact ${r.ourAvg}`));
  console.log(`  farms hidden by the export's 500-row cap: ${hidden.length}`);
  hidden.forEach((f) => console.log(`    ${f.farmId}  ${f.farmName} (${f.farmType}, ${f.region}) ${f.display.toFixed(1)} ${f.band.label}`));
  console.log(`\nwrote ${path.relative(ROOT, OUT)}\\{farms,visits,reconciliation,below-green}.csv + summary.json`);

  return { farms, visits, scorable, summary, recon, hidden, config };
}

if (require.main === module) main();
module.exports = { main, WINDOW, COMPANY };
