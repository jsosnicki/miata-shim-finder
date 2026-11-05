import { buildOffers, offersForRequest, orderAsText, parseSizes, solve } from './optimizer.js';

const SAMPLE = '2.75x3, 2.80x2, 2.85, 2.90x2, 3.00, 3.05x2, 3.10, 3.15, 3.20, 3.30x2';
const STORAGE_KEY = 'miata-shim-finder:list';

const $ = (id) => document.getElementById(id);
const money = (n) => `$${n.toFixed(2)}`;
const mmText = (n) => n.toFixed(3);
const mmShort = (n) => n.toFixed(3).replace(/0$/, '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { catalog: null, prices: null, offers: [], result: null, open: new Set() };

function readList() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function saveList(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* Storage is a convenience only. */
  }
}

function currentOptions() {
  const checked = (root) => new Set([...root.querySelectorAll('input:checked')].map((i) => i.value));
  return {
    tolerance: Number($('tolerance').value),
    lines: checked($('line-filters')),
    stores: checked($('store-filters')),
    countShipping: $('count-shipping').checked,
    includeBackorder: $('include-backorder').checked,
  };
}

function shortDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// A store is out of date only when none of its prices refreshed.
function staleSince(storeId) {
  const info = state.prices.stores[storeId];
  if (!info || info.status === 'ok') return null;
  const total = state.prices.offers.filter((o) => o.store === storeId).length;
  return info.failed >= total && info.checkedAt ? shortDate(info.checkedAt) : null;
}

function statusLabel(offer) {
  if (offer.status === 'unavailable' || !offer.price) return ['off', 'Unavailable at this store'];
  if (offer.status === 'backorder') return ['warn', 'Orderable, 0 on hand'];
  return ['ok', offer.lead || 'Orderable'];
}

function renderOrder(result, opts, alt) {
  if (!result.groups.length) return '';
  const count = result.covered.reduce((s, r) => s + r.qty, 0);
  const groups = result.groups
    .map((g) => {
      const lines = g.lines
        .map((l) => {
          const o = l.offer;
          const pack = o.packQty > 1 ? `${l.units} × ${o.packQty}-pack` : `${l.units} ×`;
          const notes = [];
          if (o.mm !== l.request.mm) notes.push(`${mmText(o.mm)} mm for ${mmText(l.request.mm)}`);
          if (l.spare) notes.push(`${l.spare} spare`);
          if (o.status === 'backorder') notes.push('0 on hand');
          else if (o.lead) notes.push(o.lead);
          return `<li>
            <span class="size">${mmShort(l.request.mm)}</span>
            <span class="part">${pack} <a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.part)}</a>${notes.length ? `<small>${esc(notes.join(' · '))}</small>` : ''}</span>
            <span class="money">${money(l.cost)}</span>
          </li>`;
        })
        .join('');
      const since = staleSince(g.store.id);
      return `<article class="store-card">
        <header>
          <h3><a href="${esc(g.store.url)}" target="_blank" rel="noopener">${esc(g.store.name)}</a>${since ? `<span class="stale-tag">Price from ${esc(since)}</span>` : ''}</h3>
          <span class="store-sum" title="${esc(g.store.shippingNote)}">${money(g.subtotal)} + ${money(g.shipping)} ship = <b>${money(g.total)}</b></span>
        </header>
        <ul class="line-list">${lines}</ul>
      </article>`;
    })
    .join('');

  const breakdown = `${money(result.partsTotal)} parts + ${money(result.shippingTotal)} est. shipping, ${result.groups.length} ${result.groups.length === 1 ? 'store' : 'stores'}`;
  const altLine =
    alt && alt.delta > 0.004
      ? `<p class="alert">Your best order includes Silver Seal discs listed with 0 on hand. <strong>Items in stock only: ${money(alt.total)}</strong>, ${money(alt.delta)} more.</p>`
      : '';

  return `<div class="total-band">
      <span class="eyebrow">Cheapest order for ${count} ${count === 1 ? 'shim' : 'shims'}</span>
      <div>
        <div class="total-figure">${money(result.total)}</div>
        <p class="total-break">${breakdown}</p>
      </div>
      <div class="total-actions"><button type="button" class="ghost" id="copy-order">Copy order</button></div>
    </div>
    ${altLine}
    <section class="store-order" aria-label="Order by store">${groups}</section>`;
}

function bestPerLine(items, lineId) {
  return items.find((o) => o.line === lineId && o.orderable) || null;
}

