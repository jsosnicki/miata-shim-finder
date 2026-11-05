import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOffers } from '../assets/optimizer.js';
import { DEFAULT_SPEC, VALVES, assign, buildPlan, buyListText, lashStatus, shimLabel, sizeCost, sizeOptions } from '../assets/lash.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));
const prices = JSON.parse(readFileSync(new URL('../data/prices.json', import.meta.url)));
const options = sizeOptions(buildOffers(catalog, prices));

const reading = (id, shim, lash) => ({ id, side: id[0] === 'I' ? 'intake' : 'exhaust', shim, lash });
const byId = (plan, id) => plan.valves.find((v) => v.id === id);

test('the head has 16 valves, 8 per side', () => {
  assert.equal(VALVES.length, 16);
  assert.equal(new Set(VALVES.map((v) => v.id)).size, 16);
  assert.equal(VALVES.filter((v) => v.side === 'intake').length, 8);
  assert.equal(VALVES[0].id, 'I1F');
  assert.equal(VALVES.at(-1).id, 'E4R');
});

test('lash status uses the spec band, including its edges', () => {
  const { intake, exhaust } = DEFAULT_SPEC;
  assert.equal(lashStatus(0.18, intake), 'ok');
  assert.equal(lashStatus(0.23, intake), 'ok');
  assert.equal(lashStatus(0.17, intake), 'tight');
  assert.equal(lashStatus(0.24, intake), 'loose');
  assert.equal(lashStatus(0.28, exhaust), 'ok');
  assert.equal(lashStatus(0.34, exhaust), 'ok');
  assert.equal(lashStatus(0.35, exhaust), 'loose');
});

test('the shim window comes from shim + lash - spec', () => {
  const [v] = buildPlan([reading('I1F', 2.9, 0.3)], DEFAULT_SPEC, options).valves;
  assert.equal(v.lo, 2970); // 3.20 stack - 0.23
  assert.equal(v.hi, 3020); // 3.20 stack - 0.18
  assert.equal(v.status, 'loose');
});

test('a loose valve gets a thicker shim, a tight valve gets a thinner one', () => {
  const loose = byId(buildPlan([reading('I1F', 2.9, 0.3)], DEFAULT_SPEC, options), 'I1F');
  assert.ok(loose.newShim > 2.9);
  assert.ok(loose.predicted >= 0.18 && loose.predicted <= 0.23);
  const tight = byId(buildPlan([reading('E1F', 3, 0.2)], DEFAULT_SPEC, options), 'E1F');
  assert.ok(tight.newShim < 3);
  assert.ok(tight.predicted >= 0.28 && tight.predicted <= 0.34);
});

test('in-spec valves are left alone when nothing needs their shim', () => {
  const plan = buildPlan([reading('I1F', 2.85, 0.2), reading('E1F', 3, 0.3)], DEFAULT_SPEC, options);
  assert.equal(plan.counts.unchanged, 2);
  assert.equal(plan.counts.moved, 0);
  assert.equal(plan.buys.length, 0);
});

test('two out-of-spec valves can fix each other by swapping', () => {
  // I1F wants about 2.95, I1R wants about 2.85, and each holds the other's shim.
  const plan = buildPlan([reading('I1F', 2.85, 0.31), reading('I1R', 2.95, 0.11)], DEFAULT_SPEC, options);
  assert.equal(plan.counts.buying, 0);
  assert.equal(plan.counts.moved, 2);
  assert.equal(plan.counts.saved, 2);
  assert.equal(byId(plan, 'I1F').from, 'I1R');
  assert.equal(byId(plan, 'I1R').from, 'I1F');
  assert.equal(byId(plan, 'I1F').predicted, 0.21);
  assert.equal(byId(plan, 'I1R').predicted, 0.21);
});

test('a three-way chain is found', () => {
  const plan = buildPlan(
    [reading('I1F', 2.8, 0.3), reading('I2F', 2.9, 0.3), reading('I3F', 3, 0.0)],
    DEFAULT_SPEC,
    options
  );
  // I1F takes 2.90, I2F takes 3.00, and I3F (window 2.77 to 2.82) takes 2.80.
  assert.equal(plan.counts.buying, 0);
  assert.equal(byId(plan, 'I1F').newShim, 2.9);
  assert.equal(byId(plan, 'I2F').newShim, 3);
  assert.equal(byId(plan, 'I3F').newShim, 2.8);
});

