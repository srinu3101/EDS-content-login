/*
 * gated-content — public content everyone sees, plus premium content only
 * signed-in visitors see (sign-in state from scripts/gated.js).
 *
 * Authored block, rows in any order:
 *   "Public Content"  | content  → shown to every visitor
 *   "Premium Content" | content  → shown to signed-in visitors only
 *   single-cell row              → premium content (the label is optional)
 *
 * The premium rows are dropped here in the browser; the Cloudflare edge worker
 * is what keeps them out of the page source for anonymous visitors.
 * Sign In / Sign Up links are removed from public content: signing in happens
 * from the header only.
 */

import { isAuthLink, isSignedIn } from '../../scripts/gated.js';

const PUBLIC = 'public content';
const PREMIUM = 'premium content';

function readRow(row) {
  const cells = [...row.children];
  const label = cells.length > 1
    ? cells[0].textContent.trim().toLowerCase().replace(/\s+/g, ' ')
    : '';
  if (label === PUBLIC || label === PREMIUM) return { label, cells: cells.slice(1) };
  return { label: PREMIUM, cells };
}

function buildPart(className) {
  const part = document.createElement('div');
  part.className = className;
  return part;
}

const hasContent = (el) => el.textContent.trim() || el.querySelector('picture, img');

// drop sign-in links (and a paragraph left holding nothing but the link)
function removeAuthLinks(part) {
  part.querySelectorAll('a').forEach((a) => {
    if (!isAuthLink(a)) return;
    const holder = a.closest('p');
    const onlyLink = holder && part.contains(holder)
      && holder.textContent.trim() === a.textContent.trim();
    (onlyLink ? holder : a).remove();
  });
}

export default function decorate(block) {
  const publicPart = buildPart('gated-content-public');
  const premiumPart = buildPart('gated-content-premium');
  // same audience marker the section-level `view` metadata produces
  premiumPart.dataset.view = 'logged-in';
  const signedIn = isSignedIn();

  [...block.children].forEach((row) => {
    const { label, cells } = readRow(row);
    if (label === PREMIUM && !signedIn) return;
    const target = label === PUBLIC ? publicPart : premiumPart;
    cells.forEach((cell) => target.append(...cell.childNodes));
  });
  removeAuthLinks(publicPart);

  // empty (and hidden by CSS) when an anonymous visitor gets a premium-only block
  block.replaceChildren(...[publicPart, premiumPart].filter(hasContent));
}
