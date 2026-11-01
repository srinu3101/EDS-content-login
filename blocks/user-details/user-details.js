/*
 * user-details — a personal landing block: the signed-in visitor's profile
 * (picture, name, username, email), public content for everyone, and premium
 * content loaded only after sign-in.
 *
 * Self-reliant: it asks the Cloudflare worker (GET /auth/me, read from the
 * signed session on every call) who is signed in. It does not use section
 * metadata, block variants, gated-content rows, the `gated` page setting or the
 * `wknd-signed-in` hint cookie.
 *
 * Authored block, every row optional, any order:
 *   "Public Content"  | content          → every visitor
 *   "Premium Content" | /premium/… link  → loaded for signed-in visitors only;
 *                                          the worker refuses /premium/ to
 *                                          anyone else, so premium content is
 *                                          never part of this page
 *   "Signed In"       | content          → welcome text; {name} is replaced
 *   "Signed Out"      | content          → message above Sign In / Sign Up
 *   any other row                        → treated as public content
 */

import { loadFragment } from '../fragment/fragment.js';

// public address of the Cloudflare worker (same as scripts/gated.js)
const EDGE_ORIGIN = 'https://eds-content-login.vanterusrinivasuluv2002.workers.dev';

const PUBLIC = 'public content';
const PREMIUM = 'premium content';
const SIGNED_IN = 'signed in';
const SIGNED_OUT = 'signed out';
const LABELS = [PUBLIC, PREMIUM, SIGNED_IN, SIGNED_OUT];

const FIELDS = [
  ['name', 'Name'],
  ['username', 'Username'],
  ['email', 'Email'],
];

// Adobe hosts and local dev have no worker, so no /auth/* routes
function hasWorker() {
  const host = window.location.hostname;
  return !(host === 'localhost' || host === '127.0.0.1' || /\.aem\.(page|live)$/.test(host));
}

function authUrl(action) {
  const origin = hasWorker() ? '' : EDGE_ORIGIN;
  return `${origin}/auth/${action}?returnTo=${encodeURIComponent(window.location.pathname)}`;
}

// null = signed out, or nobody to ask
async function fetchUser() {
  if (!hasWorker()) return null;
  try {
    const resp = await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!resp.ok) return null;
    const user = await resp.json();
    return user && user.signedIn === true ? user : null;
  } catch (e) {
    return null;
  }
}

// a cell holding only a page link or path: "/premium/x", "https://…/premium/x"
// or "/premium/x.html" → "/premium/x"; anything else → null
function premiumPath(cell) {
  const text = cell.textContent.trim();
  const links = cell.querySelectorAll('a[href]');
  if (links.length > 1 || (links.length === 1 && links[0].textContent.trim() !== text)) return null;
  const raw = links.length ? links[0].getAttribute('href') : text;
  if (!/^(\/(?!\/)|https?:\/\/)\S+$/.test(raw)) return null;
  try {
    return new URL(raw, window.location).pathname.replace(/(\.plain)?\.html$/, '');
  } catch (e) {
    return null;
  }
}

function readRows(block) {
  const parts = {
    [PUBLIC]: [], [PREMIUM]: [], [SIGNED_IN]: [], [SIGNED_OUT]: [], paths: [],
  };
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    const label = cells.length > 1
      ? cells[0].textContent.trim().toLowerCase().replace(/[\s-]+/g, ' ')
      : '';
    const known = LABELS.includes(label);
    const content = known ? cells.slice(1) : cells;
    if (label === PREMIUM) {
      content.forEach((cell) => {
        const path = premiumPath(cell);
        // a typed-in path becomes a fragment; other content is shown as is
        if (path) parts.paths.push(path);
        else parts[PREMIUM].push(...cell.childNodes);
      });
    } else {
      content.forEach((cell) => parts[known ? label : PUBLIC].push(...cell.childNodes));
    }
  });
  return parts;
}

function buildPart(className, nodes) {
  const part = document.createElement('div');
  part.className = className;
  part.append(...nodes);
  return part;
}

function buildText(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

function buildButton(label, href, style) {
  const p = document.createElement('p');
  p.className = 'button-wrapper';
  const a = document.createElement('a');
  a.className = `button ${style}`;
  a.href = href;
  a.textContent = label;
  p.append(a);
  return p;
}

// {name} in authored text → the visitor's name (as text, never as markup)
function personalise(part, name) {
  const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes('{name}')) node.nodeValue = node.nodeValue.replaceAll('{name}', name);
  }
}

function buildPicture(user, displayName) {
  let src = null;
  try {
    const url = new URL(user.picture);
    if (url.protocol === 'https:') src = url.href;
  } catch (e) { /* no picture: show the initial */ }
  if (src) {
    const img = document.createElement('img');
    img.className = 'user-details-picture';
    img.src = src;
    img.alt = '';
    img.width = 96;
    img.height = 96;
    img.referrerPolicy = 'no-referrer';
    return img;
  }
  const initial = buildText('span', displayName.charAt(0).toUpperCase());
  initial.className = 'user-details-picture';
  initial.setAttribute('aria-hidden', 'true');
  return initial;
}

function buildProfile(user, displayName) {
  const card = document.createElement('div');
  card.className = 'user-details-card';
  const list = document.createElement('dl');
  FIELDS.forEach(([key, label]) => {
    const value = typeof user[key] === 'string' ? user[key].trim() : '';
    if (value) list.append(buildText('dt', label), buildText('dd', value));
  });
  card.append(buildPicture(user, displayName), list);
  return card;
}

// premium pages, fetched only now; the worker answers 401 to anyone signed out
async function loadPremium(paths) {
  const fragments = await Promise.all(paths.map((path) => loadFragment(path)));
  return fragments.filter(Boolean).flatMap((main) => [...main.querySelectorAll(':scope > .section')]
    .flatMap((section) => [...section.childNodes]));
}

export default async function decorate(block) {
  const parts = readRows(block);
  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');

  const user = await fetchUser();
  const content = [];

  if (user) {
    const displayName = ([user.name, user.username, user.email]
      .find((v) => typeof v === 'string' && v.trim()) || 'there').trim();
    const welcome = buildPart('user-details-intro', parts[SIGNED_IN].length
      ? parts[SIGNED_IN] : [buildText('h2', 'Welcome back, {name}')]);
    personalise(welcome, displayName);
    content.push(welcome, buildProfile(user, displayName));
    if (parts[PUBLIC].length) content.push(buildPart('user-details-public', parts[PUBLIC]));
    const premium = [...parts[PREMIUM], ...await loadPremium(parts.paths)];
    if (premium.length) content.push(buildPart('user-details-premium', premium));
    content.push(buildPart('user-details-actions', [buildButton('Sign Out', authUrl('logout'), 'secondary')]));
    block.classList.add('user-details-signed-in');
  } else {
    content.push(buildPart('user-details-intro', parts[SIGNED_OUT].length
      ? parts[SIGNED_OUT]
      : [buildText('h2', 'Your account'), buildText('p', 'Sign in to see your account details and member content.')]));
    if (parts[PUBLIC].length) content.push(buildPart('user-details-public', parts[PUBLIC]));
    content.push(buildPart('user-details-actions', [
      buildButton('Sign In', authUrl('login'), 'primary'),
      buildButton('Sign Up', authUrl('signup'), 'secondary'),
    ]));
    block.classList.add('user-details-signed-out');
  }

  block.replaceChildren(...content);
  block.removeAttribute('aria-busy');
}
