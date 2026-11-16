/*
 * articles — shared helper for the news blocks (news-list, related-articles,
 * latest-articles).
 *
 * Normally the Cloudflare worker assembles these lists into the page before
 * delivery (edge assembly). The worker writes the same markup this file builds:
 *
 *   <ul class="article-cards" data-edge="assembled">
 *     <li class="article-card">
 *       <a class="article-card-image" href="/us/en/news/…"><picture>…</picture></a>
 *       <div class="article-card-body">
 *         <p class="article-card-meta">
 *           <span>Surf</span> · <time datetime="2026-11-10">November 10, 2026</time>
 *         </p>
 *         <h3><a href="/us/en/news/…">Title</a></h3>
 *         <p class="article-card-description">…</p>
 *       </div>
 *     </li>
 *   </ul>
 *
 * When a block arrives empty (aem.page / local preview without the worker, or
 * the worker couldn't read the index) the block builds the list in the browser
 * from /news-index.json with the same selection rules.
 */

import { createOptimizedPicture } from './aem.js';

export const NEWS_INDEX = '/news-index.json';
export const NEWS_PAGE = '/us/en/news';
export const RELATED_COUNT = 3;
export const LATEST_COUNT = 5;
export const PAGE_SIZE = 10;

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
});

/**
 * "2026-11-10" → "November 10, 2026" ('' for a missing / invalid date).
 * @param {string} date ISO date
 */
export function formatDate(date) {
  const d = new Date(`${String(date || '').slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : dateFormat.format(d);
}

const clean = (path) => String(path || '').replace(/\.html$/, '').replace(/\/$/, '');

// index images are absolute origin URLs; the locked origin can't be read by the
// browser, so load them from the current host instead
function imagePath(src) {
  if (!src) return '';
  try {
    const url = new URL(src, window.location);
    return /\.aem\.(page|live)$/.test(url.hostname) && url.hostname !== window.location.hostname
      ? url.pathname : url.href;
  } catch (e) {
    return '';
  }
}

let loading;
/**
 * All news articles, newest first (by date, then last modified).
 * @returns {Promise<Array>} [] when the index can't be read
 */
export function fetchArticles() {
  if (!loading) {
    loading = fetch(`${NEWS_INDEX}?limit=1000`)
      .then((resp) => (resp.ok ? resp.json() : { data: [] }))
      .then((json) => (Array.isArray(json.data) ? json.data : [])
        .filter((row) => row.path && row.title)
        .map((row) => ({
          path: clean(row.path),
          title: String(row.title).replace(/\s*\|\s*WKND.*$/i, '').trim(),
          description: String(row.description || '').trim(),
          image: imagePath(row.image),
          date: String(row.date || '').slice(0, 10),
          category: String(row.category || '').trim(),
          tags: String(row.tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
          lastModified: Number(row.lastModified) || 0,
        }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.lastModified - a.lastModified))
      .catch(() => []);
  }
  return loading;
}

/**
 * Newest articles, without the current one.
 * @param {Array} articles Newest first
 * @param {string} current Path of the page being read
 * @param {number} [count]
 */
export function pickLatest(articles, current, count = LATEST_COUNT) {
  const here = clean(current);
  return articles.filter((a) => a.path !== here).slice(0, count);
}

/**
 * Same category (or a shared tag), newest first, never the current article;
 * topped up with the newest others when there are too few.
 * @param {Array} articles Newest first
 * @param {string} current Path of the page being read
 * @param {number} [count]
 */
export function pickRelated(articles, current, count = RELATED_COUNT) {
  const here = clean(current);
  const self = articles.find((a) => a.path === here);
  const others = articles.filter((a) => a.path !== here);
  if (!self) return others.slice(0, count);
  const category = self.category.toLowerCase();
  const matches = others.filter((a) => (category && a.category.toLowerCase() === category)
    || a.tags.some((t) => self.tags.includes(t)));
  const fill = others.filter((a) => !matches.includes(a));
  return [...matches, ...fill].slice(0, count);
}

/**
 * One article card (same markup the worker writes).
 * @param {object} article
 * @param {string} [heading] Heading tag for the title
 */
export function buildCard(article, heading = 'h3') {
  const li = document.createElement('li');
  li.className = 'article-card';
  if (article.image) {
    const media = document.createElement('a');
    media.className = 'article-card-image';
    media.href = article.path;
    media.tabIndex = -1;
    media.setAttribute('aria-hidden', 'true');
    media.append(createOptimizedPicture(article.image, '', false, [{ width: '750' }]));
    li.append(media);
  }
  const body = document.createElement('div');
  body.className = 'article-card-body';
  const meta = document.createElement('p');
  meta.className = 'article-card-meta';
  if (article.category) {
    const cat = document.createElement('span');
    cat.textContent = article.category;
    meta.append(cat);
  }
  const label = formatDate(article.date);
  if (label) {
    if (article.category) meta.append(' · ');
    const time = document.createElement('time');
    time.dateTime = article.date;
    time.textContent = label;
    meta.append(time);
  }
  const title = document.createElement(heading);
  const link = document.createElement('a');
  link.href = article.path;
  link.textContent = article.title;
  title.append(link);
  body.append(meta, title);
  if (article.description) {
    const desc = document.createElement('p');
    desc.className = 'article-card-description';
    desc.textContent = article.description;
    body.append(desc);
  }
  li.append(body);
  return li;
}

/**
 * A list of cards.
 * @param {Array} articles
 * @param {string} [heading] Heading tag for each card title
 */
export function buildCards(articles, heading) {
  const ul = document.createElement('ul');
  ul.className = 'article-cards';
  articles.forEach((a) => ul.append(buildCard(a, heading)));
  return ul;
}

/**
 * Reads optional "Label | value" rows of a block (labels lower-cased).
 * @param {Element} block
 */
export function readConfig(block) {
  const config = {};
  [...block.children].forEach((row) => {
    const [label, value] = row.children;
    if (label && value) config[label.textContent.trim().toLowerCase()] = value.textContent.trim();
  });
  return config;
}

/**
 * The cards the worker already put into the block, if any.
 * @param {Element} block
 */
export const edgeCards = (block) => block.querySelector('ul.article-cards');

/**
 * Section heading for related / latest lists.
 * @param {string} text
 */
export function buildHeading(text) {
  const h2 = document.createElement('h2');
  h2.className = 'article-list-heading';
  h2.textContent = text;
  return h2;
}
