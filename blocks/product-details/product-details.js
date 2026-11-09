/*
 * product-details — the product detail page (PDP). One page serves every
 * product: it reads ?sku= from the address, finds that product in the demo
 * product API (Shopify via the worker, else /data/products) and shows photo, name, category, price,
 * member price, stock and description.
 *
 * Authored block, every row optional:
 *   "Source"    | /data/products.json   → force another product API address
 *   "Shop Page" | /us/en/shop           → target of the "Back to Shop" link
 * The block renders the page's h1 (the product name).
 */

import { createOptimizedPicture } from '../../scripts/aem.js';
import {
  PRODUCTS_PATH, SHOP_PAGE, buildPrice, fetchProducts, readConfig, sitePath, stockLabel,
} from '../../scripts/products.js';
import {
  CART_PAGE, MAX_QTY, addToCart, getCart,
} from '../../scripts/cart.js';

// quantity picker + "Add to Cart", with a status line linking to the cart
function buildPurchase(product) {
  const wrap = document.createElement('div');
  wrap.className = 'product-details-buy';
  const max = Math.min(product.stock === null ? MAX_QTY : product.stock, MAX_QTY);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button primary';
  if (max <= 0) {
    button.disabled = true;
    button.textContent = 'Out of stock';
    wrap.append(button);
    return wrap;
  }

  const label = document.createElement('label');
  label.htmlFor = 'product-details-qty';
  label.textContent = 'Quantity';
  const select = document.createElement('select');
  select.id = 'product-details-qty';
  for (let n = 1; n <= max; n += 1) select.add(new Option(String(n), String(n)));
  button.textContent = 'Add to Cart';
  const status = document.createElement('p');
  status.className = 'product-details-status';
  status.setAttribute('role', 'status');

  button.addEventListener('click', () => {
    const wanted = Number(select.value);
    const before = (getCart().find((l) => l.sku === product.sku) || { qty: 0 }).qty;
    const now = addToCart(product.sku, wanted, max);
    const added = now - before;
    const cartLink = document.createElement('a');
    cartLink.href = CART_PAGE;
    cartLink.textContent = 'View cart';
    status.replaceChildren(
      added > 0
        ? `Added ${added} to your cart (${now} in cart). `
        : `You already have the maximum of ${now} in your cart. `,
      cartLink,
    );
  });

  wrap.append(label, select, button, status);
  return wrap;
}

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
  info.append(stockEl, buildPurchase(product));

  if (product.description) {
    const desc = document.createElement('p');
    desc.className = 'product-details-description';
    desc.textContent = product.description;
    info.append(desc);
  }
  info.append(backLink(shop));

  block.replaceChildren(media, info);
}
