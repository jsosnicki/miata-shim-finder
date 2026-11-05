// Pure logic: parsing, matching and order optimization. No DOM, so tests can import it.

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const MIN_MM = 1.5;
const MAX_MM = 4.5;

// Accepts: 2.75, 2.75mm, 2.75x3, 3x2.75, 275, 2750, 0.1083 (inches), 0.1083in
// Pass known sizes as options.snap so a rounded inch value lands back on the exact size.
export function parseSizes(text, options = {}) {
  const cleaned = String(text || '')
    .replace(/[×*]/g, 'x')
    .replace(/(\d)\s+(mm|in\b|")/gi, '$1$2')
    .replace(/\s*x\s*/gi, 'x');
  const tokens = cleaned.split(/[\s,;]+/).filter(Boolean);
  const byMm = new Map();
  const errors = [];

  for (const raw of tokens) {
    let m = raw.match(/^(\d+)x(\d*\.\d+|\d{3,4})(mm|in|")?$/i); // 3x2.75
    let qty;
    let num;
    let unit;
    if (m) {
      qty = Number(m[1]);
      num = m[2];
      unit = m[3];
    } else {
      m = raw.match(/^(\d*\.?\d+)(mm|in|")?(?:x(\d+))?$/i); // 2.75x3
      if (!m) {
        errors.push(raw);
        continue;
      }
      num = m[1];
      unit = m[2];
      qty = m[3] ? Number(m[3]) : 1;
    }

    const mm = toMm(num, unit, options.snap);
    if (mm === null || mm < MIN_MM || mm > MAX_MM || qty < 1) {
      errors.push(raw);
      continue;
    }
    byMm.set(mm, (byMm.get(mm) || 0) + qty);
  }

  const requests = [...byMm.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mm, qty]) => ({ mm, qty }));
  return { requests, errors };
}

const INCH_ROUNDING_MM = 0.0013; // Half of the 0.0001 in that sizes are shown to.

function toMm(num, unit, snap = []) {
  let v = Number(num);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = (unit || '').toLowerCase();
  if (u === 'in' || u === '"' || (!u && v < 1)) {
    v *= 25.4;
    let nearest = null;
    for (const size of snap) {
      if (nearest === null || Math.abs(size - v) < Math.abs(nearest - v)) nearest = size;
    }
    if (nearest !== null && Math.abs(nearest - v) <= INCH_ROUNDING_MM) return nearest;
  } else if (!u && !String(num).includes('.')) {
    if (v >= 100 && v < 1000) v /= 100; // stamped 275
    else if (v >= 1000 && v < 10000) v /= 1000; // stamped 2750
  }
  return Math.round(v * 1000) / 1000;
}

export function buildOffers(catalog, prices) {
  const parts = new Map(catalog.parts.map((p) => [p.id, p]));
  const stores = new Map(catalog.stores.map((s) => [s.id, s]));
  const out = [];
  for (const o of prices.offers) {
    const part = parts.get(o.part);
    const store = stores.get(o.store);
    if (!part || !store) continue;
    out.push({
      ...o,
      mm: part.mm,
      line: part.line,
      packQty: catalog.lines[part.line].packQty,
    });
  }
  return out;
}

export function shippingCost(store, units, subtotal) {
  if (units <= 0) return 0;
  const s = store.shipping;
  if (s.type === 'tiers') {
    for (const t of s.tiers) {
      if (t.under === undefined || subtotal < t.under) return t.cost;
    }
    return 0;
  }
  return s.base + s.perItem * units;
}

const isOrderable = (o, includeBackorder) =>
  o.price > 0 &&
  o.status !== 'unavailable' &&
  (includeBackorder || o.status !== 'backorder');

const isAllowed = (o, opts) =>
  (!opts.lines || opts.lines.has(o.line)) && (!opts.stores || opts.stores.has(o.store));

const within = (o, mm, tol) => Math.abs(o.mm - mm) <= tol + 1e-9;

// Every offer for one requested size, cheapest first, with the cost to cover the quantity.
export function offersForRequest(request, offers, opts) {
  const tol = opts.tolerance ?? 0.005;
  return offers
    .filter((o) => within(o, request.mm, tol) && isAllowed(o, opts))
    .map((o) => {
      const units = Math.ceil(request.qty / o.packQty);
      const cost = o.price ? round2(units * o.price) : null;
      return {
        ...o,
        units,
        cost,
        perShim: cost === null ? null : round2(cost / request.qty),
        spare: units * o.packQty - request.qty,
        orderable: isOrderable(o, opts.includeBackorder !== false),
      };
    })
    .sort(
      (a, b) =>
        Number(b.orderable) - Number(a.orderable) ||
        (a.cost ?? Infinity) - (b.cost ?? Infinity) ||
        Math.abs(a.mm - request.mm) - Math.abs(b.mm - request.mm)
    );
}

function nearestSizes(mm, offers) {
  const sizes = [...new Set(offers.map((o) => o.mm))].sort((a, b) => a - b);
  let below = null;
  let above = null;
  for (const s of sizes) {
    if (s < mm) below = s;
    if (s > mm && above === null) above = s;
  }
  return { below, above };
}

// All ways to cover one request using the given offers. Quantity can be split, so 5 of
// one size may become a 4-pack plus a single.
function optionsFor(request, offersInSet, storeById, shipInObjective) {
  const tiered = (o) => storeById.get(o.store).shipping.type === 'tiers';
  const unitCost = (o) => {
    const s = storeById.get(o.store).shipping;
    return o.price + (shipInObjective && s.type !== 'tiers' ? s.perItem : 0);
  };
  const rank = (a, b) =>
    unitCost(a) - unitCost(b) ||
    Math.abs(a.mm - request.mm) - Math.abs(b.mm - request.mm) ||
    Number(a.status === 'backorder') - Number(b.status === 'backorder');

  const singles = offersInSet.filter((o) => o.packQty === 1 && !tiered(o)).sort(rank);
  const special = offersInSet.filter((o) => o.packQty > 1 || tiered(o));
  const bestSingle = singles[0] || null;
  const best = new Map();

  const finish = (lines, cost, tieredDelta) => {
    const key = JSON.stringify(Object.entries(tieredDelta).sort());
    const penalty = lines.reduce(
      (sum, l) =>
        sum +
        Math.abs(l.offer.mm - request.mm) * 1e-3 * l.used +
        (l.offer.status === 'backorder' ? 1e-4 * l.used : 0),
      0
    );
    const score = cost + penalty;
    const prior = best.get(key);
    if (!prior || score < prior.score) best.set(key, { lines, cost, score, tieredDelta });
  };

  const walk = (i, remaining, lines, cost, tieredDelta) => {
    if (i === special.length) {
      if (remaining === 0) return finish(lines, cost, tieredDelta);
      if (!bestSingle) return undefined;
      const line = { request, offer: bestSingle, units: remaining, used: remaining };
      return finish([...lines, line], cost + remaining * unitCost(bestSingle), tieredDelta);
    }
    const o = special[i];
    const maxUnits = Math.ceil(remaining / o.packQty);
    for (let n = 0; n <= maxUnits; n += 1) {
      const used = Math.min(remaining, n * o.packQty);
      const nextLines = n ? [...lines, { request, offer: o, units: n, used }] : lines;
      const nextDelta = { ...tieredDelta };
      if (n && tiered(o)) nextDelta[o.store] = (nextDelta[o.store] || 0) + n * o.price;
      walk(i + 1, remaining - used, nextLines, cost + n * unitCost(o), nextDelta);
    }
    return undefined;
  };

  walk(0, request.qty, [], 0, {});
  return [...best.values()];
}

// Cheapest order limited to one set of stores. Dynamic programming over requests, keyed by
// subtotal at stores whose shipping depends on subtotal.
function solveForStoreSet(requests, cands, setIds, storeById, shipInObjective) {
  const inSet = new Set(setIds);
  let states = new Map([['{}', { score: 0, cost: 0, sub: {}, lines: [] }]]);

  for (let r = 0; r < requests.length; r += 1) {
    const offers = cands[r].filter((o) => inSet.has(o.store));
    if (!offers.length) return null;
    const options = optionsFor(requests[r], offers, storeById, shipInObjective);
    if (!options.length) return null;

    const next = new Map();
    for (const state of states.values()) {
      for (const opt of options) {
        const sub = { ...state.sub };
        for (const [k, v] of Object.entries(opt.tieredDelta)) {
          sub[k] = round2((sub[k] || 0) + v);
        }
        const key = JSON.stringify(Object.entries(sub).sort());
        const score = state.score + opt.score;
        const prior = next.get(key);
        if (!prior || score < prior.score) {
          next.set(key, {
            score,
            cost: state.cost + opt.cost,
            sub,
            lines: state.lines.concat(opt.lines),
          });
        }
      }
    }
    states = next;
  }

  let best = null;
  for (const s of states.values()) {
    let extra = 0;
    if (shipInObjective) {
      for (const id of setIds) {
        const store = storeById.get(id);
        if (store.shipping.type === 'tiers') {
          const subtotal = s.sub[id] || 0;
          if (subtotal > 0) extra += shippingCost(store, 1, subtotal);
        } else {
          extra += store.shipping.base;
        }
      }
    }
    const total = s.score + extra;
    if (!best || total < best.total) best = { total, lines: s.lines };
  }
  return best;
}

function summarize(lines, storeById) {
  const byStore = new Map();
  for (const line of lines) {
    const id = line.offer.store;
    if (!byStore.has(id)) byStore.set(id, { store: storeById.get(id), lines: [], subtotal: 0, units: 0 });
    const group = byStore.get(id);
    group.lines.push({
      ...line,
      cost: round2(line.units * line.offer.price),
      spare: line.units * line.offer.packQty - line.used,
    });
    group.subtotal += line.units * line.offer.price;
    group.units += line.units;
  }
  const groups = [...byStore.values()];
  for (const g of groups) {
    g.subtotal = round2(g.subtotal);
    g.shipping = round2(shippingCost(g.store, g.units, g.subtotal));
    g.total = round2(g.subtotal + g.shipping);
  }
  groups.sort((a, b) => b.total - a.total);
  const partsTotal = round2(groups.reduce((s, g) => s + g.subtotal, 0));
  const shippingTotal = round2(groups.reduce((s, g) => s + g.shipping, 0));
  return { groups, partsTotal, shippingTotal, total: round2(partsTotal + shippingTotal) };
}

export function solve(requests, offers, stores, options = {}) {
  const opts = { tolerance: 0.005, includeBackorder: true, countShipping: true, ...options };
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const usable = offers.filter(
    (o) => isOrderable(o, opts.includeBackorder) && isAllowed(o, opts)
  );

  const covered = [];
  const cands = [];
  const unmatched = [];
  for (const request of requests) {
    const c = usable.filter((o) => within(o, request.mm, opts.tolerance));
    if (c.length) {
      covered.push(request);
      cands.push(c);
    } else {
      unmatched.push({ ...request, ...nearestSizes(request.mm, usable) });
    }
  }

  const empty = { groups: [], partsTotal: 0, shippingTotal: 0, total: 0 };
  if (!covered.length) return { ...empty, unmatched, covered };

  const ids = [...new Set(cands.flat().map((o) => o.store))];
  let best = null;
  if (opts.countShipping) {
    for (let mask = 1; mask < 1 << ids.length; mask += 1) {
      const setIds = ids.filter((_, i) => mask & (1 << i));
      const found = solveForStoreSet(covered, cands, setIds, storeById, true);
      if (found && (!best || found.total < best.total - 1e-9)) best = found;
    }
  } else {
    best = solveForStoreSet(covered, cands, ids, storeById, false);
  }
  return { ...summarize(best.lines, storeById), unmatched, covered };
}

export function orderAsText(result, currency = (n) => `$${n.toFixed(2)}`, size = (mm) => `${mm.toFixed(3)} mm`) {
  const out = [];
  for (const g of result.groups) {
    out.push(`${g.store.name}: ${currency(g.total)} (${currency(g.subtotal)} parts, ${currency(g.shipping)} est. shipping)`);
    for (const l of g.lines) {
      const pack = l.offer.packQty > 1 ? ` ${l.offer.packQty}-pack` : '';
      out.push(`  ${l.units} x${pack} ${l.offer.part} (${size(l.offer.mm)}) ${currency(l.cost)}`);
      out.push(`    ${l.offer.url}`);
    }
  }
  out.push(`Total: ${currency(result.total)}`);
  return out.join('\n');
}
