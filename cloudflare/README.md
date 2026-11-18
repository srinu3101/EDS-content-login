# Cloudflare worker (edge gating + Auth0 sign-in)

`worker.mjs` is Adobe's [aem-cloudflare-prod-worker](https://github.com/adobe/aem-cloudflare-prod-worker)
plus:

- **Auth0 sign-up and sign-in** — `/auth/signup`, `/auth/login`,
  `/auth/callback`, `/auth/logout`. After a real sign-up or login the worker
  sets a signed, HttpOnly session cookie (`wknd-session`) that page scripts
  can't read or forge. Auth0 always asks for credentials (`prompt=login`).
  The site header shows **Sign In** for visitors (Auth0's login page links to
  sign-up) and **Sign Out** for members.
- **Edge gating** — anonymous visitors never receive premium content in the
  page source; signed-in visitors get public + premium.

This folder is in `.hlxignore`, so it is kept in git but not published.

## 1. Auth0

1. Sign up at <https://auth0.com> (free plan) and create a tenant.
2. **Applications → Applications → Create Application** → name `eds-content-login`,
   type **Regular Web Applications** → Create.
3. In the application's **Settings**, set (replace `<subdomain>`):

| Field | Value |
| --- | --- |
| Allowed Callback URLs | `https://eds-content-login.<subdomain>.workers.dev/auth/callback` |
| Allowed Logout URLs | `https://eds-content-login.<subdomain>.workers.dev/auth/logged-out` |
| Allowed Web Origins | `https://eds-content-login.<subdomain>.workers.dev` |

   Click **Save Changes**. Note **Domain**, **Client ID** and **Client Secret**
   from the same page.
4. **Allow sign-up:** Authentication → Database →
   **Username-Password-Authentication** → turn **Disable Sign Ups** OFF → Save.
   Then check the application's **Connections** tab: this database is enabled.
5. Optional test member: **User Management → Users → Create User** (email +
   password).

## 2. Cloudflare worker

1. Deploy the code — automatically (recommended) or by hand:
   - **Automatic (Workers Builds):** Workers & Pages → `eds-content-login` →
     Settings → **Builds → Connect** → GitHub → `srinu3101/EDS-content-login`,
     branch `main`, root directory `cloudflare`, deploy command
     `npx wrangler deploy`. Every merge into `main` then deploys `worker.mjs`
     using `wrangler.toml` (`keep_vars = true` keeps the dashboard variables).
   - **By hand:** `cd cloudflare && npx wrangler deploy` (after `npx wrangler
     login`), or Workers & Pages → `eds-content-login` → **Edit code** → paste
     the whole of `worker.mjs` → **Deploy**.
2. Settings → Variables and Secrets:

