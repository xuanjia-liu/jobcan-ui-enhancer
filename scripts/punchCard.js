// scripts/punchCard.js
//
// Top-page (/employee) punch card layout.
//
// Jobcan renders the punch UI as one Bootstrap card: header (勤務中 / 退室中) +
// body (clock, 打刻場所 select, 備考 textarea, PUSH, 通常/夜勤 radios). This module
// re-lays that out without replacing any of Jobcan's own controls — every input is
// MOVED, never re-created, so the form still submits exactly what Jobcan expects:
//
//   * the card wrapper loses its background/border/padding (the flip clock and the
//     progress panel already carry their own surfaces, so the card was a box in a box)
//   * the card header is hidden and its 勤務中 text is mirrored into a status pill
//     inside the flip clock (Jobcan keeps updating #working_status in place, so the
//     mirror is a text copy — moving the live node would break clock.js's observer
//     the moment Jobcan re-renders the header)
//   * 打刻場所 / 備考 / 通常・夜勤 collapse behind a 打刻詳細設定 button that sits in
//     the PUSH row
//
// Everything here runs from applyEnhancements(), i.e. roughly once a second, so each
// step is guarded by a data-* attribute and re-entry is a no-op.

/* exported setupPunchCard, syncPunchStatusBadge */

const PUNCH_CARD_SELECTOR = '.jbc-card, .card, .box, .panel';

/**
 * Jobcan's own PUSH control. `#adit-button-push` is the id it has used for years;
 * the value/text scan is the fallback for the day it is renamed, and is cheap
 * because it only looks at buttons and submit inputs.
 */
function findPunchPushButton() {
  const byId = document.querySelector('#adit-button-push');
  if (byId) return byId;

  const candidates = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
  for (const node of candidates) {
    const label = (node.value || node.textContent || '').replace(/\s+/g, '').toUpperCase();
    if (label === 'PUSH') return node;
  }
  return null;
}

function setupPunchCard() {
  const clock = document.querySelector('.flip-clock-container');
  const push = findPunchPushButton();
  if (!clock && !push) return;

  const card =
    (clock && clock.closest(PUNCH_CARD_SELECTOR)) ||
    (push && push.closest(PUNCH_CARD_SELECTOR));

  unwrapPunchCard(card);
  ensurePunchStatusBadge(clock);
  syncPunchStatusBadge();
  collapsePunchSettings(card, push, clock);
  placePunchActionsRow(clock);
  relocateConfirmationItems();
  relocateAdminNotices();
}

/* The 打刻詳細設定+PUSH row lives inside the clock card, between the digits and
 * the timeline. It is Jobcan's own column (tagged .jbe-punch-actions by
 * collapsePunchSettings) carrying the native PUSH button — verified: the button
 * is not inside any <form>, its onclick attribute travels with it — so the node
 * is moved, never rebuilt. clock.js parks it back outside before tearing a clock
 * container down, so a rebuild can never destroy it. */
function placePunchActionsRow(clock) {
  if (!clock) return;
  const actions = document.querySelector('.jbe-punch-actions');
  const progress = clock.querySelector('.work-progress-container');
  if (!actions || !progress) return;
  if (actions.parentElement === clock) return;
  clock.insertBefore(actions, progress);
}

/* ---- Finding a Jobcan card by the text it contains -------------------------
 * Matching on `.card`/`.jbc-card` alone was not enough — Jobcan's own class names
 * on these two boxes are not guaranteed to be in that list, and when the match
 * failed the card simply stayed on screen. This locates the block by its wording
 * instead, which is the one thing about it that is stable.
 */

/**
 * Card roots, by exact class token. Measured on the live page: the phrase sits in
 * `.card > #top_info_area > .card-header > .card-text`, and `.card-text` /
 * `.card-header` both match a loose `[class*="card"]` — matching loosely stopped
 * the climb at the heading, which hid the title and left the body on screen.
 */
const SOURCE_CARD_SELECTOR = '.card, .jbc-card, .box, .box-default, .panel, section, article';

/** Our own output, which must never be mistaken for a Jobcan card to relocate. */
const OWN_OUTPUT_SELECTOR = '.jbe-notices, .jbe-work-stats, .flip-clock-container';

const compactText = (node) => ((node && node.textContent) || '').replace(/\s+/g, '');

