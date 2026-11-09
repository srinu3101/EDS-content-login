/*
 * products — the product API shared by the shop blocks (product-list,
 * product-details, cart, checkout).
 *
 * Products come from Shopify through the Cloudflare worker
 * (/commerce/products.json). Where that isn't available — Adobe hosts, local
 * dev, or Shopify down — the Document Authoring sheet /data/products is used.
 * Both answer { data: [{ sku, name, category, price, memberPrice, stock,
 * image, description, … }] }.
 */

export const PRODUCTS_PATH = '/commerce/products.json';
export const SHEET_PATH = '/data/products.json';
export const PRODUCT_PAGE = '/us/en/shop/product';
export const SHOP_PAGE = '/us/en/shop';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const toNumber = (value) => {
  const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : null;
};

/**
 * Formats a price, e.g. 299 → "$299".
 * @param {number} value Price
 */
export const formatPrice = (value) => money.format(value);

async function loadProducts(path) {
  try {
    const url = new URL(path, window.location);
    url.searchParams.set('limit', '1000');
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const json = await resp.json();
    const rows = Array.isArray(json.data) ? json.data : [];
    return rows
      .map((row) => ({
        sku: String(row.sku || '').trim(),
        name: String(row.name || '').trim(),
        category: String(row.category || '').trim(),
        price: toNumber(row.price),
        memberPrice: toNumber(row.memberPrice),
        stock: toNumber(row.stock),
        image: String(row.image || '').trim(),
        description: String(row.description || '').trim(),
      }))
      .filter((p) => p.sku && p.name);
  } catch (e) {
    return [];
  }
}

/**
 * Whether this host is served by the Cloudflare worker (Adobe hosts and local
 * dev have no /auth/* or /commerce/* routes).
 */
export function hasWorker() {
  const host = window.location.hostname;
  return !(host === 'localhost' || host === '127.0.0.1' || /\.aem\.(page|live)$/.test(host));
}

const loaded = new Map();

/**
 * Loads and normalises the catalog (once per page and address); rows without
 * a sku or name are skipped. An empty answer from anywhere but the sheet falls
 * back to the sheet, so the shop keeps working without Shopify.
 * @param {string} [path] JSON address of the product API
 * @returns {Promise<Array>} products, or [] when nothing can be read
 */
export function fetchProducts(path = PRODUCTS_PATH) {
  if (path === PRODUCTS_PATH && !hasWorker()) return fetchProducts(SHEET_PATH);
  if (!loaded.has(path)) {
    const fallback = (products) => (products.length || path === SHEET_PATH
      ? products : fetchProducts(SHEET_PATH));
    loaded.set(path, loadProducts(path).then(fallback));
  }
  return loaded.get(path);
}

/**
 * Address of a product's detail page.
 * @param {object} product Product with a sku
 * @param {string} [page] Product page path
 */
export const productUrl = (product, page = PRODUCT_PAGE) => `${page}?sku=${encodeURIComponent(product.sku)}`;

/**
 * Stock label: "In stock", "Only 6 left" (10 or fewer) or "Out of stock".
 * @param {number|null} stock Units in stock
 */
export function stockLabel(stock) {
  if (stock === null) return { text: 'In stock', state: 'in' };
  if (stock <= 0) return { text: 'Out of stock', state: 'out' };
  if (stock <= 10) return { text: `Only ${stock} left`, state: 'low' };
  return { text: 'In stock', state: 'in' };
}

/**
 * Price block: regular price plus the member price, when there is one.
 * @param {object} product Product
 * @returns {HTMLElement}
 */
export function buildPrice(product) {
  const wrap = document.createElement('p');
  wrap.className = 'product-price';
  if (product.price !== null) {
    const price = document.createElement('span');
    price.className = 'product-price-regular';
    price.textContent = formatPrice(product.price);
    wrap.append(price);
  }
  if (product.memberPrice !== null) {
    const member = document.createElement('span');
    member.className = 'product-price-member';
    member.textContent = `Member price ${formatPrice(product.memberPrice)}`;
    wrap.append(member);
  }
  return wrap;
}

/**
 * Reads optional "Label | value" rows of a block (labels lower-cased).
 * @param {Element} block The block
 */
export function readConfig(block) {
  const config = {};
  [...block.children].forEach((row) => {
    const [label, value] = row.children;
    if (!label || !value) return;
    const key = label.textContent.trim().toLowerCase().replace(/\s+/g, ' ');
    const link = value.querySelector('a[href]');
    config[key] = link ? link.getAttribute('href') : value.textContent.trim();
  });
  return config;
}

/**
 * A same-site path from an authored value, or the fallback.
 * @param {string} value Authored path or URL
 * @param {string} fallback Default path
 */
export function sitePath(value, fallback) {
  if (!value) return fallback;
  try {
    const url = new URL(value, window.location);
    return url.pathname.replace(/\.html$/, '') || fallback;
  } catch (e) {
    return fallback;
  }
}
