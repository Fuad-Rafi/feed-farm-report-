// Analytical cuts over the July run, for the report layer.
const fs = require('fs');
const path = require('path');
const { loadConfig, scoreFarm, bandFor, recoverExactVisitScore } = require('../src/score');
const { fromSnapshot } = require('../src/extract');

const ROOT = path.join(__dirname, '..');
const config = loadConfig('prototype');
const WINDOW = { from: '2026-07-01', to: '2026-07-31' };
const COMPANY = 'AKIJ Agro Feed Limited';

const visits = fromSnapshot({ ...WINDOW, company: COMPANY });
const scorable = visits.filter((v) => v.precomputedScore !== null);

const byFarm = new Map();
for (const v of scorable) {
  if (!byFarm.has(v.farmId)) byFarm.set(v.farmId, { meta: v, scores: [] });
  byFarm.get(v.farmId).scores.push(recoverExactVisitScore(v.precomputedScore, 8));
}
const farms = [...byFarm.entries()].map(([farmId, f]) => {
  const s = scoreFarm(f.scores, config);
  return { farmId, ...f.meta, visits: s.visits, mean: s.mean, display: s.display, band: s.band.colour };
});

function bandTable(rows, key) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], { key: r[key], n: 0, Green: 0, Yellow: 0, Red: 0, sum: 0, visits: 0 });
    const g = m.get(r[key]);
    g.n++; g[r.band]++; g.sum += r.mean; g.visits += r.visits;
  }
  return [...m.values()]
    .map((g) => ({ ...g, avg: +(g.sum / g.n).toFixed(1), belowGreenPct: +(100 * (g.Yellow + g.Red) / g.n).toFixed(1) }))
    .sort((a, b) => b.n - a.n);
}

const out = {
  totals: {
    farms: farms.length,
    visits: visits.length,
    scorableVisits: scorable.length,
    unscorableVisits: visits.length - scorable.length,
    bands: { Green: farms.filter(f => f.band === 'Green').length, Yellow: farms.filter(f => f.band === 'Yellow').length, Red: farms.filter(f => f.band === 'Red').length },
    avg: +(farms.reduce((s, f) => s + f.mean, 0) / farms.length).toFixed(2)
  },
  byFarmType: bandTable(farms, 'farmType'),
  byRegion: bandTable(farms, 'region'),
  byTerritory: bandTable(farms, 'territory'),
  // visit-score histogram
  visitHistogram: (() => {
    const m = new Map();
    for (const v of scorable) {
      const k = recoverExactVisitScore(v.precomputedScore, 8);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([score, n]) => ({ score: +score.toFixed(2), n, band: bandFor(score, config).colour }));
  })(),
  visitCoverage: (() => {
    const m = new Map();
    for (const f of farms) m.set(f.visits, (m.get(f.visits) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([visits, farms]) => ({ visits, farms }));
  })(),
  worst25: farms.slice().sort((a, b) => a.mean - b.mean || a.farmId - b.farmId).slice(0, 25)
    .map((f) => ({ farmId: f.farmId, farmName: f.farmName, farmType: f.farmType, region: f.region, territory: f.territory, visits: f.visits, score: f.display, band: f.band })),
  riskyAmmoniaFarms: farms.filter((f) => byFarm.get(f.farmId).scores.some((s) => s === 0))
    .map((f) => ({ farmId: f.farmId, farmName: f.farmName, farmType: f.farmType, region: f.region, territory: f.territory, visits: f.visits, score: f.display, band: f.band })),
  unscorableByFarmType: (() => {
    const m = new Map();
    for (const v of visits.filter((x) => x.precomputedScore === null)) m.set(v.farmType, (m.get(v.farmType) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([farmType, visits]) => ({ farmType, visits }));
  })()
};

fs.writeFileSync(path.join(ROOT, 'out', 'july-2026', 'breakdowns.json'), JSON.stringify(out, null, 1));

console.log('TOTALS', JSON.stringify(out.totals));
console.log('\nBY FARM TYPE');
console.table(out.byFarmType.map(r => ({ type: r.key, farms: r.n, visits: r.visits, avg: r.avg, G: r.Green, Y: r.Yellow, R: r.Red, belowGreenPct: r.belowGreenPct })));
console.log('\nBY REGION');
console.table(out.byRegion.map(r => ({ region: r.key, farms: r.n, visits: r.visits, avg: r.avg, G: r.Green, Y: r.Yellow, R: r.Red, belowGreenPct: r.belowGreenPct })));
console.log('\nVISIT COVERAGE'); console.table(out.visitCoverage);
console.log('\nUNSCORABLE VISITS BY TYPE'); console.table(out.unscorableByFarmType);
console.log('\nRISKY AMMONIA FARMS', out.riskyAmmoniaFarms.length);
console.table(out.riskyAmmoniaFarms);
