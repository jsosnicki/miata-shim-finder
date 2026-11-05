import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSizes } from '../assets/optimizer.js';
import { formatExact, formatLash, formatShim, getUnit, onUnitChange, setUnit, snapToKnown, toMm } from '../assets/units.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));
const sizes = catalog.parts.map((p) => p.mm);

test('metric is the default', () => assert.equal(getUnit(), 'mm'));

test('inch sizes match the inch column in the PDF for all 68 parts', () => {
  for (const p of catalog.parts) assert.equal(formatShim(p.mm, 'in'), p.in.toFixed(4), p.id);
});

test('every part size survives a trip to inches and back', () => {
  for (const mm of sizes) {
    if (mm === 3.25) continue; // Covered below.
    const shown = formatShim(mm, 'in');
    assert.equal(parseSizes(shown, { snap: sizes }).requests[0].mm, mm, shown);
  }
});

test('3.25 and 3.252 are the only sizes that share an inch value, and typing it picks the nearest', () => {
  const shown = new Map();
  for (const mm of new Set(sizes)) {
    const text = formatShim(mm, 'in');
    shown.set(text, [...(shown.get(text) || []), mm]);
  }
  const shared = [...shown.values()].filter((list) => list.length > 1);
  assert.deepEqual(shared, [[3.25, 3.252]]);
  assert.equal(parseSizes('0.1280', { snap: sizes }).requests[0].mm, 3.252);
});

test('metric formatting is unchanged', () => {
  assert.equal(formatShim(2.9, 'mm'), '2.90');
  assert.equal(formatShim(2.875, 'mm'), '2.875');
  assert.equal(formatExact(2.9, 'mm'), '2.900');
  assert.equal(formatLash(0.2, 'mm'), '0.20');
  assert.equal(formatLash(0.205, 'mm'), '0.205');
});

test('lash in inches shows 4 decimals', () => {
  assert.equal(formatLash(0.28, 'in'), '0.0110');
  assert.equal(formatLash(0.34, 'in'), '0.0134');
  assert.equal(formatLash(0.18, 'in'), '0.0071');
});

test('toMm converts typed values', () => {
  assert.equal(toMm(0.1, 'in'), 2.54);
  assert.equal(toMm(0.008, 'in'), 0.203);
  assert.equal(toMm(2.875, 'mm'), 2.875);
});

test('a lash reading equal to the shown limit counts as that limit', () => {
  const limits = [0.28, 0.34];
  assert.equal(snapToKnown(toMm(0.011, 'in'), limits), 0.28);
  assert.equal(snapToKnown(toMm(0.0134, 'in'), limits), 0.34);
});

test('every spec limit survives its own rounded inch value', () => {
  for (const limit of [0.18, 0.23, 0.28, 0.34]) {
    const shown = Number(formatLash(limit, 'in'));
    assert.equal(snapToKnown(toMm(shown, 'in'), [limit]), limit);
  }
});

test('a real gap is not snapped away', () => {
  assert.equal(snapToKnown(toMm(0.007, 'in'), [0.18, 0.23]), 0.178);
  assert.equal(snapToKnown(0.27, [0.28, 0.34]), 0.27);
});

test('setUnit tells listeners the new and previous unit, once per change', () => {
  const calls = [];
  onUnitChange((next, previous) => calls.push([next, previous]));
  setUnit('in');
  setUnit('in');
  setUnit('mm');
  assert.deepEqual(calls, [['in', 'mm'], ['mm', 'in']]);
});
