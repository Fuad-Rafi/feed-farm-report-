// Mode-aware extraction. Cleaning happens HERE, in SQL, so score.js stays a
// pure function of a clean row (PLAN 5.1).
//
// Two sources:
//   fromWarehouse() -- the real thing, farm.tblFarmRecordArc
//   fromSnapshot()  -- dashboard.html's frozen rows, for when the warehouse is
//                      unreachable. Carries PRECOMPUTED prototype scores only,
//                      never raw parameter values, so it can feed prototype mode
//                      and cannot feed spec mode. See notes at fromSnapshot().
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Presence must be tested on the trimmed, blanked-to-null value: the columns
// hold empty strings, not NULLs. A bare IS NOT NULL counts blanks as recorded
// and changes every denominator (PLAN 3.3).
const COLUMNS = `
         r.intFarmId                                     AS farmId,
         r.intShadeId                                    AS shedId,
         r.intRecordId                                   AS recordId,
         r.dteRecordedDate                               AS recordedDate,
         r.numAgeOfBirds                                 AS ageDays,
         LTRIM(RTRIM(r.strFarmType))                     AS farmType,
         LTRIM(RTRIM(r.strCompany))                      AS company,
         NULLIF(LTRIM(RTRIM(r.strHeightOfFeeder)),   '') AS feederHeight,
         NULLIF(LTRIM(RTRIM(r.strHeightOfDrinker)),  '') AS drinkerHeight,
         NULLIF(LTRIM(RTRIM(r.strLitterMaterials)),  '') AS litterMaterial,
         NULLIF(LTRIM(RTRIM(r.strLitterCondition)),  '') AS litterCondition,
         NULLIF(LTRIM(RTRIM(r.StrCurtainManage)),    '') AS curtain,
         NULLIF(LTRIM(RTRIM(r.strHumidity)),         '') AS humidity,
         NULLIF(LTRIM(RTRIM(r.strVentilation)),      '') AS ventilation,
         NULLIF(LTRIM(RTRIM(r.strAmonia)),           '') AS ammonia,
         NULLIF(LTRIM(RTRIM(r.strStockingDensity)),  '') AS stockingDensity`;

// Spec: dedupe to the highest intRecordId per (farm, shed, date), drop future rows,
// restrict to scored farm types.
const SPEC_SQL = `
WITH ranked AS (
  SELECT ${COLUMNS},
         ROW_NUMBER() OVER (
           PARTITION BY r.intFarmId, r.intShadeId, CAST(r.dteRecordedDate AS date)
           ORDER BY r.intRecordId DESC) AS rn
  FROM farm.tblFarmRecordArc r
  WHERE r.dteRecordedDate <= GETDATE()
    AND CAST(r.dteRecordedDate AS date) BETWEEN @fromDate AND @toDate
    AND LTRIM(RTRIM(r.strFarmType)) IN ('Broiler','Sonali','Colour','Layer','Duck')
    AND (@company IS NULL OR LTRIM(RTRIM(r.strCompany)) = @company)
)
SELECT * FROM ranked WHERE rn = 1`;

// Prototype: no dedupe, no future-date guard, no farm-type filter.
const PROTOTYPE_SQL = `
SELECT ${COLUMNS}
FROM farm.tblFarmRecordArc r
WHERE CAST(r.dteRecordedDate AS date) BETWEEN @fromDate AND @toDate
  AND (@company IS NULL OR LTRIM(RTRIM(r.strCompany)) = @company)`;

async function fromWarehouse({ mode = 'spec', from, to, company = null }) {
  const text = mode === 'spec' ? SPEC_SQL : PROTOTYPE_SQL;
  const rows = await db.query(text, {
    fromDate: { type: db.sql.Date, value: from },
    toDate: { type: db.sql.Date, value: to },
    company: { type: db.sql.NVarChar(200), value: company }
  });
  return rows.map((r) => ({ ...r, date: new Date(r.recordedDate).toISOString().slice(0, 10) }));
}

// Flag rows breaching the age sanity limits rather than dropping them: age does
// not affect the score, but a breach signals a bad record (PLAN 3.3).
function flagAgeBreaches(rows, config) {
  const limits = config.ageLimits || {};
  return rows.filter((r) => {
    const limit = limits[String(r.farmType || '').trim()];
    return limit !== undefined && r.ageDays != null && r.ageDays > limit;
  });
}

// ---------------------------------------------------------------------------
// Snapshot source: dashboard.html, frozen at 2026-07-19.
//
// The dashboard shipped one PRECOMPUTED prototype score per visit and no raw
// parameter values (row layout [d, fid, co, rg, tr, ft, fn, age, mort, fcr, cond],
// cond = -1 meaning nothing scorable was recorded). So:
//   - prototype mode can be reproduced exactly from it
//   - spec mode CANNOT: regrouping Layer/Duck onto 5 parameters and adding
//     stocking density both need to know WHICH parameters were good, and that
//     information is not in the file.
// ---------------------------------------------------------------------------
function loadSnapshot() {
  const p = path.join(__dirname, '..', 'test', 'fixtures', 'prototype.json');
  if (!fs.existsSync(p)) throw new Error('fixtures/prototype.json missing -- run scripts/build-fixtures.js');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fromSnapshot({ from, to, company = null, farmType = null, region = null, territory = null }) {
  const snap = loadSnapshot();
  const LK = snap.lookups;
  const idx = (list, name) => (name === null ? null : list.indexOf(name) + 1);

  const coIdx = idx(LK.companies, company);
  const ftIdx = idx(LK.farmtypes, farmType);
  const rgIdx = idx(LK.regions, region);
  const trIdx = idx(LK.territories, territory);
  for (const [name, i] of [['company', coIdx], ['farmType', ftIdx], ['region', rgIdx], ['territory', trIdx]]) {
    if (i === 0) throw new Error(`${name} not found in snapshot lookups`);
  }

  // Filters act on VISIT ROWS, not on farms (PLAN 4.5). Company lives on the
  // visit row, so a company filter changes a farm's visit count and its average.
  const rows = snap.visits.filter((v) =>
    v.date >= from && v.date <= to &&
    (coIdx === null || v.co === coIdx) &&
    (ftIdx === null || v.ft === ftIdx) &&
    (rgIdx === null || v.rg === rgIdx) &&
    (trIdx === null || v.tr === trIdx));

  return rows.map((v) => ({
    farmId: v.fid,
    farmName: LK.farmnames[v.fn - 1],
    farmType: LK.farmtypes[v.ft - 1],
    company: LK.companies[v.co - 1],
    region: LK.regions[v.rg - 1],
    territory: LK.territories[v.tr - 1],
    date: v.date,
    ageDays: v.age >= 0 ? v.age : null,
    mortality: v.mort >= 0 ? v.mort : null,
    fcr: v.fcr > 0 ? v.fcr : null,
    precomputedScore: v.cond < 0 ? null : v.cond
  }));
}

module.exports = { fromWarehouse, fromSnapshot, flagAgeBreaches, SPEC_SQL, PROTOTYPE_SQL };
