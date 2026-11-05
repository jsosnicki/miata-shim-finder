// Pure lash planning logic. No DOM, so tests can import it.
//
// For any valve, shim + lash is fixed: a shim 0.05 mm thicker closes the lash by 0.05 mm.
// So every valve has a window of shim thicknesses that puts it in spec, and the job is to
// give each valve one shim from those windows while buying as few as possible.
//
// Thicknesses are handled in whole thousandths of a millimeter to avoid float rounding.

const um = (mm) => Math.round(mm * 1000);
const toMm = (u) => u / 1000;

export const DEFAULT_SPEC = {
  intake: { min: 0.18, max: 0.23 },
  exhaust: { min: 0.28, max: 0.34 },
};

// Cylinder 1 is at the timing belt end. F and R are the front and rear valve of a cylinder.
export const VALVES = [1, 2, 3, 4].flatMap((cyl) =>
  ['intake', 'exhaust'].flatMap((side) =>
    ['F', 'R'].map((pos) => ({ id: `${side[0].toUpperCase()}${cyl}${pos}`, cyl, side, pos }))
  )
);

export const shimLabel = (mm) => mm.toFixed(3).replace(/0$/, '');

export function lashStatus(lash, band) {
  const value = um(lash);
  if (value < um(band.min)) return 'tight';
  if (value > um(band.max)) return 'loose';
  return 'ok';
}

// Lowest cost for a given thickness, from every orderable part of that thickness.
export function sizeOptions(offers) {
  const bySize = new Map();
  for (const o of offers) {
    if (!(o.price > 0) || o.status === 'unavailable') continue;
    const key = um(o.mm);
    if (!bySize.has(key)) bySize.set(key, { mm: o.mm, single: Infinity, packs: [] });
    const entry = bySize.get(key);
    if (o.packQty === 1) entry.single = Math.min(entry.single, o.price);
    else entry.packs.push({ qty: o.packQty, price: o.price });
  }
  return [...bySize.values()].sort((a, b) => a.mm - b.mm);
}

export function sizeCost(option, qty) {
  let best = option.single * qty;
  for (const pack of option.packs) {
    const whole = Math.ceil(qty / pack.qty) * pack.price;
    const full = Math.floor(qty / pack.qty);
    const mixed = full * pack.price + (qty - full * pack.qty) * option.single;
    best = Math.min(best, whole, mixed);
  }
  return best;
}

// Minimum cost assignment of rows to columns (Hungarian algorithm), rows <= columns.
export function assign(cost) {
  const n = cost.length;
  const m = cost[0].length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const result = new Array(n).fill(-1);
  for (let j = 1; j <= m; j += 1) {
    if (p[j]) result[p[j] - 1] = j - 1;
  }
  return result;
}

// Choose a size for each valve being bought for. Start from the size nearest each valve's
// target, then let valves change size when that lowers the bill, such as sharing a 4-pack.
function chooseBuySizes(needs) {
  const totalCost = () => {
    const counts = new Map();
    for (const n of needs) {
      if (!n.pick) continue;
      counts.set(n.pick, (counts.get(n.pick) || 0) + 1);
    }
    let sum = 0;
    for (const [option, qty] of counts) sum += sizeCost(option, qty);
    return sum;
  };
  const gap = (n, option) => Math.abs(um(option.mm) - n.target);

  for (const n of needs) {
    n.pick = n.options.slice().sort((a, b) => gap(n, a) - gap(n, b))[0] || null;
  }
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const n of needs) {
      let bestCost = totalCost();
      for (const option of n.options) {
        const previous = n.pick;
        n.pick = option;
        const cost = totalCost();
        const cheaper = cost < bestCost - 1e-6;
        const sameButCloser = Math.abs(cost - bestCost) <= 1e-6 && gap(n, option) < gap(n, previous);
        if (cheaper || sameButCloser) {
          bestCost = cost;
          changed = true;
        } else {
          n.pick = previous;
        }
      }
    }
    if (!changed) break;
  }
}

/**
 * readings: [{ id, side, shim, lash }] for valves with both numbers entered.
 * Goals, in order: fewest shims bought, fewest shims moved, lash nearest mid-range.
 */
