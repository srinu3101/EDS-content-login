/*
 * product-reviews — customer reviews for one product, on the product page.
 *
 * Reads /commerce/reviews/{sku}.json from the Cloudflare worker (Bazaarvoice
 * Conversations API format — a mock Bazaarvoice from the /data/reviews sheet
 * until a Bazaarvoice passkey is set) and shows the average stars, the star
 * breakdown (click a row to filter), the reviews (sort, show more) and a
 * "Write a review" form (POST to the same address; answered "awaiting
 * moderation"). Hidden on hosts without the worker (Adobe hosts, local dev).
 *
 * Authored block, every row optional:
 *   "Title"    | Customer reviews   → heading
 *   "SKU"      | CAMP-001           → product (default: ?sku= of the page)
 *   "Per Page" | 5                  → reviews shown before "Show more"
 */

import { hasWorker, readConfig, reviewsPath } from '../../scripts/products.js';

const PER_PAGE = 5;
const RATING_WORDS = ['', 'Terrible', 'Poor', 'Average', 'Good', 'Excellent'];

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
});

// small element helper: el('p', { className: 'x' }, 'text', child)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key in node && !key.startsWith('aria') && key !== 'role') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  });
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function stars(rating, label) {
  const wrap = el('span', { className: 'product-reviews-stars', role: 'img', 'aria-label': label });
  wrap.style.setProperty('--rating', `${Math.max(0, Math.min(100, (rating / 5) * 100))}%`);
  return wrap;
}

const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
};

function buildSummary(stats) {
  const average = Math.round((stats.AverageOverallRating || 0) * 10) / 10;
  const count = stats.TotalReviewCount || 0;
  const recommended = stats.RecommendedCount || 0;
  const answered = recommended + (stats.NotRecommendedCount || 0);
  return el(
    'div',
    { className: 'product-reviews-summary' },
    el('p', { className: 'product-reviews-average' }, average.toFixed(1)),
    stars(average, `Rated ${average} out of 5`),
    el('p', { className: 'product-reviews-count' }, `Based on ${count} ${count === 1 ? 'review' : 'reviews'}`),
    answered ? el(
      'p',
      { className: 'product-reviews-recommend' },
      `${Math.round((recommended / answered) * 100)}% would recommend this product`,
    ) : null,
  );
}

// 5★ … 1★ rows with a bar; a click filters the list to that star rating
function buildBreakdown(stats, onFilter) {
  const total = stats.TotalReviewCount || 0;
  const counts = new Map((stats.RatingDistribution || []).map((d) => [d.RatingValue, d.Count]));
  const list = el('ul', { className: 'product-reviews-breakdown', 'aria-label': 'Filter reviews by stars' });
  [5, 4, 3, 2, 1].forEach((value) => {
    const count = counts.get(value) || 0;
    const bar = el('span', { className: 'product-reviews-bar', 'aria-hidden': 'true' });
    bar.style.setProperty('--share', `${total ? (count / total) * 100 : 0}%`);
    const button = el(
      'button',
      {
        type: 'button',
        className: 'product-reviews-filter',
        disabled: count === 0,
        'aria-pressed': 'false',
        'aria-label': `${value} ${value === 1 ? 'star' : 'stars'}: ${count} ${count === 1 ? 'review' : 'reviews'}`,
      },
      el('span', { 'aria-hidden': 'true' }, `${value} ★`),
      bar,
      el('span', { 'aria-hidden': 'true' }, String(count)),
    );
    button.dataset.value = String(value);
    button.addEventListener('click', () => onFilter(value));
    list.append(el('li', {}, button));
  });
  return list;
}

function buildReview(review) {
  const meta = [review.UserNickname, review.UserLocation, formatDate(review.SubmissionTime)]
    .filter(Boolean).join(' · ');
  return el(
    'li',
    { className: 'product-reviews-item' },
    stars(review.Rating, `${review.Rating} out of 5 stars`),
    review.Title ? el('h3', {}, review.Title) : null,
    el('p', { className: 'product-reviews-meta' }, meta),
    el('p', { className: 'product-reviews-text' }, review.ReviewText || ''),
    review.IsRecommended === true
      ? el('p', { className: 'product-reviews-recommended' }, '✓ Recommends this product') : null,
  );
}

const SORTS = {
  newest: (a, b) => String(b.SubmissionTime).localeCompare(String(a.SubmissionTime)),
  highest: (a, b) => b.Rating - a.Rating || SORTS.newest(a, b),
  lowest: (a, b) => a.Rating - b.Rating || SORTS.newest(a, b),
  helpful: (a, b) => (b.TotalPositiveFeedbackCount || 0) - (a.TotalPositiveFeedbackCount || 0)
    || SORTS.newest(a, b),
};

