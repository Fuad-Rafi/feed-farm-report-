// Spec-mode fixtures transcribed from the authoritative workbook (PLAN 6.2)
// plus the structural assertions of PLAN 6.3.
const test = require('node:test');
const assert = require('node:assert');
const { loadConfig, roundHalfAwayFromZero, groupFor, markFor, scoreVisit, scoreFarm, bandFor } = require('../src/score');

const spec = loadConfig('spec');
const proto = loadConfig('prototype');

const GOOD = {
  feederHeight: 'Equal to back position',
  drinkerHeight: 'Equal to back position',
  litterMaterial: 'Rice husk',
  litterCondition: 'Standard',
  curtain: 'Bottom to Top',
  humidity: 'Within range',
  ventilation: 'Satisfactory',
  ammonia: 'Good (< 10 ppm)',
  stockingDensity: 'Normal'
};
const BAD = {
  feederHeight: 'Upper than back position',
  drinkerHeight: 'Below than back position',
  litterMaterial: 'Sawdust',
  litterCondition: 'Dry',
  curtain: 'Top to bottom',
  humidity: 'High',
  ventilation: 'Unsatisfactory',
  ammonia: 'Alarming (11 - 25 ppm)',
  stockingDensity: 'High'
};

// Build a row with the first `nGood` of the group's parameters good, rest bad.
function row(farmType, nGood, params) {
  const r = { farmType };
  params.forEach((id, i) => { r[id] = i < nGood ? GOOD[id] : BAD[id]; });
  return r;
}

function visitScore(farmType, nGood, config) {
  const g = groupFor(farmType, config);
  return scoreVisit(row(farmType, nGood, g.parameters), g, config).score;
}

test('rounding is half away from zero, not half to even', () => {
  assert.strictEqual(roundHalfAwayFromZero(81.25, 1), 81.3); // banker's gives 81.2
  assert.strictEqual(roundHalfAwayFromZero(72.222222, 1), 72.2);
  assert.strictEqual(roundHalfAwayFromZero(68.75, 1), 68.8);
  assert.strictEqual(roundHalfAwayFromZero(79.96, 1), 80.0);
});

test('Broiler sheet worked example: 4 of 9 good -> 72.2 Yellow', () => {
  const s = visitScore('Broiler', 4, spec);
  assert.ok(Math.abs(s - 72.2222222) < 1e-6, `got ${s}`);
  assert.strictEqual(roundHalfAwayFromZero(s, 1), 72.2);
  assert.strictEqual(bandFor(s, spec).colour, 'Yellow');
});

test('Layer sheet worked example: 3 of 5 good -> 80.0 Green', () => {
  const s = visitScore('Layer', 3, spec);
  assert.strictEqual(s, 80);
  assert.strictEqual(bandFor(s, spec).colour, 'Green');
});

test('Risky ammonia forces the visit to 0 even when all else is good', () => {
  const g = groupFor('Broiler', spec);
  const r = row('Broiler', 9, g.parameters);
  r.ammonia = 'Risky (> 25 ppm)';
  const v = scoreVisit(r, g, spec);
  assert.strictEqual(v.score, 0);
  assert.strictEqual(v.riskyAmmonia, true);
  assert.strictEqual(bandFor(v.score, spec).colour, 'Red');
});

test('meat bird band edges: 6/9 Green, 3/9 Yellow, 2/9 Red', () => {
  assert.strictEqual(roundHalfAwayFromZero(visitScore('Broiler', 6, spec), 1), 83.3);
  assert.strictEqual(bandFor(visitScore('Broiler', 6, spec), spec).colour, 'Green');
  assert.strictEqual(roundHalfAwayFromZero(visitScore('Broiler', 3, spec), 1), 66.7);
  assert.strictEqual(bandFor(visitScore('Broiler', 3, spec), spec).colour, 'Yellow');
  assert.strictEqual(roundHalfAwayFromZero(visitScore('Broiler', 2, spec), 1), 61.1);
  assert.strictEqual(bandFor(visitScore('Broiler', 2, spec), spec).colour, 'Red');
});

