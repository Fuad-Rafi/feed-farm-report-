// Build the July 2026 workbook: our version of the report.
// Uncapped, banded off the unrounded mean, with the reconciliation against the
// artifact export carried in the same file so the two can be compared directly.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'july-2026');

const BAND_FILL = {
  'Green · A': 'FFD8EFD8',
  'Yellow · B': 'FFFDF3CF',
  'Red · C': 'FFF8D2CE'
};

function styleHeader(ws, cols) {
  ws.columns = cols;
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5233' } };
  h.alignment = { vertical: 'middle', wrapText: true };
  h.height = 28;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

function bandColour(ws, colKey) {
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = row.getCell(colKey).value;
    const argb = BAND_FILL[v];
    if (argb) row.getCell(colKey).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  });
}

function readCsv(file) {
  const text = fs.readFileSync(path.join(OUT, file), 'utf8').trim();
  const lines = text.split('\n');
  const parse = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = parse(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(parse(l).map((v, i) => [headers[i], v])));
}

async function main() {
  const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'));
  const bd = JSON.parse(fs.readFileSync(path.join(OUT, 'breakdowns.json'), 'utf8'));
  const farms = readCsv('farms.csv');
  const visits = readCsv('visits.csv');
  const recon = readCsv('reconciliation.csv');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Akij Agro Feed - shed condition engine';
  wb.created = new Date();

  // --- Summary -----------------------------------------------------------
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 42 }, { width: 30 }, { width: 60 }];
  const put = (a, b, c) => s.addRow([a, b, c]);
  const title = put('AKIJ AGRO FEED - JULY 2026 SHED CONDITION REPORT', '', '');
  title.font = { bold: true, size: 14 };
  put('', '', '');
  put('Reporting window', `${summary.window.from} .. ${summary.window.to}`, '');
  put('Company', summary.company, 'Filter applies to visit rows, not to farms');
  put('Scoring mode', 'prototype (8 parameters)', 'Spec mode needs raw parameter values from DWH');
  put('Source', summary.source, 'Warehouse unreachable at run time');
  put('Data actually spans', `${summary.dataSpan.first} .. ${summary.dataSpan.last}`, 'Snapshot frozen 2026-07-19; 20-31 July not present');
  put('', '', '');

  const h1 = put('POPULATION', '', ''); h1.font = { bold: true };
  put('Visits in window', summary.visitsInWindow, '');
  put('  scorable', summary.visitsScorable, '');
  put('  unscorable', summary.visitsUnscorable, 'All Cattle - records none of the scored fields');
  put('Farms scored', summary.farmsScored, 'The artifact export shows 500 of these');
  put('Farms on a single visit', summary.farmsWithOneVisit, 'Thin evidence - one visit sets the whole score');
  put('', '', '');

  const h2 = put('TIERING', '', ''); h2.font = { bold: true };
  put('Green  A  (>= 80)', summary.bands.Green, `${summary.bandPct.Green}%`);
  put('Yellow B  (65 - 79.9)', summary.bands.Yellow, `${summary.bandPct.Yellow}%`);
  put('Red    C  (< 65)', summary.bands.Red, `${summary.bandPct.Red}%`);
  put('Below Green - the advisory list', summary.belowGreen, `${(100 * summary.belowGreen / summary.farmsScored).toFixed(1)}% of scored farms`);
  put('Mean of farm scores', summary.meanOfFarmScores, '');
  put('Farms scoring a clean 100', summary.perfect100Farms, '');
  put('Farms at the 50 floor', summary.floor50Farms, '');
  put('Risky-ammonia visits', summary.riskyAmmoniaVisits, 'Each forces that visit to 0');
  put('', '', '');

  const h3 = put('RECONCILIATION vs Farm_Condition_Scores_july.xlsx', '', ''); h3.font = { bold: true };
  put('Export rows', summary.reconciliation.exportRows, '');
  put('Visit counts matching', `${summary.reconciliation.visitCountMatches}/500`, 'Same visit rows, same filters');
  put('Bands matching', `${summary.reconciliation.bandMatches}/500`, 'No farm changes tier');
  put('Scores matching exactly', `${summary.reconciliation.exactMatches}/500`, '');
  put('Farms differing by 0.1', summary.reconciliation.roundingDiffFarms, 'Export averages already-rounded visit scores; we average raw ones');
  put('Farms hidden by the 500-row cap', summary.reconciliation.hiddenByCap, 'All five are Red, three of them scoring 0');
  put('', '', '');

  const h4 = put('CAVEATS', '', ''); h4.font = { bold: true };
  put('1', 'Prototype rule, not the spec rule', 'Layer/Duck are scored on 8 parameters here; the spec scores them on 5 and adds stocking density');
  put('2', 'Snapshot ends 2026-07-19', 'Visits from 20-31 July are not in this run');
  put('3', 'Duplicates and future dates retained', 'Prototype mode does no cleaning');
  s.getColumn(1).font = { ...(s.getColumn(1).font || {}) };

  // --- Farm scores -------------------------------------------------------
  const fs1 = wb.addWorksheet('Farm Scores (all 505)');
  styleHeader(fs1, [
    { header: 'Rank', key: 'rank', width: 7 },
    { header: 'Farm ID', key: 'farmId', width: 9 },
    { header: 'Farm Name', key: 'farmName', width: 32 },
    { header: 'Farm Type', key: 'farmType', width: 11 },
    { header: 'Region', key: 'region', width: 14 },
    { header: 'Territory', key: 'territory', width: 15 },
    { header: 'Visits Scored', key: 'visitsScored', width: 12 },
    { header: 'Avg Score', key: 'avgScore', width: 10 },
    { header: 'Condition', key: 'band', width: 12 },
    { header: 'Best Visit', key: 'bestVisit', width: 10 },
    { header: 'Worst Visit', key: 'worstVisit', width: 11 },
    { header: 'Risky Ammonia Visits', key: 'riskyAmmoniaVisits', width: 13 },
    { header: 'First Visit', key: 'firstVisit', width: 12 },
    { header: 'Last Visit', key: 'lastVisit', width: 12 },
    { header: 'In Artifact Export?', key: 'inArtifactExport', width: 22 }
  ]);
  farms.forEach((f) => fs1.addRow({ ...f, rank: +f.rank, farmId: +f.farmId, visitsScored: +f.visitsScored,
    avgScore: +f.avgScore, bestVisit: +f.bestVisit, worstVisit: +f.worstVisit, riskyAmmoniaVisits: +f.riskyAmmoniaVisits }));
  bandColour(fs1, 9);

  // --- Advisory list -----------------------------------------------------
  const bg = wb.addWorksheet('Below Green (advisory list)');
  styleHeader(bg, [
    { header: 'Farm ID', key: 'farmId', width: 9 },
    { header: 'Farm Name', key: 'farmName', width: 32 },
    { header: 'Farm Type', key: 'farmType', width: 11 },
    { header: 'Region', key: 'region', width: 14 },
    { header: 'Territory', key: 'territory', width: 15 },
    { header: 'Visits Scored', key: 'visitsScored', width: 12 },
    { header: 'Avg Score', key: 'avgScore', width: 10 },
    { header: 'Condition', key: 'band', width: 12 },
    { header: 'Worst Visit', key: 'worstVisit', width: 11 },
    { header: 'Risky Ammonia Visits', key: 'riskyAmmoniaVisits', width: 13 }
  ]);
  readCsv('below-green.csv').forEach((r) => bg.addRow({ ...r, farmId: +r.farmId, visitsScored: +r.visitsScored,
    avgScore: +r.avgScore, worstVisit: +r.worstVisit, riskyAmmoniaVisits: +r.riskyAmmoniaVisits }));
  bandColour(bg, 8);

  // --- Breakdowns --------------------------------------------------------
  function bandSheet(name, rows, keyHeader) {
    const ws = wb.addWorksheet(name);
    styleHeader(ws, [
      { header: keyHeader, key: 'key', width: 20 },
      { header: 'Farms', key: 'n', width: 9 },
      { header: 'Visits', key: 'visits', width: 9 },
      { header: 'Avg Score', key: 'avg', width: 11 },
      { header: 'Green', key: 'Green', width: 9 },
      { header: 'Yellow', key: 'Yellow', width: 9 },
      { header: 'Red', key: 'Red', width: 9 },
      { header: 'Below Green %', key: 'belowGreenPct', width: 14 }
    ]);
    rows.forEach((r) => ws.addRow(r));
  }
  bandSheet('By Farm Type', bd.byFarmType, 'Farm Type');
  bandSheet('By Region', bd.byRegion, 'Region');
  bandSheet('By Territory', bd.byTerritory, 'Territory');

  // --- Risky ammonia -----------------------------------------------------
  const ra = wb.addWorksheet('Risky Ammonia');
  ra.addRow(['Ammonia above 25 ppm forces that visit to score 0, overriding every other parameter.']).font = { italic: true };
  ra.addRow([]);
  const raHeaders = ['Farm ID', 'Farm Name', 'Farm Type', 'Region', 'Territory', 'Visits', 'Avg Score', 'Condition', 'In Artifact Export?'];
  const raHead = ra.addRow(raHeaders);
  raHead.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  raHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B1A1A' } };
  const exportIds = new Set(recon.map((r) => +r.farmId));
  bd.riskyAmmoniaFarms.forEach((f) => ra.addRow([f.farmId, f.farmName, f.farmType, f.region, f.territory, f.visits, f.score,
    f.band, exportIds.has(f.farmId) ? 'yes' : 'NO - hidden by cap']));
  [9, 32, 11, 14, 15, 8, 10, 10, 22].forEach((w, i) => { ra.getColumn(i + 1).width = w; });

  // --- Reconciliation ----------------------------------------------------
  const rc = wb.addWorksheet('Reconciliation');
  styleHeader(rc, [
    { header: 'Farm ID', key: 'farmId', width: 9 },
    { header: 'Farm Name', key: 'farmName', width: 32 },
    { header: 'Export Visits', key: 'exportVisits', width: 12 },
    { header: 'Our Visits', key: 'ourVisits', width: 11 },
    { header: 'Export Avg', key: 'exportAvg', width: 11 },
    { header: 'Our Avg', key: 'ourAvg', width: 10 },
    { header: 'Export Band', key: 'exportBand', width: 12 },
    { header: 'Our Band', key: 'ourBand', width: 12 },
    { header: 'Visits Match', key: 'visitsMatch', width: 12 },
    { header: 'Score Match', key: 'scoreMatch', width: 12 },
    { header: 'Band Match', key: 'bandMatch', width: 12 },
    { header: 'Note', key: 'note', width: 52 }
  ]);
  recon.forEach((r) => rc.addRow({ ...r, farmId: +r.farmId, exportVisits: +r.exportVisits, ourVisits: +r.ourVisits,
    exportAvg: +r.exportAvg, ourAvg: +r.ourAvg }));

  // --- Visit detail ------------------------------------------------------
  const vd = wb.addWorksheet('Visit Detail');
  styleHeader(vd, [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Farm ID', key: 'farmId', width: 9 },
    { header: 'Farm Name', key: 'farmName', width: 32 },
    { header: 'Farm Type', key: 'farmType', width: 11 },
    { header: 'Region', key: 'region', width: 14 },
    { header: 'Territory', key: 'territory', width: 15 },
    { header: 'Age (days)', key: 'ageDays', width: 11 },
    { header: 'Mortality', key: 'mortality', width: 10 },
    { header: 'FCR', key: 'fcr', width: 8 },
    { header: 'Visit Score', key: 'visitScore', width: 11 },
    { header: 'Condition', key: 'band', width: 12 }
  ]);
  visits.forEach((v) => vd.addRow({ ...v, farmId: +v.farmId, ageDays: v.ageDays === '' ? null : +v.ageDays,
    mortality: v.mortality === '' ? null : +v.mortality, fcr: v.fcr === '' ? null : +v.fcr, visitScore: +v.visitScore }));
  bandColour(vd, 11);

  const file = path.join(OUT, 'Akij_July_2026_Farm_Condition_Report.xlsx');
  await wb.xlsx.writeFile(file);
  console.log('wrote', path.relative(ROOT, file));
  console.log('sheets:', wb.worksheets.map((w) => `${w.name} (${w.rowCount})`).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