// field name in Bazaarvoice FormErrors → our form field
const FIELD_NAMES = {
  rating: 'rating', title: 'title', reviewtext: 'text', usernickname: 'name',
};

function buildForm(sku, uid) {
  const form = el('form', { className: 'product-reviews-form', noValidate: true });
  const errors = {};
  const field = (name, label, input, hint) => {
    const error = el('p', { className: 'product-reviews-error', id: `${uid}-${name}-error` });
    errors[name] = { error, input };
    input.setAttribute('aria-describedby', error.id);
    return el(
      'div',
      { className: 'product-reviews-field' },
      el('label', { htmlFor: input.id }, label),
      hint ? el('p', { className: 'product-reviews-hint' }, hint) : null,
      input,
      error,
    );
  };

  const ratingError = el('p', { className: 'product-reviews-error', id: `${uid}-rating-error` });
  const ratingSet = el(
    'fieldset',
    { className: 'product-reviews-rating', 'aria-describedby': ratingError.id },
    el('legend', {}, 'Your rating'),
  );
  [5, 4, 3, 2, 1].forEach((value) => {
    const id = `${uid}-rating-${value}`;
    ratingSet.append(el(
      'span',
      { className: 'product-reviews-choice' },
      el('input', {
        type: 'radio', name: 'rating', id, value: String(value), required: true,
      }),
      el('label', { htmlFor: id }, `${'★'.repeat(value)} ${RATING_WORDS[value]}`),
    ));
  });
  ratingSet.append(ratingError);
  errors.rating = { error: ratingError, input: ratingSet };

  const title = el('input', {
    type: 'text', id: `${uid}-title`, name: 'title', maxLength: 100, required: true, autocomplete: 'off',
  });
  const text = el('textarea', {
    id: `${uid}-text`, name: 'text', rows: 5, minLength: 20, maxLength: 5000, required: true,
  });
  const name = el('input', {
    type: 'text', id: `${uid}-name`, name: 'name', maxLength: 25, required: true, autocomplete: 'nickname',
  });
  const recommend = el('input', { type: 'checkbox', id: `${uid}-recommend`, name: 'recommended' });
  const status = el('p', { className: 'product-reviews-status', role: 'status' });
  const submit = el('button', { type: 'submit', className: 'button primary' }, 'Submit review');

  form.append(
    ratingSet,
    field('title', 'Review title', title),
    field('text', 'Your review', text, 'At least 20 characters.'),
    field('name', 'Your name', name, 'Shown with your review.'),
    el('div', { className: 'product-reviews-check' }, recommend, el('label', { htmlFor: recommend.id }, 'I would recommend this product')),
    el('p', { className: 'product-reviews-hint' }, 'Reviews are checked before they appear.'),
    submit,
    status,
  );

  const showErrors = (fieldErrors) => {
    let first = null;
    Object.values(errors).forEach(({ error, input }) => {
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    });
    Object.entries(fieldErrors || {}).forEach(([key, value]) => {
      const target = errors[FIELD_NAMES[key.toLowerCase()]];
      if (!target) return;
      target.error.textContent = value.Message || 'Please check this field.';
      target.input.setAttribute('aria-invalid', 'true');
      if (!first) first = target.input;
    });
    if (first) (first.querySelector ? first.querySelector('input') || first : first).focus();
    return Boolean(first);
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    submit.disabled = true;
    status.textContent = 'Sending…';
    try {
      const resp = await fetch(reviewsPath(sku), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rating: Number(data.get('rating')) || 0,
          title: data.get('title'),
          text: data.get('text'),
          name: data.get('name'),
          recommended: recommend.checked,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && !json.HasErrors) {
        const done = el(
          'div',
          { className: 'product-reviews-thanks', role: 'status', tabIndex: -1 },
          el('p', {}, json.message || 'Thanks! Your review is waiting for moderation.'),
        );
        form.replaceWith(done);
        done.focus();
        return;
      }
      const shown = showErrors(json.FormErrors && json.FormErrors.FieldErrors);
      status.textContent = shown ? 'Please check the highlighted fields.' : 'Your review could not be sent. Please try again later.';
    } catch (err) {
      status.textContent = 'Your review could not be sent. Please try again later.';
    }
    submit.disabled = false;
  });
  return form;
}

