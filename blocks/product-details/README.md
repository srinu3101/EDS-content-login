# product-details

The product detail page (PDP). One page — `/us/en/shop/product` — serves every
product: the block reads `?sku=` from the address, finds the product in the
demo product API (`/data/products.json`) and shows photo, category, name (the
page's h1), SKU, price, member price, stock and description, plus a
"Back to Shop" link. An unknown or missing SKU shows "Product not found".

## Authoring (Document Authoring)

| Product Details |  |
| --- | --- |
| Source | /data/products.json |
| Shop Page | /us/en/shop |

- Both rows are optional; the values above are the defaults.
- Don't add another h1 to the page — the block renders the product name as h1.

## Supported variations

No variations.
