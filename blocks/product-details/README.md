# product-details

The product detail page (PDP). One page — `/us/en/shop/product` — serves every
product: the block reads `?sku=` from the address and shows the photos (main
photo + thumbnails when there are several), category, name (the page's h1),
SKU, stars (link to the Product Reviews block, `#reviews`), price, member
price, stock and description, plus a "Back to Shop" link. An unknown or
missing SKU shows "Product not found".

Data (see `scripts/products.js`): on the Cloudflare worker
`/commerce/catalog.json` + `prices.json` + `inventory.json`, the product's
`/commerce/product/{sku}.json` (description, photos) and
`/commerce/ratings.json`; otherwise the sheet `/data/products`.

## Authoring (Document Authoring)

| Product Details |  |
| --- | --- |
| Source | /commerce/products.json |
| Shop Page | /us/en/shop |

- Both rows are optional; the values above are the defaults.
- `Source`: leave it out (default: the worker's commerce APIs, falling back to
  the sheet). `/data/products.json` forces the sheet.
- Don't add another h1 to the page — the block renders the product name as h1.
- Put a **Product Reviews** block in a section below it for the customer reviews.

## Supported variations

No variations.