test('intake and exhaust valves can trade shims', () => {
  const plan = buildPlan([reading('I1F', 2.9, 0.1), reading('E1F', 2.8, 0.42)], DEFAULT_SPEC, options);
  assert.equal(plan.counts.buying, 0);
  assert.equal(byId(plan, 'I1F').newShim, 2.8);
  assert.equal(byId(plan, 'E1F').newShim, 2.9);
});

test('an in-spec valve gives up its shim when it can take another without a purchase', () => {
  // E1F is in spec, but it holds the shim I1F needs, and I1F's old shim also suits E1F.
  const plan = buildPlan([reading('I1F', 2.96, 0.15), reading('E1F', 2.92, 0.33)], DEFAULT_SPEC, options);
  assert.equal(plan.counts.buying, 0);
  assert.equal(plan.counts.moved, 2);
  assert.equal(byId(plan, 'I1F').newShim, 2.92);
  assert.equal(byId(plan, 'E1F').newShim, 2.96);
  assert.equal(byId(plan, 'I1F').predicted, 0.19);
  assert.equal(byId(plan, 'E1F').predicted, 0.29);
});

test('an in-spec valve is not disturbed when that would not save a purchase', () => {
  // I1F could use E1F's shim, but E1F would then need a new one, so buying is the same count.
  const plan = buildPlan([reading('I1F', 2.8, 0.31), reading('E1F', 2.9, 0.3)], DEFAULT_SPEC, options);
  assert.equal(plan.counts.buying, 1);
  assert.equal(plan.counts.moved, 0);
  assert.equal(byId(plan, 'E1F').action, 'keep');
  assert.equal(byId(plan, 'I1F').action, 'buy');
});

test('valves that a shim could fix are identified even when the plan does not use it', () => {
  const plan = buildPlan([reading('I1F', 2.8, 0.31), reading('E1F', 2.9, 0.3)], DEFAULT_SPEC, options);
  assert.deepEqual(byId(plan, 'E1F').fixes, ['I1F']);
  assert.deepEqual(byId(plan, 'I1F').fixedBy, ['E1F']);
});

test('shims nothing needs are listed as left over', () => {
  const plan = buildPlan([reading('I1F', 2.8, 0.31)], DEFAULT_SPEC, options);
  assert.deepEqual(plan.leftovers, [{ shim: 2.8, from: 'I1F' }]);
});

test('buying for several valves prefers a shared size when that is cheaper', () => {
  // Five valves all accept 2.20, which only Silver Seal sells. The windows also accept 2.25.
  const plan = buildPlan(
    [
      reading('E1F', 2.5, 0.09),
      reading('E1R', 2.5, 0.09),
      reading('E2F', 2.5, 0.09),
      reading('E2R', 2.5, 0.09),
    ],
    DEFAULT_SPEC,
    options
  );
  assert.equal(plan.buys.length, 1);
  assert.equal(plan.buys[0].qty, 4);
});

test('a valve needing a size nobody lists is reported', () => {
  const plan = buildPlan([reading('E1F', 3.4, 0.5)], DEFAULT_SPEC, options);
  assert.equal(plan.unsolved.length, 1);
  assert.equal(byId(plan, 'E1F').action, 'none');
  assert.equal(byId(plan, 'E1F').neededShim, 3.59);
  assert.equal(plan.counts.buying, 1);
});

test('an edited spec changes the result', () => {
  const spec = { intake: { min: 0.2, max: 0.23 }, exhaust: DEFAULT_SPEC.exhaust };
  assert.equal(byId(buildPlan([reading('I1F', 2.85, 0.19)], spec, options), 'I1F').status, 'tight');
  assert.equal(byId(buildPlan([reading('I1F', 2.85, 0.19)], DEFAULT_SPEC, options), 'I1F').status, 'ok');
});

test('no readings gives an empty plan', () => {
  const plan = buildPlan([], DEFAULT_SPEC, options);
  assert.equal(plan.counts.measured, 0);
  assert.deepEqual(plan.moves, []);
});

