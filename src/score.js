// Shed-condition scoring. Pure functions of a clean row -- all cleaning happens
// upstream in extract.js, which is what makes the fixtures meaningful.
//
// Formula (PLAN 4.1), identical in both modes:
//   parameter mark: good value -> 100, any other recorded value -> 50
//   visit score:    mean of the marks over the group's RECORDED parameters
//                   ammonia starting "Risky" -> 0, overriding everything
//                   nothing recorded         -> null, visit excluded
//   farm score:     plain arithmetic mean of its visit scores
//   band:           from the UNROUNDED mean; display is rounded separately
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

function loadConfig(mode = 'spec') {
  const base = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'scoring.json'), 'utf8'));
  if (mode === 'spec') return base;
  if (mode !== 'prototype') throw new Error(`unknown mode: ${mode}`);
  const over = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'scoring.prototype.json'), 'utf8'));
  // Shallow merge is enough: the override file replaces whole top-level keys.
  return { ...base, ...over };
}

// Round half AWAY FROM ZERO, not half to even. 81.25 -> 81.3 (PLAN 4.6).
// Banker's rounding gives 81.2 and is wrong.
function roundHalfAwayFromZero(value, decimals = 1) {
  const f = Math.pow(10, decimals);
  const scaled = value * f;
  // Nudge past float error before rounding: 81.25*10 lands on 812.4999...
  const eps = Math.sign(scaled) * 1e-9;
  return (scaled < 0 ? -Math.round(-scaled - eps) : Math.round(scaled + eps)) / f;
}