/**
 * Deepest element whose text still contains `phrase`. Descends one branch at a
 * time, so it costs depth × siblings rather than a walk of the whole document.
 *
 * Our own subtrees are skipped: the relocated notices are clones of the source
 * text and sit *earlier* in the document, so without this the next pass finds the
 * clone instead of the original and starts relocating its own output.
 */
function findDeepestElementWithText(phrase) {
  let node = document.body;
  if (!node || !compactText(node).includes(phrase)) return null;

  for (;;) {
    const child = Array.from(node.children).find(
      (el) => !el.matches(OWN_OUTPUT_SELECTOR) && compactText(el).includes(phrase)
    );
    if (!child) return node;
    node = child;
  }
}

function findSourceCard(key, phrase, idHint) {
  // Once found, the card is tagged — this runs on every applyEnhancements() pass.
  const tagged = document.querySelector(`[data-jbe-source="${key}"]`);
  if (tagged && tagged.isConnected) return tagged;

  // An id beats the text: `#top_info_area` is present from the first paint, while
  // its contents arrive by ajax — matching on the wording alone meant the card sat
  // there showing 情報の更新中です… until something re-triggered a pass.
  const host = (idHint && document.getElementById(idHint)) || findDeepestElementWithText(phrase);
  if (!host || host.closest(OWN_OUTPUT_SELECTOR)) return null;

  let card = host.closest(SOURCE_CARD_SELECTOR);
  if (!card) return null;

  // Then out through any wrapper that holds nothing but this card — the `.col-lg-6`
  // around it would otherwise keep an empty half-width column in the row. This also
  // puts the hidden element outside `#top_info_area`, which Jobcan re-renders.
  while (
    card.parentElement &&
    card.parentElement !== document.body &&
    compactText(card.parentElement) === compactText(card)
  ) {
    card = card.parentElement;
  }

  // Never touch the punch UI itself.
  if (card.dataset.jbePunchCard === 'true') return null;
  const clock = document.querySelector('.flip-clock-container');
  if (clock && card.contains(clock)) return null;

  card.dataset.jbeSource = key;
  return card;
}

/* ---- 以下の項目の確認 → summary-row alerts ---------------------------------
 * Jobcan's confirmation card is a standing box that reads `0件 / 0件` on almost
 * every day, i.e. a permanent block of page for information that is only ever
 * interesting when it is non-zero. The rows move into the summary row as chips and
 * appear only when there is something to act on. The source card is hidden rather
 * than emptied, so it stays the parse source and Jobcan's own links come along.
 */

const PUNCH_COUNT_PATTERN = /^(\d+)\s*件$/;

function relocateConfirmationItems() {
  const card = findSourceCard('confirm', '以下の項目の確認', 'top_info_area');
  if (!card) return;
  card.classList.add('jbe-source-card-hidden');
  watchConfirmationCard(card);
  renderConfirmationAlertsFrom(card);
}

function renderConfirmationAlertsFrom(card) {
  // The preview holds this lock; without it the next pass (or the ajax observer
  // below) would overwrite the fake chips within a second.
  if (window.__jbe_punchPreview) return;
  const stats = document.querySelector('.jbe-work-stats');
  if (!stats) return;
  const items = parseConfirmationItems(card).filter((item) => item.count > 0);
  renderConfirmationAlerts(stats, items);
}

/**
 * The counts are filled in by ajax after first paint, so they cannot be read on the
 * pass that hides the card. This watches the (hidden) source directly rather than
 * relying on the body-wide observer in main.js to schedule another pass.
 */
function watchConfirmationCard(card) {
  if (window.__jbe_confirmWatchInited) return;
  if (typeof MutationObserver !== 'function') return;
  window.__jbe_confirmWatchInited = true;

  const observer = new MutationObserver(() => renderConfirmationAlertsFrom(card));
  observer.observe(card, { childList: true, subtree: true, characterData: true });

  if (typeof window.__jbe_registerManagedObserver === 'function') {
    window.__jbe_registerManagedObserver('watch:punchConfirm', observer, () => {
      window.__jbe_confirmWatchInited = false;
    });
  }
}

