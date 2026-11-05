/*
 * product-details — the product detail page (PDP). One page serves every
 * product: it reads ?sku= from the address, finds that product in the demo
 * product API (/data/products.json) and shows photo, name, category, price,
 * member price, stock and description.
 *
 * Authored block, every row optional:
 *   "Source"    | /data/products.json   → product API address
 *   "Shop Page" | /us/en/shop           → target of the "Back to Shop" link
 * The block renders the page's h1 (the product name).
 */

import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  PRODUCTS_PATH, SHOP_PAGE, buildPrice, fetchProducts, readConfig, sitePath, stockLabel,
} from '../../scripts/products.js';

function backLink(shop) {
  const p = document.createElement('p');
  p.className = 'product-details-back';
  const a = document.createElement('a');
  a.href = shop;
  a.textContent = '← Back to Shop';
  p.append(a);
  return p;
}

function notFound(block, shop) {
  const box = document.createElement('div');
  box.className = 'product-details-missing';
  const h1 = document.createElement('h1');
  h1.textContent = 'Product not found';
  const p = document.createElement('p');
  p.textContent = 'This product does not exist or is no longer available.';
  box.append(h1, p, backLink(shop));
  block.replaceChildren(box);
}

export default async function decorate(block) {
  const config = readConfig(block);
  const shop = sitePath(config['shop page'], SHOP_PAGE);
  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');

  const sku = (new URLSearchParams(window.location.search).get('sku') || '').trim().toLowerCase();
  const products = sku ? await fetchProducts(sitePath(config.source, PRODUCTS_PATH)) : [];
  const product = products.find((p) => p.sku.toLowerCase() === sku);
  block.removeAttribute('aria-busy');
  if (!product) {
    notFound(block, shop);
    return;
  }

  document.title = `${product.name} | WKND Shop`;

  const media = document.createElement('div');
  media.className = 'product-details-media';
  if (product.image) {
    media.append(createOptimizedPicture(product.image, product.name, true, [
      { media: '(min-width: 900px)', width: '1200' }, { width: '750' },
    ]));
    const img = media.querySelector('img');
    if (img) img.fetchPriority = 'high';
  }

  const info = document.createElement('div');
  info.className = 'product-details-info';
  if (product.category) {
    const cat = document.createElement('p');
    cat.className = 'product-details-category';
    cat.textContent = product.category;
    info.append(cat);
  }
  const h1 = document.createElement('h1');
  h1.textContent = product.name;
  const sku2 = document.createElement('p');
  sku2.className = 'product-details-sku';
  sku2.textContent = `SKU: ${product.sku}`;
  info.append(h1, sku2, buildPrice(product));

  const stock = stockLabel(product.stock);
  const stockEl = document.createElement('p');
  stockEl.className = `product-stock product-stock-${stock.state}`;
  stockEl.textContent = stock.text;
  info.append(stockEl);

  if (product.description) {
    const desc = document.createElement('p');
    desc.className = 'product-details-description';
    desc.textContent = product.description;
    info.append(desc);
  }
  info.append(backLink(shop));

  block.replaceChildren(media, info);
}
