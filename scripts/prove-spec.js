// Prove the spec rule against real data.
//
//   node scripts/prove-spec.js <raw-export.csv>
//
// There is no spec-mode oracle -- nobody has ever computed spec scores, so there
// is nothing to check them against beyond the workbook's two worked examples.
// The prototype rule DOES have a known-correct answer. So the proof runs the raw
// values through the prototype rule first and matches the dashboard's shipped
// scores; that validates extract/markFor/scoreVisit/groupFor -- the exact
// machinery spec mode depends on. Only then does it flip to spec mode.
const fs = require('fs');
const path = require('path');
const { loadConfig, scoreVisit, groupFor, scoreRows, roundHalfAwayFromZero } = require('../src/score');
const { load, applyMode, duplicateGroups } = require('../src/load-csv');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');

// Rows the dashboard shipped that DWH no longer has (PLAN 6.1).
const KNOWN_DELETED = [{ farmId: 2264, date: '2026-05-12' }, { farmId: 4252, date: '2026-06-22' }];

const PARAMS = ['feederHeight', 'drinkerHeight', 'litterMaterial', 'litterCondition',
                'curtain', 'humidity', 'ventilation', 'ammonia', 'stockingDensity'];

let failures = 0;
const line = (s = '') => console.log(s);
function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
}

