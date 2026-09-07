// July 2026 farm condition scores -- same shape as Farm_Condition_Scores_july.xlsx,
// produced by our engine instead of the dashboard.
//
// Differences from that file, all of them deliberate:
//   - every qualifying farm, not the best 500 (the export's cap dropped 5 Red farms)
//   - farm score is the mean of RAW visit scores; the export averaged values it had
//     already rounded to 1dp, which moves 39 farms by 0.1
//   - the band is taken from the unrounded mean, per PLAN 4.6
const path = require('path');
const ExcelJS = require('exceljs');
const { loadConfig, scoreFarm, recoverExactVisitScore } = require('./score');
const { fromSnapshot } = require('./extract');

const ROOT = path.join(__dirname, '..');
const WINDOW = { from: '2026-07-01', to: '2026-07-31' };
const COMPANY = 'AKIJ Agro Feed Limited';

async function main() {
  const config = loadConfig('prototype');

  const visits = fromSnapshot({ ...WINDOW, company: COMPANY })
    .filter((v) => v.precomputedScore !== null);

  const byFarm = new Map();
  for (const v of visits) {
    if (!byFarm.has(v.farmId)) byFarm.set(v.farmId, { meta: v, scores: [] });
    // The snapshot stores each visit score rounded to 1dp; recover the exact
    // value so the farm mean averages raw scores.
    byFarm.get(v.farmId).scores.push(recoverExactVisitScore(v.precomputedScore, 8));
  }

  const farms = [...byFarm.entries()]
    .map(([farmId, f]) => {
      const s = scoreFarm(f.scores, config);
      return {
        farmName: f.meta.farmName,
        farmId,
        farmType: f.meta.farmType,
        region: f.meta.region,
        territory: f.meta.territory,
        visits: s.visits,
        avg: s.display,
        band: s.band.label
      };
    })
    .sort((a, b) => b.avg - a.avg || a.farmId - b.farmId);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Akij Agro Feed - shed condition engine';
  wb.created = new Date();

  const ws = wb.addWorksheet('Farm Condition Scores');
  ws.columns = [
    { header: 'Farm Name', key: 'farmName', width: 34 },
    { header: 'Farm ID', key: 'farmId', width: 10 },
    { header: 'Farm Type', key: 'farmType', width: 12 },
    { header: 'Region', key: 'region', width: 15 },
    { header: 'Territory', key: 'territory', width: 16 },
    { header: 'Visits Scored', key: 'visits', width: 14 },
    { header: 'Avg Condition Score', key: 'avg', width: 20 },
    { header: 'Condition', key: 'band', width: 13 }
  ];

  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5233' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } };

  const FILL = { 'Green · A': 'FFD8EFD8', 'Yellow · B': 'FFFDF3CF', 'Red · C': 'FFF8D2CE' };
  farms.forEach((f) => {
    const row = ws.addRow(f);
    row.getCell(7).numFmt = '0.0';
    row.getCell(7).alignment = { horizontal: 'right' };
    row.getCell(6).alignment = { horizontal: 'right' };
    const argb = FILL[f.band];
    if (argb) row.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  });

  const file = path.join(ROOT, 'Akij_Farm_Condition_Scores_July2026.xlsx');
  await wb.xlsx.writeFile(file);

  const bands = farms.reduce((a, f) => { a[f.band] = (a[f.band] || 0) + 1; return a; }, {});
  console.log('wrote', path.basename(file));
  console.log('farms', farms.length, '| visits', visits.length, '|', JSON.stringify(bands));
}

main().catch((e) => { console.error(e); process.exit(1); });
