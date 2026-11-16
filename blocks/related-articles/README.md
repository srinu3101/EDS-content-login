# related-articles

Put at the bottom of a news article: 3 other articles on the same topic —
same **Category** (or a shared **Tag**), newest first, never the article
itself; topped up with the newest others when there are too few.

Normally the **Cloudflare worker** fills this block before the page is
delivered (edge assembly, data from `/news-index.json`). Without the worker
(aem.page, local preview) the block builds the same list in the browser. If
no articles can be found the block hides itself.

## Authoring (Document Authoring)

| Related Articles |  |
| --- | --- |
| Title | Related articles |
| Count | 3 |

Every row is optional; an empty block uses the defaults above.

## Supported variations

No variations.
