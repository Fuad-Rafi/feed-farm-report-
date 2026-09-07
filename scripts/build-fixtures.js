// Turn the two frozen artefacts into JSON fixtures.
//
//   dashboard.html                  -> fixtures/prototype.json   (every visit row + lookups)
//   Farm_Condition_Scores_july.xlsx -> fixtures/july-export.json  (the 500 exported farm rows)
//
// Run once. The output is what the July analysis and the regression gates read.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'test', 'fixtures');

// dashboard row layout, lifted verbatim from dashboard.html renderFarmCondition():
//   r = [d, fid, co, rg, tr, ft, fn, age, mort, fcr, cond]
// cond === -1 means no shed-condition field was recorded on that visit.
const FIELDS = ['d', 'fid', 'co', 'rg', 'tr', 'ft', 'fn', 'age', 'mort', 'fcr', 'cond'];

// Each of DATA / LK lives on one very long line, terminated by ';'.
// Line endings are CRLF, so match on the line rather than on ";\n".
function extractConst(text, name) {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`${name} not found in dashboard.html`);
  let body = line.slice(`const ${name} = `.length);
  // DATA is followed by a trailing `// [d, fid, ...]` schema comment on the same line.
  const close = body.lastIndexOf(body.trimStart()[0] === '[' ? '];' : '};');
  if (close >= 0) body = body.slice(0, close + 1);
  return JSON.parse(body);
}

function buildPrototype() {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  const rows = extractConst(html, 'DATA');
  const lk = extractConst(html, 'LK');

  // BASE_DATE = 2024-01-01 UTC; r[0] is a day offset from it.
  const BASE = Date.UTC(2024, 0, 1);
  const visits = rows.map((r) => {
    const o = {};
    FIELDS.forEach((f, i) => { o[f] = r[i]; });
    o.date = new Date(BASE + o.d * 86400000).toISOString().slice(0, 10);
    return o;
  });

  const out = {
    _source: 'dashboard.html',
    _note: 'Prototype snapshot. cond is precomputed by the dashboard; raw parameter values are NOT present.',
    baseDate: '2024-01-01',
    lookups: {
      companies: lk.companies,
      regions: lk.regions,
      territories: lk.territories,
      farmtypes: lk.farmtypes,
      farmnames: lk.farmnames
    },
    visits
  };
  fs.writeFileSync(path.join(FIX, 'prototype.json'), JSON.stringify(out));

  const dates = visits.map((v) => v.date).sort();
  const scored = visits.filter((v) => v.cond >= 0);
  console.log(`prototype.json: ${visits.length} visit rows, ${scored.length} scorable`);
  console.log(`  date span ${dates[0]} .. ${dates[dates.length - 1]}`);
  return out;
}

async function buildJulyExport() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ROOT, 'Farm_Condition_Scores_july.xlsx'));
  const ws = wb.worksheets[0];

  const cell = (row, c) => {
    let v = row.getCell(c).value;
    if (v && typeof v === 'object') v = v.text ?? v.result ?? String(v);
    return v;
  };

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (cell(row, 2) == null || cell(row, 2) === '') continue;
    rows.push({
      farmName: String(cell(row, 1)),
      farmId: Number(cell(row, 2)),
      farmType: String(cell(row, 3)),
      region: String(cell(row, 4)),
      territory: String(cell(row, 5)),
      visits: Number(cell(row, 6)),
      avg: Number(cell(row, 7)),
      band: String(cell(row, 8))
    });
  }

  const out = {
    _source: 'Farm_Condition_Scores_july.xlsx',
    _sheet: ws.name,
    _cap: 500,
    rows
  };
  fs.writeFileSync(path.join(FIX, 'july-export.json'), JSON.stringify(out, null, 1));
  console.log(`july-export.json: ${rows.length} farm rows, ${rows.reduce((s, r) => s + r.visits, 0)} visits`);
  return out;
}

async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  buildPrototype();
  await buildJulyExport();
}

main().catch((e) => { console.error(e); process.exit(1); });
