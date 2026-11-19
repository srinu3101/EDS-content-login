/*
 * Copyright 2022 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/*
 * Cloudflare worker for eds-content-login: Adobe's aem-cloudflare-prod-worker
 * (https://github.com/adobe/aem-cloudflare-prod-worker, src/index.mjs) plus
 * edge gating and Auth0 sign-in for the gated-content story. Everything Adobe
 * ships is kept as is; the additions are marked "GATING" and "AUTH".
 *
 * AUTH: real sign-in through Auth0 (OpenID Connect authorization-code flow).
 *   /auth/login?returnTo=/path   → Auth0's hosted login page
 *   /auth/signup?returnTo=/path  → the same, opened on Auth0's sign-up screen
 *   /auth/callback               → code exchanged for an ID token (client
 *                                  secret stays in Cloudflare), claims checked,
 *                                  HMAC-signed HttpOnly session cookie set
 *   /auth/logout?returnTo=/path  → session cleared, Auth0 session ended
 *   /auth/logged-out             → back to the page the visitor left from
 *   /auth/me                     → JSON { signedIn, name, username, email,
 *                                  picture } from the session (never cached)
 * The session cookie `wknd-session` can't be read or forged by page scripts.
 * `wknd-signed-in=true` is a plain hint cookie so the site's header can show
 * "Sign Out"; it unlocks nothing. Without the AUTH0_* / SESSION_SECRET
 * variables the worker falls back to the demo: `wknd-signed-in=true` alone
 * counts as signed in (not secure, for local demos only).
 *
 * GATING: logged-in users see premium content, anonymous users see public
 * content only — enforced here, before the page leaves Cloudflare, so premium
 * markup never reaches an anonymous visitor's browser (unlike the in-browser
 * hiding in scripts/gated.js, which only hides it on screen).
 *   - signed in  = valid `wknd-session` (or the demo cookie when AUTH is off)
 *   - anonymous  → removes sections with data-view="logged-in" (section
 *                  metadata view = logged-in), blocks with the `logged-in`
 *                  class, and the "Premium Content" rows of gated-content
 *   - signed in  → removes sections / blocks marked logged-out
 *   - applies to pages and their .plain.html; .md is refused
 *   - optional LOGIN_TEASER (e.g. /fragments/login-teaser) is inserted where
 *     the first premium section was removed
 *
 * LOCKED PAGES: everything under /premium/ and /members/ is for signed-in
 * visitors only (/members/ holds the pages behind login).
 * Anonymous page views are sent to /auth/login (and back); other requests
 * (.plain.html, images) get 401. The user-details block loads its premium
 * content from such a page, so that content is never part of a public page.
 *
 * NEWS (edge assembly): on /us/en/news and /us/en/news/* pages the worker
 * fills the news-list, related-articles and latest-articles placeholder blocks
 * from /news-index.json (cached ~60 s) before the page is sent — the News list
 * (newest first, ?page=n), 3 related (same category / tag) and 5 latest (never
 * the article itself). No index → page unchanged (blocks fill themselves).
 *
 * COMMERCE: Shopify (Storefront API, products tagged `wknd-shop`) as separate
 * JSON APIs, each cached for its own time and refreshed only when its data
 * changes: /commerce/catalog.json, product/{sku}.json, prices.json,
 * inventory.json, products.json (all in one, the /data/products sheet shape),
 * POST /commerce/cart (priced live, private), reviews/{sku}.json and
 * ratings.json (Bazaarvoice format, mock from a sheet), cache-status.json and the
 * invalidate admin API. A Cron Trigger compares Shopify with the cache every
 * minute (scheduled). The Storefront token never leaves the worker.
 * Headers: x-commerce-cache HIT / MISS / BYPASS, x-commerce-version (= ETag).
 *
 * Environment variables:
 *   ORIGIN_HOSTNAME    main--eds-content-login--srinu3101.aem.live
 *   PUSH_INVALIDATION  disabled (workers.dev) | enabled (own domain + CDN config)
 *   ORIGIN_AUTHENTICATION  optional site token (secret)
 *   LOGIN_TEASER       optional fragment path, must start with /fragments/
 *   AUTH0_DOMAIN       Auth0 tenant domain, e.g. dev-abc123.us.auth0.com
 *   AUTH0_CLIENT_ID    Auth0 application Client ID
 *   AUTH0_CLIENT_SECRET  Auth0 application Client Secret (secret)
 *   SESSION_SECRET     long random string used to sign sessions (secret)
 *   SHOPIFY_STORE_DOMAIN      e.g. wknd-demo-430gsp3x.myshopify.com
 *   SHOPIFY_STOREFRONT_TOKEN  Storefront API public access token (secret)
 *   SHOPIFY_API_VERSION       optional, defaults to SHOPIFY_DEFAULT_VERSION
 *   CACHE_ADMIN_TOKEN         protects the commerce cache admin API (secret)
 *   BAZAARVOICE_PASSKEY       optional: real Bazaarvoice reviews (secret); without
 *                             it /commerce/reviews/* is a mock from /data/reviews
 *   BAZAARVOICE_ENVIRONMENT   optional: staging (default) | production
 *
 * Bindings (wrangler.toml):
 *   COMMERCE_CACHE            KV namespace for the commerce JSON cache
 */

'use strict';

const getExtension = (path) => {
  const basename = path.split('/').pop();
  const pos = basename.lastIndexOf('.');
  return (basename === '' || pos < 1) ? '' : basename.slice(pos + 1);
};

const isMediaRequest = (url) => /\/media_[0-9a-f]{40,}[/a-zA-Z0-9_-]*\.[0-9a-z]+$/.test(url.pathname);
const isRUMRequest = (url) => /\/\.(rum|optel)\/.*/.test(url.pathname);

/* ------------------------------------------------------------------ AUTH */

const SESSION_COOKIE = 'wknd-session';
const STATE_COOKIE = 'wknd-auth-state';
const RETURN_COOKIE = 'wknd-auth-return';
const SIGNED_IN_COOKIE = 'wknd-signed-in'; // UI hint only when AUTH is on
const SESSION_SECONDS = 8 * 60 * 60;
const STATE_SECONDS = 10 * 60;

const encoder = new TextEncoder();

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const decodeBase64url = (text) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

const nowSeconds = () => Math.floor(Date.now() / 1000);

const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
};

const safeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// "<base64url JSON>.<HMAC>", with an `exp` (seconds) inside the JSON
const signValue = async (secret, payload) => {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
};

const verifyValue = async (secret, value) => {
  const [body, signature] = (value || '').split('.');
  if (!body || !signature || !safeEqual(await hmac(secret, body), signature)) return null;
  try {
    const payload = JSON.parse(decodeBase64url(body));
    return payload.exp > nowSeconds() ? payload : null;
  } catch (e) {
    return null;
  }
};

const getCookie = (request, name) => {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
};

const cookieHeader = (name, value, maxAge, { httpOnly = true } = {}) => (
  `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}`
);

const authConfig = (env) => {
  if (!env.AUTH0_DOMAIN || !env.AUTH0_CLIENT_ID || !env.AUTH0_CLIENT_SECRET || !env.SESSION_SECRET) return null;
  return {
    domain: env.AUTH0_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    clientId: env.AUTH0_CLIENT_ID,
    clientSecret: env.AUTH0_CLIENT_SECRET,
    secret: env.SESSION_SECRET,
  };
};

// only same-site paths; anything else (//evil.example, https://…) → home
const safeReturnTo = (path) => (
  typeof path === 'string' && /^\/(?![/\\])/.test(path) && !path.startsWith('/auth/') ? path : '/'
);

const redirect = (location, cookies = []) => {
  const resp = new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
  cookies.forEach((c) => resp.headers.append('set-cookie', c));
  return resp;
};

