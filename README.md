# Miata Shim Finder

Enter your valve lash readings to see which shims can move between valves, then get the cheapest order for the rest. It's built for a Mazda BP solid-lifter head and covers the Toyota, Silver Seal and Mazda parts in the [Shim Part Numbers PDF](https://www.thecarpassionchannel.com/wp-content/uploads/2019/11/Shim-Part-Numbers.pdf).

## Lash plan

- Enter the shim and measured lash for each of the 16 valves on the head diagram. Partial heads work, and only valves with both numbers are planned.
- The default lash spec is 0.18 to 0.23 mm intake and 0.28 to 0.34 mm exhaust. Both can be edited.
- For each valve, shim + lash is fixed, so its in-spec shim range is `shim + lash - spec max` to `shim + lash - spec min`.
- Every valve gets one shim from the 16 on hand or a bought one, using a minimum cost assignment. The goals, in order, are fewest shims bought, fewest shims moved, and lash closest to mid-range.
- Matching letters on the diagram show each move. Each valve also lists the out-of-spec valves its shim would fit, even if the plan doesn't use that swap. Selecting a valve highlights its matches.
- **Price these shims** sends the buy list to the shim finder.

## Buying shims

- Reads sizes as `2.75, 2.75, 3.05x2`, as stamped values such as `275`, or as inches such as `0.1083`.
- Matches each size to every part number within the tolerance you choose. The default of 0.005 mm treats Mazda's 3.052 as 3.05.
- Finds the lowest total order, counting Silver Seal's 4-pack size, each store's shipping and the option to split a size between stores.
- Compares Toyota, Silver Seal and Mazda side by side for each size, with every store listed when you open a row.
- Leaves out anything a store can't sell, and reports any size with no orderable part.

## How prices stay current

A GitHub Pages site can't read store pages from the browser, so prices live in `data/prices.json`. `.github/workflows/refresh-prices.yml` updates that file every Monday and commits the result. You can also start it from the Actions tab.

If a page fails, doesn't match the expected format, or shows a price that moved more than 4x, the old price is kept and the site says it didn't refresh. Requests are 10 seconds apart and only use public product pages that the stores' `robots.txt` files allow.

**Original Mazda Parts and Mazda Parts Factor don't refresh.** Both return HTTP 403 to GitHub's servers, so the job stops after three refusals and keeps their last prices. The site labels those prices with their date. Update them in `data/prices.json` by hand, or remove the stores from `data/catalog.json`.

GitHub pauses scheduled workflows after 60 days without repository activity. The weekly price commit normally prevents that. If it does pause, re-enable it from the Actions tab.

## Shipping

Shipping rules are in `data/catalog.json` and do not refresh on their own. They were quoted to Richmond, VA 23219 on 2026-11-05, so they're estimates for other ZIP codes. Taxes aren't included.

## Fitment

The Mazda and Silver Seal lists match the [Miata Turbo BP lifter shims thread](https://www.miataturbo.net/engine-performance-56/bp-lifter-shims-90918/), which gives the shim diameter as 27 mm nominal, 26.95 mm actual. The Toyota 13753-50xxx interchange comes from the PDF only. Its diameter hasn't been separately confirmed, so measure one before buying a full set.

## Run it locally

    python3 -m http.server 8000     # then open http://localhost:8000
    npm test                        # no dependencies, needs Node 22 or newer
    npm run refresh                 # refreshes data/prices.json

## Adding a store

Add it to `stores` in `data/catalog.json`, using the `apg`, `revolution` or `shopify` adapter or a new parser in `scripts/lib/parsers.mjs`, and add its offers to `data/prices.json`.
