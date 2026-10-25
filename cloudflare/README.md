# Cloudflare worker (edge gating)

`worker.mjs` is Adobe's [aem-cloudflare-prod-worker](https://github.com/adobe/aem-cloudflare-prod-worker)
plus edge gating: anonymous visitors never receive premium content in the page
source; signed-in visitors (cookie `wknd-signed-in=true`) get public + premium.
This folder is in `.hlxignore`, so it is kept in git but not published.

## Deploy

1. Cloudflare dashboard → Workers & Pages → `eds-content-login` → **Edit code**.
2. Select all, delete, paste the whole of `worker.mjs`, **Deploy**.
3. Settings → Variables and Secrets:

| Variable | Value |
| --- | --- |
| `ORIGIN_HOSTNAME` | `main--eds-content-login--srinu3101.aem.live` |
| `PUSH_INVALIDATION` | `disabled` (workers.dev) / `enabled` (own domain + CDN config) |
| `LOGIN_TEASER` | optional, e.g. `/fragments/login-teaser` |
| `ORIGIN_AUTHENTICATION` | optional secret: site token once aem.live is protected |

## What it gates

| Visitor | Removed before delivery |
| --- | --- |
| Anonymous | sections with `view = logged-in`, `(logged-in)` blocks, gated-content `Premium Content` rows |
| Signed in | sections with `view = logged-out`, `(logged-out)` blocks |

Applies to pages and `/page.plain.html`; `/page.md` returns 404. Gated
responses are `private, no-store` with `Vary: Cookie`. Pages without gating
markup pass through unchanged.

Direct `*.aem.page` / `*.aem.live` requests bypass this worker; protect them
with site authentication and set `ORIGIN_AUTHENTICATION`.
