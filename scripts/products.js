/*
 * products — the product APIs shared by the shop blocks (product-list,
 * product-details, product-reviews, cart, checkout).
 *
 * Products come from Shopify through the Cloudflare worker as separate APIs,
 * each cached for its own time and refreshed when its data changes:
 *   /commerce/catalog.json      name, category, photo        (1 hour)
 *   /commerce/prices.json       price, member price          (15 minutes)
 *   /commerce/inventory.json    stock                        (10 seconds)
 *   /commerce/product/{sku}.json  description, photos (PDP)  (1 hour)
 *   /commerce/ratings.json      stars + review count         (1 hour)
 * Fallbacks: the all-in-one /commerce/products.json, then the Document
 * Authoring sheet /data/products (always on Adobe hosts and local dev, which
 * have no worker). Every list has the shape { sku, name, category, price,
 * memberPrice, stock, image, description }.
 */

export const PRODUCTS_PATH = '/commerce/products.json';
export const CATALOG_PATH = '/commerce/catalog.json';
export const PRICES_PATH = '/commerce/prices.json';
export const INVENTORY_PATH = '/commerce/inventory.json';
export const RATINGS_PATH = '/commerce/ratings.json';
export const productPath = (sku) => `/commerce/product/${encodeURIComponent(sku)}.json`;
export const reviewsPath = (sku) => `/commerce/reviews/${encodeURIComponent(sku)}.json`;
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

const normalise = (row) => ({
  sku: String(row.sku || '').trim(),
  name: String(row.name || '').trim(),
  category: String(row.category || '').trim(),
  price: toNumber(row.price),
  memberPrice: toNumber(row.memberPrice),
  stock: toNumber(row.stock),
  image: String(row.image || '').trim(),
  description: String(row.description || '').trim(),
});

async function getJson(path) {
  try {
    const resp = await fetch(path);
    return resp.ok ? await resp.json() : null;
  } catch (e) {
    return null;
  }
}

async function loadProducts(path) {
  const url = new URL(path, window.location);
  url.searchParams.set('limit', '1000');
  const json = await getJson(url);
  const rows = json && Array.isArray(json.data) ? json.data : [];
  return rows.map(normalise).filter((p) => p.sku && p.name);
}

// catalog + prices + inventory, merged by SKU ([] when one of them is missing)
async function loadSplit() {
  const [catalog, prices, inventory] = await Promise.all(
    [CATALOG_PATH, PRICES_PATH, INVENTORY_PATH].map(getJson),
  );
  const rows = (json) => (json && Array.isArray(json.data) ? json.data : null);
  if (!rows(catalog) || !rows(prices) || !rows(inventory)) return [];
  const price = new Map(rows(prices).map((p) => [p.sku, p]));
  const stock = new Map(rows(inventory).map((p) => [p.sku, p]));
  return rows(catalog)
    .map((row) => normalise({
      ...row,
      price: (price.get(row.sku) || {}).price,
      memberPrice: (price.get(row.sku) || {}).memberPrice,
      stock: (stock.get(row.sku) || {}).stock,
    }))
    .filter((p) => p.sku && p.name && p.price !== null);
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
    // the worker's separate APIs first, then the all-in-one, then the sheet
    const load = path === PRODUCTS_PATH
      ? loadSplit().then((split) => (split.length ? split : loadProducts(path)))
      : loadProducts(path);
    loaded.set(path, load.then(fallback));
  }
  return loaded.get(path);
}

/**
 * One product for the product page: the list entry (price, stock) plus its
 * details from /commerce/product/{sku}.json (description, photos).
 * @param {string} sku SKU, any case
 * @param {string} [path] JSON address of the product list
 * @returns {Promise<object|null>} product with `images: [{ url, alt }]`, or null
 */
export async function fetchProduct(sku, path = PRODUCTS_PATH) {
  const wanted = String(sku || '').trim().toLowerCase();
  if (!wanted) return null;
  const product = (await fetchProducts(path)).find((p) => p.sku.toLowerCase() === wanted);
  if (!product) return null;
  const useWorker = path === PRODUCTS_PATH && hasWorker();
  const detail = useWorker ? await getJson(productPath(product.sku)) : null;
  const images = (detail && Array.isArray(detail.images) ? detail.images : [])
    .filter((i) => i && i.url).map((i) => ({ url: i.url, alt: i.alt || '' }));
  if (!images.length && product.image) images.push({ url: product.image, alt: '' });
  return {
    ...product,
    description: (detail && detail.description) || product.description,
    images,
  };
}

let ratings;
/**
 * Stars and review count per SKU from /commerce/ratings.json (Bazaarvoice
 * statistics format). Empty without the worker.
 * @returns {Promise<Map<string, {average: number, count: number}>>}
 */
export function fetchRatings() {
  if (!ratings) {
    ratings = (hasWorker() ? getJson(RATINGS_PATH) : Promise.resolve(null)).then((json) => new Map(
      ((json && json.Results) || [])
        .map((r) => r.ProductStatistics || {})
        .filter((p) => p.ProductId && p.ReviewStatistics)
        .map((p) => [p.ProductId, {
          average: Number(p.ReviewStatistics.AverageOverallRating) || 0,
          count: Number(p.ReviewStatistics.TotalReviewCount) || 0,
        }]),
    ));
  }
  return ratings;
}

/**
 * Star rating: ★★★★☆ 4.3 (12). Read out as "Rated 4.3 out of 5, 12 reviews".
 * @param {{average: number, count: number}} rating Average and count
 * @param {string} [href] Optional link (e.g. to the reviews)
 * @returns {HTMLElement}
 */
export function buildRating(rating, href) {
  const wrap = document.createElement(href ? 'a' : 'span');
  wrap.className = 'product-rating';
  if (href) wrap.href = href;
  const average = Math.round(rating.average * 10) / 10;
  const label = `Rated ${average} out of 5, ${rating.count} ${rating.count === 1 ? 'review' : 'reviews'}`;
  if (href) wrap.setAttribute('aria-label', label);
  else {
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', label);
  }
  const stars = document.createElement('span');
  stars.className = 'product-rating-stars';
  stars.setAttribute('aria-hidden', 'true');
  stars.style.setProperty('--rating', `${Math.max(0, Math.min(100, (rating.average / 5) * 100))}%`);
  const text = document.createElement('span');
  text.className = 'product-rating-text';
  text.setAttribute('aria-hidden', 'true');
  text.textContent = `${average.toFixed(1)} (${rating.count})`;
  wrap.append(stars, text);
  return wrap;
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
