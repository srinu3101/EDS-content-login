# news-list

The News page (`/us/en/news`): every news article, newest first, as cards
(photo, category · date, title, description) with page links (`?page=2` …).

Normally the **Cloudflare worker** fills this block before the page is
delivered (edge assembly, data from `/news-index.json`). Without the worker
(aem.page, local preview) the block builds the same list in the browser.

## Authoring (Document Authoring)

| News List |  |
| --- | --- |
| Per Page | 10 |
| Category | Surf |

Every row is optional (defaults: 10 per page, all categories).

## Articles

Pages under `/us/en/news/` with page metadata **Date** (YYYY-MM-DD),
**Category**, **Description** and a photo. They appear after publishing.

## Supported variations

No variations.
