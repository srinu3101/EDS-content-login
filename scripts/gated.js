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
 * keeping it from anonymous users is the Cloudflare edge worker's job, which
 * reads the same cookie. Sign-in is a demo: any "Sign In" link sets the
 * cookie, "Sign Out" clears it — no accounts or passwords.
 */

import { toClassName } from './aem.js';

const COOKIE = 'wknd-signed-in';
const SIGN_IN = /^sign\s*in$/i;
const SIGN_OUT = /^sign\s*out$/i;

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
 * Turn "Sign In" / "Sign Out" links into the demo sign-in toggle, labelled for
 * the current state.
 * @param {Element} root Element to search for links (nav, main, …)
 */
export function decorateAuthLinks(root) {
  const signedIn = isSignedIn();
  root.querySelectorAll('a').forEach((a) => {
    const label = a.textContent.trim();
    if (!SIGN_IN.test(label) && !SIGN_OUT.test(label)) return;
    a.textContent = signedIn ? 'Sign Out' : 'Sign In';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      setSignedIn(!isSignedIn());
      window.location.reload();
    });
  });
}