function parseConfirmationItems(card) {
  const items = [];
  const claimedRows = new Set();

  card.querySelectorAll('a, td, th, span, div, p, li').forEach((node) => {
    // Leaf nodes only, so a wrapper around the count is not counted a second time.
    if (node.children.length > 0) return;
    const compact = (node.textContent || '').replace(/\s+/g, '');
    const match = compact.match(PUNCH_COUNT_PATTERN);
    if (!match) return;

    const row = findCountRow(node, card);
    if (!row || claimedRows.has(row)) return;
    claimedRows.add(row);

    const label = (row.textContent || '').replace(/\d+\s*件/g, '').replace(/\s+/g, ' ').trim();
    if (!label) return;

    const link = node.closest('a') || row.querySelector('a[href]');
    items.push({
      label,
      count: Number(match[1]),
      href: link ? link.getAttribute('href') : ''
    });
  });

  return items;
}

/** The nearest ancestor that carries the label as well as the count. */
function findCountRow(node, card) {
  const tableRow = node.closest('tr');
  if (tableRow && card.contains(tableRow)) return tableRow;

  let current = node.parentElement;
  while (current && current !== card) {
    const compact = (current.textContent || '').replace(/\s+/g, '');
    if (compact && !PUNCH_COUNT_PATTERN.test(compact)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Alerts are tiles, not a strip below the tiles: they sit in the same grid (the
 * wrapper is `display: contents`), so an alert costs a column. `data-alerts` tells
 * the stylesheet how many arrived, and the same priority order that handles a
 * narrow clock drops 定時進捗率 then 目標達成時刻 to pay for them.
 */
function renderConfirmationAlerts(stats, items) {
  const signature = items.map((item) => `${item.label}:${item.count}`).join('|');
  const existing = stats.querySelector('.jbe-stat-alerts');

  const alertCount = String(Math.min(items.length, 2));
  if (stats.dataset.alerts !== alertCount) stats.dataset.alerts = alertCount;

  if (existing && existing.dataset.signature === signature) return;
  if (existing) existing.remove();
  if (!items.length) return;

  const row = document.createElement('div');
  row.className = 'jbe-stat-alerts';
  row.dataset.signature = signature;

  items.forEach((item) => {
    // Same classes as a summary tile, so the geometry and the responsive rules
    // (icon hidden when narrow, etc.) are shared rather than re-specified.
    const chip = document.createElement(item.href ? 'a' : 'div');
    chip.className = 'jbe-stat-tile jbe-stat-alert';
    chip.dataset.stat = 'alert';
    if (item.href) chip.href = item.href;

    const icon = document.createElement('span');
    icon.className = 'jbe-stat-icon';
    icon.textContent = '!';

    const body = document.createElement('span');
    body.className = 'jbe-stat-body';

    const label = document.createElement('span');
    label.className = 'jbe-stat-label';
    label.textContent = item.label;
    label.title = item.label;

    const count = document.createElement('span');
    count.className = 'jbe-stat-value';
    count.textContent = `${item.count}件`;

    body.appendChild(label);
    body.appendChild(count);
    chip.appendChild(icon);
    chip.appendChild(body);
    row.appendChild(chip);
  });

  stats.appendChild(row);
}

/* ---- 管理者からのお知らせ → cards under the punch controls -------------------
 * Same problem, opposite shape: a card that exists to say there is nothing to say.
 * Notices are cloned (not moved) into one card each below the punch controls, and
 * the original is hidden — cloning keeps this idempotent and keeps Jobcan's own
 * markup untouched, since the notice body can carry links it wires up itself.
 */

function relocateAdminNotices() {
  const card = findSourceCard('notice', '管理者からのお知らせ');
  if (!card) return;
  card.classList.add('jbe-source-card-hidden');

  // `adit-control-area` is an id on the live page, not a class.
  const anchor = document.getElementById('adit-control-area') ||
    document.querySelector('.adit-control-area') ||
    document.querySelector('.jbe-punch-card');
  if (!anchor || !anchor.parentElement) return;

  if (window.__jbe_punchPreview) return;

  const notices = extractAdminNotices(card);
  const signature = notices.map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim()).join('||');
  const existing = document.querySelector('.jbe-notices');

  if (existing && existing.dataset.signature === signature) return;
  if (existing) existing.remove();
  if (!notices.length) return;

  const list = document.createElement('div');
  list.className = 'jbe-notices';
  list.dataset.signature = signature;

  notices.forEach((node) => {
    const noticeCard = document.createElement('div');
    noticeCard.className = 'jbe-notice-card';
    const clone = node.cloneNode(true);
    // Ids would be duplicated by the clone, and Jobcan's own scripts look them up.
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    noticeCard.appendChild(clone);
    list.appendChild(noticeCard);
  });

  anchor.parentElement.insertBefore(list, anchor.nextSibling);
}

/**
 * The individual notices in the card body — list items when it is a list, block
 * children otherwise. `お知らせはありません` and its variants are the card's empty
 * state, not a notice, so they are dropped and nothing is rendered.
 */
function extractAdminNotices(card) {
  // Body only — the card's own `管理者からのお知らせ` heading is a title, not a
  // notice, and cloning it produced a card that just repeated the section name.
  const body = card.querySelector('.card-body, .jbc-card-body');
  if (!body) return [];

  const list = body.querySelector('ul, ol');
  let nodes = list
    ? Array.from(list.children)
    : Array.from(body.children).filter((el) => (el.textContent || '').trim());

  if (!nodes.length && (body.textContent || '').trim()) nodes = [body];

  return nodes.filter((node) => {
    const compact = (node.textContent || '').replace(/\s+/g, '');
    if (!compact) return false;
    // The card's empty state, not a notice.
    if (/(ありません|ございません)。?$/.test(compact)) return false;
    return compact !== '管理者からのお知らせ';
  });
}

/** Strip the card chrome: background, border, shadow, padding — header included. */
function unwrapPunchCard(card) {
  if (!card || card.dataset.jbePunchCard === 'true') return;
  card.dataset.jbePunchCard = 'true';
  card.classList.add('jbe-punch-card');

  card.querySelectorAll(':scope > .card-header, :scope > .jbc-card-header').forEach((header) => {
    header.classList.add('jbe-punch-card-header');
  });
  card.querySelectorAll(':scope > .card-body, :scope > .jbc-card-body').forEach((body) => {
    body.classList.add('jbe-punch-card-body');
  });
}

/**
 * The status pill inside the flip clock. Created empty; syncPunchStatusBadge()
 * fills it, both from here and from clock.js's #working_status observer, so the
 * pill changes at the same moment the digits change colour.
 */
function ensurePunchStatusBadge(clock) {
  if (!clock || clock.querySelector('.jbe-clock-status')) return;
  const badge = document.createElement('div');
  badge.className = 'jbe-clock-status';
  badge.dataset.state = 'unknown';
  // Preferred home is the seconds stack, so the pill sits directly above the
  // seconds pair at the end of the digits row (see setupSelfAnimatingClockDigits).
  // The fallbacks keep it visible if the digits are ever rebuilt without the stack.
  const stack = clock.querySelector('.flip-seconds-stack');
  const digits = clock.querySelector('.flip-clock-digits-container');
  if (stack) stack.prepend(badge);
  else if (digits) clock.insertBefore(badge, digits);
  else clock.prepend(badge);
}

function syncPunchStatusBadge() {
  const source = document.getElementById('working_status');
  const badges = document.querySelectorAll('.jbe-clock-status');
  if (!badges.length) return;

  const text = source ? (source.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const state = resolvePunchStatusState(text);

  badges.forEach((badge) => {
    // Keep the last known wording through Jobcan's momentary blank re-renders —
    // same reasoning as resolveClockColorClassFromStatus()'s fallback.
    if (text && badge.textContent !== text) badge.textContent = text;
    if (badge.dataset.state !== state) badge.dataset.state = state;
  });
}

function resolvePunchStatusState(text) {
  if (!text) return 'unknown';
  const lower = text.toLowerCase();
  if (text.includes('勤務中') || text.includes('入室中') || text.includes('出勤中') || lower.includes('working')) {
    return 'working';
  }
  if (text.includes('退室中') || text.includes('未出勤') || lower.includes('not arrived')) {
    return 'not-working';
  }
  return 'unknown';
}

/**
 * The largest wrapper around `el` that can be moved without dragging any of
 * `forbidden` (the PUSH button, the clock) along with it. Climbing rather than
 * assuming a fixed depth is deliberate: Jobcan wraps these controls in a different
 * number of `.row`/`.col`/`.form-group` layers depending on the field.
 */
function liftablePunchRow(el, scope, forbidden) {
  if (!el || !scope || !scope.contains(el)) return null;
  const blocks = (node) => forbidden.some((f) => f && node.contains(f));
  if (blocks(el)) return null;

  let node = el;
  while (node.parentElement && node.parentElement !== scope && !blocks(node.parentElement)) {
    node = node.parentElement;
  }
  return node.parentElement ? node : null;
}

function collapsePunchSettings(card, push, clock) {
  if (!push) return;
  const scope = push.closest('form') || card;
  if (!scope || scope.dataset.jbePunchCollapsed === 'true') return;

  const forbidden = [push, clock].filter(Boolean);
  const rows = [];

  const addRow = (el) => {
    const row = liftablePunchRow(el, scope, forbidden);
    if (!row) return;
    // Drop anything already covered by a wrapper we are taking, and drop a wrapper's
    // children if the wrapper itself arrives later.
    if (rows.some((existing) => existing === row || existing.contains(row))) return;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (row.contains(rows[i])) rows.splice(i, 1);
    }
    rows.push(row);
  };

  const select = scope.querySelector('select');
  addRow(select);
  scope.querySelectorAll('textarea').forEach(addRow);
  const firstRadio = scope.querySelector('input[type="radio"]');
  addRow(firstRadio);

  // The bare 打刻場所を選択してください。line is its own element on the current page
  // but is not guaranteed to be, so it is matched by text rather than by position.
  Array.from(scope.children).forEach((child) => {
    if (!child.textContent || !child.textContent.includes('打刻場所')) return;
    addRow(child);
  });

  if (!rows.length) return;
  scope.dataset.jbePunchCollapsed = 'true';

  // Keep document order, so the panel reads the way the page did.
  rows.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  const panel = document.createElement('div');
  panel.className = 'jbe-punch-advanced';
  panel.id = 'jbe-punch-advanced';
  panel.hidden = true;

  rows.forEach((row) => panel.appendChild(row));

  // The panel is a popover anchored to its button, so the two live in one
  // position:relative wrapper that sits in the PUSH row.
  const anchor = document.createElement('div');
  anchor.className = 'jbe-punch-settings';
  const toggle = createPunchSettingsToggle(panel, select, anchor);
  anchor.appendChild(toggle);
  anchor.appendChild(panel);

  push.parentElement.insertBefore(anchor, push);
  push.parentElement.classList.add('jbe-punch-actions');
  push.classList.add('jbe-punch-push');

  // Tag the Bootstrap column that wraps the row (`.col-lg-7.m-auto`) so CSS can
  // re-centre this one column. The card-wide `m-auto` reset left-aligns every
  // column, but this row belongs under the centred clock.
  const actionsCol = push.closest('.m-auto');
  if (actionsCol) actionsCol.classList.add('jbe-punch-actions-col');
}

function createPunchSettingsToggle(panel, select, anchor) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'jbe-punch-settings-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panel.id);

  const label = document.createElement('span');
  label.className = 'jbe-punch-settings-label';
  label.textContent = '打刻詳細設定';

  // The 打刻場所 is the one hidden field with a consequence, so the button carries
  // the current選択 rather than making the panel the only way to check it.
  const summary = document.createElement('span');
  summary.className = 'jbe-punch-settings-summary';

  const text = document.createElement('span');
  text.className = 'jbe-punch-settings-text';
  text.appendChild(label);
  text.appendChild(summary);

  const caret = document.createElement('span');
  caret.className = 'jbe-punch-settings-caret';
  caret.setAttribute('aria-hidden', 'true');

  toggle.appendChild(text);
  toggle.appendChild(caret);

  const syncSummary = () => {
    if (!select) return;
    const option = select.options ? select.options[select.selectedIndex] : null;
    const value = option ? (option.textContent || '').trim() : '';
    if (summary.textContent !== value) summary.textContent = value;
  };
  syncSummary();
  if (select) select.addEventListener('change', syncSummary);

  // Dismiss handlers are bound only while the popover is open, so a closed popover
  // costs nothing on a page whose body already churns once a second.
  const onDocumentPointerDown = (event) => {
    if (anchor.contains(event.target)) return;
    setOpen(false);
  };
  const onDocumentKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    setOpen(false);
    toggle.focus();
  };

  function setOpen(open) {
    if (panel.hidden === !open) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('is-open', open);
    if (open) {
      document.addEventListener('pointerdown', onDocumentPointerDown, true);
      document.addEventListener('keydown', onDocumentKeyDown, true);
    } else {
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      syncSummary();
    }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));

  return toggle;
}

