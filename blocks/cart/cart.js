/*
 * cart — the shop cart page (/us/en/shop/cart). Lists every product in the
 * cart (scripts/cart.js) with photo, unit price, quantity − / +, remove and
 * line total, then the order summary (items, member savings, shipping, total)
 * with Checkout and Continue shopping.
 *
 * Prices come from the product API; signed-in members (checked with the
 * worker) pay the member price. Free shipping from FREE_SHIPPING_FROM.
 * Authored block: no rows needed.
 */

import { createOptimizedPicture } from '../../scripts/aem.js';
import { SHOP_PAGE, formatPrice, productUrl } from '../../scripts/products.js';
import {
  CHECKOUT_PAGE, FREE_SHIPPING_FROM, buildTotals, pricedCart, removeFromCart, setQuantity,
} from '../../scripts/cart.js';

function link(text, href, className) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  if (className) a.className = className;
  return a;
}

function stepButton(label, text, onClick, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cart-qty-step';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

function buildLine(line, cart) {
  const { product, qty, unit } = line;
  const li = document.createElement('li');
  li.className = 'cart-line';

  const media = document.createElement('div');
  media.className = 'cart-line-image';
  if (product.image) media.append(createOptimizedPicture(product.image, '', false, [{ width: '240' }]));

  const info = document.createElement('div');
  info.className = 'cart-line-info';
  const name = document.createElement('h2');
  name.append(link(product.name, productUrl(product)));
  const price = document.createElement('p');
  price.className = 'cart-line-unit';
  price.textContent = cart.member && unit < product.price
    ? `${formatPrice(unit)} each (member price, was ${formatPrice(product.price)})`
    : `${formatPrice(unit)} each`;
  info.append(name, price);

  const qtyBox = document.createElement('div');
  qtyBox.className = 'cart-line-qty';
  const value = document.createElement('span');
  value.className = 'cart-qty-value';
  value.textContent = String(qty);
  value.setAttribute('aria-label', `Quantity ${qty}`);
  qtyBox.append(
    stepButton(`Decrease quantity of ${product.name}`, '−', () => setQuantity(product.sku, qty - 1, line.max), false),
    value,
    stepButton(`Increase quantity of ${product.name}`, '+', () => setQuantity(product.sku, qty + 1, line.max), qty >= line.max),
  );
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cart-line-remove';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove ${product.name} from cart`);
  remove.addEventListener('click', () => removeFromCart(product.sku));
  qtyBox.append(remove);

  const total = document.createElement('p');
  total.className = 'cart-line-total';
  total.textContent = formatPrice(line.total);

  li.append(media, info, qtyBox, total);
  return li;
}

async function render(block) {
  const cart = await pricedCart();
  if (!cart.lines.length) {
    const empty = document.createElement('div');
    empty.className = 'cart-empty';
    const p = document.createElement('p');
    p.textContent = 'Your cart is empty.';
    const cta = document.createElement('p');
    cta.className = 'button-wrapper';
    cta.append(link('Continue shopping', SHOP_PAGE, 'button primary'));
    empty.append(p, cta);
    block.replaceChildren(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'cart-lines';
  list.setAttribute('aria-label', `${cart.count} ${cart.count === 1 ? 'item' : 'items'} in your cart`);
  cart.lines.forEach((line) => list.append(buildLine(line, cart)));

  const summary = document.createElement('aside');
  summary.className = 'cart-summary';
  const h = document.createElement('h2');
  h.textContent = 'Order summary';
  summary.append(h, buildTotals(cart));
  if (!cart.member) {
    const hint = document.createElement('p');
    hint.className = 'cart-hint';
    hint.textContent = 'Members pay the member price — sign in to save.';
    summary.append(hint);
  }
  if (cart.shipping) {
    const ship = document.createElement('p');
    ship.className = 'cart-hint';
    ship.textContent = `Add ${formatPrice(FREE_SHIPPING_FROM - cart.subtotal)} more for free shipping.`;
    summary.append(ship);
  }
  const actions = document.createElement('div');
  actions.className = 'cart-actions';
  actions.append(link('Checkout', CHECKOUT_PAGE, 'button primary'), link('Continue shopping', SHOP_PAGE, 'cart-continue'));
  summary.append(actions);

  block.replaceChildren(list, summary);
}

export default async function decorate(block) {
  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');
  await render(block);
  block.removeAttribute('aria-busy');
  window.addEventListener('cart:change', () => render(block));
}
