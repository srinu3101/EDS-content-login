/*
 * gated-content — premium content inside a page, with optional public content
 * for anonymous visitors. Protection happens at the edge, not here: the
 * Cloudflare worker strips the premium rows for anonymous users (and the
 * public rows for signed-in users) before the page is delivered. This block
 * only lays out whatever arrived, so it renders correctly with either part
 * missing.
 *
 * Authored block, rows in any order:
 *   "Public Content"  | content  → shown to logged-out visitors
 *   "Premium Content" | content  → shown to logged-in visitors
 *   single-cell row              → premium content (the label is optional)
 */

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

function buildPart(className, view) {
  const part = document.createElement('div');
  part.className = className;
  // same audience marker the section-level `view` metadata produces
  part.dataset.view = view;
  return part;
}

const hasContent = (el) => el.textContent.trim() || el.querySelector('picture, img');

export default function decorate(block) {
  const publicPart = buildPart('gated-content-public', 'logged-out');
  const premiumPart = buildPart('gated-content-premium', 'logged-in');

  [...block.children].forEach((row) => {
    const { label, cells } = readRow(row);
    const target = label === PUBLIC ? publicPart : premiumPart;
    cells.forEach((cell) => target.append(...cell.childNodes));
  });

  if (hasContent(premiumPart)) {
    const badge = document.createElement('p');
    badge.className = 'gated-content-label';
    badge.textContent = 'Premium content';
    premiumPart.prepend(badge);
  }

  // empty when the edge removed the only part this visitor may not see
  block.replaceChildren(...[publicPart, premiumPart].filter(hasContent));
}