const authError = (message, status = 401) => new Response(
  `<!doctype html><title>Sign-in problem</title><p>${message}</p><p><a href="/">Back to the site</a></p>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
);

const readIdToken = (idToken) => {
  try {
    return JSON.parse(decodeBase64url(idToken.split('.')[1]));
  } catch (e) {
    return null;
  }
};

const meResponse = (body) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
});

// GET /auth/me → who is signed in, read from the signed session on every call
// (blocks such as user-details ask this instead of trusting page markup)
const handleMe = async (request, env) => {
  const config = authConfig(env);
  if (!config) return meResponse({ signedIn: getCookie(request, SIGNED_IN_COOKIE) === 'true' });
  const session = await verifyValue(config.secret, getCookie(request, SESSION_COOKIE));
  if (!session) return meResponse({ signedIn: false });
  const {
    name = '', username = '', email = '', picture = '',
  } = session;
  return meResponse({
    signedIn: true, name, username, email, picture,
  });
};

const handleAuth = async (request, url, env) => {
  if (url.pathname === '/auth/me') return handleMe(request, env);
  const config = authConfig(env);
  if (!config) return new Response('Sign-in is not configured', { status: 404 });
  const origin = `${url.protocol}//${url.host}`;
  const callback = `${origin}/auth/callback`;

  // sign-up is the same flow; Auth0 just opens on its "create account" screen
  if (url.pathname === '/auth/login' || url.pathname === '/auth/signup') {
    const state = randomToken();
    const nonce = randomToken();
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
    const authorize = new URL(`https://${config.domain}/authorize`);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: callback,
      scope: 'openid profile email',
      state,
      nonce,
      // always ask for credentials, even if Auth0 still remembers the visitor
      prompt: 'login',
    });
    if (url.pathname === '/auth/signup') params.set('screen_hint', 'signup');
    authorize.search = params.toString();
    const pending = await signValue(config.secret, { state, nonce, returnTo, exp: nowSeconds() + STATE_SECONDS });
    return redirect(authorize.href, [cookieHeader(STATE_COOKIE, pending, STATE_SECONDS)]);
  }

  if (url.pathname === '/auth/callback') {
    const pending = await verifyValue(config.secret, getCookie(request, STATE_COOKIE));
    const clearState = cookieHeader(STATE_COOKIE, '', 0);
    if (url.searchParams.get('error')) {
      return authError(`Sign-in was cancelled or failed: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`.replace(/[<>&"]/g, ''));
    }
    if (!pending || pending.state !== url.searchParams.get('state')) {
      return authError('Your sign-in expired or was started in another tab. Please sign in again.', 400);
    }
    const tokenResp = await fetch(`https://${config.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: url.searchParams.get('code') || '',
        redirect_uri: callback,
      }),
    });
    if (!tokenResp.ok) return authError('Sign-in could not be completed. Please try again.');
    const { id_token: idToken } = await tokenResp.json();
    // the ID token came straight from Auth0's token endpoint over TLS
    // (OIDC Core 3.1.3.7), so checking its claims is sufficient here
    const claims = idToken && readIdToken(idToken);
    const audience = claims && [].concat(claims.aud);
    if (!claims
      || claims.iss !== `https://${config.domain}/`
      || !audience.includes(config.clientId)
      || !(claims.exp > nowSeconds())
      || claims.nonce !== pending.nonce) {
      return authError('Sign-in could not be verified. Please try again.');
    }
    const session = await signValue(config.secret, {
      sub: claims.sub,
      name: claims.name || claims.email || '',
      // profile shown by the user-details block through /auth/me
      username: claims.nickname || '',
      email: claims.email || '',
      picture: claims.picture || '',
      exp: nowSeconds() + SESSION_SECONDS,
    });
    return redirect(`${origin}${pending.returnTo}`, [
      clearState,
      cookieHeader(SESSION_COOKIE, session, SESSION_SECONDS),
      cookieHeader(SIGNED_IN_COOKIE, 'true', SESSION_SECONDS, { httpOnly: false }),
    ]);
  }

  if (url.pathname === '/auth/logout') {
    const logout = new URL(`https://${config.domain}/v2/logout`);
    logout.search = new URLSearchParams({ client_id: config.clientId, returnTo: `${origin}/auth/logged-out` }).toString();
    return redirect(logout.href, [
      cookieHeader(SESSION_COOKIE, '', 0),
      cookieHeader(SIGNED_IN_COOKIE, '', 0, { httpOnly: false }),
      cookieHeader(RETURN_COOKIE, encodeURIComponent(safeReturnTo(url.searchParams.get('returnTo'))), STATE_SECONDS),
    ]);
  }

  if (url.pathname === '/auth/logged-out') {
    const returnTo = safeReturnTo(decodeURIComponent(getCookie(request, RETURN_COOKIE) || '/'));
    return redirect(`${origin}${returnTo}`, [cookieHeader(RETURN_COOKIE, '', 0)]);
  }

  return new Response('Not Found', { status: 404 });
};

// signed in = valid Auth0 session; without AUTH configured, the demo cookie
const isSignedIn = async (request, env) => {
  const config = authConfig(env);
  if (!config) return getCookie(request, SIGNED_IN_COOKIE) === 'true';
  return !!(await verifyValue(config.secret, getCookie(request, SESSION_COOKIE)));
};

/* -------------------------------------------------------------- END AUTH */

/* -------------------------------------------------------------- COMMERCE */

const SHOPIFY_DEFAULT_VERSION = '2025-10';
const COMMERCE_CACHE_SECONDS = 60; // without the KV binding (BYPASS)
const SHOP_TAG = 'wknd-shop';
const MEMBER_PRICE_TAG = /^member-price-(\d+(?:\.\d+)?)$/i;

const PRODUCTS_QUERY = `query Products($cursor: String, $query: String) {
  products(first: 100, after: $cursor, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      handle title description productType tags
      featuredImage { url altText }
      images(first: 6) { nodes { url altText } }
      variants(first: 1) {
        nodes { id sku availableForSale quantityAvailable price { amount } }
      }
    }
  }
}`;

const commerceJson = (body, status = 200, maxAge = 0) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  },
});

const shopifyQuery = async (env, query, variables) => {
  const domain = env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const version = env.SHOPIFY_API_VERSION || SHOPIFY_DEFAULT_VERSION;
  const resp = await fetch(`https://${domain}/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-storefront-access-token': env.SHOPIFY_STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`Shopify answered ${resp.status}`);
  const json = await resp.json();
  if (json.errors) throw new Error(`Shopify query failed: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data;
};

const commerceConfigured = (env) => Boolean(
  env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_STOREFRONT_TOKEN,
);

// one Shopify product (first variant) → { sku, name, category, price, … }
const toShopProduct = (node) => {
  const variant = (node.variants && node.variants.nodes && node.variants.nodes[0]) || {};
  const memberTag = (node.tags || []).map((t) => t.trim()).find((t) => MEMBER_PRICE_TAG.test(t));
  let stock = '';
  if (typeof variant.quantityAvailable === 'number') stock = String(Math.max(0, variant.quantityAvailable));
  else if (variant.availableForSale === false) stock = '0';
  return {
    sku: variant.sku || node.handle,
    name: node.title,
    category: node.productType || '',
    price: variant.price ? String(Number(variant.price.amount)) : '',
    memberPrice: memberTag ? memberTag.match(MEMBER_PRICE_TAG)[1] : '',
    stock,
    image: node.featuredImage ? node.featuredImage.url : '',
    description: node.description || '',
    handle: node.handle,
    variantId: variant.id || '',
  };
};

// every shop product straight from Shopify (no cache)
const loadShopifyNodes = async (env) => {
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const data = await shopifyQuery(env, PRODUCTS_QUERY, { cursor, query: `tag:${SHOP_TAG}` });
    nodes.push(...data.products.nodes);
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return nodes;
};

/*
 * COMMERCE APIS — one Shopify read, split by how often the data changes, so a
 * change only clears the API it belongs to:
 *
 *   API                     contains                              kept in KV
 *   products.json           everything (older code, sheet shape)  1 day
 *   catalog.json            PLP list: sku, name, category, image  1 hour
 *   product/{sku}.json      PDP: description, photos, details     1 hour
 *   prices.json             price, member price                   15 minutes
 *   inventory.json          stock, available                      edge, 10 s
 *   cart (POST)             the visitor's cart priced live        never
 *
 * KV entries carry metadata { version, savedAt }; version is a hash of the
 * body (= ETag), so the same data always has the same version. Browsers
 * re-check every time (max-age=0 + ETag → 304), so a refreshed API shows at
 * once. inventory.json changes too often for KV writes: it is cached for 10 s
 * per data center (and per worker instance) instead.
 */
const VIEW_SECONDS = {
  products: 86400, catalog: 3600, product: 3600, prices: 900, reviews: 3600, ratings: 3600,
};
const INVENTORY_SECONDS = 10;
const PRODUCT_VIEW = /^product\/([A-Za-z0-9_-]+)\.json$/;
const STATUS_KEY = 'cache-status';

// 'product/CAMP-001.json' → 'product', 'prices.json' → 'prices'
const viewKind = (key) => key.split(/[/.]/)[0];

const sheet = (data) => JSON.stringify({
  total: data.length, offset: 0, limit: data.length, data, source: 'shopify',
});

// Shopify products → Map(key → JSON body) for every API
const buildViews = (nodes) => {
  const items = nodes.map((node) => ({ node, p: toShopProduct(node) }))
    .filter(({ p }) => p.sku && p.name && p.price);
  const list = items.map(({ p }) => p);
  const views = new Map();
  views.set('products.json', sheet(list));
  views.set('catalog.json', sheet(list.map(({
    sku, name, category, image, handle,
  }) => ({
    sku, name, category, image, handle,
  }))));
  views.set('prices.json', sheet(list.map(({ sku, price, memberPrice }) => ({ sku, price, memberPrice }))));
  views.set('inventory.json', sheet(list.map(({ sku, stock }) => ({ sku, stock, available: stock !== '0' }))));
  items.filter(({ p }) => PRODUCT_VIEW.test(`product/${p.sku}.json`)).forEach(({ node, p }) => {
    const images = ((node.images && node.images.nodes) || []).map((i) => ({ url: i.url, alt: i.altText || '' }));
    views.set(`product/${p.sku}.json`, JSON.stringify({
      sku: p.sku,
      name: p.name,
      category: p.category,
      description: p.description,
      image: p.image,
      images: images.length ? images : [{ url: p.image, alt: '' }].filter((i) => i.url),
      handle: p.handle,
      variantId: p.variantId,
      source: 'shopify',
    }));
  });
  return views;
};

const parseData = (body) => {
  try {
    return (JSON.parse(body).data || []);
  } catch (e) {
    return [];
  }
};

const contentVersion = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
};

