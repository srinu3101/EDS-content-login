# gated-content

Public content every visitor sees, plus premium content only signed-in
visitors see. The block-level counterpart of section metadata
`view = logged-in`.

## Authoring (Document Authoring)

| Gated Content |  |
| --- | --- |
| Public Content | Intro or teaser everyone can read. |
| Premium Content | Premium text, images, links… |

- `Public Content` row: shown to every visitor. Optional.
- `Premium Content` row: shown to signed-in visitors only. A single-cell row (no label) also counts as premium content.
- Rows can be in any order and repeated.
- Set page metadata `gated = true` on any page that uses this block.

## Delivery

Sign-in state comes from `scripts/gated.js` (the `wknd-signed-in` hint
cookie, set only after a real Auth0 login in the Cloudflare worker). Sign In /
Sign Up links authored inside Public Content are removed: visitors sign in from
the header. For anonymous visitors the block drops the `Premium Content`
rows in the browser, so they never display, but they are still in the page
source. The Cloudflare edge worker is what removes them before delivery; it can
read the same cookie. The premium part carries `data-view="logged-in"`.

## Supported variations

No variations.
