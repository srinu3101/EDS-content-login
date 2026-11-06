/*
 * checkout — the shop checkout (/us/en/shop/checkout): contact and delivery
 * details, payment method and "Place order", then an order confirmation.
 *
 * DEMO ONLY: no payment is taken and nothing is sent anywhere — the order
 * number is made up in the browser and the cart is emptied. No card numbers
 * are asked for. Guest checkout; signed-in members pay the member price
 * (scripts/cart.js). Authored block: no rows needed.
 */

import { SHOP_PAGE, formatPrice } from '../../scripts/products.js';
import {
  CART_PAGE, buildTotals, clearCart, pricedCart,
} from '../../scripts/cart.js';

const PAYMENT_METHODS = [
  ['card', 'Credit / debit card'],
  ['upi', 'UPI'],
  ['paypal', 'PayPal'],
  ['cod', 'Cash on delivery'],
];

const COUNTRIES = ['India', 'United States', 'United Kingdom', 'Germany', 'Australia', 'Canada'];

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  });
  node.append(...children);
  return node;
};

function field(id, label, attrs = {}) {
  const wrap = el('div', { className: 'checkout-field' });
  wrap.append(el('label', { for: id, text: label }), el('input', { id, name: id, ...attrs }));
  return wrap;
}

function countryField() {
  const wrap = el('div', { className: 'checkout-field' });
  const select = el('select', { id: 'checkout-country', name: 'country', autocomplete: 'country-name' });
  COUNTRIES.forEach((c) => select.add(new Option(c, c)));
  wrap.append(el('label', { for: 'checkout-country', text: 'Country' }), select);
  return wrap;
}

function paymentFieldset() {
  const fs = el('fieldset', { className: 'checkout-payment' });
  fs.append(el('legend', { text: 'Payment method' }));
  PAYMENT_METHODS.forEach(([value, label], i) => {
    const id = `checkout-pay-${value}`;
    const input = el('input', {
      type: 'radio', id, name: 'payment', value, required: '',
    });
    if (i === 0) input.checked = true;
    fs.append(el('div', { className: 'checkout-radio' }, input, el('label', { for: id, text: label })));
  });
  fs.append(el('p', { className: 'checkout-demo', text: 'Demo checkout: no real payment is taken and no card details are asked for.' }));
  return fs;
}

function summary(cart) {
  const aside = el('aside', { className: 'checkout-summary' });
  aside.append(el('h2', { text: 'Your order' }));
  const list = el('ul', { className: 'checkout-lines' });
  cart.lines.forEach((l) => {
    list.append(el('li', {}, el('span', { text: `${l.qty} × ${l.product.name}` }), el('span', { text: formatPrice(l.total) })));
  });
  aside.append(list, buildTotals(cart));
  if (cart.member) aside.append(el('p', { className: 'checkout-member', text: 'Member prices applied.' }));
  aside.append(el('p', {}, el('a', { href: CART_PAGE, text: 'Edit cart' })));
  return aside;
}

function orderNumber() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 90000;
  return `WKND-${10000 + n}`;
}

function confirmation(block, cart, data) {
  const method = (PAYMENT_METHODS.find(([v]) => v === data.get('payment')) || ['', ''])[1];
  const firstName = String(data.get('name') || '').trim().split(/\s+/)[0];
  const box = el('div', { className: 'checkout-confirmation' });
  const heading = el('h2', { tabindex: '-1', text: `Thank you${firstName ? `, ${firstName}` : ''}!` });
  box.append(
    heading,
    el('p', { className: 'checkout-order-number' }, 'Your order ', el('strong', { text: orderNumber() }), ' has been placed.'),
    el('p', { text: `Payment method: ${method}. Delivery to ${data.get('address')}, ${data.get('city')} ${data.get('postcode')}, ${data.get('country')}.` }),
  );
  const list = el('ul', { className: 'checkout-lines' });
  cart.lines.forEach((l) => {
    list.append(el('li', {}, el('span', { text: `${l.qty} × ${l.product.name}` }), el('span', { text: formatPrice(l.total) })));
  });
  box.append(list, buildTotals(cart));
  box.append(el('p', { className: 'checkout-demo', text: `Demo order: no payment was taken and no email is sent to ${data.get('email')}.` }));
  box.append(el('p', { className: 'button-wrapper' }, el('a', { href: SHOP_PAGE, className: 'button primary', text: 'Continue shopping' })));
  block.replaceChildren(box);
  heading.focus();
  block.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function render(block) {
  const cart = await pricedCart();
  if (!cart.lines.length) {
    block.replaceChildren(el(
      'div',
      { className: 'checkout-empty' },
      el('p', { text: 'Your cart is empty, so there is nothing to check out yet.' }),
      el('p', { className: 'button-wrapper' }, el('a', { href: SHOP_PAGE, className: 'button primary', text: 'Go to the Shop' })),
    ));
    return;
  }

  const form = el('form', { className: 'checkout-form', novalidate: '' });
  const contact = el('fieldset', {}, el('legend', { text: 'Contact' }));
  contact.append(
    field('name', 'Full name', { required: '', autocomplete: 'name' }),
    field('email', 'Email', { type: 'email', required: '', autocomplete: 'email' }),
    field('phone', 'Phone (optional)', { type: 'tel', autocomplete: 'tel' }),
  );
  const delivery = el('fieldset', {}, el('legend', { text: 'Delivery address' }));
  delivery.append(
    field('address', 'Street address', { required: '', autocomplete: 'street-address' }),
    field('city', 'City', { required: '', autocomplete: 'address-level2' }),
    field('postcode', 'Postal code', { required: '', autocomplete: 'postal-code' }),
    countryField(),
  );
  const error = el('p', { className: 'checkout-error', role: 'alert' });
  const submit = el('button', { type: 'submit', className: 'button primary checkout-submit', text: `Place order · ${formatPrice(cart.total)}` });
  form.append(contact, delivery, paymentFieldset(), error, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      error.textContent = 'Please fill in the required fields.';
      form.querySelector('input:invalid, select:invalid')?.focus();
      return;
    }
    // re-price at the moment of ordering (prices or stock may have changed)
    const latest = await pricedCart();
    if (!latest.lines.length) {
      render(block);
      return;
    }
    const data = new FormData(form);
    clearCart();
    confirmation(block, latest, data);
  });

  block.replaceChildren(form, summary(cart));
}

export default async function decorate(block) {
  block.replaceChildren();
  block.setAttribute('aria-busy', 'true');
  await render(block);
  block.removeAttribute('aria-busy');
}