const readStored = async (env, key) => {
  const stored = await env.COMMERCE_CACHE.getWithMetadata(key);
  if (stored && stored.value && stored.metadata && stored.metadata.version) {
    return { body: stored.value, ...stored.metadata };
  }
  return null;
};

// saves one API body in KV for its cache time → { body, version, savedAt }
const saveView = async (env, key, body) => {
  const entry = { body, version: await contentVersion(body), savedAt: new Date().toISOString() };
  await env.COMMERCE_CACHE.put(key, body, {
    expirationTtl: VIEW_SECONDS[viewKind(key)],
    metadata: { version: entry.version, savedAt: entry.savedAt },
  });
  return entry;
};

// readView loader for the Shopify APIs
const shopifyView = async (env, key) => buildViews(await loadShopifyNodes(env)).get(key);

// one API from KV, or loaded (Shopify by default) and saved → { entry, state } (null: unknown)
const readView = async (env, key, load = shopifyView) => {
  if (env.COMMERCE_CACHE) {
    try {
      const entry = await readStored(env, key);
      if (entry) return { entry, state: 'HIT' };
    } catch (e) {
      // KV unavailable → answer from Shopify below
    }
  }
  const body = await load(env, key);
  if (body === undefined || body === null) return null;
  if (env.COMMERCE_CACHE) {
    try {
      return { entry: await saveView(env, key, body), state: 'MISS' };
    } catch (e) {
      // KV write failed (e.g. daily write limit) → answer without saving
    }
  }
  return {
    entry: { body, version: await contentVersion(body), savedAt: new Date().toISOString() },
    state: 'BYPASS',
  };
};

const cachedJson = (request, entry, state, ttl) => {
  const etag = `"${entry.version}"`;
  const headers = {
    'content-type': 'application/json',
    'cache-control': state === 'BYPASS' ? `public, max-age=${COMMERCE_CACHE_SECONDS}` : 'public, max-age=0, must-revalidate',
    etag,
    'x-commerce-cache': state,
    'x-commerce-version': entry.version,
    'x-commerce-saved-at': entry.savedAt,
    'x-commerce-ttl': String(ttl),
  };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : entry.body, { headers });
};

const SKU_VIEW = /^(?:product|reviews)\/([A-Za-z0-9_-]+)\.json$/;

const handleView = async (request, env, key, load = shopifyView) => {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405 });
  if (!commerceConfigured(env)) return commerceJson({ error: 'Commerce is not configured' }, 404);
  try {
    // unknown SKU and a cached catalog → 404 without asking Shopify
    const sku = (key.match(SKU_VIEW) || [])[1];
    if (sku && env.COMMERCE_CACHE) {
      const catalog = await readStored(env, 'catalog.json').catch(() => null);
      if (catalog && !parseData(catalog.body).some((p) => p.sku === sku)) {
        return commerceJson({ error: 'Product not found' }, 404);
      }
    }
    const result = await readView(env, key, load);
    if (!result) return commerceJson({ error: 'Product not found' }, 404);
    return cachedJson(request, result.entry, result.state, VIEW_SECONDS[viewKind(key)]);
  } catch (e) {
    return commerceJson({ error: `${key} could not be loaded` }, 502);
  }
};

// inventory.json: 10 s per worker instance and per data center (no KV writes)
let inventoryMemory = null; // { body, version, savedAt, at }

const readInventory = async (env) => {
  if (inventoryMemory && Date.now() - inventoryMemory.at < INVENTORY_SECONDS * 1000) {
    return { entry: inventoryMemory, state: 'HIT' };
  }
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = 'https://commerce.cache/inventory.json';
  const cached = cache && await cache.match(cacheKey).catch(() => null);
  if (cached) {
    const body = await cached.text();
    const savedAt = cached.headers.get('x-commerce-saved-at') || new Date().toISOString();
    inventoryMemory = {
      body, version: await contentVersion(body), savedAt, at: Date.parse(savedAt) || Date.now(),
    };
    return { entry: inventoryMemory, state: 'HIT' };
  }
  const body = buildViews(await loadShopifyNodes(env)).get('inventory.json');
  const savedAt = new Date().toISOString();
  inventoryMemory = {
    body, version: await contentVersion(body), savedAt, at: Date.now(),
  };
  if (cache) {
    await cache.put(cacheKey, new Response(body, {
      headers: { 'cache-control': `max-age=${INVENTORY_SECONDS}`, 'x-commerce-saved-at': savedAt },
    })).catch(() => {});
  }
  return { entry: inventoryMemory, state: 'MISS' };
};

const handleInventory = async (request, env) => {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405 });
  if (!commerceConfigured(env)) return commerceJson({ error: 'Commerce is not configured' }, 404);
  try {
    const { entry, state } = await readInventory(env);
    const resp = cachedJson(request, entry, state, INVENTORY_SECONDS);
    if (resp.status === 200) resp.headers.set('cache-control', `public, max-age=${INVENTORY_SECONDS}`);
    return resp;
  } catch (e) {
    return commerceJson({ error: 'Stock could not be loaded from Shopify' }, 502);
  }
};

/*
 * CART API: POST /commerce/cart { "items": [{ "sku": "CAMP-001", "qty": 2 }] }
 * prices the visitor's cart (kept in their browser) with live prices
 * (prices.json), the member price when signed in, and live stock
 * (inventory.json): unknown or sold-out products are removed, quantities are
 * capped at the stock. Private, never cached.
 */
const CART_MAX_QTY = 10;
const CART_MAX_LINES = 50;
const FREE_SHIPPING_FROM = 200;
const SHIPPING_COST = 10;

const privateJson = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
});

const handleCart = async (request, env) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  if (!commerceConfigured(env)) return commerceJson({ error: 'Commerce is not configured' }, 404);
  let items;
  try {
    ({ items } = await request.json());
  } catch (e) {
    items = null;
  }
  if (!Array.isArray(items)) return privateJson({ error: 'Send { "items": [{ "sku": "…", "qty": 1 }] }' }, 400);

  // same SKU twice → one line
  const wanted = new Map();
  items.slice(0, CART_MAX_LINES).forEach((item) => {
    const sku = item && typeof item.sku === 'string' ? item.sku.trim() : '';
    const qty = Math.floor(Number(item && item.qty) || 0);
    if (sku && qty > 0) wanted.set(sku, (wanted.get(sku) || 0) + qty);
  });

  try {
    const [prices, inventory, member] = await Promise.all([
      readView(env, 'prices.json'), readInventory(env), isSignedIn(request, env),
    ]);
    const priceBySku = new Map(parseData(prices.entry.body).map((p) => [p.sku, p]));
    const stockBySku = new Map(parseData(inventory.entry.body).map((p) => [p.sku, p]));
    const lines = [];
    const removed = [];
    const adjusted = [];
    wanted.forEach((requested, sku) => {
      const p = priceBySku.get(sku);
      if (!p) {
        removed.push({ sku, reason: 'not available' });
        return;
      }
      const stockText = (stockBySku.get(sku) || {}).stock;
      const stock = stockText === '' || stockText === undefined ? CART_MAX_QTY : Number(stockText);
      const max = Math.min(stock, CART_MAX_QTY);
      if (max <= 0) {
        removed.push({ sku, reason: 'out of stock' });
        return;
      }
      const qty = Math.min(requested, max);
      if (qty < requested) {
        const reason = stock < CART_MAX_QTY ? `only ${stock} left` : `at most ${CART_MAX_QTY}`;
        adjusted.push({
          sku, requested, qty, reason,
        });
      }
      const price = Number(p.price);
      const memberPrice = p.memberPrice === '' ? null : Number(p.memberPrice);
      const unit = member && memberPrice !== null ? memberPrice : price;
      lines.push({
        sku, qty, unit, price, memberPrice, total: unit * qty, regular: price * qty, max,
      });
    });
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    const regular = lines.reduce((s, l) => s + l.regular, 0);
    const shipping = !lines.length || subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_COST;
    return privateJson({
      lines,
      removed,
      adjusted,
      count: lines.reduce((n, l) => n + l.qty, 0),
      subtotal,
      regular,
      savings: regular - subtotal,
      shipping,
      total: subtotal + shipping,
      currency: 'USD',
      member,
      pricedAt: new Date().toISOString(),
    });
  } catch (e) {
    return privateJson({ error: 'The cart could not be priced right now' }, 502);
  }
};

