// scripts/emptyState.js
//
// The request-list pages (休暇申請 / 残業申請 / 休日出勤申請) show only column
// headers above a blank table when there are no records — no "nothing here yet"
// message. This module injects a friendly, token-styled empty state when the
// results table has no data rows, and removes it again if rows appear.
//
// Styling lives in css/styles.css (.jbe-empty-state*). Insertion is idempotent
// and the observer is registered through the managed registry (watch: prefix) so
// it is torn down on SPA navigation.

(function () {
  'use strict';

  if (window.__jbe_emptyStateModuleReady) return;
  window.__jbe_emptyStateModuleReady = true;

  const MESSAGES = {
    holiday: {
      title: '休暇申請の履歴はまだありません',
      sub: '申請を作成すると、ここに一覧で表示されます。'
    },
    'over-work': {
      title: '残業申請の履歴はまだありません',
      sub: '申請を作成すると、ここに一覧で表示されます。'
    },
    holidayworking: {
      title: '休日出勤申請の履歴はまだありません',
      sub: '申請を作成すると、ここに一覧で表示されます。'
    }
  };

  function pageKey() {
    const p = window.location.pathname;
    if (/\/employee\/holidayworking/.test(p)) return 'holidayworking';
    if (/\/employee\/over-work/.test(p)) return 'over-work';
    if (/\/employee\/holiday/.test(p)) return 'holiday';
    return null;
  }

  function findResultsTable() {
    const tables = [...document.querySelectorAll('table')];
    return tables.find((t) => /申請No|申請番号|承認・却下|承認/.test(t.textContent)) || null;
  }

  function isEmpty(table) {
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) return true;
    // A single full-width placeholder row also counts as empty.
    if (rows.length === 1) {
      const cells = rows[0].querySelectorAll('td');
      if (cells.length <= 1 || /(ありません|該当|データがありません|見つかりません)/.test(rows[0].textContent)) {
        return true;
      }
    }
    return false;
  }

  function render(table, key) {
    const msg = MESSAGES[key];
    if (!msg || document.getElementById('jbe-empty-state')) return;
    const host = table.closest('.table-responsive') || table;

    const box = document.createElement('div');
    box.id = 'jbe-empty-state';
    box.className = 'jbe-empty-state';

    const title = document.createElement('div');
    title.className = 'jbe-empty-state-title';
    title.textContent = msg.title;

    const sub = document.createElement('div');
    sub.className = 'jbe-empty-state-sub';
    sub.textContent = msg.sub;

    box.appendChild(title);
    box.appendChild(sub);

    if (host.parentElement) {
      host.parentElement.insertBefore(box, host.nextSibling);
    } else {
      host.appendChild(box);
    }
  }

  function setupRequestListEmptyState() {
    const key = pageKey();
    if (!key) return;

    const apply = () => {
      const existing = document.getElementById('jbe-empty-state');
      const table = findResultsTable();
      if (!table) return;
      if (isEmpty(table)) {
        if (!existing) render(table, key);
      } else if (existing) {
        existing.remove();
      }
    };

    apply();
    const obs = new MutationObserver(() => apply());
    obs.observe(document.body, { childList: true, subtree: true });
    if (typeof window.__jbe_registerManagedObserver === 'function') {
      window.__jbe_registerManagedObserver('watch:requestEmptyState', obs);
    }
  }

  window.setupRequestListEmptyState = setupRequestListEmptyState;
})();
