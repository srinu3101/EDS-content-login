# latest-articles

Put at the bottom of a news article: the 5 newest news articles, never the
article itself — compact list with photo, category · date and title.

Normally the **Cloudflare worker** fills this block before the page is
delivered (edge assembly, data from `/news-index.json`). Without the worker
(aem.page, local preview) the block builds the same list in the browser. If
no articles can be found the block hides itself.

## Authoring (Document Authoring)

| Latest Articles |  |
| --- | --- |
| Title | Latest articles |
| Count | 5 |

Every row is optional; an empty block uses the defaults above.

## Supported variations

No variations.
