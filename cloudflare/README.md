# Cloudflare worker (edge gating + Auth0 sign-in)

`worker.mjs` is Adobe's [aem-cloudflare-prod-worker](https://github.com/adobe/aem-cloudflare-prod-worker)
plus:

- **Auth0 sign-up and sign-in** — `/auth/signup`, `/auth/login`,
  `/auth/callback`, `/auth/logout`. After a real sign-up or login the worker
  sets a signed, HttpOnly session cookie (`wknd-session`) that page scripts
  can't read or forge. The site header shows **Sign In** + **Sign Up** for
  visitors and **Sign Out** for members.
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

1. Workers & Pages → `eds-content-login` → **Edit code** → select all, delete,
   paste the whole of `worker.mjs` → **Deploy**.
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

   Deploy. Enter secrets only in Cloudflare — never in code, chat or email.
   Changing `SESSION_SECRET` signs everyone out.

## 3. Test

1. Open `https://eds-content-login.<subdomain>.workers.dev/us/en` → **Sign Up**
   → Auth0 sign-up page → create an account → back on the page, header shows
   **Sign Out**. **Sign Out**, then **Sign In** with the same account.
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
- On `*.aem.page` / `*.aem.live` (no worker) the site's Sign In stays a demo
  toggle for authors' previews. Protect those hosts with site authentication
  and set `ORIGIN_AUTHENTICATION`, otherwise they bypass this worker.
