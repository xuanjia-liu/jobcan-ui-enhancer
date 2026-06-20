// scripts/requestStatus.js
//
// Request-list pages (休暇申請 / 残業申請 / 休日出勤申請) render their approval
// status as plain text in the 「承認・却下」 column (e.g. 承認待ち). Jobcan ships
// unstyled status text; the extension already defines status-chip classes
// (.status / .status-pending / .status-approved / .status-rejected in styles.css)
// but nothing applied them. This module wraps the native status text in those
// chips so state reads at a glance, consistently in light + dark mode.
//
// Read-only to the DOM except wrapping the status text in a <span>. Idempotent via
// data-jbe-badged, and re-applied through the managed-observer registry so it
// survives Jobcan's re-renders without leaking observers.

(function () {
  'use strict';

  if (window.__jbe_requestStatusModuleReady) return;
  window.__jbe_requestStatusModuleReady = true;

  // Map a status label to a chip class. Order matters: 承認待ち must resolve to
  // "pending", not "approved", so the pending/rejected checks run before 承認.
  function statusClassFor(text) {
    const t = (text || '').replace(/\s+/g, '');
    if (!t) return null;
    if (/(却下|否認|差[し]?戻|取消|取り消)/.test(t)) return 'status-rejected';
    if (/(承認待ち|申請中|未承認|確認中|保留)/.test(t)) return 'status-pending';
    if (/(承認|許可|完了)/.test(t)) return 'status-approved';
    return null;
  }

  function findStatusColumnIndex(table) {
    const headerCells = table.querySelectorAll('thead th, thead td');
    let idx = -1;
    headerCells.forEach((th, i) => {
      if (idx !== -1) return;
      const t = (th.textContent || '').replace(/\s+/g, '');
      if (/(承認|却下|状態|ステータス)/.test(t)) idx = i;
    });
    return idx;
  }

  function badgeTable(table) {
    const idx = findStatusColumnIndex(table);
    if (idx < 0) return;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cell = tr.children[idx];
      if (!cell || cell.dataset.jbeBadged === 'true') return;
      // Only wrap pure-text cells, so we never destroy nested markup/icons.
      if (cell.children.length > 0) return;
      const raw = (cell.textContent || '').trim();
      const cls = statusClassFor(raw);
      if (!cls) return;
      cell.dataset.jbeBadged = 'true';
      const span = document.createElement('span');
      span.className = 'status ' + cls;
      span.textContent = raw;
      cell.textContent = '';
      cell.appendChild(span);
    });
  }

  function applyBadges() {
    document.querySelectorAll('table').forEach((t) => {
      if (findStatusColumnIndex(t) >= 0) badgeTable(t);
    });
  }

  function setupRequestStatusBadges() {
    applyBadges();
    // The list may (re-)render after load; re-apply on mutations. badgeTable is
    // idempotent (data-jbe-badged), so this never loops on its own changes.
    const obs = new MutationObserver(() => applyBadges());
    obs.observe(document.body, { childList: true, subtree: true });
    if (typeof window.__jbe_registerManagedObserver === 'function') {
      window.__jbe_registerManagedObserver('watch:requestStatusBadges', obs);
    }
  }

  window.setupRequestStatusBadges = setupRequestStatusBadges;
})();