/*
 * REVIEWS (Bazaarvoice) — customer reviews and ratings in the Bazaarvoice
 * Conversations API format, cached and watched like the product APIs:
 *
 *   GET  /commerce/reviews/{sku}.json  one product's reviews + statistics   KV, 1 hour
 *   GET  /commerce/ratings.json        stars + review count, every product   KV, 1 hour
 *   POST /commerce/reviews/{sku}.json  write a review (→ "awaiting moderation")
 *
 * Source: with BAZAARVOICE_PASSKEY (secret) the real Bazaarvoice API
 * (BAZAARVOICE_ENVIRONMENT staging | production) — not tried yet, no
 * Bazaarvoice account. Without it a MOCK BAZAARVOICE: approved rows of the
 * /data/reviews sheet (SKU, Rating, Title, Review, Name, Location, Date,
 * Recommended, Status) answered in the same format, so the blocks don't care
 * which one is used. Submitted reviews are checked but never saved (a real
 * Bazaarvoice moderates first); add a row to the sheet to "approve" one.
 */
const REVIEWS_VIEW = /^reviews\/([A-Za-z0-9_-]+)\.json$/;
const REVIEWS_SHEET = '/data/reviews.json';
const REVIEW_STATUS_KEY = 'cache-status-reviews';
const REVIEWS_LIMIT = 100;
const BV_API_VERSION = '5.4';

const realBazaarvoice = (env) => Boolean(env.BAZAARVOICE_PASSKEY);
const reviewsSource = (env) => (realBazaarvoice(env) ? 'bazaarvoice' : 'mock-bazaarvoice');

const bvHost = (env) => (env.BAZAARVOICE_ENVIRONMENT === 'production'
  ? 'api.bazaarvoice.com' : 'stg.api.bazaarvoice.com');

const bvQuery = async (env, endpoint, params) => {
  const url = new URL(`https://${bvHost(env)}/data/${endpoint}`);
  url.searchParams.set('apiversion', BV_API_VERSION);
  url.searchParams.set('passkey', env.BAZAARVOICE_PASSKEY);
  params.forEach(([k, v]) => url.searchParams.append(k, v));
  const resp = await fetch(url.href);
  if (!resp.ok) throw new Error(`Bazaarvoice answered ${resp.status}`);
  const json = await resp.json();
  if (json.HasErrors) throw new Error('Bazaarvoice returned errors');
  return json;
};

// sheet cell by column name, any case / spacing ("Review Text" = "reviewtext")
const cell = (row, ...names) => {
  const key = Object.keys(row).find((k) => names.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
  return key === undefined ? '' : String(row[key] ?? '').trim();
};

// "2026-11-10" or a spreadsheet day number → BV SubmissionTime
const submissionTime = (value) => {
  let date = /^\d{5}$/.test(value) ? new Date(Date.UTC(1899, 11, 30) + Number(value) * 86400000) : new Date(value);
  if (Number.isNaN(date.getTime())) date = new Date(0);
  return `${date.toISOString().slice(0, 23)}+00:00`;
};

const loadReviewRows = async (env) => {
  const headers = {};
  if (env.ORIGIN_AUTHENTICATION) headers.authorization = `token ${env.ORIGIN_AUTHENTICATION}`;
  const resp = await fetch(`https://${env.ORIGIN_HOSTNAME}${REVIEWS_SHEET}?limit=5000`, { headers });
  if (resp.status === 404) return []; // no sheet yet → no reviews
  if (!resp.ok) throw new Error(`reviews sheet answered ${resp.status}`);
  const json = await resp.json();
  if (Array.isArray(json.data)) return json.data;
  const first = json[':names'] && json[json[':names'][0]];
  return (first && Array.isArray(first.data)) ? first.data : [];
};

// sheet rows → { sku: [BV review, …] } (approved, valid rows only, newest first)
const mockReviews = (rows, skus) => {
  const wanted = new Set(skus);
  const bySku = {};
  rows.forEach((row) => {
    const sku = cell(row, 'sku', 'productid', 'product');
    const rating = Math.round(Number(cell(row, 'rating', 'stars')));
    const text = cell(row, 'review', 'reviewtext', 'text');
    const status = cell(row, 'status');
    if (!wanted.has(sku) || !(rating >= 1 && rating <= 5) || !text) return;
    if (status && !/^approved$/i.test(status)) return;
    const recommended = cell(row, 'recommended');
    let isRecommended = null;
    if (/^(yes|y|true|1)$/i.test(recommended)) isRecommended = true;
    else if (/^(no|n|false|0)$/i.test(recommended)) isRecommended = false;
    (bySku[sku] = bySku[sku] || []).push({
      ProductId: sku,
      Rating: rating,
      RatingRange: 5,
      Title: cell(row, 'title').slice(0, 200),
      ReviewText: text.slice(0, 5000),
      UserNickname: cell(row, 'name', 'nickname', 'usernickname').slice(0, 50) || 'Anonymous',
      UserLocation: cell(row, 'location', 'userlocation').slice(0, 100) || null,
      SubmissionTime: submissionTime(cell(row, 'date', 'submissiontime')),
      IsRecommended: isRecommended,
      ModerationStatus: 'APPROVED',
      TotalPositiveFeedbackCount: Math.max(0, Math.floor(Number(cell(row, 'helpful')) || 0)),
    });
  });
  Object.values(bySku).forEach((list) => {
    list.sort((a, b) => b.SubmissionTime.localeCompare(a.SubmissionTime));
    list.forEach((r, i) => { r.Id = `${r.ProductId}-${list.length - i}`; }); // oldest = 1
  });
  return bySku;
};

// BV ReviewStatistics for a list of reviews
const reviewStatistics = (list) => {
  const total = list.length;
  const counts = [5, 4, 3, 2, 1].map((v) => ({
    RatingValue: v, Count: list.filter((r) => r.Rating === v).length,
  }));
  const times = list.map((r) => r.SubmissionTime).sort();
  const sum = list.reduce((s, r) => s + r.Rating, 0);
  return {
    TotalReviewCount: total,
    AverageOverallRating: total ? Math.round((sum / total) * 100) / 100 : null,
    OverallRatingRange: 5,
    RatingDistribution: counts.filter((c) => c.Count > 0),
    RecommendedCount: list.filter((r) => r.IsRecommended === true).length,
    NotRecommendedCount: list.filter((r) => r.IsRecommended === false).length,
    FirstSubmissionTime: times[0] || null,
    LastSubmissionTime: times[times.length - 1] || null,
  };
};

const bvReviewsBody = (sku, list, source) => JSON.stringify({
  HasErrors: false,
  Errors: [],
  Locale: 'en_US',
  Offset: 0,
  Limit: REVIEWS_LIMIT,
  TotalResults: list.length,
  Results: list.slice(0, REVIEWS_LIMIT),
  Includes: {
    Products: { [sku]: { Id: sku, ReviewStatistics: reviewStatistics(list) } },
    ProductsOrder: [sku],
  },
  source,
});

const bvRatingsBody = (stats, source) => JSON.stringify({
  HasErrors: false,
  Errors: [],
  Locale: 'en_US',
  Offset: 0,
  Limit: stats.length,
  TotalResults: stats.length,
  Results: stats.map(({ sku, s }) => ({
    ProductStatistics: {
      ProductId: sku,
      ReviewStatistics: {
        AverageOverallRating: s.AverageOverallRating,
        TotalReviewCount: s.TotalReviewCount,
        OverallRatingRange: 5,
      },
    },
  })),
  source,
});

// ratings.json body → [{ sku, average, count }]
const parseRatings = (body) => {
  try {
    return (JSON.parse(body).Results || []).map((r) => r.ProductStatistics || {}).map((p) => ({
      sku: p.ProductId,
      average: (p.ReviewStatistics || {}).AverageOverallRating ?? null,
      count: (p.ReviewStatistics || {}).TotalReviewCount || 0,
    })).filter((r) => r.sku);
  } catch (e) {
    return [];
  }
};

// Map(key → body): reviews/{sku}.json for every SKU (+ ratings.json)
const buildReviewViews = async (env, skus, { ratings = true } = {}) => {
  const views = new Map();
  const source = reviewsSource(env);
  if (realBazaarvoice(env)) {
    await Promise.all(skus.map(async (sku) => {
      const json = await bvQuery(env, 'reviews.json', [
        ['Filter', `ProductId:${sku}`], ['Include', 'Products'], ['Stats', 'Reviews'],
        ['Sort', 'SubmissionTime:desc'], ['Limit', String(REVIEWS_LIMIT)],
      ]);
      views.set(`reviews/${sku}.json`, JSON.stringify({ ...json, source }));
    }));
    if (ratings && skus.length) {
      const json = await bvQuery(env, 'statistics.json', [
        ['Filter', `ProductId:${skus.slice(0, 100).join(',')}`], ['Stats', 'Reviews'],
      ]);
      views.set('ratings.json', JSON.stringify({ ...json, source }));
    } else if (ratings) views.set('ratings.json', bvRatingsBody([], source));
    return views;
  }
  const bySku = mockReviews(await loadReviewRows(env), skus);
  skus.forEach((sku) => views.set(`reviews/${sku}.json`, bvReviewsBody(sku, bySku[sku] || [], source)));
  if (ratings) {
    views.set('ratings.json', bvRatingsBody(skus.map((sku) => ({ sku, s: reviewStatistics(bySku[sku] || []) })), source));
  }
  return views;
};

const catalogSkus = async (env) => {
  const result = await readView(env, 'catalog.json');
  return result ? parseData(result.entry.body).map((p) => p.sku) : [];
};

// readView loader for reviews/{sku}.json and ratings.json
const reviewView = async (env, key) => {
  const sku = (key.match(REVIEWS_VIEW) || [])[1];
  if (sku) return (await buildReviewViews(env, [sku], { ratings: false })).get(key);
  return (await buildReviewViews(env, await catalogSkus(env))).get(key);
};

/*
 * Write a review: POST /commerce/reviews/{sku}.json
 *   { "rating": 1-5, "title": "…", "text": "…", "name": "…", "recommended": true }
 * Answers like Bazaarvoice's submitreview.json: FormErrors on bad input,
 * otherwise a SubmissionId and "awaiting moderation". Nothing is stored.
 */
const REVIEW_TEXT_MIN = 20;

const handleReviewSubmit = async (request, env, sku) => {
  if (!commerceConfigured(env)) return commerceJson({ error: 'Commerce is not configured' }, 404);
  if (realBazaarvoice(env)) {
    return privateJson({ HasErrors: true, Errors: [{ Code: 'ERROR_NOT_IMPLEMENTED', Message: 'Use the Bazaarvoice submission form' }] }, 501);
  }
  let input = {};
  try {
    const text = await request.text();
    if (text.length > 20000) return privateJson({ HasErrors: true, Errors: [{ Code: 'ERROR_REQUEST_LIMIT', Message: 'Too long' }] }, 413);
    input = JSON.parse(text || '{}') || {};
  } catch (e) {
    return privateJson({ HasErrors: true, Errors: [{ Code: 'ERROR_PARAM_INVALID', Message: 'Send JSON' }] }, 400);
  }
  const skus = await catalogSkus(env).catch(() => null);
  if (skus && !skus.includes(sku)) return commerceJson({ error: 'Product not found' }, 404);

  const rating = Number(input.rating);
  const title = String(input.title || '').trim();
  const reviewText = String(input.text || '').trim();
  const name = String(input.name || '').trim();
  const fieldErrors = {};
  const fail = (field, code, message) => {
    fieldErrors[field] = { Field: field, Code: code, Message: message };
  };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) fail('rating', 'ERROR_FORM_REQUIRED', 'Choose 1 to 5 stars');
  if (!title) fail('title', 'ERROR_FORM_REQUIRED', 'Add a title');
  else if (title.length > 100) fail('title', 'ERROR_FORM_TOO_HIGH', 'Title: at most 100 characters');
  if (reviewText.length < REVIEW_TEXT_MIN) fail('reviewtext', 'ERROR_FORM_TOO_LOW', `Review: at least ${REVIEW_TEXT_MIN} characters`);
  else if (reviewText.length > 5000) fail('reviewtext', 'ERROR_FORM_TOO_HIGH', 'Review: at most 5,000 characters');
  if (name.length < 2) fail('usernickname', 'ERROR_FORM_TOO_LOW', 'Name: at least 2 characters');
  else if (name.length > 25) fail('usernickname', 'ERROR_FORM_TOO_HIGH', 'Name: at most 25 characters');

  if (Object.keys(fieldErrors).length) {
    return privateJson({
      HasErrors: true, Errors: [], FormErrors: { FieldErrors: fieldErrors }, source: 'mock-bazaarvoice',
    }, 400);
  }
  return privateJson({
    HasErrors: false,
    Errors: [],
    FormErrors: {},
    SubmissionId: `mock-${randomToken().slice(0, 12)}`,
    TypicalHoursToPost: 72,
    Review: { Id: null, ProductId: sku, ModerationStatus: 'SUBMITTED' },
    message: 'Thanks! Your review is waiting for moderation.',
    source: 'mock-bazaarvoice',
  });
};