/* ---- Preview hook ----------------------------------------------------------
 * Both relocations only render when Jobcan has something to show, which on a normal
 * day is never: the counts are 0件 and there are no notices. This fakes both so the
 * layout can be checked without waiting for a real one.
 *
 * From the page console (the default context — the CustomEvent crosses into the
 * content script's isolated world):
 *
 *   jbePreview()                                  // 2 alerts + 1 notice
 *   jbePreview({ alerts: 1, notices: 2 })         // counts
 *   jbePreview({ items: [{ label: '打刻エラー', count: 3 }] })
 *   jbePreview({ notices: ['メンテナンスのお知らせ'] })
 *   jbePreview({ reset: true })                   // back to the real data
 *
 * where `jbePreview = (o) => window.dispatchEvent(new CustomEvent('jbe:preview', { detail: o }))`.
 * In the extension's own console context, call window.__jbe_previewPunchCards()
 * directly. The preview holds a lock so the once-a-second re-apply does not wipe it;
 * reset releases the lock and re-reads the real cards.
 */

const PREVIEW_DEFAULT_ITEMS = [
  { label: '打刻漏れ・打刻間違い', count: 2, href: '/employee/attendance' },
  { label: '打刻エラー', count: 1, href: '/employee/attendance' }
];

const PREVIEW_DEFAULT_NOTICES = [
  '【重要】12月28日〜1月4日は年末年始休業のため、勤怠の締め処理を行いません。',
  '打刻漏れの修正申請は毎月5日までにお願いします。'
];

