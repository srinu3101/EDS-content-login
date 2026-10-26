/*
 * gated — demo sign-in and audience gating for gated content.
 *
 * Audience markers authored in DA:
 *   section metadata `view` = logged-in | logged-out  → data-view on the section
 *   block variant (logged-in) / (logged-out)          → class on the block
 *   gated-content "Premium Content" rows              → handled by that block
 * Anything unmarked is public. Anonymous visitors get public + logged-out
 * parts; signed-in visitors get public + logged-in parts.
 *
 * This runs in the browser, so premium markup still reaches the page source;
 * keeping it from anonymous users is the Cloudflare edge worker's job.
 *
 * Sign-in: behind the Cloudflare worker, "Sign Up" / "Sign In" / "Sign Out"
 * go to the worker's Auth0 routes (/auth/signup, /auth/login, /auth/logout),
 * which set a signed session plus the `wknd-signed-in` hint cookie read here.
 * Adobe's own hosts (*.aem.page / *.aem.live) and local dev have no worker,
 * so there the links stay a demo toggle of the hint cookie — no accounts or
 * passwords.
 */

import { toClassName } from './aem.js';

const COOKIE = 'wknd-signed-in';
const SIGN_IN = /^sign\s*in$/i;
const SIGN_OUT = /^sign\s*out$/i;
const SIGN_UP = /^sign\s*up$/i;

function hasEdgeSignIn() {
  const host = window.location.hostname;
  return !(host === 'localhost' || host === '127.0.0.1' || /\.aem\.(page|live)$/.test(host));
}

export function isSignedIn() {
  return document.cookie.split(';').some((c) => c.trim() === `${COOKIE}=true`);
}

function setSignedIn(signedIn) {
  document.cookie = signedIn
    ? `${COOKIE}=true; path=/; SameSite=Lax`
    : `${COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

/**
 * Remove the sections and blocks this visitor's audience may not see. Runs on
 * the raw markup, before sections and blocks are decorated, so removed parts
 * never render, load their block code, or flash on screen.
 * @param {Element} main The main element
 */
export function applyGating(main) {
  const hiddenView = isSignedIn() ? 'logged-out' : 'logged-in';
  main.querySelectorAll(':scope > div[data-view]').forEach((section) => {
    if (toClassName(section.dataset.view) === hiddenView) section.remove();
  });
  main.querySelectorAll(`:scope > div > div.${hiddenView}`).forEach((block) => block.remove());
  // a section whose only block was removed would render as an empty gap
  main.querySelectorAll(':scope > div:empty').forEach((section) => section.remove());
}

/**
 * Send a link to a worker auth route, or make it the demo toggle (setting the
 * hint cookie to `signIn`) where there is no worker.
 * @param {HTMLAnchorElement} a The link
 * @param {string} route Worker route: login, signup or logout
 * @param {boolean} signIn Demo toggle target state
 */
function wireAuthLink(a, route, signIn) {
  if (hasEdgeSignIn()) {
    a.href = `/auth/${route}?returnTo=${encodeURIComponent(window.location.pathname)}`;
    return;
  }
  a.addEventListener('click', (e) => {
    e.preventDefault();
    setSignedIn(signIn);
    window.location.reload();
  });
}

/**
 * Point "Sign Up" / "Sign In" / "Sign Out" links at the worker's Auth0 routes
 * (or the demo toggle where there is no worker), labelled for the current
 * state. "Sign Up" links are hidden for visitors who are already signed in.
 * @param {Element} root Element to search for links (nav, main, …)
 */
export function decorateAuthLinks(root) {
  const signedIn = isSignedIn();
  root.querySelectorAll('a').forEach((a) => {
    const label = a.textContent.trim();
    if (SIGN_UP.test(label)) {
      if (signedIn) (a.closest('li') || a).hidden = true;
      else wireAuthLink(a, 'signup', true);
      return;
    }
    if (!SIGN_IN.test(label) && !SIGN_OUT.test(label)) return;
    a.textContent = signedIn ? 'Sign Out' : 'Sign In';
    wireAuthLink(a, signedIn ? 'logout' : 'login', !signedIn);
  });
}

/**
 * Add a "Sign Up" link next to the header's "Sign In" for anonymous visitors
 * (unless the nav already has one). Run after decorateAuthLinks.
 * @param {Element} nav The decorated header nav
 */
export function addSignUpLink(nav) {
  if (isSignedIn()) return;
  const links = [...nav.querySelectorAll('a')];
  if (links.some((a) => SIGN_UP.test(a.textContent.trim()))) return;
  const signInItem = links.find((a) => SIGN_IN.test(a.textContent.trim()))?.closest('li');
  if (!signInItem) return;
  const item = document.createElement('li');
  const a = document.createElement('a');
  a.href = '/';
  a.textContent = 'Sign Up';
  wireAuthLink(a, 'signup', true);
  item.append(a);
  signInItem.after(item);
}