export default async function decorate(block) {
  const config = readConfig(block);
  const sku = (config.sku || new URLSearchParams(window.location.search).get('sku') || '').trim();
  const perPage = Math.max(1, Math.min(50, Number(config['per page']) || PER_PAGE));
  const titleText = config.title || 'Customer reviews';
  block.replaceChildren();
  if (!sku || !hasWorker()) {
    block.hidden = true;
    return;
  }
  block.setAttribute('aria-busy', 'true');

  let json = null;
  try {
    const resp = await fetch(reviewsPath(sku));
    json = resp.ok ? await resp.json() : null;
  } catch (e) {
    json = null;
  }
  block.removeAttribute('aria-busy');
  if (!json || json.HasErrors || !Array.isArray(json.Results)) {
    block.hidden = true;
    return;
  }

  const reviews = json.Results.filter((r) => r && r.Rating);
  const productId = Object.keys((json.Includes && json.Includes.Products) || {})[0];
  const stats = (productId && json.Includes.Products[productId].ReviewStatistics) || {};
  const uid = `reviews-${sku.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
  const heading = el('h2', { id: 'reviews' }, titleText);

  // write a review (form opens below the button)
  const writeButton = el('button', { type: 'button', className: 'button secondary', 'aria-expanded': 'false' }, 'Write a review');
  const formSlot = el('div', { className: 'product-reviews-write', hidden: true });
  writeButton.setAttribute('aria-controls', `${uid}-write`);
  formSlot.id = `${uid}-write`;
  writeButton.addEventListener('click', () => {
    const open = writeButton.getAttribute('aria-expanded') !== 'true';
    writeButton.setAttribute('aria-expanded', String(open));
    formSlot.hidden = !open;
    if (open && !formSlot.firstChild) formSlot.append(buildForm(sku, uid));
    if (open) formSlot.querySelector('input').focus();
  });

  const source = json.source === 'mock-bazaarvoice'
    ? 'Demo reviews in the Bazaarvoice format.' : 'Reviews powered by Bazaarvoice.';
  const note = el('p', { className: 'product-reviews-source' }, source);

  if (!reviews.length) {
    block.append(
      heading,
      el('p', { className: 'product-reviews-empty' }, 'No reviews yet. Be the first to review this product.'),
      writeButton,
      formSlot,
      note,
    );
    return;
  }

  // list with filter (stars), sort and "Show more"
  let filter = 0;
  let sort = 'newest';
  let shown = perPage;
  const list = el('ol', { className: 'product-reviews-list' });
  const count = el('p', { className: 'product-reviews-showing', 'aria-live': 'polite' });
  const more = el('button', { type: 'button', className: 'button secondary product-reviews-more' }, 'Show more reviews');
  const clear = el('button', { type: 'button', className: 'product-reviews-clear', hidden: true }, 'Show all reviews');
  const breakdown = buildBreakdown(stats, (value) => {
    filter = filter === value ? 0 : value;
    shown = perPage;
    // eslint-disable-next-line no-use-before-define
    render();
  });

  function render() {
    const matching = reviews.filter((r) => !filter || r.Rating === filter).sort(SORTS[sort]);
    list.replaceChildren(...matching.slice(0, shown).map(buildReview));
    more.hidden = matching.length <= shown;
    clear.hidden = !filter;
    breakdown.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.value) === filter)));
    const of = json.TotalResults > reviews.length && !filter ? ` (latest ${reviews.length} of ${json.TotalResults})` : '';
    count.textContent = `Showing ${Math.min(shown, matching.length)} of ${matching.length}${filter ? ` ${filter}-star` : ''} ${matching.length === 1 ? 'review' : 'reviews'}${of}`;
  }

  const sortId = `${uid}-sort`;
  const select = el('select', { id: sortId });
  [['newest', 'Newest'], ['highest', 'Highest rating'], ['lowest', 'Lowest rating'], ['helpful', 'Most helpful']]
    .forEach(([value, label]) => select.add(new Option(label, value)));
  select.addEventListener('change', () => {
    sort = select.value;
    render();
  });
  more.addEventListener('click', () => {
    shown += perPage;
    render();
  });
  clear.addEventListener('click', () => {
    filter = 0;
    render();
  });

  const toolbar = el(
    'div',
    { className: 'product-reviews-toolbar' },
    count,
    clear,
    el('div', { className: 'product-reviews-sort' }, el('label', { htmlFor: sortId }, 'Sort by'), select),
  );
  render();

  block.append(
    heading,
    el(
      'div',
      { className: 'product-reviews-layout' },
      el('div', { className: 'product-reviews-side' }, buildSummary(stats), breakdown, writeButton),
      el('div', { className: 'product-reviews-main' }, formSlot, toolbar, list, more),
    ),
    note,
  );
}
