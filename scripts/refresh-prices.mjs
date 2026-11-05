#!/usr/bin/env node
// Refreshes data/prices.json from each store's public product pages.
// Runs on a weekly schedule. A page that fails keeps its last known price, and the store is
// marked "stale" so the site can say so. Exits 1 only when every store fails.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseApg, parseRevolution, parseShopify } from './lib/parsers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'data/catalog.json');
const PRICES = join(ROOT, 'data/prices.json');

// Slow on purpose. The RevolutionParts stores ask crawlers for 10 seconds between requests.
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 10000);
// A failed fetch is retried once, after a pause, because these are ordinary store pages.
const RETRY_MS = Number(process.env.RETRY_DELAY_MS ?? 30000);
// Treat a price that moves this far in one refresh as a parser problem, not a real change.
const MAX_JUMP = 4;
const HEADERS = {
  'User-Agent': 'miata-shim-finder/1.0 (weekly price refresh for a hobby tool)',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      if (attempt === 1) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt === 1) throw err;
    }
    await sleep(RETRY_MS);
  }
  throw new Error('unreachable');
}

async function readOffer(store, offer) {
  if (store.adapter === 'apg') return parseApg(await get(offer.url));
  if (store.adapter === 'revolution') return parseRevolution(await get(offer.url));
  if (store.adapter === 'shopify') {
    const json = await get(`${offer.url}.js`);
    await sleep(DELAY_MS);
    return parseShopify(json, await get(offer.url));
  }
  throw new Error(`Unknown adapter: ${store.adapter}`);
}

async function refreshStore(store, offers) {
  const updated = [];
  const failures = [];
  for (const offer of offers) {
    let next = null;
    let reason = 'page did not match the expected format';
    try {
      next = await readOffer(store, offer);
    } catch (err) {
      reason = err.message;
    }
    const jumped =
      next?.price && offer.price &&
      (next.price > offer.price * MAX_JUMP || next.price < offer.price / MAX_JUMP);
    if (!next || jumped) {
      failures.push(`${offer.part}: ${jumped ? `price jumped to ${next.price}` : reason}`);
      updated.push(offer);
    } else {
      const entry = { store: offer.store, part: offer.part, price: next.price, status: next.status, url: offer.url };
      if (next.lead) entry.lead = next.lead;
      updated.push(entry);
    }
    await sleep(DELAY_MS);
  }
  return { updated, failures };
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const prices = JSON.parse(await readFile(PRICES, 'utf8'));
  const now = new Date().toISOString();

  const outcomes = await Promise.all(
    catalog.stores.map(async (store) => {
      const offers = prices.offers.filter((o) => o.store === store.id);
      const result = await refreshStore(store, offers);
      const ok = offers.length - result.failures.length;
      console.log(`${store.name}: ${ok}/${offers.length} refreshed`);
      for (const f of result.failures.slice(0, 5)) console.log(`  ${f}`);
      return { store, offers: offers.length, ...result };
    })
  );

  const storeStatus = {};
  for (const o of outcomes) {
    const fresh = o.failures.length === 0;
    storeStatus[o.store.id] = fresh
      ? { checkedAt: now, status: 'ok' }
      : { checkedAt: prices.stores[o.store.id]?.checkedAt ?? null, status: 'stale', failed: o.failures.length };
  }

  const anyRefreshed = outcomes.some((o) => o.failures.length < o.offers);
  if (!anyRefreshed) {
    console.error('Every store failed. Leaving prices.json unchanged.');
    process.exit(1);
  }

  const output = { generatedAt: now, stores: storeStatus, offers: outcomes.flatMap((o) => o.updated) };
  await writeFile(PRICES, `${JSON.stringify(output, null, 1)}\n`);
}

main();
