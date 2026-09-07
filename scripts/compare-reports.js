// Compare the two July workbooks farm by farm and write difference.xlsx.
//
//   ours   Akij_Farm_Condition_Scores_July2026.xlsx   (our engine, 505 farms)
//   theirs Farm_Condition_Scores_july.xlsx            (dashboard export, 500 farms)
//
// Both files are read from disk -- nothing here reuses the earlier run's
// intermediate output, so this is a genuine file-to-file comparison.
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const OURS = path.join(ROOT, 'Akij_Farm_Condition_Scores_July2026.xlsx');
const THEIRS = path.join(ROOT, 'Farm_Condition_Scores_july.xlsx');

const cell = (row, c) => {
  let v = row.getCell(c).value;
  if (v && typeof v === 'object') v = v.text ?? v.result ?? String(v);
  return v;
};

async function read(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const rows = new Map();
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const id = cell(row, 2);
    if (id === null || id === undefined || id === '') continue;
    rows.set(Number(id), {
      farmName: String(cell(row, 1)),
      farmId: Number(id),
      farmType: String(cell(row, 3)),
      region: String(cell(row, 4)),
      territory: String(cell(row, 5)),
      visits: Number(cell(row, 6)),
      avg: Number(cell(row, 7)),
      band: String(cell(row, 8)).trim()
    });
  }
  return rows;
}

// "Green · A" -> "Green"
const colourOf = (band) => band.split('·')[0].trim();

