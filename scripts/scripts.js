import {
  loadHeader,
  loadFooter,
  decorateIcons,
  decorateSections,
  decorateBlocks,
  decorateTemplateAndTheme,
  waitForFirstImage,
  loadSection,
  loadSections,
  loadCSS,
  buildBlock,
} from './aem.js';
import { applyGating, decorateAuthLinks } from './gated.js';

if (window.trustedTypes && window.trustedTypes.createPolicy) {
  const innerTT = window.trustedTypes.createPolicy('tt-inner', {
    createHTML: (s) => s, // avoid stack overflow
  });

  window.trustedTypes.createPolicy('default', {
    createHTML: (input, type, sink) => {
      let processedInput = input;
      if (/srcdoc\s*=/i.test(processedInput)) {
        const doc = new DOMParser().parseFromString(innerTT.createHTML(processedInput), 'text/html');
        doc.querySelectorAll('iframe[srcdoc]').forEach((el) => el.removeAttribute('srcdoc'));
        processedInput = doc.body.innerHTML;
      }
      if (sink.includes('createContextualFragment') || sink.includes('Document write')) {
        const doc = new DOMParser().parseFromString(innerTT.createHTML(processedInput), 'text/html');
        doc.querySelectorAll('script').forEach((el) => el.remove());
        processedInput = doc.body.innerHTML;
      }
      return processedInput;
    },
    createScriptURL: (input) => input,
    createScript: (input) => input,
  });
}

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

/**
 * Turns `/widgets/...` links into widget blocks.
 * @param {Element} main The container element
 */
function buildWidgetAutoBlocks(main) {
  const widgetLinks = [...main.querySelectorAll('a[href*="/widgets/"]')];
  widgetLinks.forEach((link) => {
    if (link.closest('.widget')) return;
    const newLink = link.cloneNode(true);
    const widgetBlock = buildBlock('widget', { elems: [newLink] });
    const p = link.closest('p');
    if (
      p
      && p.querySelectorAll('a').length === 1
      && p.querySelector('a') === link
      && p.textContent.trim() === link.textContent.trim()
    ) {
      p.replaceWith(widgetBlock);
    } else {
      link.replaceWith(widgetBlock);
    }
  });
}

/**
 * Builds all synthetic blocks in a container element.
 * @param {Element} main The container element
 */