// "4.5★ (2)" — for the change record
const ratingText = (r) => (r && r.count ? `${r.average}★ (${r.count})` : 'no reviews');

const describeRatingChanges = (oldBody, newBody) => {
  const before = new Map(parseRatings(oldBody).map((r) => [r.sku, r]));
  return parseRatings(newBody)
    .filter((r) => ratingText(before.get(r.sku)) !== ratingText(r))
    .map((r) => ({
      sku: r.sku, change: 'reviews', from: ratingText(before.get(r.sku)), to: ratingText(r),
    }))
    .slice(0, 50);
};

/*
 * CHANGE WATCHER (Cron Trigger, wrangler.toml): every minute the worker reads
 * Shopify once, builds every API and compares each version with KV. Only the
 * APIs whose data changed are replaced (invalidate + refill, so visitors never
 * wait for Shopify); a product that left the shop loses its product/{sku}.json.
 * Unchanged → nothing is written (KV free plan: 1,000 writes a day), except a
 * refill shortly before an entry would expire or after it expired.
 */
const REFILL_BEFORE_SECONDS = 120;
const PRODUCT_FIELDS = ['name', 'category', 'price', 'memberPrice', 'stock', 'image', 'description'];

// what changed between two products.json bodies, e.g. "CAMP-001 price 389 → 369"
const describeChanges = (oldBody, newBody) => {
  const before = new Map(parseData(oldBody).map((p) => [p.sku, p]));
  const after = new Map(parseData(newBody).map((p) => [p.sku, p]));
  const changes = [];
  after.forEach((p, sku) => {
    const old = before.get(sku);
    if (!old) {
      changes.push({ sku, change: 'added' });
      return;
    }
    PRODUCT_FIELDS.filter((f) => String(old[f] ?? '') !== String(p[f] ?? '')).forEach((field) => {
      const short = !['image', 'description'].includes(field);
      changes.push({
        sku, change: field, ...(short ? { from: old[field] ?? '', to: p[field] ?? '' } : {}),
      });
    });
  });
  before.forEach((p, sku) => { if (!after.has(sku)) changes.push({ sku, change: 'removed' }); });
  return changes.slice(0, 50);
};

// writes the views whose data changed; deletes the stale keys (from the old copies)
const syncViews = async (env, views, staleKeys = () => []) => {
  const keys = [...views.keys()];
  const stored = await Promise.all(keys.map((key) => readStored(env, key).catch(() => null)));
  const old = new Map(keys.map((key, i) => [key, stored[i]]));
  const refreshed = [];
  const filled = [];
  await Promise.all(keys.map(async (key) => {
    const body = views.get(key);
    const before = old.get(key);
    const version = await contentVersion(body);
    if (before && before.version === version) {
      const age = (Date.now() - Date.parse(before.savedAt)) / 1000;
      if (age < VIEW_SECONDS[viewKind(key)] - REFILL_BEFORE_SECONDS) return;
      await saveView(env, key, body); // same data, refilled before it expires
      filled.push(key);
      return;
    }
    await saveView(env, key, body);
    if (before) refreshed.push({ api: key, from: before.version, to: version });
    else filled.push(key);
  }));
  const removed = staleKeys(old).filter((key) => !views.has(key));
  await Promise.all(removed.map((key) => env.COMMERCE_CACHE.delete(key)));
  refreshed.sort((x, y) => x.api.localeCompare(y.api));
  return {
    old, refreshed, removed, filled: filled.sort(),
  };
};

const syncResult = ({ refreshed, removed, filled }) => ({
  checked: true,
  changed: refreshed.length > 0 || removed.length > 0,
  refreshed,
  removed,
  filled,
});

const checkCommerce = async (env, trigger = 'watcher') => {
  if (!env.COMMERCE_CACHE || !commerceConfigured(env)) return { checked: false };
  const views = buildViews(await loadShopifyNodes(env));
  views.delete('inventory.json'); // edge-cached for 10 s, not kept in KV
  // products that left the shop lose their product/{sku}.json
  const result = await syncViews(env, views, (old) => {
    const products = old.get('products.json');
    return products ? parseData(products.body).map((p) => `product/${p.sku}.json`) : [];
  });
  if (result.refreshed.length || result.removed.length) {
    const products = result.old.get('products.json');
    await env.COMMERCE_CACHE.put(STATUS_KEY, JSON.stringify({
      changedAt: new Date().toISOString(),
      trigger,
      refreshed: result.refreshed,
      removed: result.removed,
      changes: products ? describeChanges(products.body, views.get('products.json')) : [],
    }));
  }
  return syncResult(result);
};

// reviews watcher: the sheet (or Bazaarvoice) for every catalog SKU
const checkReviews = async (env, trigger = 'watcher') => {
  if (!env.COMMERCE_CACHE || !commerceConfigured(env)) return { checked: false };
  const views = await buildReviewViews(env, await catalogSkus(env));
  const result = await syncViews(env, views, (old) => {
    const ratings = old.get('ratings.json');
    return ratings ? parseRatings(ratings.body).map((r) => `reviews/${r.sku}.json`) : [];
  });
  if (result.refreshed.length || result.removed.length) {
    const ratings = result.old.get('ratings.json');
    await env.COMMERCE_CACHE.put(REVIEW_STATUS_KEY, JSON.stringify({
      changedAt: new Date().toISOString(),
      trigger,
      source: reviewsSource(env),
      refreshed: result.refreshed,
      removed: result.removed,
      changes: ratings ? describeRatingChanges(ratings.body, views.get('ratings.json')) : [],
    }));
  }
  return syncResult(result);
};

