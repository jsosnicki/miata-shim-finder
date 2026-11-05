import { DEFAULT_SPEC, VALVES, buildPlan, buyListText, sizeOptions } from './lash.js';
import { parseSizes, solve } from './optimizer.js';
import { formatLash, formatShim, getUnit, onUnitChange, snapToKnown, toMm, unitName } from './units.js';

const STORAGE_KEY = 'miata-shim-finder:lash';

// Example readings. They are labelled as a sample on the page.
const SAMPLE = {
  I1F: [2.85, 0.2], I1R: [2.9, 0.13], E1F: [3.0, 0.3], E1R: [2.95, 0.36],
  I2F: [2.8, 0.21], I2R: [2.9, 0.26], E2F: [3.05, 0.31], E2R: [3.0, 0.25],
  I3F: [2.85, 0.19], I3R: [2.95, 0.22], E3F: [3.1, 0.24], E3R: [2.95, 0.33],
  I4F: [2.9, 0.2], I4R: [2.85, 0.29], E4F: [3.0, 0.29], E4R: [3.05, 0.38],
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shimLabel = (mm) => formatShim(mm);
const lashText = (mm) => formatLash(mm);
const STATUS_TEXT = { ok: 'In spec', tight: 'Tight', loose: 'Loose' };
const valveName = (v) => `${v.side === 'intake' ? 'Intake' : 'Exhaust'} cylinder ${v.cyl} ${v.pos === 'F' ? 'front' : 'rear'}`;

function readSaved() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeSaved(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* Storage is a convenience only. */
  }
}

function valveCard(v) {
  return `<article class="valve" data-id="${v.id}" data-status="empty">
    <div class="valve-head">
      <button type="button" class="bucket" data-select="${v.id}" aria-pressed="false" aria-label="Show shims that match ${esc(valveName(v))}">${v.id}</button>
      <span class="valve-status" data-role="status">No reading</span>
    </div>
    <div class="valve-inputs">
      <label><span>Shim <span class="unit-short">mm</span></span><input class="num" id="shim-${v.id}" data-field="shim" data-valve="${v.id}" inputmode="decimal" autocomplete="off" aria-label="${esc(valveName(v))} shim"></label>
      <label><span>Lash <span class="unit-short">mm</span></span><input class="num" id="lash-${v.id}" data-field="lash" data-valve="${v.id}" inputmode="decimal" autocomplete="off" aria-label="${esc(valveName(v))} lash"></label>
    </div>
    <div class="valve-plan" data-role="plan"></div>
  </article>`;
}

function cylinder(cyl) {
  const bank = (side, label) => {
    const cards = VALVES.filter((v) => v.cyl === cyl && v.side === side).map(valveCard).join('');
    return `<div class="bank-name">${label}</div><div class="bank">${cards}</div>`;
  };
  return `<section class="cyl" aria-label="Cylinder ${cyl}">
    <div class="cyl-name"><span class="plug" aria-hidden="true"></span>Cylinder ${cyl}</div>
    ${bank('intake', 'Intake')}
    ${bank('exhaust', 'Exhaust')}
  </section>`;
}

function template() {
  const specGroup = (side, label) => `<fieldset class="spec-group">
    <legend>${label} lash spec</legend>
    <div class="spec-inputs">
      <input class="num" id="spec-${side}-min" data-spec="${side}.min" inputmode="decimal" aria-label="${label} minimum lash">
      to
      <input class="num" id="spec-${side}-max" data-spec="${side}.max" inputmode="decimal" aria-label="${label} maximum lash">
      <span class="unit-short">mm</span>
    </div>
  </fieldset>`;
  return `<div class="lash-top">
      <div class="spec-row">${specGroup('intake', 'Intake')}${specGroup('exhaust', 'Exhaust')}</div>
      <div class="button-row">
        <span class="sample-tag" id="lash-sample-tag" hidden>Sample readings</span>
        <button type="button" class="ghost" id="lash-sample">Use sample</button>
        <button type="button" class="ghost" id="lash-clear">Clear all</button>
      </div>
    </div>
    <div class="plan-band" id="plan-band"></div>
    <section class="head" aria-label="Cylinder head, 16 valves">
      <div class="head-legend">
        <span>Front of engine (timing belt) is cylinder 1</span>
        <span>I intake, E exhaust, then cylinder, then F front or R rear valve</span>
      </div>
      <div class="cyls">${[1, 2, 3, 4].map(cylinder).join('')}</div>
      <p class="head-hint" id="head-hint" aria-live="polite"></p>
    </section>
    <div class="plan-lists" id="plan-lists"></div>
    <p class="formula">New shim = current shim + measured lash − target lash. A thicker shim closes the gap. Shims are entered in <span class="unit-long">mm</span>, and a micrometer reading is more reliable than the stamped size. Lash predictions depend on your readings, so recheck every valve after refitting.</p>`;
}