function previewPunchCards(options = {}) {
  const stats = document.querySelector('.jbe-work-stats');

  if (options.reset) {
    window.__jbe_punchPreview = false;
    document.querySelectorAll('.jbe-notices[data-preview="true"]').forEach((node) => node.remove());
    if (stats) {
      const alerts = stats.querySelector('.jbe-stat-alerts');
      if (alerts) alerts.remove();
      delete stats.dataset.alerts;
    }
    relocateConfirmationItems();
    relocateAdminNotices();
    return 'preview off — showing the real cards again';
  }

  window.__jbe_punchPreview = true;

  // Alerts: either explicit items, or the first N of the defaults.
  const items = Array.isArray(options.items)
    ? options.items.map((item, index) => ({
      label: item.label || `確認項目 ${index + 1}`,
      count: Number(item.count) || 1,
      href: item.href || '/employee/attendance'
    }))
    : PREVIEW_DEFAULT_ITEMS.slice(0, options.alerts === undefined ? 2 : Number(options.alerts) || 0);

  if (stats) {
    const existing = stats.querySelector('.jbe-stat-alerts');
    if (existing) existing.remove();
    renderConfirmationAlerts(stats, items);
  }

  // Notices: either explicit strings, or the first N of the defaults.
  const texts = Array.isArray(options.notices)
    ? options.notices
    : PREVIEW_DEFAULT_NOTICES.slice(0, options.notices === undefined ? 1 : Number(options.notices) || 0);

  document.querySelectorAll('.jbe-notices').forEach((node) => node.remove());

  if (texts.length) {
    const anchor = document.getElementById('adit-control-area') ||
      document.querySelector('.adit-control-area') ||
      document.querySelector('.jbe-punch-card');

    if (anchor && anchor.parentElement) {
      const list = document.createElement('div');
      list.className = 'jbe-notices';
      list.dataset.preview = 'true';
      list.dataset.signature = 'preview';

      texts.forEach((text) => {
        const noticeCard = document.createElement('div');
        noticeCard.className = 'jbe-notice-card';
        const body = document.createElement('div');
        body.className = 'card-text';
        body.textContent = text;
        noticeCard.appendChild(body);
        list.appendChild(noticeCard);
      });

      anchor.parentElement.insertBefore(list, anchor.nextSibling);
    }
  }

  return `preview on — ${items.length} alert(s), ${texts.length} notice(s). ` +
    'Call again with { reset: true } to restore.';
}

if (!window.__jbe_punchPreviewBound) {
  window.__jbe_punchPreviewBound = true;
  // The listener is what makes this reachable from the page's own console; the
  // isolated world's globals are not.
  window.addEventListener('jbe:preview', (event) => {
    const result = previewPunchCards((event && event.detail) || {});
    console.info('[jobcan-ui-enhancer]', result);
  });
}

window.setupPunchCard = setupPunchCard;
window.syncPunchStatusBadge = syncPunchStatusBadge;
window.__jbe_previewPunchCards = previewPunchCards;
