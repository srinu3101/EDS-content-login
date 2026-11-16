/*
 * news-list — the News page: every news article, newest first, with paging
 * (?page=2 …).
 *
 * The Cloudflare worker fills this block before delivery (edge assembly) —
 * cards plus the page links; the block then only keeps that markup. Without
 * the worker (aem.page, local) it builds the list in the browser from
 * /news-index.json.
 *
 * Authored block, every row optional:
 *   "Per Page" | 10       → articles per page
 *   "Category" | Surf     → only this category
 */

import {
  PAGE_SIZE, buildCards, edgeCards, fetchArticles, readConfig,
} from '../../scripts/articles.js';

function pageLink(n, label, current) {
  const url = new URL(window.location.href);
  if (n > 1) url.searchParams.set('page', n);
  else url.searchParams.delete('page');
  const a = document.createElement('a');
  a.href = `${url.pathname}${url.search}`;
  a.textContent = label;
  if (n === current) a.setAttribute('aria-current', 'page');
  return a;
}

function buildPagination(current, pages) {
  const nav = document.createElement('nav');
  nav.className = 'news-pagination';
  nav.setAttribute('aria-label', 'News pages');
  if (current > 1) nav.append(pageLink(current - 1, '← Newer', 0));
  for (let n = 1; n <= pages; n += 1) nav.append(pageLink(n, String(n), current));
  if (current < pages) nav.append(pageLink(current + 1, 'Older →', 0));
  return nav;
}

export default async function decorate(block) {
  const config = readConfig(block);
  if (edgeCards(block)) {
    const cards = edgeCards(block);
    const nav = block.querySelector('nav.news-pagination');
    block.replaceChildren(cards, ...(nav ? [nav] : []));
    return;
  }

  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');
  const perPage = Number(config['per page']) || PAGE_SIZE;
  const category = (config.category || '').toLowerCase();
  const articles = (await fetchArticles())
    .filter((a) => !category || a.category.toLowerCase() === category);
  block.removeAttribute('aria-busy');
  if (!articles.length) {
    const p = document.createElement('p');
    p.className = 'news-list-empty';
    p.textContent = 'No news yet — check back soon.';
    block.replaceChildren(p);
    return;
  }

  const pages = Math.ceil(articles.length / perPage);
  const requested = Number(new URLSearchParams(window.location.search).get('page')) || 1;
  const current = Math.min(Math.max(1, requested), pages);
  const cards = buildCards(articles.slice((current - 1) * perPage, current * perPage), 'h2');
  block.replaceChildren(cards, ...(pages > 1 ? [buildPagination(current, pages)] : []));
}