const describeSeconds = (s) => {
  if (s >= 3600) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  if (s >= 60) return `${s / 60} minutes`;
  return `${s} seconds`;
};

// the API keys known now: fixed ones + product/{sku}.json from the catalog
const knownKeys = async (env) => {
  const catalog = await readStored(env, 'catalog.json').catch(() => null)
    || await readStored(env, 'products.json').catch(() => null);
  const skus = catalog ? parseData(catalog.body).map((p) => p.sku) : [];
  return [
    'products.json', 'catalog.json', 'prices.json', 'ratings.json',
    ...skus.map((sku) => `product/${sku}.json`), ...skus.map((sku) => `reviews/${sku}.json`),
  ];
};

// GET /commerce/cache-status.json — every API: version, age, cache time; last change
const handleCacheStatus = async (env) => {
  if (!env.COMMERCE_CACHE) return commerceJson({ cache: 'none' });
  const keys = await knownKeys(env);
  const [entries, lastChange, lastReviewChange] = await Promise.all([
    Promise.all(keys.map((key) => readStored(env, key).catch(() => null))),
    env.COMMERCE_CACHE.get(STATUS_KEY, { type: 'json' }),
    env.COMMERCE_CACHE.get(REVIEW_STATUS_KEY, { type: 'json' }),
  ]);
  const count = (key, body) => {
    if (['products', 'catalog', 'prices'].includes(viewKind(key))) return { count: parseData(body).length };
    if (key === 'ratings.json') return { count: parseRatings(body).length };
    if (REVIEWS_VIEW.test(key)) {
      try {
        return { reviews: JSON.parse(body).TotalResults };
      } catch (e) {
        return {};
      }
    }
    return {};
  };
  const apis = {};
  keys.forEach((key, i) => {
    const e = entries[i];
    apis[key] = {
      keptFor: describeSeconds(VIEW_SECONDS[viewKind(key)]),
      ...(e ? {
        version: e.version,
        savedAt: e.savedAt,
        ageSeconds: Math.round((Date.now() - Date.parse(e.savedAt)) / 1000),
        ...count(key, e.body),
      } : { cached: false }),
    };
  });
  apis['inventory.json'] = { keptFor: `${describeSeconds(INVENTORY_SECONDS)} (edge, per data center)` };
  apis.cart = { keptFor: 'never (private)' };
  return commerceJson({
    cache: 'kv',
    watcher: 'checks Shopify and the reviews every minute',
    reviewsSource: reviewsSource(env),
    apis,
    lastChange: lastChange || null,
    lastReviewChange: lastReviewChange || null,
  });
};

/*
 * CACHE ADMIN API: POST /commerce/invalidate with
 *   Authorization: Bearer <CACHE_ADMIN_TOKEN>
 * body (optional JSON) { "mode": "refresh" | "clear", "api": "all" | "<api>" }
 *   refresh (default) — check Shopify now, replace every API that changed
 *   clear             — delete the cached copy of one API (e.g. prices.json,
 *                       product/CAMP-001.json) or all; the next visitor or the
 *                       watcher reloads it
 * For manual clearing, Shopify webhooks or an Adobe I/O action. Without the
 * secret the API is off (404).
 */
const CLEARABLE = /^(products|catalog|prices|ratings)\.json$|^(product|reviews)\/[A-Za-z0-9_-]+\.json$/;

const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const isCacheAdmin = async (request, env) => {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  // compare fixed-length hashes, so neither the value nor its length leaks
  return safeEqual(await sha256Hex(match[1].trim()), await sha256Hex(env.CACHE_ADMIN_TOKEN));
};

const handleInvalidate = async (request, env) => {
  if (!env.CACHE_ADMIN_TOKEN || !env.COMMERCE_CACHE) return commerceJson({ error: 'Not Found' }, 404);
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  if (!(await isCacheAdmin(request, env))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer', 'cache-control': 'no-store' },
    });
  }
  let mode = 'refresh';
  let api = 'all';
  try {
    const body = await request.json();
    if (body && body.mode) mode = String(body.mode);
    if (body && body.api) api = String(body.api);
  } catch (e) {
    // no / invalid body → refresh all
  }
  if (!['refresh', 'clear'].includes(mode)) return commerceJson({ error: 'mode must be refresh or clear' }, 400);
  if (api !== 'all' && !CLEARABLE.test(api)) {
    return commerceJson({ error: 'api must be all, products.json, catalog.json, prices.json, ratings.json, product/{sku}.json or reviews/{sku}.json (inventory.json refreshes itself every 10 s)' }, 400);
  }

  if (mode === 'clear') {
    const keys = api === 'all' ? await knownKeys(env) : [api];
    await Promise.all(keys.map((key) => env.COMMERCE_CACHE.delete(key)));
    const at = new Date().toISOString();
    await env.COMMERCE_CACHE.put(STATUS_KEY, JSON.stringify({
      changedAt: at, trigger: 'manual clear', refreshed: [], removed: [], cleared: keys, changes: [],
    }));
    return commerceJson({
      mode, cleared: keys, at,
    });
  }
  try {
    const commerce = await checkCommerce(env, 'manual refresh');
    const reviewsResult = await checkReviews(env, 'manual refresh');
    return commerceJson({ mode, ...commerce, reviews: reviewsResult });
  } catch (e) {
    return commerceJson({ mode, error: 'Shopify could not be reached; cached copies kept' }, 502);
  }
};

// every /commerce/* route
const handleCommerce = (request, url, env) => {
  const path = url.pathname.slice('/commerce/'.length);
  if (['products.json', 'catalog.json', 'prices.json'].includes(path)) return handleView(request, env, path);
  if (PRODUCT_VIEW.test(path)) return handleView(request, env, path);
  if (REVIEWS_VIEW.test(path)) {
    if (request.method === 'POST') return handleReviewSubmit(request, env, path.match(REVIEWS_VIEW)[1]);
    return handleView(request, env, path, reviewView);
  }
  if (path === 'ratings.json') return handleView(request, env, path, reviewView);
  if (path === 'inventory.json') return handleInventory(request, env);
  if (path === 'cart') return handleCart(request, env);
  if (path === 'cache-status.json') return handleCacheStatus(env);
  if (path === 'invalidate') return handleInvalidate(request, env);
  return commerceJson({ error: 'Not Found' }, 404);
};

/* ---------------------------------------------------------- END COMMERCE */

/* ---------------------------------------------------------- LOCKED PAGES */

// Whole documents only signed-in visitors may open: /premium/… (premium
// content the user-details block loads after sign-in) and /members/… (pages
// behind login, e.g. /members/trips, /members/profile). Anonymous visitors
// never reach the origin.
const LOCKED_FOLDERS = ['/premium', '/members'];

const isLockedPath = (path) => LOCKED_FOLDERS
  .some((folder) => path === folder || path.startsWith(`${folder}/`));

// anonymous: a page opened directly → sign in first, then back to the page;
// anything else (.plain.html, images, …) → 401
const lockedResponse = (url) => {
  const extension = getExtension(url.pathname);
  if ((extension === '' || extension === 'html') && !url.pathname.endsWith('.plain.html')) {
    return redirect(`/auth/login?returnTo=${encodeURIComponent(url.pathname)}`);
  }
  return new Response('Sign in to see this content', {
    status: 401,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
  });
};

// a signed-in visitor's copy must never be cached for anyone else
const makePrivate = (resp) => {
  resp.headers.set('cache-control', 'private, no-store');
  resp.headers.append('vary', 'Cookie');
  resp.headers.delete('etag');
  resp.headers.delete('last-modified');
  return resp;
};

/* ------------------------------------------------------ END LOCKED PAGES */

/* ---------------------------------------------------------------- GATING */