function renderMatrix(requests, opts) {
  const lineIds = Object.keys(state.catalog.lines).filter((id) => opts.lines.has(id));
  const stores = new Map(state.catalog.stores.map((s) => [s.id, s]));
  const rows = requests
    .map((request) => {
      const items = offersForRequest(request, state.offers, opts);
      const bests = lineIds.map((id) => bestPerLine(items, id));
      const lowest = Math.min(...bests.filter(Boolean).map((o) => o.cost));
      const cells = bests
        .map((o) => {
          if (!o) return `<td class="cell-none">None</td>`;
          const pack = o.packQty > 1 ? `${o.units} × ${o.packQty}-pack` : `${stores.get(o.store).name}`;
          const sub = o.packQty > 1 ? `${money(o.perShim)} per shim needed` : `${money(o.price)} each`;
          return `<td class="${o.cost === lowest ? 'best' : ''}"><span class="cell-price">${money(o.cost)}</span><span class="cell-sub">${esc(pack)}</span><span class="cell-sub">${sub}</span></td>`;
        })
        .join('');
      const key = String(request.mm);
      const isOpen = state.open.has(key);
      const detail = items
        .map((o) => {
          const [cls, text] = statusLabel(o);
          return `<li class="${o.orderable ? '' : 'off'}">
            <span class="mono"><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.part)}</a></span>
            <span class="detail-store">${esc(stores.get(o.store).name)}</span>
            <span class="status ${cls} hide-narrow">${esc(text)}</span>
            <span class="mono detail-price">${o.price ? money(o.price) : 'n/a'}${o.packQty > 1 ? ` / ${o.packQty}` : ''}</span>
          </li>`;
        })
        .join('');
      return `<tr class="size-row">
          <td><button type="button" class="size-toggle" data-key="${key}" aria-expanded="${isOpen}"><span class="size">${mmText(request.mm)}</span><span class="qty">× ${request.qty}</span></button></td>
          ${cells}
        </tr>
        <tr class="detail-row" ${isOpen ? '' : 'hidden'}><td colspan="${lineIds.length + 1}"><ul class="detail-list">${detail || '<li>No parts in this size.</li>'}</ul></td></tr>`;
    })
    .join('');

  const heads = lineIds.map((id) => `<th>${esc(state.catalog.lines[id].label)}</th>`).join('');
  return `<section class="by-size">
    <div class="section-head">
      <h2>Compare by size</h2>
      <p class="help">Parts cost to cover the quantity, before shipping. Open a size to see every store.</p>
    </div>
    <div class="table-scroll"><table>
      <thead><tr><th>Size (mm)</th>${heads}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function renderUnmatched(unmatched) {
  if (!unmatched.length) return '';
  const items = unmatched
    .map((u) => {
      const near = [u.below, u.above].filter((v) => v !== null).map(mmText).join(' or ');
      return `<strong>${mmText(u.mm)} mm</strong> (nearest: ${near || 'none'})`;
    })
    .join(', ');
  return `<p class="alert"><strong>No orderable part for:</strong> ${items}. These are left out of the total.</p>`;
}

function renderGauge(requests) {
  const lineIds = Object.keys(state.catalog.lines);
  const W = 900;
  const LEFT = 92;
  const RIGHT = 16;
  const ROW = 38;
  const TOP = 12;
  const H = TOP + ROW * lineIds.length + 26;
  const MIN = 2.0;
  const MAX = 3.4;
  const x = (mm) => LEFT + ((mm - MIN) / (MAX - MIN)) * (W - LEFT - RIGHT);

  const orderable = new Set(
    state.offers.filter((o) => o.price > 0 && o.status !== 'unavailable').map((o) => o.part)
  );
  let svg = '';
  for (let v = 2.0; v <= 3.4001; v += 0.2) {
    svg += `<text x="${x(v)}" y="${H - 6}" text-anchor="middle">${v.toFixed(1)}</text>`;
  }
  lineIds.forEach((id, i) => {
    const y = TOP + ROW * i + ROW / 2;
    svg += `<text class="row-label" x="0" y="${y + 4}">${esc(state.catalog.lines[id].label)}</text>`;
    svg += `<line class="rail" x1="${LEFT}" x2="${W - RIGHT}" y1="${y}" y2="${y}"/>`;
    for (const p of state.catalog.parts.filter((q) => q.line === id)) {
      const on = orderable.has(p.id);
      svg += `<line class="${on ? 'tick-on' : 'tick-off'}" x1="${x(p.mm)}" x2="${x(p.mm)}" y1="${y - 11}" y2="${y + 11}"><title>${esc(p.id)}: ${mmText(p.mm)} mm${on ? '' : ', unavailable'}</title></line>`;
    }
  });
  for (const r of requests) {
    if (r.mm < MIN || r.mm > MAX) continue;
    svg += `<line class="marker" x1="${x(r.mm)}" x2="${x(r.mm)}" y1="${TOP - 4}" y2="${H - 20}"><title>Your list: ${mmText(r.mm)} mm</title></line>`;
  }
  $('gauge').innerHTML = `<svg class="gauge" viewBox="0 0 ${W} ${H}" role="img" aria-label="Shim sizes available from each part line, from 2.0 to 3.4 mm">${svg}</svg>`;
}

function render() {
  const raw = $('sizes').value;
  saveList(raw);
  $('sample-tag').hidden = raw.trim() !== SAMPLE;

  const { requests, errors } = parseSizes(raw);
  const errBox = $('parse-errors');
  errBox.hidden = !errors.length;
  errBox.textContent = errors.length
    ? `Could not read: ${errors.join(', ')}. Sizes should be between 1.5 and 4.5 mm.`
    : '';

  const opts = currentOptions();
  renderGauge(requests);

  if (!requests.length) {
    state.result = null;
    $('results').innerHTML = '<p class="empty">Enter at least one size to see the cheapest order.</p>';
    return;
  }

  const result = solve(requests, state.offers, state.catalog.stores, opts);
  state.result = result;

  let alt = null;
  const usesBackorder = result.groups.some((g) => g.lines.some((l) => l.offer.status === 'backorder'));
  if (usesBackorder) {
    const stock = solve(requests, state.offers, state.catalog.stores, { ...opts, includeBackorder: false });
    if (!stock.unmatched.length) alt = { total: stock.total, delta: Math.round((stock.total - result.total) * 100) / 100 };
  }

  $('results').innerHTML = renderOrder(result, opts, alt) + renderUnmatched(result.unmatched) + renderMatrix(requests, opts);
}

function renderFilters() {
  const { catalog } = state;
  $('line-filters').innerHTML = Object.entries(catalog.lines)
    .map(
      ([id, l]) => `<label class="check"><input type="checkbox" value="${id}" checked>
        <span>${esc(l.label)}<small>${esc(l.series)}${l.packQty > 1 ? `, packs of ${l.packQty}` : ''}</small></span></label>`
    )
    .join('');
  $('store-filters').innerHTML = catalog.stores
    .map(
      (s) => `<label class="check"><input type="checkbox" value="${s.id}" checked>
        <span>${esc(s.name)}<small>${esc(catalog.lines[s.line].label)}</small></span></label>`
    )
    .join('');
}

function renderFreshness() {
  const when = new Date(state.prices.generatedAt);
  const days = Math.floor((Date.now() - when.getTime()) / 86400000);
  const label = when.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const nameOf = (id) => state.catalog.stores.find((s) => s.id === id)?.name || id;
  const notOk = Object.entries(state.prices.stores).filter(([, v]) => v.status !== 'ok');
  const stale = notOk.filter(([id]) => staleSince(id));
  const partial = notOk.filter(([id]) => !staleSince(id));
  let text = `Prices last checked ${label}. Confirm on the store page before you order.`;
  if (days > 14) text += ` These prices are ${days} days old.`;
  if (stale.length) {
    text += ` ${stale.map(([id]) => nameOf(id)).join(' and ')} can't be updated automatically, so ${stale.length === 1 ? 'its prices' : 'their prices'} may be out of date.`;
  }
  for (const [id, v] of partial) {
    text += ` ${v.failed} ${nameOf(id)} ${v.failed === 1 ? 'price' : 'prices'} did not refresh.`;
  }
  $('freshness').textContent = text;
}

