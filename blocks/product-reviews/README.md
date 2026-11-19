# product-reviews

Customer reviews for one product, on the product page (`/us/en/shop/product`),
below Product Details. Shows the average stars, number of reviews and "% would
recommend", the star breakdown (click a row to show only those reviews), the
reviews (stars, title, name · location · date, text, "Recommends this
product") with Sort by (newest, highest, lowest, most helpful) and "Show more
reviews", and a **Write a review** form.

Data: `/commerce/reviews/{sku}.json` from the Cloudflare worker, in the
**Bazaarvoice** Conversations API format. Until a Bazaarvoice passkey is set in
Cloudflare this is a **mock Bazaarvoice** built from the Document Authoring
sheet `/data/reviews` (see below). A written review is sent to the same
address and answered "Thanks! Your review is waiting for moderation." — the
mock checks it but doesn't save it. On hosts without the worker (aem.page,
aem.live, local dev) the block is hidden.

## Authoring (Document Authoring)

| Product Reviews |  |
| --- | --- |
| Title | Customer reviews |
| SKU | CAMP-001 |
| Per Page | 5 |

- Every row is optional; an empty block works. Defaults: title "Customer
  reviews", the product from the page's `?sku=`, 5 reviews before "Show more".
- The heading gets `id="reviews"`; the Product Details stars link to it.

## Reviews sheet (`/data/reviews`)

| SKU | Rating | Title | Review | Name | Location | Date | Recommended | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CAMP-001 | 5 | Light and quick to pitch | Under two kilos… | Ravi | Manali | 2026-11-10 | Yes | |

- `Rating` 1–5; rows without a valid rating or review text are skipped.
- `Status` empty or `Approved` = shown; anything else (e.g. `Pending`) =
  hidden, like a review waiting for moderation.
- `Recommended`: Yes / No / empty. `Date`: YYYY-MM-DD.
- The sheet is public (`/data/reviews.json`): sample data only, no e-mails.
- Changes show within about 1–2 minutes (the worker checks the sheet every
  minute and refreshes only that product's reviews and the ratings).

## Supported variations

No variations.