async function main() {
  const ours = await read(OURS);
  const theirs = await read(THEIRS);

  const inBoth = [...ours.keys()].filter((id) => theirs.has(id));
  const onlyOurs = [...ours.keys()].filter((id) => !theirs.has(id));
  const onlyTheirs = [...theirs.keys()].filter((id) => !ours.has(id));

  const bandDiff = [];
  const scoreOnlyDiff = [];

  for (const id of inBoth) {
    const a = ours.get(id);
    const b = theirs.get(id);
    const sameBand = colourOf(a.band) === colourOf(b.band);
    const sameScore = Math.abs(a.avg - b.avg) < 1e-9;
    if (!sameBand) {
      bandDiff.push({ ...a, theirAvg: b.avg, theirBand: b.band, theirVisits: b.visits });
    } else if (!sameScore) {
      scoreOnlyDiff.push({ ...a, theirAvg: b.avg, theirBand: b.band, theirVisits: b.visits });
    }
  }

  bandDiff.sort((x, y) => x.avg - y.avg);
  scoreOnlyDiff.sort((x, y) => x.avg - y.avg);
  const onlyOursRows = onlyOurs.map((id) => ours.get(id)).sort((a, b) => a.avg - b.avg);

  // ---- build difference.xlsx --------------------------------------------
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Akij Agro Feed - shed condition engine';
  wb.created = new Date();

  const HEAD_FILL = 'FF2F5233';
  const BAND_FILL = { Green: 'FFD8EFD8', Yellow: 'FFFDF3CF', Red: 'FFF8D2CE' };

  function sheet(name, cols) {
    const ws = wb.addWorksheet(name);
    ws.columns = cols;
    const h = ws.getRow(1);
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    h.alignment = { vertical: 'middle', wrapText: true };
    h.height = 26;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    return ws;
  }

  function paint(ws, col, key) {
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const argb = BAND_FILL[colourOf(String(row.getCell(col).value || ''))];
      if (argb) row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    });
  }

  // --- Summary ------------------------------------------------------------
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 46 }, { width: 16 }, { width: 62 }];
  const t = s.addRow(['JULY 2026 - CATEGORY DIFFERENCES BETWEEN THE TWO REPORTS', '', '']);
  t.font = { bold: true, size: 13 };
  s.addRow([]);
  s.addRow(['Our report', 'Akij_Farm_Condition_Scores_July2026.xlsx', `${ours.size} farms`]);
  s.addRow(['Dashboard export', 'Farm_Condition_Scores_july.xlsx', `${theirs.size} farms`]);
  s.addRow(['Window', '2026-07-01 .. 2026-07-31', 'Company: AKIJ Agro Feed Limited']);
  s.addRow([]);
  const h = s.addRow(['RESULT', '', '']); h.font = { bold: true };
  s.addRow(['Farms present in both', inBoth.length, '']);
  const bd = s.addRow(['Farms in a DIFFERENT category', bandDiff.length,
    bandDiff.length === 0 ? 'No farm changes tier between the two reports' : 'Listed on "Different Category"']);
  bd.font = { bold: true };
  s.addRow(['Farms only in our report', onlyOurs.length, 'Cut by the export\'s 500-row cap - see "Only In Our Report"']);
  s.addRow(['Farms only in the export', onlyTheirs.length, '']);
  s.addRow(['Same category, score differs by 0.1', scoreOnlyDiff.length, 'See "Score Differs Only"']);
  s.addRow([]);
  const wh = s.addRow(['WHY THEY DIFFER', '', '']); wh.font = { bold: true };
  s.addRow(['1', 'Row cap', 'The export shows the best 500 of 505 farms; the 5 it drops are all Red']);
  s.addRow(['2', 'Double rounding', 'The export averages visit scores it had already rounded to 1 dp; we average the raw scores']);
  s.addRow(['3', 'Band source', 'We take the band from the unrounded mean, per PLAN 4.6']);
  s.addRow([]);
  s.addRow(['Note', '', 'Both reports use the prototype rule (8 parameters, all farm types).']);
  s.addRow(['', '', 'The spec rule scores Layer/Duck on 5 parameters and adds stocking density;']);
  s.addRow(['', '', 'it needs raw parameter values from the warehouse, which is unreachable.']);

  // --- Different Category -------------------------------------------------
  const dc = sheet('Different Category', [
    { header: 'Farm Name', key: 'farmName', width: 32 },
    { header: 'Farm ID', key: 'farmId', width: 10 },
    { header: 'Farm Type', key: 'farmType', width: 12 },
    { header: 'Region', key: 'region', width: 15 },
    { header: 'Territory', key: 'territory', width: 16 },
    { header: 'Visits', key: 'visits', width: 9 },
    { header: 'Our Score', key: 'avg', width: 11 },
    { header: 'Our Category', key: 'band', width: 14 },
    { header: 'Export Score', key: 'theirAvg', width: 13 },
    { header: 'Export Category', key: 'theirBand', width: 16 }
  ]);
  if (bandDiff.length === 0) {
    const r = dc.addRow({ farmName: 'None - no farm falls in a different category between the two reports.' });
    r.font = { italic: true };
    dc.mergeCells(2, 1, 2, 10);
  } else {
    bandDiff.forEach((f) => dc.addRow(f));
    paint(dc, 8); paint(dc, 10);
  }

  // --- Only In Our Report -------------------------------------------------
  const oo = sheet('Only In Our Report', [
    { header: 'Farm Name', key: 'farmName', width: 32 },
    { header: 'Farm ID', key: 'farmId', width: 10 },
    { header: 'Farm Type', key: 'farmType', width: 12 },
    { header: 'Region', key: 'region', width: 15 },
    { header: 'Territory', key: 'territory', width: 16 },
    { header: 'Visits', key: 'visits', width: 9 },
    { header: 'Our Score', key: 'avg', width: 11 },
    { header: 'Our Category', key: 'band', width: 14 },
    { header: 'Why missing from the export', key: 'why', width: 42 }
  ]);
  onlyOursRows.forEach((f) => oo.addRow({ ...f, why: 'Cut by the 500-row cap (export sorts best first)' }));
  paint(oo, 8);

  // --- Score Differs Only -------------------------------------------------
  const sd = sheet('Score Differs Only', [
    { header: 'Farm Name', key: 'farmName', width: 32 },
    { header: 'Farm ID', key: 'farmId', width: 10 },
    { header: 'Farm Type', key: 'farmType', width: 12 },
    { header: 'Region', key: 'region', width: 15 },
    { header: 'Territory', key: 'territory', width: 16 },
    { header: 'Visits', key: 'visits', width: 9 },
    { header: 'Our Score', key: 'avg', width: 11 },
    { header: 'Export Score', key: 'theirAvg', width: 13 },
    { header: 'Difference', key: 'delta', width: 11 },
    { header: 'Category (same in both)', key: 'band', width: 20 }
  ]);
  scoreOnlyDiff.forEach((f) => {
    const row = sd.addRow({ ...f, delta: +(f.avg - f.theirAvg).toFixed(1) });
    row.getCell(9).numFmt = '+0.0;-0.0;0.0';
  });
  paint(sd, 10);

  for (const ws of [dc, oo, sd]) {
    ws.eachRow((row, i) => { if (i > 1) { row.getCell(7).numFmt = '0.0'; } });
  }

  const file = path.join(ROOT, 'difference.xlsx');
  await wb.xlsx.writeFile(file);

  console.log('wrote difference.xlsx');
  console.log(`  ours ${ours.size} farms | export ${theirs.size} farms | in both ${inBoth.length}`);
  console.log(`  DIFFERENT CATEGORY      ${bandDiff.length}`);
  console.log(`  only in our report      ${onlyOurs.length}`);
  console.log(`  only in the export      ${onlyTheirs.length}`);
  console.log(`  same category, score differs ${scoreOnlyDiff.length}`);
  if (bandDiff.length) console.table(bandDiff.map((f) => ({ id: f.farmId, name: f.farmName, ours: f.avg, oursBand: f.band, theirs: f.theirAvg, theirsBand: f.theirBand })));
  console.log('\n  only in our report:');
  console.table(onlyOursRows.map((f) => ({ id: f.farmId, name: f.farmName, type: f.farmType, region: f.region, score: f.avg, band: f.band })));
}

main().catch((e) => { console.error(e); process.exit(1); });
