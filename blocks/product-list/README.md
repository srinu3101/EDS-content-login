# product-list

The shop's product listing page (PLP), e.g. `/us/en/shop`. Reads the demo
product API — the Document Authoring sheet `/data/products`, served as
`/data/products.json` — and shows a card grid (photo, category, name, price,
member price, stock) with category filter tabs. Each card opens the product
page with `?sku=`.

## Authoring (Document Authoring)

| Product List |  |
| --- | --- |
| Source | /data/products.json |
| Product Page | /us/en/shop/product |
| Category | Surf |

- Every row is optional; the values above (without Category) are the defaults.
- `Category`: show only that category, without filter tabs.
- A tab can be preselected from the address: `/us/en/shop?category=climbing`.

## Products sheet

Columns: `sku`, `name`, `category`, `price`, `memberPrice`, `stock`, `image`
(site path of a photo), `description`. Rows without `sku` or `name` are
skipped. Stock of 10 or fewer shows "Only N left", 0 shows "Out of stock".

## Supported variations

No variations.