async function copyOrder(button) {
  const text = orderAsText(state.result);
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy blocked by browser';
  }
  window.setTimeout(() => {
    button.textContent = 'Copy order';
  }, 1600);
}

function bindEvents() {
  let timer = 0;
  $('sizes').addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(render, 120);
  });
  for (const id of ['tolerance', 'count-shipping', 'include-backorder']) {
    $(id).addEventListener('change', render);
  }
  $('line-filters').addEventListener('change', render);
  $('store-filters').addEventListener('change', render);
  $('use-sample').addEventListener('click', () => {
    $('sizes').value = SAMPLE;
    render();
  });
  $('clear').addEventListener('click', () => {
    $('sizes').value = '';
    render();
    $('sizes').focus();
  });
  $('results').addEventListener('click', (event) => {
    const copy = event.target.closest('#copy-order');
    if (copy) {
      copyOrder(copy);
      return;
    }
    const toggle = event.target.closest('.size-toggle');
    if (!toggle) return;
    const key = toggle.dataset.key;
    if (state.open.has(key)) state.open.delete(key);
    else state.open.add(key);
    render();
  });
}

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function start() {
  try {
    [state.catalog, state.prices] = await Promise.all([
      window.SHIM_DATA?.catalog ?? loadJson('data/catalog.json'),
      window.SHIM_DATA?.prices ?? loadJson('data/prices.json'),
    ]);
  } catch (err) {
    $('results').innerHTML = `<p class="alert"><strong>Parts data did not load.</strong> Reload the page. (${esc(err.message)})</p>`;
    return;
  }
  state.offers = buildOffers(state.catalog, state.prices);
  renderFilters();
  renderFreshness();
  $('sizes').value = readList() ?? SAMPLE;
  bindEvents();
  render();
}

start();
