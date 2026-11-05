/*
 * product-list — the shop's product listing page (PLP). Reads the demo
 * product API (/data/products.json, a Document Authoring sheet) and shows a
 * card grid with category filter tabs; each card links to the product page.
 *
 * Authored block, every row optional:
 *   "Category"     | Surf                  → show only this category (no tabs)
 *   "Source"       | /data/products.json   → product API address
 *   "Product Page" | /us/en/shop/product   → detail page, opened with ?sku=
 * The tab can also be preselected with ?category=surf in the page address.
 */

import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  PRODUCTS_PATH, PRODUCT_PAGE, buildPrice, fetchProducts, productUrl, readConfig, sitePath,
  stockLabel,
} from '../../scripts/products.js';

const toKey = (s) => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function buildCard(product, page) {
  const li = document.createElement('li');
  li.className = 'product-list-card';
  li.dataset.category = toKey(product.category);
  const href = productUrl(product, page);

  const imageCell = document.createElement('div');
  imageCell.className = 'product-list-card-image';
  if (product.image) {
    const a = document.createElement('a');
    a.href = href;
    a.tabIndex = -1;
    a.setAttribute('aria-hidden', 'true');
    a.append(createOptimizedPicture(product.image, '', false, [{ width: '750' }]));
    imageCell.append(a);
  }

  const body = document.createElement('div');
  body.className = 'product-list-card-body';
  if (product.category) {
    const cat = document.createElement('p');
    cat.className = 'product-list-card-category';
    cat.textContent = product.category;
    body.append(cat);
  }
  const title = document.createElement('h2');
  const link = document.createElement('a');
  link.href = href;
  link.textContent = product.name;
  title.append(link);
  const stock = stockLabel(product.stock);
  const stockEl = document.createElement('p');
  stockEl.className = `product-stock product-stock-${stock.state}`;
  stockEl.textContent = stock.text;
  body.append(title, buildPrice(product), stockEl);

  li.append(imageCell, body);
  return li;
}

function message(text) {
  const p = document.createElement('p');
  p.className = 'product-list-message';
  p.textContent = text;
  return p;
}

export default async function decorate(block) {
  const config = readConfig(block);
  const page = sitePath(config['product page'], PRODUCT_PAGE);
  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');

  const fixed = toKey(config.category);
  const products = (await fetchProducts(sitePath(config.source, PRODUCTS_PATH)))
    .filter((p) => !fixed || toKey(p.category) === fixed);
  block.removeAttribute('aria-busy');
  if (!products.length) {
    block.append(message(fixed ? 'No products in this category yet.' : 'Products could not be loaded. Please try again later.'));
    return;
  }

  const grid = document.createElement('ul');
  grid.className = 'product-list-grid';
  products.forEach((p) => grid.append(buildCard(p, page)));

  if (!fixed) {
    const categories = [...new Map(products
      .filter((p) => p.category)
      .map((p) => [toKey(p.category), p.category])).entries()];
    const filters = document.createElement('div');
    filters.className = 'product-list-filters';
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter by category');
    const count = document.createElement('p');
    count.className = 'product-list-count';
    count.setAttribute('aria-live', 'polite');

    const apply = (key) => {
      let shown = 0;
      grid.querySelectorAll('.product-list-card').forEach((card) => {
        card.hidden = key !== 'all' && card.dataset.category !== key;
        if (!card.hidden) shown += 1;
      });
      filters.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === key)));
      count.textContent = `${shown} ${shown === 1 ? 'product' : 'products'}`;
    };

    [['all', 'All'], ...categories].forEach(([key, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'product-list-filter';
      button.dataset.key = key;
      button.textContent = label;
      button.addEventListener('click', () => apply(key));
      filters.append(button);
    });

    const requested = toKey(new URLSearchParams(window.location.search).get('category'));
    apply(categories.some(([key]) => key === requested) ? requested : 'all');
    block.append(filters, count);
  }

  block.append(grid);
}