function buildAutoBlocks(main) {
  try {
    // auto load `*/fragments/*` references
    const fragments = [...main.querySelectorAll('a[href*="/fragments/"]')].filter((f) => !f.closest('.fragment'));
    if (fragments.length > 0) {
      // eslint-disable-next-line import/no-cycle
      import('../blocks/fragment/fragment.js').then(({ loadFragment }) => {
        fragments.forEach(async (fragment) => {
          try {
            const { pathname } = new URL(fragment.href);
            const frag = await loadFragment(pathname);
            fragment.parentElement.replaceWith(...frag.children);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Fragment loading failed', error);
          }
        });
      });
    }
    buildWidgetAutoBlocks(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}

/**
 * Decorates formatted links to style them as buttons.
 * @param {HTMLElement} main The main container element
 */
function decorateButtons(main) {
  main.querySelectorAll('p a[href]').forEach((a) => {
    a.title = a.title || a.textContent;
    const p = a.closest('p');
    const text = a.textContent.trim();

    // never buttonize breadcrumb trail links — they are navigation, not CTAs
    if (a.closest('.breadcrumbs')) return;

    // quick structural checks
    if (a.querySelector('img') || p.textContent.trim() !== text) return;

    // skip URL display links
    try {
      if (new URL(a.href).href === new URL(text, window.location).href) return;
    } catch { /* continue */ }

    const strong = a.closest('strong');
    const em = a.closest('em');

    p.className = 'button-wrapper';
    a.className = 'button';
    if (strong && em) { // high-impact call-to-action
      a.classList.add('accent');
      const outer = strong.contains(em) ? strong : em;
      outer.replaceWith(a);
    } else if (strong) {
      a.classList.add('primary');
      strong.replaceWith(a);
    } else if (em) {
      a.classList.add('secondary');
      em.replaceWith(a);
    } else {
      // wknd authors CTAs as a bare, single-link paragraph (no strong/em).
      // Promote any such solo-link paragraph to the signature yellow CTA so
      // every CTA-style link renders uniformly across templates. This only
      // catches paragraphs whose sole content is one link — block links that
      // are not wrapped in <p> (breadcrumbs) or live inside a heading (card
      // titles) never match, and header/footer are decorated separately.
      a.classList.add('primary');
    }
  });
}

/**
 * The homepage's currently-live authored content is missing a section break
 * between "Recent Articles" and "Next Adventures" (both ended up in one
 * div), so they render as a single section — no gap, and the Featured
 * Article's grey band visually runs into "Recent Articles". The import
 * transformer now places new imports correctly, but existing content needs
 * a reimport to pick that up; split client-side in the meantime so it
 * renders correctly regardless. Harmless no-op once the content is fixed at
 * the source (the heading won't be found where this expects it).
 * @param {Element} main The main element
 */
function splitHomepageSections(main) {
  if (window.location.pathname !== '/us/en') return;
  const heading = [...main.querySelectorAll(':scope > div > h2')]
    .find((h) => h.textContent.trim() === 'Next Adventures');
  if (!heading) return;
  const parent = heading.parentElement;
  const siblings = [...parent.children];
  const newSection = document.createElement('div');
  siblings.slice(siblings.indexOf(heading)).forEach((el) => newSection.append(el));
  parent.after(newSection);
}

/**
 * Apply section-metadata to its section, then remove the metadata block.
 *
 * The vendored scripts/aem.js in this project does NOT process
 * `<div class="section-metadata">` (it neither reads the `style` rows to add a
 * class to the section nor removes the block). Without this, a section whose
 * metadata sets `style: faq` never gets the `faq` class — so the FAQ page's
 * two-column layout rule (`main .section.faq`) never applies — and the raw
 * "style / faq" table renders as a visible (and 404-loading) block. Replicate
 * the standard EDS behaviour here: read each section-metadata block's `style`
 * value(s), add them as classes to the parent section, and drop the block.
 * Runs after decorateSections (so wrappers exist) and before decorateBlocks
 * (so the block is gone before it would be turned into a real block).
 */
function applySectionMetadata(main) {
  main.querySelectorAll(':scope > .section .section-metadata').forEach((meta) => {
    const section = meta.closest('.section');
    [...meta.children].forEach((row) => {
      const cells = [...row.children];
      const key = (cells[0]?.textContent || '').trim().toLowerCase();
      const val = (cells[1]?.textContent || '').trim();
      if (key === 'style' && val) {
        val.split(',').forEach((cls) => {
          const token = cls.trim().replace(/\s+/g, '-').toLowerCase();
          if (token) section.classList.add(token);
        });
      }
    });
    // remove the metadata block and its wrapper so it isn't decorated/shown
    (meta.closest('.section-metadata-wrapper') || meta).remove();
  });

  // drop any now-empty section wrappers left behind — an empty grid item would
  // otherwise add a phantom row and break the FAQ two-column alignment.
  main.querySelectorAll(':scope > .section > div:empty').forEach((w) => w.remove());
}

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  splitHomepageSections(main);
  decorateIcons(main);
  buildAutoBlocks(main);
  applyGating(main);
  decorateSections(main);
  applySectionMetadata(main);
  decorateBlocks(main);
  decorateButtons(main);
  decorateAuthLinks(main);
}

/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  document.documentElement.lang = 'en';
  decorateTemplateAndTheme();
  const main = doc.querySelector('main');
  if (main) {
    decorateMain(main);
    document.body.classList.add('appear');
    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  loadHeader(doc.querySelector('body > header'));

  const main = doc.querySelector('main');
  await loadSections(main);

  // magazine-article pages get a right-hand sidebar (share links + index-driven
  // related articles) and a two-column layout, matching wknd. No-op elsewhere.
  try {
    const { default: decorateMagazineSidebar } = await import('./magazine-sidebar.js');
    await decorateMagazineSidebar(main);
  } catch (e) {
    // sidebar is non-critical; ignore failures
  }

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  loadFooter(doc.querySelector('body > footer'));

  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  import('./consent-check.js');
  // load anything that can be postponed to the latest here
}

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
