// scripts/requestHeader.js
//
// Request-list pages (休暇申請 / 残業申請 / 休日出勤申請) put the page heading and
// the 新規申請 buttons in two different places: `h2.mb-3` is a direct child of
// `.jbc-container`, while the buttons live in `.card-body > .card-title.text-right`
// inside the card below it. That wastes a full row and pushes the primary action
// away from the title.
//
// This module lifts both into one flex row (`.jbe-page-head`), so the buttons sit
// on the right-hand side of the h2. Only node moves, no markup rewriting — the
// buttons keep their own handlers/hrefs.
//
// Styling lives in css/styles.css (.jbe-page-head*). Idempotent: applyEnhancements()
// re-runs constantly, and after the first move the guards below make it a no-op, so
// no observer is registered.

/* exported setupRequestHeaderActions */

(function () {
  'use strict';

  if (window.__jbe_requestHeaderModuleReady) return;
  window.__jbe_requestHeaderModuleReady = true;

  function setupRequestHeaderActions() {
    const container = document.querySelector('.jbc-container');
    if (!container) return;

    const head = container.querySelector(':scope > .jbe-page-head');
    const heading = head ? head.querySelector('h2') : container.querySelector(':scope > h2');
    if (!heading) return;

    // The actions block is the first .card-title.text-right in the page card —
    // scoped to .card-body so a .text-right elsewhere (e.g. the footer
    // .card-text.text-right) is never picked up.
    // Once moved, the block is no longer a .card-body child, so this returns null
    // on every later run — that is the idempotency guard.
    const actions = container.querySelector('.card-body > .card-title.text-right');
    if (!actions) return;

    let row = head;
    if (!row) {
      row = document.createElement('div');
      row.className = 'jbe-page-head';
      heading.parentElement.insertBefore(row, heading);
      row.appendChild(heading);
    }

    if (actions.parentElement !== row) {
      actions.classList.add('jbe-page-head-actions');
      row.appendChild(actions);
    }
  }

  window.setupRequestHeaderActions = setupRequestHeaderActions;
})();