function normalise(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// Which parameter set applies to this farm type.
function groupFor(farmType, config) {
  const ft = normalise(farmType);
  const groups = config.livestockGroups;
  for (const [name, g] of Object.entries(groups)) {
    if (g.farmTypes === null) return { name, parameters: g.parameters }; // prototype: one group for everything
    if (ft && g.farmTypes.some((t) => t.trim().toLowerCase() === ft.toLowerCase())) {
      return { name, parameters: g.parameters };
    }
  }
  return null; // Cattle, Fish, unknown types -- not scored
}

// 100 on the configured good value, 50 on any other RECOGNISED value.
// Throws on an unrecognised value: a silent 50 moves farms between bands.
function markFor(parameterId, value, config) {
  const v = normalise(value);
  if (v === null) return null;
  const param = config.parameters[parameterId];
  if (!param) throw new Error(`unknown parameter id: ${parameterId}`);

  const known = config.knownValues?.[parameterId];
  if (known && !known.some((k) => k.toLowerCase() === v.toLowerCase())) {
    throw new Error(`unrecognised value for ${parameterId} (${param.column}): ${JSON.stringify(v)}`);
  }
  return v.toLowerCase() === param.good.toLowerCase() ? config.marks.good : config.marks.bad;
}

// Match ammonia on a normalised prefix, never the full literal, so an upstream
// spacing change cannot silently kill the override (PLAN 3.1).
function isRiskyAmmonia(row, config) {
  const o = config.ammoniaOverride;
  const v = normalise(row.ammonia);
  return v !== null && v.toLowerCase().startsWith(o.matchPrefix.toLowerCase());
}

// -> { score, recorded, good, riskyAmmonia, marks } or null when nothing recorded
function scoreVisit(row, group, config) {
  const marks = {};
  for (const id of group.parameters) {
    const m = markFor(id, row[id], config);
    if (m !== null) marks[id] = m;
  }
  const recorded = Object.keys(marks).length;
  if (recorded < (config.minParametersRecorded ?? 1)) return null;

  const risky = group.parameters.includes('ammonia') && isRiskyAmmonia(row, config);
  const good = Object.values(marks).filter((m) => m === config.marks.good).length;
  const score = risky
    ? config.ammoniaOverride.visitScore
    : Object.values(marks).reduce((a, b) => a + b, 0) / recorded;

  return { score, recorded, good, riskyAmmonia: risky, marks };
}

function bandFor(mean, config) {
  const b = config.bands;
  if (mean >= b.green) return { code: 'A', label: 'Green · A', colour: 'Green' };
  if (mean >= b.yellow) return { code: 'B', label: 'Yellow · B', colour: 'Yellow' };
  return { code: 'C', label: 'Red · C', colour: 'Red' };
}

// Plain arithmetic mean of visit scores. Band off the raw mean, display rounded.
function scoreFarm(visitScores, config) {
  if (!visitScores.length) return null;
  const mean = visitScores.reduce((a, b) => a + b, 0) / visitScores.length;
  return {
    visits: visitScores.length,
    mean,
    display: roundHalfAwayFromZero(mean, config.rounding.decimals),
    band: bandFor(config.bands.fromUnroundedMean ? mean : roundHalfAwayFromZero(mean, config.rounding.decimals), config)
  };
}

// Score a set of clean visit rows and roll them up per farm.
// Rows carry: farmId, farmType, the parameter ids, plus any passthrough fields.
function scoreRows(rows, config) {
  const byFarm = new Map();
  const skipped = { noGroup: 0, nothingRecorded: 0 };
  const scoredVisits = [];

  for (const row of rows) {
    const group = groupFor(row.farmType, config);
    if (!group) { skipped.noGroup++; continue; }
    const v = scoreVisit(row, group, config);
    if (v === null) { skipped.nothingRecorded++; continue; }

    scoredVisits.push({ ...row, group: group.name, ...v });

    if (!byFarm.has(row.farmId)) byFarm.set(row.farmId, { farmId: row.farmId, meta: row, group: group.name, scores: [] });
    byFarm.get(row.farmId).scores.push(v.score);
  }

  const farms = [...byFarm.values()]
    .map((f) => ({ farmId: f.farmId, group: f.group, meta: f.meta, ...scoreFarm(f.scores, config) }))
    .sort((a, b) => b.mean - a.mean || a.farmId - b.farmId);

  return { farms, scoredVisits, skipped };
}

// ---------------------------------------------------------------------------
// Recovering exact visit scores from the dashboard snapshot.
//
// dashboard.html stores each visit score ALREADY ROUNDED to 1dp (93.75 is held
// as 93.8) and then averages those rounded values -- it rounds twice. Averaging
// raw visit scores is the correct method and can disagree in the first decimal.
//
// A visit score is 50 + 50*good/recorded with recorded in 1..8, or 0 for Risky
// ammonia: 24 achievable values, whose 1dp images are all distinct. The map back
// is therefore injective and the exact score is recoverable.
// ---------------------------------------------------------------------------
function buildExactByRounded(maxParams) {
  const exact = new Set([0]);
  for (let n = 1; n <= maxParams; n++) for (let g = 0; g <= n; g++) exact.add(50 + (50 * g) / n);
  const map = new Map();
  for (const e of exact) {
    const key = roundHalfAwayFromZero(e, 1);
    if (map.has(key)) throw new Error(`rounded score ${key} is ambiguous for maxParams=${maxParams}`);
    map.set(key, e);
  }
  return map;
}

const EXACT_BY_ROUNDED = { 8: buildExactByRounded(8), 9: buildExactByRounded(9) };

function recoverExactVisitScore(rounded, maxParams = 8) {
  const map = EXACT_BY_ROUNDED[maxParams] || (EXACT_BY_ROUNDED[maxParams] = buildExactByRounded(maxParams));
  const key = roundHalfAwayFromZero(rounded, 1);
  const exact = map.get(key);
  if (exact === undefined) throw new Error(`no achievable visit score rounds to ${rounded}`);
  return exact;
}

module.exports = {
  loadConfig, roundHalfAwayFromZero, groupFor, markFor,
  isRiskyAmmonia, scoreVisit, scoreFarm, bandFor, scoreRows,
  recoverExactVisitScore, buildExactByRounded
};