export function buildPlan(readings, spec = DEFAULT_SPEC, options = []) {
  const valves = readings.map((r) => {
    const band = spec[r.side];
    const shim = um(r.shim);
    const stack = shim + um(r.lash);
    return {
      ...r,
      status: lashStatus(r.lash, band),
      band,
      shimUm: shim,
      lo: stack - um(band.max),
      hi: stack - um(band.min),
      target: stack - (um(band.max) + um(band.min)) / 2,
      stack,
    };
  });

  const empty = {
    valves,
    moves: [],
    buys: [],
    unsolved: [],
    leftovers: [],
    counts: { measured: 0, inSpec: 0, outOfSpec: 0, buying: 0, moved: 0, unchanged: 0, saved: 0 },
  };
  if (!valves.length) return empty;

  const fits = (v, shimUm) => shimUm >= v.lo && shimUm <= v.hi;
  for (const v of valves) {
    v.options = options.filter((o) => fits(v, um(o.mm)));
    v.fixes = []; // Out-of-spec valves this valve's shim would bring into spec.
    v.fixedBy = []; // Other valves whose shim would bring this valve into spec.
  }
  for (const a of valves) {
    for (const b of valves) {
      if (a !== b && b.status !== 'ok' && fits(b, a.shimUm)) {
        a.fixes.push(b.id);
        b.fixedBy.push(a.id);
      }
    }
  }

  // Costs are scaled so each goal outranks everything below it.
  const NO_FIT = 1e10;
  const NO_PART = 1e9;
  const BUY = 1e7;
  const MOVE = 1e4;

  const n = valves.length;
  const matrix = valves.map((v, i) => {
    const row = valves.map((donor, j) => {
      if (!fits(v, donor.shimUm)) return NO_FIT;
      return (i === j ? 0 : MOVE) + Math.abs(donor.shimUm - v.target);
    });
    const nearest = v.options.length
      ? Math.min(...v.options.map((o) => Math.abs(um(o.mm) - v.target)))
      : null;
    const buyCost = nearest === null ? NO_PART : BUY + nearest;
    return row.concat(new Array(n).fill(buyCost));
  });
  const picks = assign(matrix);

  const moves = [];
  const needs = [];
  const unsolved = [];
  const usedShim = new Set();
  let letter = 65;

  valves.forEach((v, i) => {
    const col = picks[i];
    if (col < n) {
      usedShim.add(col);
      if (col === i) {
        v.action = 'keep';
        v.newShim = v.shim;
      } else {
        const donor = valves[col];
        v.action = 'swap';
        v.newShim = donor.shim;
        v.from = donor.id;
        v.letter = String.fromCharCode(letter);
        letter += 1;
        donor.givesTo = v.id;
        donor.givesLetter = v.letter;
        moves.push({ letter: v.letter, shim: donor.shim, from: donor.id, to: v.id });
      }
      v.predicted = toMm(v.stack - um(v.newShim));
    } else if (v.options.length) {
      v.action = 'buy';
      needs.push(v);
    } else {
      v.action = 'none';
      v.neededShim = toMm(Math.round(v.target));
      unsolved.push(v);
    }
  });

  chooseBuySizes(needs);
  for (const v of needs) {
    v.newShim = v.pick.mm;
    v.predicted = toMm(v.stack - um(v.newShim));
  }

  const buyMap = new Map();
  for (const v of needs) {
    const key = um(v.newShim);
    if (!buyMap.has(key)) buyMap.set(key, { mm: v.newShim, qty: 0, valves: [] });
    const entry = buyMap.get(key);
    entry.qty += 1;
    entry.valves.push(v.id);
  }
  const buys = [...buyMap.values()].sort((a, b) => a.mm - b.mm);

  const leftovers = valves
    .filter((_, i) => !usedShim.has(i))
    .map((v) => ({ shim: v.shim, from: v.id }))
    .sort((a, b) => a.shim - b.shim);

  const outOfSpec = valves.filter((v) => v.status !== 'ok').length;
  const buying = needs.length + unsolved.length;
  return {
    valves,
    moves,
    buys,
    unsolved,
    leftovers,
    counts: {
      measured: n,
      inSpec: n - outOfSpec,
      outOfSpec,
      buying,
      moved: moves.length,
      unchanged: valves.filter((v) => v.action === 'keep').length,
      saved: outOfSpec - buying,
    },
  };
}

export function buyListText(buys) {
  return buys.map((b) => `${shimLabel(b.mm)}${b.qty > 1 ? `x${b.qty}` : ''}`).join(', ');
}
