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
 * edge gating for the gated-content story. Everything Adobe ships is kept as
 * is; the gating additions are marked "GATING".
 *
 * GATING: logged-in users see premium content, anonymous users see public
 * content only — enforced here, before the page leaves Cloudflare, so premium
 * markup never reaches an anonymous visitor's browser (unlike the in-browser
 * hiding in scripts/gated.js, which only hides it on screen).
 *   - signed in  = cookie `wknd-signed-in=true` (set by the demo Sign In link)
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
 */

'use strict';

const getExtension = (path) => {
  const basename = path.split('/').pop();
  const pos = basename.lastIndexOf('.');
  return (basename === '' || pos < 1) ? '' : basename.slice(pos + 1);
};

const isMediaRequest = (url) => /\/media_[0-9a-f]{40,}[/a-zA-Z0-9_-]*\.[0-9a-z]+$/.test(url.pathname);
const isRUMRequest = (url) => /\/\.(rum|optel)\/.*/.test(url.pathname);

/* ---------------------------------------------------------------- GATING */

const SIGNED_IN_COOKIE = 'wknd-signed-in';
// cheap pre-check: pages without any audience marker pass through untouched.
// Only markup counts (attributes / classes), not the words in page text.
const GATING_MARKERS = /\sdata-view="|\sclass="[^"]*\b(logged-in|logged-out|gated-content)\b/i;
const PUBLIC_ROW = 'public content';

const isSignedIn = (request) => (request.headers.get('cookie') || '')
  .split(';')
  .some((c) => c.trim() === `${SIGNED_IN_COOKIE}=true`);

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

const applyGating = async (request, resp, env, extension) => {
  if (!isPageRequest(extension) || resp.status !== 200) return resp;
  if (!(resp.headers.get('content-type') || '').includes('text/html')) return resp;

  const html = await resp.text();
  if (!GATING_MARKERS.test(html)) return new Response(html, resp);

  const teaserPath = (env.LOGIN_TEASER || '').startsWith('/fragments/') ? env.LOGIN_TEASER : '';
  const gated = new Response(gateHtml(html, isSignedIn(request), teaserPath), resp);
  // the body now depends on the visitor: never let a browser or shared cache
  // hand one visitor's version to another
  gated.headers.set('cache-control', 'private, no-store');
  gated.headers.append('vary', 'Cookie');
  gated.headers.delete('etag');
  gated.headers.delete('last-modified');
  gated.headers.delete('content-length');
  return gated;
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
  // GATING: tailor the page to this visitor before it leaves Cloudflare
  return applyGating(request, resp, env, extension);
};

export default {
  fetch: handleRequest,
};