function main() {
  const csv = process.argv[2];
  if (!csv) { console.error('usage: node scripts/prove-spec.js <raw-export.csv>'); process.exit(2); }
  fs.mkdirSync(LOGS, { recursive: true });

  const spec = loadConfig('spec');
  const proto = loadConfig('prototype');
  const raw = load(csv);

  line(`\nRAW EXPORT  ${path.basename(csv)}`);
  const dates = raw.map((r) => r.date).sort();
  line(`  ${raw.length.toLocaleString()} rows, ${dates[0]} .. ${dates[dates.length - 1]}`);

  // ---- STEP 1 — value domains ------------------------------------------
  // markFor throws on anything unrecognised, so catch config drift here first.
  line('\nSTEP 1  VALUE DOMAINS');
  const unknown = {};
  for (const id of PARAMS) {
    const known = new Set((spec.knownValues[id] || []).map((v) => v.toLowerCase()));
    for (const r of raw) {
      const v = r[id];
      if (v === null || v === undefined) continue;
      if (!known.has(String(v).trim().toLowerCase())) {
        (unknown[id] = unknown[id] || new Map()).set(v, (unknown[id].get(v) || 0) + 1);
      }
    }
  }
  const unknownIds = Object.keys(unknown);
  check(unknownIds.length === 0, 'every recorded value is in the configured domain',
    unknownIds.length ? `${unknownIds.length} column(s) carry unknown labels` : '');
  for (const id of unknownIds) {
    for (const [v, n] of [...unknown[id]].sort((a, b) => b[1] - a[1])) {
      line(`        ${id}: ${JSON.stringify(v)} x${n}  -> add to knownValues, or fix the export`);
    }
  }
  if (unknownIds.length) {
    line('\n  Stopping: scoring an unknown label would silently mark it 50 and move farms between bands.');
    process.exit(1);
  }

  // ---- STEP 2 — reproduce the prototype FROM RAW VALUES -----------------
  // This is the linchpin. The dashboard's per-visit scores are the oracle.
  line('\nSTEP 2  PROTOTYPE REPLAY FROM RAW VALUES  (the oracle)');
  const fixPath = path.join(ROOT, 'test', 'fixtures', 'prototype.json');
  if (!fs.existsSync(fixPath)) {
    line('  SKIP — fixtures/prototype.json missing; run scripts/build-fixtures.js');
  } else {
    const snap = JSON.parse(fs.readFileSync(fixPath, 'utf8'));
    const LK = snap.lookups;

    // The snapshot keys on (farmId, date); scores are held rounded to 1dp.
    const oracle = new Map();
    for (const v of snap.visits) {
      if (v.cond < 0) continue;
      const key = `${v.fid}|${v.date}`;
      if (!oracle.has(key)) oracle.set(key, []);
      oracle.get(key).push(v.cond);
    }

    const protoRows = applyMode(raw, proto, {});
    let compared = 0, exact = 0;
    const misses = [];
    for (const r of protoRows) {
      const key = `${r.farmId}|${r.date}`;
      const want = oracle.get(key);
      if (!want || !want.length) continue;
      const g = groupFor(r.farmType, proto);
      if (!g) continue;
      const v = scoreVisit(r, g, proto);
      if (v === null) continue;
      compared++;
      const mine = roundHalfAwayFromZero(v.score, 1);
      if (want.some((w) => Math.abs(w - mine) < 1e-9)) exact++;
      else misses.push({ farmId: r.farmId, date: r.date, mine, dashboard: want.join('/') });
    }

    const excusable = misses.filter((m) => KNOWN_DELETED.some((k) => k.farmId === m.farmId && k.date === m.date));
    const real = misses.filter((m) => !excusable.includes(m));
    line(`  compared ${compared.toLocaleString()} visits against the dashboard`);

    // A run that compared nothing proves nothing. This is the step the rest of
    // the proof leans on, so an empty overlap has to fail loudly, not pass.
    const MIN_OVERLAP = 500;
    if (compared < MIN_OVERLAP) {
      check(false, 'the replay compared enough visits to mean anything',
        `only ${compared.toLocaleString()} of the export's rows overlap the dashboard snapshot (need ${MIN_OVERLAP}+). ` +
        `Re-export covering 2026-05-01..2026-07-19, which is where the snapshot has data.`);
    } else {
      check(real.length === 0, 'every raw-scored visit matches the dashboard',
        `${exact.toLocaleString()}/${compared.toLocaleString()} exact, ${real.length} unexplained, ${excusable.length} known-deleted`);
    }
    real.slice(0, 15).forEach((m) => line(`        farm ${m.farmId} ${m.date}: ours ${m.mine} vs dashboard ${m.dashboard}`));
    if (real.length) {
      fs.writeFileSync(path.join(LOGS, 'prototype-replay-misses.json'), JSON.stringify(real, null, 1));
      line(`        full list -> logs/prototype-replay-misses.json`);
    }
  }

  // ---- STEP 3 — spec mode ----------------------------------------------
  line('\nSTEP 3  SPEC MODE');
  const specRows = applyMode(raw, spec, {});
  const specOut = scoreRows(specRows, spec);
  const bands = { Green: 0, Yellow: 0, Red: 0 };
  specOut.farms.forEach((f) => bands[f.band.colour]++);
  line(`  ${specOut.farms.length.toLocaleString()} farms, ${specOut.scoredVisits.length.toLocaleString()} scored visits`);
  line(`  Green ${bands.Green}  Yellow ${bands.Yellow}  Red ${bands.Red}`);

  // ---- STEP 4 — structural gates (PLAN 6.3) ----------------------------
  line('\nSTEP 4  STRUCTURAL GATES');

  const dupBefore = duplicateGroups(raw);
  const dupAfter = duplicateGroups(specRows);
  check(dupAfter.groups === 0, 'spec mode leaves no duplicate (farm, shed, date) key',
    `${dupBefore.groups} collision groups in the raw export, ${dupAfter.groups} after cleaning`);

  const today = new Date().toISOString().slice(0, 10);
  const futureRaw = raw.filter((r) => r.date > today).length;
  check(specRows.every((r) => r.date <= today), 'spec mode drops future-dated rows',
    `${futureRaw} future row(s) in the raw export`);

  const colour = specOut.farms.filter((f) => String(f.meta.farmType).trim() === 'Colour');
  check(colour.length > 0, 'Colour farms survive the trailing-space trim', `${colour.length} farms`);

  const layerish = specOut.scoredVisits.filter((v) => v.group === 'layer');
  const layerClean = layerish.every((v) => !['feederHeight', 'drinkerHeight', 'litterMaterial', 'litterCondition']
    .some((p) => p in v.marks));
  check(layerClean, 'no Layer/Duck score is influenced by feeder, drinker or litter',
    `${layerish.length} layer-group visits checked`);

  const ducks = specOut.farms.filter((f) => String(f.meta.farmType).trim() === 'Duck');
  check(ducks.length > 0 && ducks.every((d) => d.group === 'layer'), 'Duck is scored in the layer group',
    `${ducks.length} farms`);

  const excluded = specOut.farms.filter((f) => ['Cattle', 'Fish'].includes(String(f.meta.farmType).trim()));
  check(excluded.length === 0, 'Cattle and Fish are absent from spec output');

  const risky = specOut.scoredVisits.filter((v) => v.riskyAmmonia);
  check(risky.every((v) => v.score === 0), 'every Risky ammonia visit scores 0', `${risky.length} visits`);

  const floor = specOut.scoredVisits.filter((v) => !v.riskyAmmonia).every((v) => v.score >= 50);
  check(floor, 'no non-Risky visit scores below the 50 floor');

  // Distribution smoke test — catches a mis-transcribed good value in a way unit
  // tests cannot. Skewing almost everything Green means a `good` is wrong.
  const greenPct = (100 * bands.Green) / specOut.farms.length;
  check(greenPct < 90, 'the distribution is not degenerate', `${greenPct.toFixed(1)}% Green`);

  // ---- mode diff --------------------------------------------------------
  line('\nMODE DIFF  spec vs prototype');
  const protoOut = scoreRows(applyMode(raw, proto, {}), proto);
  const protoBy = new Map(protoOut.farms.map((f) => [f.farmId, f]));
  const diff = [];
  for (const f of specOut.farms) {
    const p = protoBy.get(f.farmId);
    if (p && p.band.colour !== f.band.colour) {
      diff.push({
        farmId: f.farmId, farmType: String(f.meta.farmType).trim(),
        specScore: f.display, specBand: f.band.colour,
        protoScore: p.display, protoBand: p.band.colour
      });
    }
  }
  const byType = diff.reduce((a, d) => { a[d.farmType] = (a[d.farmType] || 0) + 1; return a; }, {});
  line(`  ${diff.length} farms land in a different band  ${JSON.stringify(byType)}`);
  fs.writeFileSync(path.join(LOGS, `mode-diff-${today}.csv`),
    'farmId,farmType,specScore,specBand,protoScore,protoBand\n' +
    diff.map((d) => `${d.farmId},${d.farmType},${d.specScore},${d.specBand},${d.protoScore},${d.protoBand}`).join('\n') + '\n');
  line(`  -> logs/mode-diff-${today}.csv`);

  line(`\n${failures === 0 ? 'ALL GATES PASSED — spec mode is proven on real data.' : failures + ' GATE(S) FAILED — do not ship spec numbers yet.'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