test('layer group moves in 10s and Yellow is reachable only at exactly 2 of 5', () => {
  assert.strictEqual(visitScore('Layer', 3, spec), 80);
  assert.strictEqual(bandFor(visitScore('Layer', 3, spec), spec).colour, 'Green');
  assert.strictEqual(visitScore('Layer', 2, spec), 70);
  assert.strictEqual(bandFor(visitScore('Layer', 2, spec), spec).colour, 'Yellow');
  assert.strictEqual(visitScore('Layer', 1, spec), 60);
  assert.strictEqual(bandFor(visitScore('Layer', 1, spec), spec).colour, 'Red');
});

test('band comes from the unrounded mean: 79.96 displays 80.0 but grades Yellow', () => {
  const f = scoreFarm([79.96], spec);
  assert.strictEqual(f.display, 80.0);
  assert.strictEqual(f.band.colour, 'Yellow');
});

test('Duck sits in the layer group and is scored on five parameters', () => {
  const g = groupFor('Duck', spec);
  assert.strictEqual(g.name, 'layer');
  assert.strictEqual(g.parameters.length, 5);
});

test('layer-group scores ignore feeder/drinker/litter even when populated', () => {
  const g = groupFor('Layer', spec);
  const clean = row('Layer', 3, g.parameters);
  const polluted = { ...clean, feederHeight: BAD.feederHeight, drinkerHeight: BAD.drinkerHeight,
                     litterMaterial: BAD.litterMaterial, litterCondition: BAD.litterCondition };
  assert.strictEqual(scoreVisit(polluted, g, spec).score, scoreVisit(clean, g, spec).score);
});

test('Cattle and Fish are not scored in spec mode', () => {
  assert.strictEqual(groupFor('Cattle', spec), null);
  assert.strictEqual(groupFor('Fish', spec), null);
});

test('trailing space on the Colour farm type still resolves', () => {
  assert.strictEqual(groupFor('Colour ', spec).name, 'meatBird');
});

test('blank and empty-string parameters are treated as not recorded', () => {
  assert.strictEqual(markFor('humidity', '', spec), null);
  assert.strictEqual(markFor('humidity', '   ', spec), null);
  assert.strictEqual(markFor('humidity', null, spec), null);
});

test('an unrecognised label throws rather than silently scoring 50', () => {
  assert.throws(() => markFor('humidity', 'Slightly damp', spec), /unrecognised value/);
});

test('the counter-intuitive good values are the configured ones', () => {
  assert.strictEqual(markFor('curtain', 'Bottom to Top', spec), 100);
  assert.strictEqual(markFor('curtain', 'Top to bottom', spec), 50);
  assert.strictEqual(markFor('litterMaterial', 'Rice husk', spec), 100);
  assert.strictEqual(markFor('litterMaterial', 'Wood shavings', spec), 50);
});

test('prototype mode puts every farm type in one 8-parameter group', () => {
  const g = groupFor('Layer', proto);
  assert.strictEqual(g.parameters.length, 8);
  assert.ok(!g.parameters.includes('stockingDensity'));
  assert.strictEqual(groupFor('Cattle', proto).parameters.length, 8); // scores nothing, but is not excluded
});

test('prototype: 5 of 8 good -> 81.25 -> displays 81.3, Green', () => {
  const s = visitScore('Broiler', 5, proto);
  assert.strictEqual(s, 81.25);
  assert.strictEqual(roundHalfAwayFromZero(s, 1), 81.3);
  assert.strictEqual(bandFor(s, proto).colour, 'Green');
});

test('a visit with nothing recorded is excluded, not scored 50', () => {
  const g = groupFor('Broiler', spec);
  assert.strictEqual(scoreVisit({ farmType: 'Broiler' }, g, spec), null);
});

test('the score floor is 50 unless ammonia is Risky', () => {
  assert.strictEqual(visitScore('Broiler', 0, spec), 50);
  assert.strictEqual(visitScore('Layer', 0, spec), 50);
});
