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
 * Environment variables:
 *   ORIGIN_HOSTNAME    main--eds-content-login--srinu3101.aem.live
 *   PUSH_INVALIDATION  disabled (workers.dev) | enabled (own domain + CDN config)
 *   ORIGIN_AUTHENTICATION  optional site token (secret)
 *   LOGIN_TEASER       optional fragment path, must start with /fragments/
 *   AUTH0_DOMAIN       Auth0 tenant domain, e.g. dev-abc123.us.auth0.com
 *   AUTH0_CLIENT_ID    Auth0 application Client ID
 *   AUTH0_CLIENT_SECRET  Auth0 application Client Secret (secret)
 *   SESSION_SECRET     long random string used to sign sessions (secret)
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

const handleAuth = async (request, url, env) => {
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

const handleRequest = async (request, env, ctx) => {
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
  return applyGating(request, resp, env, extension);
};

export default {
  fetch: handleRequest,
};
