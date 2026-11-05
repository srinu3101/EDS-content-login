# cart

The shop cart page (`/us/en/shop/cart`). Lists every product in the cart with
photo, unit price, quantity − / +, Remove and line total, then the order
summary — items, member savings, shipping, total — with Checkout and Continue
shopping. Empty cart: a message and a link back to the Shop.

## Authoring (Document Authoring)

| Cart |
| --- |
|  |

No rows are needed. Put the page heading (e.g. "Your Cart") above the block.

## Delivery

- The cart lives in the visitor's browser (`localStorage`, `scripts/cart.js`):
  only SKUs and quantities are stored; prices always come from the product API.
- Signed-in members (checked with the worker, `/auth/me`) pay the member price.
- Free shipping from $200, otherwise $10. Quantities are capped at the stock
  and at 10 per product.
- "Add to Cart" lives on the product page (quantity picker) and on the Shop
  cards; the header shows the number of items.

## Supported variations

No variations.
