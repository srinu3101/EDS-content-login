# product-list

The shop's product listing page (PLP), e.g. `/us/en/shop`. Shows a card grid
(photo, category, name, stars, price, member price, stock) with category
filter tabs. Each card opens the product page with `?sku=`.

Data (see `scripts/products.js`): on the Cloudflare worker the separate
commerce APIs `/commerce/catalog.json` + `prices.json` + `inventory.json`
(Shopify, each cached for its own time) and `/commerce/ratings.json` for the
stars (shown only for products with reviews); otherwise — Adobe hosts, local
dev, or the APIs failing — the Document Authoring sheet `/data/products`.

## Authoring (Document Authoring)

| Product List |  |
| --- | --- |
| Source | /commerce/products.json |
| Product Page | /us/en/shop/product |
| Category | Surf |

- Every row is optional; the values above (without Category) are the defaults.
- `Category`: show only that category, without filter tabs.
- `Source`: leave it out (default: the worker's commerce APIs, falling back to
  the sheet). `/data/products.json` forces the sheet.
- A tab can be preselected from the address: `/us/en/shop?category=climbing`.

## Products sheet

Columns: `sku`, `name`, `category`, `price`, `memberPrice`, `stock`, `image`
(site path of a photo), `description`. Rows without `sku` or `name` are
skipped. Stock of 10 or fewer shows "Only N left", 0 shows "Out of stock".

## Supported variations

No variations.

## Product photos

The demo product photos are in `/images/shop/` (1200×900). They are free
Unsplash photos (Unsplash License — free to use, no permission needed):

| File | Photographer | Unsplash |
| --- | --- | --- |
| surf-starter-kit.jpg | Aliburhan S | https://unsplash.com/photos/CY3wdG4eRoA |
| pro-wetsuit.jpg | Orca | https://unsplash.com/photos/ad0ms1fF8Hc |
| harness-carabiner-set.jpg | Matthew Hume | https://unsplash.com/photos/kAw_eMS1r1I |
| bouldering-crash-pad.jpg | Jeremy Vejgman | https://unsplash.com/photos/DqmySSDLDUs |
| trail-bike-helmet.jpg | Jan Kopřiva | https://unsplash.com/photos/rw8jnGPJpho |
| touring-panniers.jpg | Tim Oun | https://unsplash.com/photos/MnhPkBfjj0Q |
| all-mountain-goggles.jpg | Hansjörg Rath | https://unsplash.com/photos/QDgg2Y4_wMM |
| backpacking-tent.jpg | Dave Hoefler | https://unsplash.com/photos/a3e7yEtQxJs |
