/*
 * gated — sign-in links and audience gating for gated content.
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
 * Sign-in only ever happens through Auth0 in the Cloudflare worker
 * (/auth/login, /auth/logout), which sets a signed session plus the
 * `wknd-signed-in` hint cookie read here. Nothing in the browser can sign a
 * visitor in. Adobe's own hosts (*.aem.page / *.aem.live) and local dev have no
 * worker, so their Sign In links go to the worker's login on EDGE_ORIGIN.
 */

import { toClassName } from './aem.js';

// public address of the Cloudflare worker (update when a custom domain is added)
const EDGE_ORIGIN = 'https://eds-content-login.vanterusrinivasuluv2002.workers.dev';
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

/**
 * Whether a link is a "Sign In" / "Sign Up" / "Sign Out" link.
 * @param {HTMLAnchorElement} a The link
 */
export function isAuthLink(a) {
  const label = a.textContent.trim();
  return SIGN_IN.test(label) || SIGN_OUT.test(label) || SIGN_UP.test(label);
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
 * Point "Sign In" / "Sign Out" (and authored "Sign Up") links at the worker's
 * Auth0 routes, labelled for the current state. "Sign Up" links are hidden for
 * visitors who are already signed in.
 * @param {Element} root Element to search for links (nav, main, …)
 */
export function decorateAuthLinks(root) {
  const signedIn = isSignedIn();
  const origin = hasEdgeSignIn() ? '' : EDGE_ORIGIN;
  const returnTo = encodeURIComponent(window.location.pathname);
  root.querySelectorAll('a').forEach((a) => {
    if (!isAuthLink(a)) return;
    if (SIGN_UP.test(a.textContent.trim())) {
      if (signedIn) (a.closest('li') || a).hidden = true;
      else a.href = `${origin}/auth/signup?returnTo=${returnTo}`;
      return;
    }
    a.textContent = signedIn ? 'Sign Out' : 'Sign In';
    a.href = `${origin}/auth/${signedIn ? 'logout' : 'login'}?returnTo=${returnTo}`;
  });
}