| Type | Name | Value |
| --- | --- | --- |
| Text | `ORIGIN_HOSTNAME` | `main--eds-content-login--srinu3101.aem.live` |
| Text | `PUSH_INVALIDATION` | `disabled` (workers.dev) / `enabled` (own domain) |
| Text | `AUTH0_DOMAIN` | Auth0 **Domain**, e.g. `dev-abc123.us.auth0.com` (no `https://`) |
| Text | `AUTH0_CLIENT_ID` | Auth0 **Client ID** |
| **Secret** | `AUTH0_CLIENT_SECRET` | Auth0 **Client Secret** |
| **Secret** | `SESSION_SECRET` | 64+ random characters (e.g. a password manager's generator) |
| Text | `LOGIN_TEASER` | optional, e.g. `/fragments/login-teaser` |
| **Secret** | `ORIGIN_AUTHENTICATION` | optional: site token once aem.live is protected |
| Text | `SHOPIFY_STORE_DOMAIN` | optional: Shopify store, e.g. `wknd-demo-430gsp3x.myshopify.com` |
| **Secret** | `SHOPIFY_STOREFRONT_TOKEN` | optional: Storefront API public access token (Shopify **Headless** channel) |
| Text | `SHOPIFY_API_VERSION` | optional: Storefront API version, defaults to the one in `worker.mjs` |

   Deploy. Enter secrets only in Cloudflare — never in code, chat or email.
   Changing `SESSION_SECRET` signs everyone out.

## 3. Test

1. Open `https://eds-content-login.<subdomain>.workers.dev/us/en` → **Sign In**
   → Auth0 login page → **Sign up** link → create an account → back on the
   page, header shows **Sign Out**. **Sign Out**, then **Sign In** with the
   same account.
2. A gated page shows premium content; **Sign Out** → public only.
3. Signed out, view source of a gated page: no premium text.

## How it decides

| Visitor | Removed before delivery |
| --- | --- |
| Anonymous | sections with `view = logged-in`, `(logged-in)` blocks, gated-content `Premium Content` rows |
| Signed in (valid session) | sections with `view = logged-out`, `(logged-out)` blocks |

- Signed in = valid `wknd-session` (8 h). `wknd-signed-in=true` is only a hint
  for the header label; on its own it unlocks nothing and is cleared.
- Without the four AUTH0/SESSION variables the worker runs in **demo mode**:
  `wknd-signed-in=true` alone counts as signed in. Not secure.
- Applies to pages and `/page.plain.html`; `/page.md` returns 404. Gated
  responses are `private, no-store` with `Vary: Cookie`.
- On `*.aem.page` / `*.aem.live` (no worker) the site's Sign In sends visitors
  to this worker's login (`EDGE_ORIGIN` in `scripts/gated.js`); nothing there
  unlocks premium content. Protect those hosts with site authentication and
  set `ORIGIN_AUTHENTICATION`, otherwise their page source bypasses this worker.

## Shopify products (`/commerce/products.json`)

With `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_STOREFRONT_TOKEN` set, the worker
answers `/commerce/products.json` from the Shopify **Storefront API** — the
products tagged `wknd-shop` — in the same shape as the `/data/products` sheet,
cached for a minute. The shop blocks (`scripts/products.js`) read it first and
fall back to the sheet when it is missing, empty or failing (and always on
aem.page / aem.live / localhost, which have no worker).

Mapping: first variant's SKU → `sku`, title → `name`, product type →
`category`, variant price → `price`, tag `member-price-<n>` → `memberPrice`,
quantity available → `stock`, featured image → `image`, description →
`description` (plus `handle`, `variantId`).

Shopify setup: install the **Headless** sales channel, create a storefront,
allow *read products, inventory and tags* (and *carts / checkouts* for a
Shopify checkout), include the products in the Headless channel, tag them
`wknd-shop`. Import file for the demo products: `.migration/shopify/wknd-products.csv`
(not committed).

## Commerce cache and change watcher

`/commerce/products.json` is kept in the **Workers KV** namespace
`COMMERCE_CACHE` (binding in `wrangler.toml`) for a day, the same copy for every
data center. Response headers show what happened: `x-commerce-cache: HIT`
(from KV) / `MISS` (loaded from Shopify and saved) / `BYPASS` (no KV binding,
old one-minute cache), `x-commerce-version` and `ETag` (hash of the data),
`x-commerce-saved-at`. Browsers re-check every time (`max-age=0` + ETag → 304).

The **change watcher** (Cron Trigger every minute, `[triggers]` in
`wrangler.toml`) loads the catalog from Shopify and compares its version with
the cached one. Changed → the KV copy is replaced at once and the change is
recorded; unchanged → nothing is written (KV free plan: 1,000 writes a day),
except a refill an hour before the copy would expire. Shopify down → the cached
copy stays. A Shopify change shows on the site within about 1–2 minutes (cron
interval + KV propagation).

`GET /commerce/cache-status.json` shows the cached version, when it was saved,
its age and the last change (e.g. `TENT-001 price 379 → 349`).

**Cache admin API** — `POST /commerce/invalidate` with
`Authorization: Bearer <CACHE_ADMIN_TOKEN>` and an optional JSON body
`{"mode":"refresh"}` (default: check Shopify now, replace the copy if changed)
or `{"mode":"clear"}` (delete the copy; the next visitor reloads it). For
manual clearing, Shopify webhooks or an Adobe I/O action. Off (404) without the
secret; wrong or missing token → 401.

Setup: Storage & databases → Workers KV → create `COMMERCE_CACHE`, put its id
in `wrangler.toml`; secret `CACHE_ADMIN_TOKEN` for the cache admin API. Don't
add the KV binding or the cron trigger in the dashboard — deploys use
`wrangler.toml`.
