import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOffers, offersForRequest, orderAsText, parseSizes, round2, shippingCost, solve } from '../assets/optimizer.js';

const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url)));
const prices = JSON.parse(readFileSync(new URL('../data/prices.json', import.meta.url)));
const offers = buildOffers(catalog, prices);
const stores = catalog.stores;
const run = (text, opts = {}) => solve(parseSizes(text).requests, offers, stores, opts);

test('catalog matches the PDF', () => {
  const count = (line) => catalog.parts.filter((p) => p.line === line).length;
  assert.equal(count('toyota'), 33);
  assert.equal(count('silverseal'), 21);
  assert.equal(count('mazda'), 14);
  const mm = (id) => catalog.parts.find((p) => p.id === id).mm;
  assert.equal(mm('13753-50010'), 2.5);
  assert.equal(mm('13753-50610'), 3.3);
  assert.equal(mm('NISK3-00'), 3);
  assert.equal(mm('Z5Y1-12-541'), 2.75);
  assert.equal(mm('Z502-12-545'), 3.052);
  assert.equal(mm('Z502-12-593'), 3.396);
});

test('every offer points at a known part and store', () => {
  assert.equal(offers.length, prices.offers.length);
  assert.equal(offers.length, 33 * 3 + 21 + 14 * 3);
});

test('parseSizes reads the accepted formats', () => {
  const { requests, errors } = parseSizes('2.75, 2.75\n3.05x2 3 x 3.10; 3.15 mm\n0.1083 275 2800 2.95*2 2.90 x 3');
  assert.deepEqual(errors, []);
  const get = (mm) => requests.find((r) => r.mm === mm)?.qty;
  assert.equal(get(2.75), 3); // two typed, plus stamped 275
  assert.equal(get(2.751), 1); // 0.1083 in
  assert.equal(get(3.05), 2);
  assert.equal(get(3.1), 3);
  assert.equal(get(3.15), 1);
  assert.equal(get(2.8), 1);
  assert.equal(get(2.95), 2);
  assert.equal(get(2.9), 3);
});

test('parseSizes reports what it cannot read', () => {
  const { requests, errors } = parseSizes('abc, 9.9, 2.75');
  assert.deepEqual(errors, ['abc', '9.9']);
  assert.equal(requests.length, 1);
});

test('one shim of a Silver-Seal-only size costs a whole pack plus shipping', () => {
  const r = run('2.20');
  assert.equal(r.total, 30.14); // 18.15 + 11.99
  assert.equal(r.groups[0].lines[0].spare, 3);
});

test('a pack covers four of one size, five needs a second pack', () => {
  assert.equal(run('2.20x4').total, 30.14);
  assert.equal(run('2.20x5').total, 48.29); // 36.30 + 11.99
});

test('Piston Depot shipping tiers apply at $50 and $100', () => {
  const pd = stores.find((s) => s.id === 'pistondepot');
  assert.equal(shippingCost(pd, 1, 49.99), 11.99);
  assert.equal(shippingCost(pd, 1, 50), 6.99);
  assert.equal(shippingCost(pd, 1, 99.99), 6.99);
  assert.equal(shippingCost(pd, 1, 100), 0);
  assert.equal(run('2.00 2.05 2.10').total, 61.44); // 54.45 + 6.99
  assert.equal(run('2.00 2.05 2.10 2.15 2.20 2.25').total, 108.9); // free shipping
});

test('flat rate shipping grows slightly per shim at ToyotaPartsDeal', () => {
  const tpd = stores.find((s) => s.id === 'toyotapartsdeal');
  assert.equal(round2(shippingCost(tpd, 1, 0)), 12.47);
  assert.equal(round2(shippingCost(tpd, 8, 0)), 12.98);
});

test('an order compares Mazda singles with packs on total cost', () => {
  // 2.75 x5 at Original Mazda Parts is 62.20 + 9.78. Two Silver Seal packs are 36.30 + 11.99.
  const r = run('2.75x5');
  assert.equal(r.total, 48.29);
  assert.equal(r.groups[0].store.id, 'pistondepot');
});

test('turning off 0-on-hand items moves the order to orderable stock', () => {
  const r = run('2.75x5', { includeBackorder: false });
  assert.equal(r.groups[0].store.id, 'originalmazdaparts');
  assert.equal(r.total, 71.98); // 62.20 + 9.78
});

test('unavailable parts are never chosen', () => {
  const r = run('2.60', { lines: new Set(['toyota']) }); // 13753-50060 is unavailable at all three
  assert.equal(r.groups.length, 0);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].below, 2.575);
  assert.equal(r.unmatched[0].above, 2.625);
});