function parseNumber(text) {
  const value = Number(String(text).trim());
  return String(text).trim() === '' || !Number.isFinite(value) ? null : value;
}

export function initLash({ root, offers, stores, onPrice }) {
  const options = sizeOptions(offers);
  const saved = readSaved();
  const state = {
    spec: structuredClone(saved?.spec ?? DEFAULT_SPEC),
    selected: null,
    plan: null,
    priceKey: null,
    priceText: '',
  };

  root.innerHTML = template();
  const $ = (id) => root.querySelector(`#${id}`);
  const card = (id) => root.querySelector(`.valve[data-id="${id}"]`);
  const input = (id, field) => $(`${field}-${id}`);

  // Inputs keep their millimeter value alongside the text, so showing a rounded inch value
  // never replaces the number it came from. Text the user types is read in the current unit.
  function setField(el, mm) {
    if (mm === null) {
      el.value = '';
      delete el.dataset.mm;
      delete el.dataset.shown;
      return;
    }
    el.value = el.dataset.field === 'lash' ? formatLash(mm) : formatShim(mm);
    el.dataset.mm = String(mm);
    el.dataset.shown = el.value;
  }

  function readField(el, unit, band) {
    const text = el.value.trim();
    if (!text) return { mm: null, bad: false };
    if (el.dataset.shown === el.value) return { mm: Number(el.dataset.mm), bad: false };
    const number = parseNumber(text);
    if (number === null) return { mm: null, bad: true };
    const mm = toMm(number, unit);
    return { mm: unit === 'in' && band ? snapToKnown(mm, [band.min, band.max]) : mm, bad: false };
  }

  function fill(values) {
    for (const v of VALVES) {
      const [shim = null, lash = null] = values?.[v.id] ?? [];
      setField(input(v.id, 'shim'), shim);
      setField(input(v.id, 'lash'), lash);
    }
  }

  function showSpec() {
    for (const el of root.querySelectorAll('[data-spec]')) {
      const [side, key] = el.dataset.spec.split('.');
      el.value = formatLash(state.spec[side][key]);
      el.setAttribute('aria-invalid', 'false');
    }
  }

  function collect() {
    const readings = [];
    const entered = {};
    const unit = getUnit();
    let isSample = true;
    for (const v of VALVES) {
      const shimEl = input(v.id, 'shim');
      const lashEl = input(v.id, 'lash');
      const shimRead = readField(shimEl, unit);
      const lashRead = readField(lashEl, unit, state.spec[v.side]);
      const shim = shimRead.mm;
      const lash = lashRead.mm;
      const shimOk = shim === null || (shim >= 1.5 && shim <= 4.5);
      const lashOk = lash === null || (lash >= 0 && lash <= 1);
      shimEl.setAttribute('aria-invalid', String(!shimOk || shimRead.bad));
      lashEl.setAttribute('aria-invalid', String(!lashOk || lashRead.bad));
      if (shimEl.value.trim() || lashEl.value.trim()) {
        entered[v.id] = [shim === null ? shimEl.value.trim() : String(shim), lash === null ? lashEl.value.trim() : String(lash)];
      }
      const sample = SAMPLE[v.id];
      if (shim !== sample[0] || lash !== sample[1]) isSample = false;
      if (shim !== null && lash !== null && shimOk && lashOk) {
        readings.push({ id: v.id, cyl: v.cyl, side: v.side, shim, lash });
      }
    }
    return { readings, entered, isSample };
  }

  function planLine(v) {
    const lines = [];
    if (v.action === 'keep' && !v.givesTo) lines.push(v.status === 'ok' ? `<span>Keep <b>${shimLabel(v.shim)}</b></span>` : '');
    if (v.action === 'swap') {
      lines.push(`<span><span class="chip">${v.letter}</span>Use <b>${shimLabel(v.newShim)}</b> from ${v.from}, lash ${lashText(v.predicted)}</span>`);
    }
    if (v.action === 'buy') {
      lines.push(`<span><span class="chip buy">Buy</span><b>${shimLabel(v.newShim)}</b>, lash ${lashText(v.predicted)}</span>`);
    }
    if (v.action === 'none') {
      lines.push(`<span>Needs about <b>${shimLabel(v.neededShim)}</b>, not in the parts list</span>`);
    }
    if (v.givesTo) {
      lines.push(`<span><span class="chip">${v.givesLetter}</span>Shim goes to ${v.givesTo}</span>`);
    }
    if (v.fixes.length && v.givesTo === undefined) {
      lines.push(`<span class="fits">Shim would fit ${v.fixes.join(', ')}</span>`);
    }
    return lines.filter(Boolean).join('');
  }

  function renderBand(plan) {
    const c = plan.counts;
    const missing = 16 - c.measured;
    const cell = (figure, caption, lead = false) =>
      `<div class="${lead ? 'lead' : ''}"><span class="plan-figure">${figure}</span><span class="plan-cap">${caption}</span></div>`;
    const buyCap = c.saved > 0
      ? `${c.buying === 1 ? 'shim' : 'shims'} to buy, ${c.saved} saved by swapping`
      : `${c.buying === 1 ? 'shim' : 'shims'} to buy`;
    $('plan-band').innerHTML = [
      cell(c.buying, buyCap, true),
      cell(c.moved, `${c.moved === 1 ? 'shim' : 'shims'} to move between valves`),
      cell(c.outOfSpec, `out of spec, of ${c.measured} measured`),
      cell(c.unchanged, `left as they are${missing ? `, ${missing} not entered` : ''}`),
    ].join('');
  }

  function priceEstimate(plan) {
    const text = buyListText(plan.buys);
    if (text !== state.priceKey) {
      state.priceKey = text;
      state.priceText = '';
      if (plan.buys.length) {
        const { requests } = parseSizes(text);
        const order = solve(requests, offers, stores, {});
        if (order.groups.length) {
          state.priceText = `About $${order.total.toFixed(2)} with shipping, from ${order.groups.length} ${order.groups.length === 1 ? 'store' : 'stores'}.`;
        }
      }
    }
    return state.priceText;
  }

  function renderLists(plan) {
    const moves = plan.moves
      .map((m) => `<li><span class="chip">${m.letter}</span><span class="mono">${shimLabel(m.shim)}</span> from ${m.from} to ${m.to}</li>`)
      .join('');
    const buys = plan.buys
      .map((b) => `<li><span class="chip buy">${b.qty} ×</span><span class="mono">${shimLabel(b.mm)}</span> for ${b.valves.join(', ')}</li>`)
      .join('');
    const unsolved = plan.unsolved
      .map((v) => `<li>${v.id} needs about <span class="mono">${shimLabel(v.neededShim)}</span>, which is not in the parts list</li>`)
      .join('');
    const left = plan.leftovers.length
      ? `<p class="help">Left over after the swaps: ${plan.leftovers.map((l) => `${shimLabel(l.shim)} from ${l.from}`).join(', ')}.</p>`
      : '';
    const estimate = priceEstimate(plan);
    const buyBlock = plan.buys.length
      ? `<div class="buy-actions"><button type="button" class="solid" id="price-buys">Price these shims</button><span class="help">${esc(estimate)}</span></div>`
      : '';

    if (!plan.counts.measured) {
      $('plan-lists').innerHTML = '';
      return;
    }
    $('plan-lists').innerHTML = `<section>
        <h2>Move these shims</h2>
        ${moves ? `<ul class="step-list">${moves}</ul>` : '<p class="help">No swaps help here.</p>'}
        ${left}
      </section>
      <section>
        <h2>Buy these shims</h2>
        ${buys || unsolved ? `<ul class="step-list">${buys}${unsolved}</ul>` : '<p class="help">Nothing to buy.</p>'}
        ${buyBlock}
      </section>`;
  }

  function renderSelection(plan) {
    const hint = $('head-hint');
    for (const el of root.querySelectorAll('.valve')) el.classList.remove('selected', 'match');
    for (const el of root.querySelectorAll('.bucket')) el.setAttribute('aria-pressed', 'false');

    const v = plan.valves.find((x) => x.id === state.selected);
    if (!state.selected || !v) {
      hint.textContent = plan.counts.outOfSpec
        ? 'Tap a valve to highlight the shims that would fix it, or the valves its shim would fix.'
        : '';
      return;
    }
    card(v.id).classList.add('selected');
    root.querySelector(`.bucket[data-select="${v.id}"]`).setAttribute('aria-pressed', 'true');
    const related = v.status === 'ok' ? v.fixes : v.fixedBy;
    for (const id of related) card(id).classList.add('match');
    const range = `${shimLabel(v.lo / 1000)} to ${shimLabel(v.hi / 1000)}`;
    if (v.status === 'ok') {
      hint.textContent = v.fixes.length
        ? `${v.id}'s ${shimLabel(v.shim)} shim would fix ${v.fixes.join(', ')}.`
        : `${v.id}'s ${shimLabel(v.shim)} shim would not fix any out-of-spec valve.`;
    } else {
      hint.textContent = v.fixedBy.length
        ? `${v.id} needs a shim from ${range} ${unitName()}. These valves hold one: ${v.fixedBy.join(', ')}.`
        : `${v.id} needs a shim from ${range} ${unitName()}. None of your shims fit.`;
    }
  }

  function render() {
    const { readings, entered, isSample } = collect();
    writeSaved({ spec: state.spec, entered });
    $('lash-sample-tag').hidden = !isSample;

    const plan = buildPlan(readings, state.spec, options);
    state.plan = plan;
    const byId = new Map(plan.valves.map((v) => [v.id, v]));

    for (const meta of VALVES) {
      const el = card(meta.id);
      const v = byId.get(meta.id);
      const status = el.querySelector('[data-role="status"]');
      const planBox = el.querySelector('[data-role="plan"]');
      if (!v) {
        el.dataset.status = 'empty';
        status.textContent = 'No reading';
        planBox.innerHTML = '';
        continue;
      }
      el.dataset.status = v.status;
      status.textContent = v.status === 'ok' ? STATUS_TEXT.ok : `${STATUS_TEXT[v.status]}, needs ${shimLabel(v.lo / 1000)} to ${shimLabel(v.hi / 1000)}`;
      planBox.innerHTML = planLine(v);
    }

    renderBand(plan);
    renderLists(plan);
    renderSelection(plan);
  }

  function setSpec(el) {
    const [side, key] = el.dataset.spec.split('.');
    const typed = parseNumber(el.value);
    const value = typed === null ? null : toMm(typed);
    const other = state.spec[side][key === 'min' ? 'max' : 'min'];
    const valid = value !== null && value >= 0 && value <= 1 && (key === 'min' ? value <= other : value >= other);
    el.setAttribute('aria-invalid', String(!valid));
    if (valid) state.spec[side][key] = value;
  }

  let timer = 0;
  root.addEventListener('input', (event) => {
    if (event.target.dataset.spec) setSpec(event.target);
    window.clearTimeout(timer);
    timer = window.setTimeout(render, 120);
  });
  root.addEventListener('click', (event) => {
    const bucket = event.target.closest('[data-select]');
    if (bucket) {
      const id = bucket.dataset.select;
      state.selected = state.selected === id ? null : id;
      renderSelection(state.plan);
      return;
    }
    if (event.target.closest('#price-buys')) onPrice(buyListText(state.plan.buys));
  });
  $('lash-sample').addEventListener('click', () => {
    fill(SAMPLE);
    state.selected = null;
    render();
  });
  $('lash-clear').addEventListener('click', () => {
    fill({});
    state.selected = null;
    render();
    input('I1F', 'shim').focus();
  });

  onUnitChange((next, previous) => {
    for (const v of VALVES) {
      for (const field of ['shim', 'lash']) {
        const el = input(v.id, field);
        const { mm } = readField(el, previous, field === 'lash' ? state.spec[v.side] : undefined);
        if (mm !== null) setField(el, mm);
      }
    }
    showSpec();
    render();
  });

  // Saved readings are always millimeters. Text that isn't a number is kept as typed.
  showSpec();
  const restored = saved?.entered;
  if (restored) {
    for (const v of VALVES) {
      for (const [index, field] of ['shim', 'lash'].entries()) {
        const value = restored[v.id]?.[index] ?? '';
        const mm = parseNumber(value);
        const el = input(v.id, field);
        if (mm === null) el.value = value;
        else setField(el, mm);
      }
    }
  } else {
    fill(SAMPLE);
  }
  render();
}