// cheap pre-check: pages without any audience marker pass through untouched.
// Only markup counts (attributes / classes), not the words in page text.
const GATING_MARKERS = /\sdata-view="|\sclass="[^"]*\b(logged-in|logged-out|gated-content)\b/i;
const PUBLIC_ROW = 'public content';

// pages are extensionless; their raw content is /page.plain.html
const isPageRequest = (extension) => extension === '' || extension === 'html';

// same normalisation as toClassName in scripts/aem.js ("Logged In" → "logged-in")
const toClassName = (name) => name.toLowerCase()
  .replace(/[^0-9a-z]/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

const getAttribute = (openTag, name) => {
  const match = openTag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
};

const textOf = (html) => html
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// index just past the </div> closing the <div> that opens at `start`
const findDivEnd = (html, start) => {
  const tag = /<div\b[^>]*>|<\/div>/gi;
  tag.lastIndex = start;
  let depth = 0;
  let match = tag.exec(html);
  while (match) {
    depth += match[0][1] === '/' ? -1 : 1;
    if (depth === 0) return tag.lastIndex;
    match = tag.exec(html);
  }
  return html.length;
};

// [start, end) ranges of the direct child <div>s between `from` and `to`
const childDivs = (html, from, to) => {
  const children = [];
  let start = html.indexOf('<div', from);
  while (start > -1 && start < to) {
    const end = findDivEnd(html, start);
    children.push([start, end]);
    start = html.indexOf('<div', end);
  }
  return children;
};

// gated-content block for an anonymous visitor: keep only "Public Content"
// rows (mirrors blocks/gated-content: unlabelled rows count as premium)
const keepPublicRows = (block) => {
  const innerStart = block.indexOf('>') + 1;
  const innerEnd = block.lastIndexOf('</div>');
  const rows = childDivs(block, innerStart, innerEnd).filter(([start, end]) => {
    const cells = childDivs(block, block.indexOf('>', start) + 1, end);
    return cells.length > 1 && textOf(block.slice(...cells[0])) === PUBLIC_ROW;
  });
  return block.slice(0, innerStart)
    + rows.map(([start, end]) => block.slice(start, end)).join('')
    + block.slice(innerEnd);
};

const gateHtml = (html, signedIn, teaserPath) => {
  const hiddenView = signedIn ? 'logged-out' : 'logged-in';
  const teaser = !signedIn && teaserPath
    ? `<div><p><a href="${teaserPath}">${teaserPath}</a></p></div>`
    : '';
  let teaserAdded = false;
  let out = '';
  let pos = 0;
  const openTag = /<div\b[^>]*>/gi;
  let match = openTag.exec(html);
  while (match) {
    const tag = match[0];
    const start = match.index;
    const view = getAttribute(tag, 'data-view');
    const classes = (getAttribute(tag, 'class') || '').split(/\s+/);

    if ((view && toClassName(view) === hiddenView) || classes.includes(hiddenView)) {
      const end = findDivEnd(html, start);
      out += html.slice(pos, start);
      if (view && teaser && !teaserAdded) {
        out += teaser;
        teaserAdded = true;
      }
      pos = end;
      openTag.lastIndex = end;
    } else if (!signedIn && classes[0] === 'gated-content') {
      const end = findDivEnd(html, start);
      out += html.slice(pos, start) + keepPublicRows(html.slice(start, end));
      pos = end;
      openTag.lastIndex = end;
    }
    match = openTag.exec(html);
  }
  return out + html.slice(pos);
};

// LOCKED ORIGIN: indexes (e.g. query-index.json) hold absolute origin URLs
// such as image links. With site authentication on, the browser can't load
// those directly — point them at this worker instead.
const rewriteOriginUrls = async (request, resp, env, extension) => {
  if (extension !== 'json' || resp.status !== 200) return resp;
  const origin = `https://${env.ORIGIN_HOSTNAME}`;
  const json = await resp.text();
  if (!json.includes(origin)) return new Response(json, resp);
  const self = new URL(request.url).origin;
  const out = new Response(json.split(origin).join(self), resp);
  out.headers.delete('content-length');
  out.headers.delete('etag');
  return out;
};

const applyGating = async (request, resp, env, extension) => {
  if (!isPageRequest(extension) || resp.status !== 200) return resp;
  if (!(resp.headers.get('content-type') || '').includes('text/html')) return resp;

  const signedIn = await isSignedIn(request, env);
  const html = await resp.text();
  let out;
  if (!GATING_MARKERS.test(html)) {
    out = new Response(html, resp);
  } else {
    const teaserPath = (env.LOGIN_TEASER || '').startsWith('/fragments/') ? env.LOGIN_TEASER : '';
    out = new Response(gateHtml(html, signedIn, teaserPath), resp);
    // the body now depends on the visitor: never let a browser or shared cache
    // hand one visitor's version to another
    out.headers.set('cache-control', 'private, no-store');
    out.headers.append('vary', 'Cookie');
    out.headers.delete('etag');
    out.headers.delete('last-modified');
    out.headers.delete('content-length');
  }
  // AUTH: session expired or was forged → drop the stale "Sign Out" hint
  if (!signedIn && authConfig(env) && getCookie(request, SIGNED_IN_COOKIE)) {
    out.headers.append('set-cookie', cookieHeader(SIGNED_IN_COOKIE, '', 0, { httpOnly: false }));
  }
  return out;
};

/* ------------------------------------------------------------ END GATING */

/* ------------------------------------------------------------------ NEWS */

const NEWS_ROOT = '/us/en/news';
const NEWS_INDEX = '/news-index.json';
const NEWS_INDEX_SECONDS = 60; // a new article shows up within about a minute
const NEWS_PAGE_SECONDS = 60; // browsers keep an assembled news page this long
const NEWS_BLOCKS = /<div class="(news-list|related-articles|latest-articles)(?:\s[^"]*)?">/g;
const NEWS_DEFAULTS = {
  'news-list': { 'per page': 10 },
  'related-articles': { title: 'Related articles', count: 3 },
  'latest-articles': { title: 'Latest articles', count: 5 },
};

const isNewsPath = (path) => path === NEWS_ROOT || path.startsWith(`${NEWS_ROOT}/`);

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const cleanPath = (path) => String(path || '').replace(/\.html$/, '').replace(/\/$/, '') || '/';

const newsDateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
});