test('tolerance decides whether near-round Mazda sizes match', () => {
  const lines = new Set(['mazda']);
  assert.equal(run('3.05', { lines, tolerance: 0 }).unmatched.length, 1);
  const hit = run('3.05', { lines, tolerance: 0.005 });
  assert.equal(hit.unmatched.length, 0);
  assert.equal(hit.groups[0].lines[0].offer.part, 'Z502-12-545');
});

test('a size nobody makes is reported, not silently dropped', () => {
  const r = run('2.75 4.00');
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].mm, 4);
  assert.equal(r.unmatched[0].below, 3.396);
  assert.equal(r.unmatched[0].above, null);
});

test('ignoring shipping picks cheapest parts while still reporting shipping', () => {
  const a = run('2.95', { countShipping: false, lines: new Set(['mazda']) });
  assert.equal(a.partsTotal, 9.32); // MazdaPartsNow
  assert.equal(a.shippingTotal, 9.31);
});

test('offersForRequest lists unavailable offers after orderable ones', () => {
  const list = offersForRequest({ mm: 2.75, qty: 1 }, offers, { tolerance: 0.005, includeBackorder: true });
  assert.equal(list.length, 3 + 1 + 3);
  assert.equal(list.at(-1).orderable, false);
  assert.equal(list[0].part, 'Z5Y1-12-541');
});

test('order text carries the total and links', () => {
  const text = orderAsText(run('2.20'));
  assert.match(text, /NISK2-20/);
  assert.match(text, /Total: \$30\.14/);
});

// Exhaustive check: try every per-request allocation and compare with the solver.
function bruteForce(requests, opts) {
  const byId = new Map(stores.map((s) => [s.id, s]));
  const usable = offers.filter((o) => o.price > 0 && o.status !== 'unavailable');
  const perRequest = requests.map((req) => {
    const cands = usable.filter((o) => Math.abs(o.mm - req.mm) <= opts.tolerance + 1e-9);
    const out = [];
    const walk = (i, remaining, chosen) => {
      if (i === cands.length) {
        if (remaining === 0) out.push(chosen);
        return;
      }
      const o = cands[i];
      const max = Math.ceil(remaining / o.packQty);
      for (let n = 0; n <= max; n += 1) {
        const covered = Math.min(remaining, n * o.packQty);
        walk(i + 1, remaining - covered, n ? [...chosen, [o, n]] : chosen);
      }
    };
    walk(0, req.qty, []);
    return out;
  });

  let best = Infinity;
  const combine = (i, totals) => {
    if (i === perRequest.length) {
      let sum = 0;
      for (const [id, t] of totals) sum += t.sub + shippingCost(byId.get(id), t.units, t.sub);
      best = Math.min(best, sum);
      return;
    }
    for (const alloc of perRequest[i]) {
      const next = new Map([...totals].map(([k, v]) => [k, { ...v }]));
      for (const [o, n] of alloc) {
        const t = next.get(o.store) || { sub: 0, units: 0 };
        t.sub += n * o.price;
        t.units += n;
        next.set(o.store, t);
      }
      combine(i + 1, next);
    }
  };
  combine(0, new Map());
  return round2(best);
}

test('solver equals an exhaustive search on random small orders', () => {
  const sizes = ['2.20', '2.55', '2.65', '2.75', '2.80', '2.90', '2.95', '3.00', '3.05', '3.10', '3.20', '3.35'];
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let run_ = 0; run_ < 200; run_ += 1) {
    const picks = new Map();
    const count = 1 + rand(3);
    for (let i = 0; i < count; i += 1) picks.set(sizes[rand(sizes.length)], 1 + rand(3));
    const text = [...picks].map(([s, q]) => `${s}x${q}`).join(' ');
    const { requests } = parseSizes(text);
    const opts = { tolerance: 0.005 };
    const got = solve(requests, offers, stores, opts);
    const expected = bruteForce(requests, opts);
    assert.ok(Math.abs(got.total - expected) <= 0.011, `${text}: solver ${got.total}, exhaustive ${expected}`);
  }
});

test('a full 16-valve list solves quickly', () => {
  const started = Date.now();
  const r = run('2.00 2.10 2.20 2.30 2.40 2.50 2.60 2.70 2.80 2.90 3.00 3.10 3.20 3.30 3.35 3.40');
  assert.equal(r.unmatched.length, 0);
  assert.ok(Date.now() - started < 1500);
});
