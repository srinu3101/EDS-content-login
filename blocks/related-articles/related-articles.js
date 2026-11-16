/*
 * related-articles — articles on the same topic as the one being read: same
 * category (or a shared tag), newest first, never the article itself; topped
 * up with the newest others when there are too few.
 *
 * The Cloudflare worker fills this block before delivery (edge assembly); the
 * block then only keeps that markup. Without the worker (aem.page, local) it
 * builds the list in the browser from /news-index.json.
 *
 * Authored block, every row optional:
 *   "Title" | Related articles   → section heading
 *   "Count" | 3                  → number of articles
 */

import {
  RELATED_COUNT, buildCards, buildHeading, edgeCards, fetchArticles, pickRelated, readConfig,
} from '../../scripts/articles.js';

export default async function decorate(block) {
  const config = readConfig(block);
  const title = config.title || 'Related articles';
  const edge = edgeCards(block);
  if (edge) {
    block.replaceChildren(block.querySelector('h2') || buildHeading(title), edge);
    return;
  }

  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');
  const count = Number(config.count) || RELATED_COUNT;
  const articles = pickRelated(await fetchArticles(), window.location.pathname, count);
  block.removeAttribute('aria-busy');
  if (!articles.length) {
    block.hidden = true;
    return;
  }
  block.replaceChildren(buildHeading(title), buildCards(articles, 'h3'));
}
