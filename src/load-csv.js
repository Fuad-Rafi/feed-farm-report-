// Load a raw export of farm.tblFarmRecordArc from CSV.
//
// This is the offline twin of extract.js: same output shape, same cleaning, so
// score.js cannot tell the difference between a CSV and a live query. It exists
// because the warehouse is unreachable and a colleague with access can hand over
// a file instead.
//
// Expected columns (header names as they come out of SSMS / Azure Data Studio,
// matched case-insensitively; extra columns are ignored):
//   intFarmId, intShadeId, intRecordId, dteRecordedDate, numAgeOfBirds,
//   strFarmType, strCompany, strHeightOfFeeder, strHeightOfDrinker,
//   strLitterMaterials, strLitterCondition, StrCurtainManage, strHumidity,
//   strVentilation, strAmonia, strStockingDensity
const fs = require('fs');

// Column name in the export -> field name score.js expects.
const MAP = {
  intfarmid: 'farmId',
  intshadeid: 'shedId',
  intrecordid: 'recordId',
  dterecordeddate: 'recordedDate',
  numageofbirds: 'ageDays',
  strfarmtype: 'farmType',
  strcompany: 'company',
  strheightoffeeder: 'feederHeight',
  strheightofdrinker: 'drinkerHeight',
  strlittermaterials: 'litterMaterial',
  strlittercondition: 'litterCondition',
  strcurtainmanage: 'curtain',
  strhumidity: 'humidity',
  strventilation: 'ventilation',
  stramonia: 'ammonia',
  strstockingdensity: 'stockingDensity'
};

const NUMERIC = new Set(['farmId', 'shedId', 'recordId', 'ageDays']);

// RFC4180-ish: quoted fields, doubled quotes, embedded commas and newlines.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM

  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* handled by \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || '').trim() !== '');
}

// Dates arrive in many shapes depending on who ran the export. Accept the common
// ones and refuse anything ambiguous rather than guessing a day/month order.
function toIsoDate(raw) {
  const v = String(raw).trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);                       // 2026-07-14 ...
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);                            // 20260714
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/);               // Jul 14 2026
  if (m) {
    const mo = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
      .indexOf(m[1].toLowerCase()) + 1;
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  throw new Error(`unrecognised date format: ${JSON.stringify(v)} — re-export dates as YYYY-MM-DD`);
}

// Empty strings are NOT nulls in this warehouse. Blank means "not recorded", and
// a bare presence test that misses this changes every denominator (PLAN 3.3).
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || s.toUpperCase() === 'NULL' ? null : s;
};

function load(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (rows.length < 2) throw new Error('CSV has no data rows');

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/^﻿/, ''));
  const missing = ['intfarmid', 'dterecordeddate', 'strfarmtype', 'stramonia']
    .filter((k) => !headers.includes(k));
  if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r];
    if (raw.every((c) => String(c).trim() === '')) continue;
    const rec = {};
    headers.forEach((h, c) => {
      const key = MAP[h];
      if (!key) return;
      const value = clean(raw[c]);
      rec[key] = NUMERIC.has(key) && value !== null ? Number(value) : value;
    });
    rec.date = toIsoDate(rec.recordedDate);
    out.push(rec);
  }
  return out;
}

// Apply the mode's cleaning rules — the work extract.js does in SQL.
function applyMode(rows, config, { from = null, to = null, company = null } = {}) {
  let out = rows;

  if (from) out = out.filter((r) => r.date >= from);
  if (to) out = out.filter((r) => r.date <= to);
  if (company) out = out.filter((r) => (r.company || '') === company);

  if (config.excludeFutureDates) {
    const today = new Date().toISOString().slice(0, 10);
    out = out.filter((r) => r.date <= today);
  }

  const excluded = (config.excludedFarmTypes || []).map((t) => t.trim().toLowerCase());
  if (excluded.length) {
    out = out.filter((r) => !excluded.includes(String(r.farmType || '').trim().toLowerCase()));
  }

  if (config.dedupeShedDay) {
    // Keep the highest intRecordId per (farm, shed, date).
    const best = new Map();
    for (const r of out) {
      const key = `${r.farmId}|${r.shedId}|${r.date}`;
      const prev = best.get(key);
      if (!prev || (r.recordId ?? 0) > (prev.recordId ?? 0)) best.set(key, r);
    }
    out = [...best.values()];
  }

  return out;
}

// How many (farm, shed, date) keys appear more than once — the dedupe gate needs this.
function duplicateGroups(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = `${r.farmId}|${r.shedId}|${r.date}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const groups = [...seen.values()].filter((c) => c > 1);
  return { groups: groups.length, rows: groups.reduce((a, b) => a + b, 0) };
}

module.exports = { load, applyMode, duplicateGroups, parseCsv, toIsoDate, MAP };
