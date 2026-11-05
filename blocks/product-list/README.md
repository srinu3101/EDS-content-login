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
