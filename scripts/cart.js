/*
 * cart — the demo shop cart, kept in the visitor's browser (localStorage).
 *
 * Only SKUs and quantities are stored; prices always come from the server,
 * so nothing in the browser can change a price. With the Cloudflare worker
 * the cart is priced by POST /commerce/cart (live prices, member price when
 * signed in, live stock — never cached); without it (Adobe hosts, local dev,
 * or the cart API failing) from the product API (scripts/products.js), with
 * sign-in checked by /auth/me, never by the hint cookie.
 * Every change fires a `cart:change` event on window ({ detail: { count } }).
 */

import { fetchProducts, formatPrice, hasWorker } from './products.js';

const KEY = 'wknd-cart';
export const MAX_QTY = 10;
export const CART_PAGE = '/us/en/shop/cart';
export const CHECKOUT_PAGE = '/us/en/shop/checkout';
export const FREE_SHIPPING_FROM = 200;
export const SHIPPING_COST = 10;
const CART_API = '/commerce/cart';

const clampQty = (qty, max = MAX_QTY) => Math.max(0, Math.min(Math.floor(Number(qty) || 0), max));

/**
 * Cart lines: [{ sku, qty }].
 * @returns {Array<{sku: string, qty: number}>}
 */
export function getCart() {
  try {
    const lines = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(lines)
      ? lines.filter((l) => l && typeof l.sku === 'string' && clampQty(l.qty) > 0)
        .map((l) => ({ sku: l.sku, qty: clampQty(l.qty) }))
      : [];
  } catch (e) {
    return [];
  }
}

/**
 * Number of items (sum of quantities).
 * @param {Array} [lines] Cart lines
 */
export const countItems = (lines = getCart()) => lines.reduce((n, l) => n + l.qty, 0);

function save(lines) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch (e) { /* storage full or blocked: the cart just isn't kept */ }
  window.dispatchEvent(new CustomEvent('cart:change', { detail: { count: countItems(lines) } }));
}

/**
 * Adds a quantity of a product; the line never exceeds `max`.
 * @param {string} sku Product SKU
 * @param {number} qty Quantity to add
 * @param {number} [max] Upper limit (stock), at most MAX_QTY
 * @returns {number} the line's new quantity
 */
export function addToCart(sku, qty = 1, max = MAX_QTY) {
  const limit = Math.min(MAX_QTY, max);
  const lines = getCart();
  const line = lines.find((l) => l.sku === sku);
  if (line) line.qty = clampQty(line.qty + qty, limit);
  else lines.push({ sku, qty: clampQty(qty, limit) });
  save(lines.filter((l) => l.qty > 0));
  return (lines.find((l) => l.sku === sku) || { qty: 0 }).qty;
}

/**
 * Sets a line's quantity (0 removes it).
 * @param {string} sku Product SKU
 * @param {number} qty New quantity
 * @param {number} [max] Upper limit (stock)
 */
export function setQuantity(sku, qty, max = MAX_QTY) {
  const lines = getCart()
    .map((l) => (l.sku === sku ? { ...l, qty: clampQty(qty, Math.min(MAX_QTY, max)) } : l))
    .filter((l) => l.qty > 0);
  save(lines);
}

export const removeFromCart = (sku) => setQuantity(sku, 0);

export const clearCart = () => save([]);

// keep other tabs' cart badges in step
window.addEventListener('storage', (e) => {
  if (e.key === KEY) window.dispatchEvent(new CustomEvent('cart:change', { detail: { count: countItems() } }));
});

let member;
/**
 * Whether the visitor is a signed-in member (asks the worker once per page).
 * Adobe hosts and local dev have no worker → not a member.
 * @returns {Promise<boolean>}
 */
export function isMember() {
  if (!member) {
    member = !hasWorker() ? Promise.resolve(false)
      : fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : {}))
        .then((u) => u.signedIn === true)
        .catch(() => false);
  }
  return member;
}

// the cart priced in the browser from the product API (fallback)
async function localPricedCart() {
  const [products, signedIn] = await Promise.all([fetchProducts(), isMember()]);
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const lines = getCart()
    .map((l) => {
      const product = bySku.get(l.sku);
      if (!product || product.price === null) return null;
      const stock = product.stock === null ? MAX_QTY : product.stock;
      const qty = Math.min(l.qty, stock, MAX_QTY);
      if (qty <= 0) return null;
      const unit = signedIn && product.memberPrice !== null ? product.memberPrice : product.price;
      return {
        product,
        qty,
        unit,
        regular: product.price * qty,
        total: unit * qty,
        max: Math.min(stock, MAX_QTY),
      };
    })
    .filter(Boolean);
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const regular = lines.reduce((s, l) => s + l.regular, 0);
  const shipping = !lines.length || subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_COST;
  return {
    lines,
    count: lines.reduce((n, l) => n + l.qty, 0),
    subtotal,
    regular,
    savings: regular - subtotal,
    shipping,
    total: subtotal + shipping,
    member: signedIn,
    notices: [],
  };
}

async function serverCart(lines) {
  try {
    const resp = await fetch(CART_API, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: lines }),
    });
    const json = resp.ok ? await resp.json() : null;
    return json && Array.isArray(json.lines) ? json : null;
  } catch (e) {
    return null;
  }
}

/**
 * The cart priced with live prices and stock: unknown or sold-out products are
 * dropped and quantities are capped at the stock, with a notice for each.
 * @returns {Promise<{lines: Array, count: number, subtotal: number, regular: number,
 *   savings: number, shipping: number, total: number, member: boolean, notices: string[]}>}
 */
export async function pricedCart() {
  const lines = getCart();
  if (!hasWorker() || !lines.length) return localPricedCart();
  const [products, server] = await Promise.all([fetchProducts(), serverCart(lines)]);
  const bySku = new Map(products.map((p) => [p.sku, p]));
  if (!server || !server.lines.every((l) => bySku.has(l.sku))) return localPricedCart();
  const name = (sku) => (bySku.get(sku) || { name: sku }).name;
  return {
    lines: server.lines.map((l) => ({
      product: { ...bySku.get(l.sku), price: l.price, memberPrice: l.memberPrice },
      qty: l.qty,
      unit: l.unit,
      regular: l.regular,
      total: l.total,
      max: l.max,
    })),
    count: server.count,
    subtotal: server.subtotal,
    regular: server.regular,
    savings: server.savings,
    shipping: server.shipping,
    total: server.total,
    member: server.member === true,
    notices: [
      ...(server.adjusted || []).map((a) => `${name(a.sku)}: ${a.reason}, quantity set to ${a.qty}.`),
      ...(server.removed || []).map((r) => `${name(r.sku)} is ${r.reason} and is not included.`),
    ],
  };
}

/**
 * Order totals as a definition list: items, subtotal, member savings,
 * shipping and total.
 * @param {object} cart Result of pricedCart()
 * @returns {HTMLElement}
 */
export function buildTotals(cart) {
  const dl = document.createElement('dl');
  dl.className = 'cart-totals';
  const row = (label, value, className) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (className) {
      dt.className = className;
      dd.className = className;
    }
    dl.append(dt, dd);
  };
  row(`Items (${cart.count})`, formatPrice(cart.regular));
  if (cart.savings > 0) row('Member savings', `−${formatPrice(cart.savings)}`, 'cart-totals-savings');
  row('Shipping', cart.shipping ? formatPrice(cart.shipping) : 'Free');
  row('Total', formatPrice(cart.total), 'cart-totals-total');
  return dl;
}
