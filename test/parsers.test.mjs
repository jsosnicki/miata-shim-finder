import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApg, parseRevolution, parseShopify } from '../scripts/lib/parsers.mjs';

// Snippets copied from each store's live pages on 2026-11-05.
const apg = (availability, price) => `<html><script type="application/ld+json">
 { "@context": "https://schema.org/", "@type": "WebSite", "url": "https://www.mazdapartsnow.com" }
</script><script type="application/ld+json">
 { "@context": "https://schema.org/", "@type": "Product", "mpn": "Z5Y2-12-541",
   "offers": { "@type": "Offer", "priceCurrency": "USD",
     "itemCondition": "https://schema.org/NewCondition",
     "availability": "https://schema.org/${availability}", "price": "${price}" } }
</script></html>`;

test('APG stores: in stock', () => {
  assert.deepEqual(parseApg(apg('InStock', '13.36')), { price: 13.36, status: 'in_stock' });
});

test('APG stores: Discontinued means unavailable, and keeps the listed price', () => {
  assert.deepEqual(parseApg(apg('Discontinued', '13.91')), { price: 13.91, status: 'unavailable' });
});

test('APG stores: a zero price has no price', () => {
  assert.deepEqual(parseApg(apg('Discontinued', '0.00')), { price: null, status: 'unavailable' });
});

test('APG stores: an unfamiliar page is rejected', () => {
  assert.equal(parseApg('<html>Access denied</html>'), null);
  assert.equal(parseApg(apg('InStock', '0.00')), null);
});

const revolution = (buy) => `<script>{"price":"$15.39","rawMsrp":17.81,"rawPrice":15.39,"salePriceLabel":"Sale Price",
"purchaseActions":{"addToCartLabel":"Add to Cart","canPurchase":${buy}}}</script>
<div>Ships in 7 days.</div>`;

test('RevolutionParts stores: price, stock and lead time', () => {
  assert.deepEqual(parseRevolution(revolution('true')), { price: 15.39, status: 'in_stock', lead: 'Ships in 7 days' });
  assert.equal(parseRevolution(revolution('false')).status, 'unavailable');
  assert.equal(parseRevolution('<html></html>'), null);
});

const shopifyJson = (available) =>
  JSON.stringify({ title: 'NISK2.45', available, variants: [{ price: 1815, available, sku: 'SS NISK2.45' }] });

test('Shopify: orderable with 0 on hand is a backorder', () => {
  assert.deepEqual(parseShopify(shopifyJson(true), '"inventory_quantity":0'), {
    price: 18.15,
    status: 'backorder',
    lead: 'Orderable, listed 0 on hand',
  });
});

test('Shopify: stock on hand and unavailable items', () => {
  assert.equal(parseShopify(shopifyJson(true), '"inventory_quantity":6').status, 'in_stock');
  assert.equal(parseShopify(shopifyJson(false), '').status, 'unavailable');
  assert.equal(parseShopify('not json', ''), null);
});
