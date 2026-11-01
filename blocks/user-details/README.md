# user-details

A personal landing block (e.g. on `/us/en/my-account`): the signed-in
visitor's profile, public content for everyone, and premium content that is
loaded only after sign-in.

The block is self-reliant: it asks the Cloudflare worker (`GET /auth/me`) who
is signed in. It needs no section metadata (`view`), no `gated` page setting,
no block variants and no Gated Content block.

## Authoring (Document Authoring)

| User Details |  |
| --- | --- |
| Public Content | Text everyone can read |
| Premium Content | /premium/my-account |
| Signed In | Welcome back, {name}! |
| Signed Out | Sign in or create an account to see member content. |

- Every row is optional and rows can be in any order. Without `Signed In` /
  `Signed Out` rows the block shows default text.
- `Premium Content`: a link to (or the path of) a page under `/premium/`. Write
  the premium text, images and blocks on that page and publish it as usual.
  The worker refuses `/premium/` to visitors who are not signed in, so premium
  content is never part of the landing page itself. Text typed straight into
  this row is shown to signed-in visitors only, but it IS in the page source —
  use a `/premium/` page for anything that must stay private.
- `{name}` in `Signed In` is replaced with the visitor's name (or username /
  email).
- Rows with any other label, or without a label, count as public content.

## What visitors see

| Visitor | Shown |
| --- | --- |
| Signed out | `Signed Out` text, public content, Sign In and Sign Up buttons |
| Signed in | `Signed In` text, profile card (picture, name, username, email), public content, premium page, Sign Out button |

On Adobe's hosts (`*.aem.page`, `*.aem.live`) and in local development there is
no worker, so the block always shows the signed-out view there; Sign In goes to
the worker's address.

## Delivery

- `/auth/me` reads only the signed, HttpOnly `wknd-session` cookie, never the
  `wknd-signed-in` hint; its answer is never cached.
- Name, username (Auth0 `nickname`), email and picture are stored in the session
  at sign-in. Sessions created before this change carry only the name: sign out
  and in again.
- Premium pages are fetched with the fragment loader (`/premium/….plain.html`);
  the worker answers 401 to anyone not signed in and marks signed-in copies
  `private, no-store`.

## Supported variations

No variations.
