/*
 * magazine-sidebar — the right-hand column on wknd magazine-article pages.
 *
 * The source article layout is two columns: the article body on the left and a
 * sidebar on the right holding an index-driven list of other magazine articles
 * (title + publish date). Our import captured only the single article column,
 * so this module rebuilds that layout client-side on magazine-article pages:
 *   1. keeps the hero image + breadcrumb full-width at the top;
 *   2. moves the remaining article content into a left column;
 *   3. appends a right-column sidebar (the related-articles list).
 * The related list is index-driven (fetched from /query-index.json) so it stays
 * in sync as articles are added — the same pattern as magazine-cards.
 */

import { loadCSS } from './aem.js';

const INDEX_PATH = '/query-index.json';
const MAGAZINE_PREFIX = '/us/en/magazine/';
const SIDEBAR_COUNT = 4;

/*
 * Original publish dates from wknd.site, keyed by article slug. The source
 * shows these fixed publish dates in the sidebar (e.g. "Thursday, 9 Jul 2020")
 * — NOT the content's last-modified time, which is all our query-index carries.
 * We render/sort by these authored dates so the sidebar matches the source. Any
 * article not listed falls back to its index lastModified. `order` gives a
 * stable newest-first sort (higher = more recent) since several share a date.
 */
const PUBLISH_DATES = {
  'guide-la-skateparks': { text: 'Wednesday, 30 Sep 2020', order: 5 },
  'ski-touring': { text: 'Wednesday, 30 Sep 2020', order: 4 },
  'western-australia': { text: 'Thursday, 9 Jul 2020', order: 3 },
  'san-diego-surf': { text: 'Thursday, 9 Jul 2020', order: 2 },
  'arctic-surfing': { text: 'Thursday, 9 Jul 2020', order: 1 },
};

function slugOf(path) {
  return path.replace(/\.html?$/, '').split('/').filter(Boolean).pop();
}

function publishDate(path) {
  return PUBLISH_DATES[slugOf(path)] || null;
}

function currentPath() {
  // strip a leading /content (local `aem up` preview) and any .html suffix so
  // the same checks work locally and on the hosted preview/live
  return window.location.pathname.replace(/^\/content/, '').replace(/\.html?$/, '');
}

function isMagazineArticle() {
  const path = currentPath();
  // an article lives under /us/en/magazine/ (the bare /magazine listing is not one)
  return path.startsWith(MAGAZINE_PREFIX) && path !== '/us/en/magazine';
}

async function fetchArticles() {
  try {
    const resp = await fetch(INDEX_PATH);
    if (!resp.ok) return [];
    const json = await resp.json();
    return Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    return [];
  }
}

function buildShare() {
  // wknd shows a "SHARE THIS STORY" heading here. Its only control on the
  // source is a Pinterest widget button that renders at 0x0 (the embed doesn't
  // load), so visually the section is just the heading — no social icons and no
  // visible Save button. Render the heading only to match.
  const wrap = document.createElement('div');
  wrap.className = 'magazine-sidebar-share';

  const heading = document.createElement('h5');
  heading.className = 'magazine-sidebar-heading';
  heading.textContent = 'SHARE THIS STORY';
  wrap.append(heading);
  return wrap;
}

function buildRelated(articles) {
  const here = currentPath();
  const items = articles
    .filter((e) => e.path && e.path.startsWith(MAGAZINE_PREFIX)
      && e.path.replace(/\.html?$/, '') !== here)
    // newest first by authored publish order, falling back to index lastModified
    .sort((a, b) => {
      const oa = publishDate(a.path)?.order ?? (Number(a.lastModified) || 0);
      const ob = publishDate(b.path)?.order ?? (Number(b.lastModified) || 0);
      return ob - oa;
    })
    .slice(0, SIDEBAR_COUNT);
  if (!items.length) return null;

  const ul = document.createElement('ul');
  ul.className = 'magazine-sidebar-list';
  items.forEach((entry) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = entry.path.replace(/\.html?$/, '');

    const title = document.createElement('span');
    title.className = 'magazine-sidebar-list-title';
    title.textContent = entry.title || '';
    a.append(title);

    const date = publishDate(entry.path);
    if (date) {
      const dateEl = document.createElement('span');
      dateEl.className = 'magazine-sidebar-list-date';
      dateEl.textContent = date.text;
      a.append(dateEl);
    }
    li.append(a);
    ul.append(li);
  });
  return ul;
}

export default async function decorateMagazineSidebar(main) {
  if (!isMagazineArticle()) return;

  // An article is normally one section, but gated articles split it into
  // public / view=logged-in / view=logged-out sections. Lay out from the first
  // section (hero + breadcrumb) and move every later section into the article
  // column whole, so each keeps its data-view attribute.
  const [section, ...moreSections] = [...main.querySelectorAll(':scope > .section')]
    .filter((s) => s.children.length);
  if (!section || section.querySelector('.magazine-article-body')) return;
  section.classList.add('magazine-article');

  // the layout CSS ships with writer-details, which a gated page may not carry
  // (e.g. the edge strips a writer-details (logged-in) block for anonymous users)
  await loadCSS(`${window.hlx.codeBasePath}/blocks/writer-details/writer-details.css`);

  // Everything currently in the section, in order. The hero image (first
  // wrapper holding an img) and the breadcrumb wrapper stay full-width on top;
  // the rest becomes the left column.
  const wrappers = [...section.children];
  const heroWrapper = wrappers.find((w) => w.querySelector('picture, img'));
  const breadcrumbWrapper = wrappers.find((w) => w.classList.contains('breadcrumbs-wrapper'));
  const topWrappers = [heroWrapper, breadcrumbWrapper].filter(Boolean);
  const bodyWrappers = wrappers.filter((w) => !topWrappers.includes(w));

  // two-column grid: article body (left) + sidebar (right)
  const grid = document.createElement('div');
  grid.className = 'magazine-article-body';

  const mainCol = document.createElement('div');
  mainCol.className = 'magazine-article-main';
  bodyWrappers.forEach((w) => mainCol.append(w));
  moreSections.forEach((s) => mainCol.append(s));

  // Byline: the "By <author>" line renders bold + uppercase on wknd (it's an
  // <h4> there; our import made it a <p>). Tag it so CSS can style it.
  const byline = [...mainCol.querySelectorAll('p')]
    .find((p) => /^By\s+\S/i.test(p.textContent.trim()));
  if (byline) byline.classList.add('magazine-article-byline');

  // wknd shows the definition line ("noun") inside the grey quote box, right
  // under the quotation. Our import placed it as a standalone paragraph right
  // after the quote block; move it into the blockquote so it sits in the grey
  // box like the source.
  const quote = mainCol.querySelector('.quote blockquote');
  if (quote) {
    const quoteWrapper = mainCol.querySelector('.quote-wrapper') || quote.closest('.quote')?.parentElement;
    const afterWrapper = quoteWrapper?.nextElementSibling;
    const nounP = afterWrapper
      && [...afterWrapper.querySelectorAll('p')].find((p) => /^noun$/i.test(p.textContent.trim()));
    if (nounP) {
      nounP.classList.add('quote-definition');
      quote.append(nounP);
    }
  }

  const aside = document.createElement('aside');
  aside.className = 'magazine-article-aside';
  aside.append(buildShare());

  grid.append(mainCol, aside);
  section.append(grid);

  // populate the index-driven related list (async; layout already in place)
  const related = buildRelated(await fetchArticles());
  if (related) {
    const sep = document.createElement('hr');
    sep.className = 'magazine-sidebar-sep';
    aside.append(sep, related);
  }
}
