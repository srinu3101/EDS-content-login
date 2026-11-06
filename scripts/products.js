/*
 * products — the demo product API shared by the product-list (PLP) and
 * product-details (PDP) blocks.
 *
 * The catalog is a Document Authoring sheet (/data/products) that Edge
 * Delivery serves as JSON: { data: [{ sku, name, category, price,
 * memberPrice, stock, image, description }, …] }.
 */

export const PRODUCTS_PATH = '/data/products.json';
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

/**
 * Loads and normalises the catalog; rows without a sku or name are skipped.
 * @param {string} [path] JSON address of the products sheet
 * @returns {Promise<Array>} products, or [] when the API can't be read
 */
export async function fetchProducts(path = PRODUCTS_PATH) {
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
