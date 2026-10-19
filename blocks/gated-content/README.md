# gated-content

Premium content inside a page, plus optional public content for anonymous
visitors. The block-level counterpart of section metadata
`view = logged-in / logged-out`.

## Authoring (Document Authoring)

| Gated Content |  |
| --- | --- |
| Public Content | Sign in to see the full itinerary. [Sign In](/) |
| Premium Content | Premium text, images, links… |

- `Public Content` row: shown to logged-out visitors. Optional.
- `Premium Content` row: shown to logged-in visitors. A single-cell row (no label) also counts as premium content.
- Rows can be in any order and repeated.
- Set page metadata `gated = true` on any page that uses this block.

## Delivery

The block does not hide anything in the browser. The Cloudflare edge worker
removes the `Premium Content` rows for anonymous visitors (and the
`Public Content` rows for signed-in visitors) before the page is delivered, so
premium content never reaches anonymous users. The block renders whatever
arrives, and its output parts carry `data-view="logged-out"` (public) /
`data-view="logged-in"` (premium).

## Supported variations

No variations.
