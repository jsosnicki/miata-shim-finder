// Turn a store's page into { price, status, lead }. Each returns null when the page does
// not look right, so a markup change can never write a bad price over a good one.

function toPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ToyotaPartsDeal, ToyotaPartsNow, LexusPartsNow, MazdaPartsNow: JSON-LD Product offer.
// schema.org "Discontinued" on these stores renders as "Currently Unavailable".
export function parseApg(html) {
  const blocks = [...html.matchAll(/application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)];
  const product = blocks.map((m) => m[1]).find((b) => /"@type"\s*:\s*"Product"/.test(b));
  if (!product) return null;
  const availability = product.match(/"availability"\s*:\s*"[^"]*\/(\w+)"/);
  const price = product.match(/"price"\s*:\s*"?([\d.]+)"?/);
  if (!availability || !price) return null;
  const inStock = availability[1] === 'InStock';
  const value = toPrice(price[1]);
  if (inStock && value === null) return null;
  return { price: value, status: inStock && value ? 'in_stock' : 'unavailable' };
}

// Original Mazda Parts, Mazda Parts Factor: RevolutionParts page state.
export function parseRevolution(html) {
  const price = html.match(/"rawPrice":([\d.]+)/);
  const canPurchase = html.match(/"canPurchase":(true|false)/);
  if (!price || !canPurchase) return null;
  const value = toPrice(price[1]);
  if (value === null) return null;
  const visible = html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const lead = visible.match(/Ships in \d+ days?|Ready to ship today/i);
  const result = {
    price: value,
    status: canPurchase[1] === 'true' ? 'in_stock' : 'unavailable',
  };
  if (lead) result.lead = lead[0];
  return result;
}

// Piston Depot: Shopify product .js, plus the on-hand count embedded in the page.
export function parseShopify(productJson, html) {
  let product;
  try {
    product = JSON.parse(productJson);
  } catch {
    return null;
  }
  const variant = product?.variants?.[0];
  if (!variant || !Number.isFinite(variant.price)) return null;
  const value = toPrice(variant.price / 100);
  if (value === null) return null;
  if (!product.available) return { price: value, status: 'unavailable' };
  const onHand = html.match(/inventory_quantity"?\s*[:=]\s*(-?\d+)/);
  if (onHand && Number(onHand[1]) > 0) return { price: value, status: 'in_stock' };
  return { price: value, status: 'backorder', lead: 'Orderable, listed 0 on hand' };
}