const formatNewsDate = (date) => {
  const d = new Date(`${String(date || '').slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : newsDateFormat.format(d);
};

// index image URLs point at the locked origin → serve them from this host
const newsImagePath = (src) => {
  try {
    const url = new URL(src);
    return /\.aem\.(page|live)$/.test(url.hostname) ? url.pathname : url.href;
  } catch (e) {
    return src && src.startsWith('/') ? src.split('?')[0] : '';
  }
};

// all news articles, newest first; [] when the index can't be read
const loadNews = async (env) => {
  const headers = {};
  if (env.ORIGIN_AUTHENTICATION) headers.authorization = `token ${env.ORIGIN_AUTHENTICATION}`;
  try {
    const resp = await fetch(`https://${env.ORIGIN_HOSTNAME}${NEWS_INDEX}?limit=1000`, {
      headers, cf: { cacheEverything: true, cacheTtl: NEWS_INDEX_SECONDS },
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    return (Array.isArray(json.data) ? json.data : [])
      .filter((row) => row.path && row.title)
      .map((row) => ({
        path: cleanPath(row.path),
        title: String(row.title).trim(),
        description: String(row.description || '').trim(),
        image: newsImagePath(row.image),
        date: String(row.date || '').slice(0, 10),
        category: String(row.category || '').trim(),
        tags: String(row.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
        lastModified: Number(row.lastModified) || 0,
      }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.lastModified - a.lastModified);
  } catch (e) {
    return [];
  }
};

// same rules as scripts/articles.js
const pickLatestNews = (articles, current, count) => articles
  .filter((a) => a.path !== current).slice(0, count);

const pickRelatedNews = (articles, current, count) => {
  const self = articles.find((a) => a.path === current);
  const others = articles.filter((a) => a.path !== current);
  if (!self) return others.slice(0, count);
  const category = self.category.toLowerCase();
  const matches = others.filter((a) => (category && a.category.toLowerCase() === category)
    || a.tags.some((t) => self.tags.includes(t)));
  return [...matches, ...others.filter((a) => !matches.includes(a))].slice(0, count);
};

// same markup as buildCard() in scripts/articles.js
const newsPicture = (src) => {
  const ext = (src.split('.').pop() || 'jpg').toLowerCase();
  return `<picture><source type="image/webp" srcset="${escapeHtml(src)}?width=750&amp;format=webply&amp;optimize=medium">`
    + `<img loading="lazy" alt="" src="${escapeHtml(src)}?width=750&amp;format=${escapeHtml(ext)}&amp;optimize=medium"></picture>`;
};

const newsCard = (article, heading) => {
  const href = escapeHtml(article.path);
  const label = formatNewsDate(article.date);
  const meta = [
    article.category ? `<span>${escapeHtml(article.category)}</span>` : '',
    label ? `<time datetime="${escapeHtml(article.date)}">${escapeHtml(label)}</time>` : '',
  ].filter(Boolean).join(' · ');
  return '<li class="article-card">'
    + (article.image ? `<a class="article-card-image" href="${href}" tabindex="-1" aria-hidden="true">${newsPicture(article.image)}</a>` : '')
    + '<div class="article-card-body">'
    + `<p class="article-card-meta">${meta}</p>`
    + `<${heading}><a href="${href}">${escapeHtml(article.title)}</a></${heading}>`
    + (article.description ? `<p class="article-card-description">${escapeHtml(article.description)}</p>` : '')
    + '</div></li>';
};

const newsCards = (articles, heading) => `<ul class="article-cards" data-edge="assembled">${articles.map((a) => newsCard(a, heading)).join('')}</ul>`;

const newsPagination = (current, pages) => {
  if (pages < 2) return '';
  const link = (n, text, active) => `<a href="${NEWS_ROOT}${n > 1 ? `?page=${n}` : ''}"${active ? ' aria-current="page"' : ''}>${text}</a>`;
  let html = '<nav class="news-pagination" aria-label="News pages">';
  if (current > 1) html += link(current - 1, '← Newer', false);
  for (let n = 1; n <= pages; n += 1) html += link(n, String(n), n === current);
  if (current < pages) html += link(current + 1, 'Older →', false);
  return `${html}</nav>`;
};

// "Label | value" rows authored in a placeholder block
const newsBlockConfig = (block, name) => {
  const config = { ...NEWS_DEFAULTS[name] };
  const innerStart = block.indexOf('>') + 1;
  const innerEnd = block.lastIndexOf('</div>');
  childDivs(block, innerStart, innerEnd).forEach(([start, end]) => {
    const cells = childDivs(block, block.indexOf('>', start) + 1, end);
    if (cells.length < 2) return;
    const key = textOf(block.slice(...cells[0]));
    const value = block.slice(...cells[1]).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (key && value) config[key] = value;
  });
  return config;
};

const newsBlockHtml = (name, config, articles, current, page) => {
  if (name === 'news-list') {
    const perPage = Number(config['per page']) || 10;
    const category = String(config.category || '').toLowerCase();
    const list = articles.filter((a) => !category || a.category.toLowerCase() === category);
    if (!list.length) return null;
    const pages = Math.ceil(list.length / perPage);
    const at = Math.min(Math.max(1, page), pages);
    return newsCards(list.slice((at - 1) * perPage, at * perPage), 'h2') + newsPagination(at, pages);
  }
  const count = Number(config.count) || NEWS_DEFAULTS[name].count;
  const picked = name === 'related-articles'
    ? pickRelatedNews(articles, current, count)
    : pickLatestNews(articles, current, count);
  if (!picked.length) return null;
  return `<h2 class="article-list-heading">${escapeHtml(config.title)}</h2>${newsCards(picked, 'h3')}`;
};

// EDGE ASSEMBLY: fill the news placeholder blocks before the page is sent.
// Pages without placeholders, or an unreadable index, pass through unchanged
// (the blocks then fill themselves in the browser).
const assembleNews = async (request, resp, env, extension) => {
  const url = new URL(request.url);
  if (!isNewsPath(url.pathname) || !isPageRequest(extension) || url.pathname.endsWith('.plain.html')) return resp;
  if (resp.status !== 200 || !(resp.headers.get('content-type') || '').includes('text/html')) return resp;
  const html = await resp.text();
  NEWS_BLOCKS.lastIndex = 0;
  if (!NEWS_BLOCKS.test(html)) return new Response(html, resp);

  const articles = await loadNews(env);
  if (!articles.length) return new Response(html, resp);
  const current = cleanPath(url.pathname);
  const page = Number(url.searchParams.get('page')) || 1;

  let out = '';
  let pos = 0;
  let filled = 0;
  NEWS_BLOCKS.lastIndex = 0;
  let match = NEWS_BLOCKS.exec(html);
  while (match) {
    const start = match.index;
    const end = findDivEnd(html, start);
    const name = match[1];
    const inner = newsBlockHtml(name, newsBlockConfig(html.slice(start, end), name), articles, current, page);
    if (inner) {
      out += `${html.slice(pos, start)}${match[0]}<div><div>${inner}</div></div></div>`;
      pos = end;
      filled += 1;
    }
    NEWS_BLOCKS.lastIndex = end;
    match = NEWS_BLOCKS.exec(html);
  }
  const assembled = new Response(out + html.slice(pos), resp);
  assembled.headers.delete('content-length');
  assembled.headers.delete('etag');
  assembled.headers.delete('last-modified');
  if (filled) {
    // a page already made private (gated content) stays private
    if (!/private|no-store/.test(assembled.headers.get('cache-control') || '')) {
      assembled.headers.set('cache-control', `public, max-age=${NEWS_PAGE_SECONDS}`);
    }
    assembled.headers.set('x-news-assembled', String(filled));
  }
  return assembled;
};

/* -------------------------------------------------------------- END NEWS */

const handleRequest = async (request, env) => {
  const url = new URL(request.url);
  if (url.port) {
    // Cloudflare opens a couple more ports than 443, so we redirect visitors
    // to the default port to avoid confusion.
    // https://developers.cloudflare.com/fundamentals/reference/network-ports/#network-ports-compatible-with-cloudflares-proxy
    const redirectTo = new URL(request.url);
    redirectTo.port = '';
    return new Response('Moved permanently to ' + redirectTo.href, {
      status: 301,
      headers: {
        location: redirectTo.href
      }
    });
  }

  if (url.pathname.startsWith('/drafts/')) {
    return new Response('Not Found', { status: 404 });
  }

  // AUTH: sign-in routes are answered here, never forwarded to the origin
  if (url.pathname.startsWith('/auth/')) {
    return handleAuth(request, url, env);
  }

  // COMMERCE: Shopify APIs for the shop blocks, cart, cache status and admin
  if (url.pathname.startsWith('/commerce/')) {
    return handleCommerce(request, url, env);
  }

  // LOCKED PAGES: /premium/* and /members/* only for signed-in visitors
  const locked = isLockedPath(url.pathname);
  if (locked && !(await isSignedIn(request, env))) {
    return lockedResponse(url);
  }

  if(isRUMRequest(url)) {
    // only allow GET, POST, OPTIONS
    if(!['GET', 'POST', 'OPTIONS'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405 });
    }
  }

  const extension = getExtension(url.pathname);

  // GATING: markdown is another raw view of the page; refuse it rather than
  // filter it, so premium text can't be read through /page.md
  if (extension === 'md') {
    return new Response('Not Found', { status: 404 });
  }

  // remember original search params
  const savedSearch = url.search;

  // sanitize search params
  const { searchParams } = url;
  if (isMediaRequest(url)) {
    for (const [key] of searchParams.entries()) {
      if (!['format', 'height', 'optimize', 'width'].includes(key)) {
        searchParams.delete(key);
      }
    }
  } else if (extension === 'json') {
    for (const [key] of searchParams.entries()) {
      if (!['limit', 'offset', 'sheet'].includes(key)) {
        searchParams.delete(key);
      }
    }
  } else {
    // neither media nor json request: strip search params
    url.search = '';
  }
  searchParams.sort();

  url.hostname = env.ORIGIN_HOSTNAME;
  if (!url.origin.match(/^https:\/\/main--.*--.*\.aem\.live/)) {
    return new Response('Invalid ORIGIN_HOSTNAME', { status: 500 });
  }
  const req = new Request(url, request);
  req.headers.set('x-forwarded-host', req.headers.get('host'));
  req.headers.set('x-byo-cdn-type', 'cloudflare');
  if (env.PUSH_INVALIDATION !== 'disabled') {
    req.headers.set('x-push-invalidation', 'enabled');
  }
  if (env.ORIGIN_AUTHENTICATION) {
    req.headers.set('authorization', `token ${env.ORIGIN_AUTHENTICATION}`);
  }
  // GATING: always fetch full pages, so a 304 can't make the browser reuse a
  // copy rendered for the other audience
  if (isPageRequest(extension)) {
    req.headers.delete('if-none-match');
    req.headers.delete('if-modified-since');
  }
  let resp = await fetch(req, {
    method: req.method,
    cf: {
      // cf doesn't cache html by default: need to override the default behavior
      cacheEverything: true,
      // NEWS: the article index stays fresh (new articles within about a minute)
      ...(url.pathname === NEWS_INDEX ? { cacheTtl: NEWS_INDEX_SECONDS } : {}),
    },
  });
  resp = new Response(resp.body, resp);
  if (resp.status === 301 && savedSearch) {
    const location = resp.headers.get('location');
    if (location && !location.match(/\?.*$/)) {
      resp.headers.set('location', `${location}${savedSearch}`);
    }
  }
  if (resp.status === 304) {
    // 304 Not Modified - remove CSP header
    resp.headers.delete('Content-Security-Policy');
  }
  resp.headers.delete('age');
  resp.headers.delete('x-robots-tag');
  resp = await rewriteOriginUrls(request, resp, env, extension);
  // GATING: tailor the page to this visitor before it leaves Cloudflare
  resp = await applyGating(request, resp, env, extension);
  // NEWS: assemble News list / Related / Latest into news pages at the edge
  resp = await assembleNews(request, resp, env, extension);
  return locked ? makePrivate(resp) : resp;
};

export default {
  fetch: handleRequest,
  // CHANGE WATCHER: Cron Trigger (wrangler.toml [triggers])
  scheduled: (event, env, ctx) => {
    // Shopify, the reviews or KV unavailable: keep the cached copies, try again next minute
    const log = (name) => (e) => {
      // eslint-disable-next-line no-console
      console.log(`${name} watcher: ${e.message}`);
    };
    // reviews after products: they use the (refreshed) catalog's SKUs
    ctx.waitUntil(checkCommerce(env, 'watcher').catch(log('commerce'))
      .then(() => checkReviews(env, 'watcher').catch(log('reviews'))));
  },
};