test('sizeCost uses singles, packs or a mix, whichever is lowest', () => {
  const option = { mm: 2.8, single: 12.6, packs: [{ qty: 4, price: 18.15 }] };
  assert.equal(sizeCost(option, 1), 12.6);
  assert.equal(sizeCost(option, 2), 18.15);
  assert.equal(sizeCost(option, 4), 18.15);
  assert.equal(sizeCost(option, 5), 30.75); // pack + single beats 2 packs at 36.30
});

test('sizeOptions only offers orderable sizes', () => {
  const sizes = options.map((o) => o.mm);
  assert.ok(sizes.includes(2)); // Silver Seal only
  assert.ok(sizes.includes(3.396)); // Mazda only
  assert.ok(!sizes.includes(3.075)); // Toyota 13753-50750 is unavailable at every store
  assert.ok(!sizes.includes(3.225)); // Toyota 13753-50790 is unavailable at every store
});

test('shim labels keep at least two decimals', () => {
  assert.equal(shimLabel(2.9), '2.90');
  assert.equal(shimLabel(2.875), '2.875');
  assert.equal(shimLabel(3.052), '3.052');
  assert.equal(buyListText([{ mm: 2.875, qty: 1 }, { mm: 2.9, qty: 2 }]), '2.875, 2.90x2');
});

test('assign finds the minimum cost', () => {
  assert.deepEqual(assign([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  assert.deepEqual(assign([[9, 1, 9, 9], [1, 9, 9, 9]]), [1, 0]);
});

// Exhaustive check: try every way of giving valves shims on hand and compare the two goals.
function bruteForce(valves) {
  const n = valves.length;
  const fits = (v, u) => u >= v.lo && u <= v.hi;
  let best = { buys: Infinity, moves: Infinity };
  const walk = (i, used, buys, moves) => {
    if (i === n) {
      if (buys < best.buys || (buys === best.buys && moves < best.moves)) best = { buys, moves };
      return;
    }
    walk(i + 1, used, buys + 1, moves); // Buy for this valve.
    for (let j = 0; j < n; j += 1) {
      if (used & (1 << j)) continue;
      if (!fits(valves[i], valves[j].shimUm)) continue;
      walk(i + 1, used | (1 << j), buys, moves + (i === j ? 0 : 1));
    }
  };
  walk(0, 0, 0, 0);
  return best;
}

test('the plan matches an exhaustive search on random heads', () => {
  let seed = 11;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const ids = VALVES.map((v) => v.id);
  for (let round = 0; round < 400; round += 1) {
    const n = 2 + rand(6);
    const readings = [];
    for (let i = 0; i < n; i += 1) {
      const id = ids[rand(16)];
      if (readings.some((r) => r.id === id)) continue;
      const exhaust = id[0] === 'E';
      const shim = (260 + rand(12) * 5) / 100;
      const base = exhaust ? 22 : 12;
      readings.push(reading(id, shim, (base + rand(22)) / 100));
    }
    const plan = buildPlan(readings, DEFAULT_SPEC, options);
    const expected = bruteForce(plan.valves);
    assert.equal(plan.counts.buying, expected.buys, `buys, round ${round}`);
    assert.equal(plan.counts.moved, expected.moves, `moves, round ${round}`);
    for (const v of plan.valves) {
      if (v.action === 'none') continue;
      assert.ok(um3(v.predicted) >= um3(v.band.min) && um3(v.predicted) <= um3(v.band.max), `${v.id} in spec`);
    }
  }
});

function um3(x) {
  return Math.round(x * 1000);
}

test('a full 16-valve head plans instantly and each shim is used once', () => {
  const readings = VALVES.map((v, i) =>
    reading(v.id, 2.7 + ((i * 7) % 12) * 0.05, (v.side === 'intake' ? 0.12 : 0.22) + ((i * 5) % 9) * 0.02)
  );
  const started = Date.now();
  const plan = buildPlan(readings, DEFAULT_SPEC, options);
  assert.ok(Date.now() - started < 200);
  assert.equal(plan.counts.measured, 16);
  const sources = plan.valves.filter((v) => v.from).map((v) => v.from);
  assert.equal(new Set(sources).size, sources.length);
  const kept = plan.valves.filter((v) => v.action === 'keep').map((v) => v.id);
  for (const s of sources) assert.ok(!kept.includes(s), `${s} cannot both keep and give its shim`);
});
