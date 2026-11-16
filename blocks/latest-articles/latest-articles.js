/*
 * latest-articles — the newest news articles, never the one being read.
 *
 * The Cloudflare worker fills this block before delivery (edge assembly); the
 * block then only keeps that markup. Without the worker (aem.page, local) it
 * builds the list in the browser from /news-index.json.
 *
 * Authored block, every row optional:
 *   "Title" | Latest articles    → section heading
 *   "Count" | 5                  → number of articles
 */

import {
  LATEST_COUNT, buildCards, buildHeading, edgeCards, fetchArticles, pickLatest, readConfig,
} from '../../scripts/articles.js';

export default async function decorate(block) {
  const config = readConfig(block);
  const title = config.title || 'Latest articles';
  const edge = edgeCards(block);
  if (edge) {
    block.replaceChildren(block.querySelector('h2') || buildHeading(title), edge);
    return;
  }

  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');
  const count = Number(config.count) || LATEST_COUNT;
  const articles = pickLatest(await fetchArticles(), window.location.pathname, count);
  block.removeAttribute('aria-busy');
  if (!articles.length) {
    block.hidden = true;
    return;
  }
  block.replaceChildren(buildHeading(title), buildCards(articles, 'h3'));
}
