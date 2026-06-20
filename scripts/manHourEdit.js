// scripts/manHourEdit.js
//
// Isolated-world enhancements for the rebuilt man-hour edit page
// (/employee/man-hour-manage/edit-achievement):
//   * decimal-hour normalization on input.manhour ("3" -> "3:00", "3.5" -> "3:30")
//   * per-row "suggestion chips" proposing the value that balances the day
//   * keyboard shortcuts (Shift+Enter = add row, Cmd/Ctrl+Enter = save)
//
// NOTE: project/task selection is handled by Jobcan's own native autocomplete.
// We do NOT replace those fields — an earlier custom side-panel picker did, but
// selections made that way bypass Jobcan's internal model and get rejected as
// 未入力/invalid (and would not save). Improving the project SEARCH (substring
// matching) is done by widening the native autocomplete's source in
// scripts/manHourEditSearch.js, which must run in the MAIN world to reach the
// page's jQuery + autocomplete instances.

(function () {
  if (window.__jbe_manHourEditModuleReady) return;
  window.__jbe_manHourEditModuleReady = true;

  function getEditTable() {
    return document.querySelector('table.jbc-table');
  }

  function parseHHMMToSeconds(text) {
    const m = String(text || '').trim().match(/^(\d{1,4}):(\d{1,2})$/);
    if (!m) return null;
    return ((parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0)) * 60;
  }

  function secondsToHHMM(seconds) {
    const v = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(v / 3600);
    const m = Math.round((v - h * 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // 1. Decimal-hour normalization on the man-hour (実績) input
  // ---------------------------------------------------------------------------

  function formatMinutesAsHMM(totalMinutes) {
    const safe = Math.max(0, Math.round(Number(totalMinutes) || 0));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
  }

  function normalizeTypedDecimalHours(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return text;

    const colon = text.match(/^(\d+)\s*:\s*(\d{1,2})$/);
    if (colon) {
      const h = parseInt(colon[1], 10) || 0;
      let mi = parseInt(colon[2], 10) || 0;
      if (mi > 59) mi = 59;
      return formatMinutesAsHMM(h * 60 + mi);
    }

    if (/^(\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
      const hours = parseFloat(text);
      if (Number.isFinite(hours) && hours >= 0) return formatMinutesAsHMM(hours * 60);
    }

    return text;
  }

  function attachDecimalHoursNormalizer(input) {
    if (!input || input.dataset.jbeDecimalHoursNormalize === '1') return;
    input.dataset.jbeDecimalHoursNormalize = '1';

    const commit = () => {
      const next = normalizeTypedDecimalHours(input.value);
      if (next === input.value) return;
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Capture phase so it runs before the page's own parsing.
    input.addEventListener('blur', commit, true);
    input.addEventListener('change', commit, true);
  }

  // ---------------------------------------------------------------------------
  // 2. Suggestion chips: propose the man-hour value that balances the day
  // ---------------------------------------------------------------------------

  function getActualWorkSeconds() {
    const labelCell = Array.from(document.querySelectorAll('th, td'))
      .find((c) => c.textContent.trim() === '実労働時間');
    if (labelCell && labelCell.nextElementSibling) {
      const secs = parseHHMMToSeconds(labelCell.nextElementSibling.textContent);
      if (secs != null) return secs;
    }
    return null;
  }

  function getEnteredSeconds() {
    let total = 0;
    document.querySelectorAll('table.jbc-table input.manhour').forEach((inp) => {
      const secs = parseHHMMToSeconds(inp.value);
      if (secs != null) total += secs;
    });
    return total;
  }

  function refreshSuggestionChips() {
    updateSummary();
    const actual = getActualWorkSeconds();
    if (actual == null) return;
    const entered = getEnteredSeconds();
    const diff = actual - entered; // remaining seconds to allocate

    document.querySelectorAll('table.jbc-table tbody tr').forEach((row) => {
      if (row.id === 'template') return;
      const input = row.querySelector('input.manhour');
      if (!input) return;
      let chip = input.parentElement.querySelector('.time-suggestion-chip');
      const thisSecs = parseHHMMToSeconds(input.value) || 0;
      const suggestedSecs = Math.max(0, thisSecs + diff);
      if (diff === 0) { if (chip) chip.remove(); return; }

      if (!chip) {
        chip = document.createElement('div');
        chip.className = 'time-suggestion-chip';
        chip.style.display = 'none';
        input.parentElement.appendChild(chip);
        // The chip is position:fixed (so it isn't clipped by the man-hour table's
        // overflow:hidden); place it centered just below the input on each show.
        // CSS applies translateX(-50%), so `left` is the input's horizontal center.
        const positionChip = () => {
          const r = input.getBoundingClientRect();
          chip.style.left = `${Math.round(r.left + r.width / 2)}px`;
          chip.style.top = `${Math.round(r.bottom + 6)}px`;
        };
        const show = () => { positionChip(); chip.style.display = 'block'; };
        const hide = () => { if (document.activeElement !== input && !chip.matches(':hover')) chip.style.display = 'none'; };
        input.addEventListener('mouseover', show);
        input.addEventListener('focus', show);
        input.addEventListener('mouseout', hide);
        input.addEventListener('blur', () => setTimeout(hide, 50));
        chip.addEventListener('mouseover', show);
        chip.addEventListener('mouseout', hide);
        chip.addEventListener('click', () => {
          input.value = secondsToHHMM(Number(chip.dataset.seconds) || 0);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          chip.style.display = 'none';
          refreshSuggestionChips();
        });
      }
      chip.dataset.seconds = String(suggestedSecs);
      chip.textContent = `提案: ${secondsToHHMM(suggestedSecs)}`;
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Keyboard shortcuts for the standalone edit page
  // ---------------------------------------------------------------------------

  function setupEditKeyboardShortcuts() {
    if (window.__jbe_manHourEditShortcuts) return;
    window.__jbe_manHourEditShortcuts = true;
    document.addEventListener('keydown', (e) => {
      if (!(window.location.pathname || '').startsWith('/employee/man-hour-manage/edit-achievement')) return;
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const addBtn = document.getElementById('add');
        if (addBtn) { e.preventDefault(); addBtn.click(); }
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        const saveBtn = document.getElementById('save');
        if (saveBtn) { e.preventDefault(); saveBtn.click(); }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Action bar: group 追加 + スクリーンショット + 保存 into one row
  // ---------------------------------------------------------------------------

  // The rebuilt editor scatters its actions (保存 top-right, 追加 below the table)
  // and has no on-page screenshot button. Pull all three into one bottom action
  // bar. The native #save / #add are MOVED (never cloned) so their own click
  // handlers stay attached; the screenshot button reuses the shared capture tool.
  function setupEditActionBar() {
    const save = document.getElementById('save');
    const add = document.getElementById('add');
    if (!save || !add) return false;

    let bar = document.getElementById('jbe-mh-actionbar');
    if (bar) {
      // Re-assert membership if the page ever re-renders the native buttons.
      if (add.parentElement !== bar) bar.insertBefore(add, bar.firstChild);
      if (save.parentElement !== bar) bar.appendChild(save);
      return true;
    }

    const saveCol = save.parentElement;
    const addAnchor = add.closest('.row') || add.parentElement;

    bar = document.createElement('div');
    bar.id = 'jbe-mh-actionbar';

    const shot = document.createElement('button');
    shot.type = 'button';
    shot.id = 'jbe-mh-screenshot';
    shot.className = 'btn jbc-btn-outline-primary';
    shot.title = 'スクリーンショット';
    shot.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>スクリーンショット</span>';
    shot.addEventListener('click', () => {
      // Auto-generate the day's 工数レポート (copy + download preview). Fall back to
      // the manual area-select capture only if the report builder isn't available.
      if (typeof captureManHourDayReport === 'function') captureManHourDayReport();
      else if (typeof initScreenshotCapture === 'function') initScreenshotCapture();
    });

    // Insert the bar where 追加 sat, then MOVE the native buttons into it.
    addAnchor.parentElement.insertBefore(bar, addAnchor);
    bar.appendChild(add);   // 追加 — pushed to the left by CSS (margin-right:auto)
    bar.appendChild(shot);  // スクリーンショット
    bar.appendChild(save);  // 保存 — primary, far right

    // Hide the now-empty original wrappers so they don't leave gaps.
    if (saveCol && !saveCol.querySelector('button, input, select, a')) saveCol.style.display = 'none';
    if (addAnchor && addAnchor !== bar && !addAnchor.querySelector('button, input, select, a')) addAnchor.style.display = 'none';

    return true;
  }

  // ---------------------------------------------------------------------------
  // 5. Compact summary header + date/nav row (replaces the native 工数情報 card)
  // ---------------------------------------------------------------------------
  //
  // Native layout inside #man-hour-manage-v2-body .card-body (top -> bottom):
  //   .row.pl-1.pr-1  -> #date_selector > form#search > .jbc-ymd-select (#year/#month/#day)
  //   .row.mt-3       -> .col-lg-6 (工数情報 card: td#actual_work / td#last_update)
  //                      .col-lg-6 (備考 card: textarea#note)
  //   .row.pl-1.pr-1  -> #template_buttons (#add_default_manhour, .btn-group>#add_from_template) + #remove
  //   .row.p-3        -> table.jbc-table
  //
  // We MOVE the native 備考 textarea, the date form, and テンプレート/削除 into our
  // own #jbe-mh-summary / #jbe-mh-nav containers (moved, never cloned, so their
  // handlers + Jobcan's model stay intact), hide the now-empty native rows, and
  // render a compact header reading the same live values the suggestion chips use.

  // Move a native node into one of our containers (no-op if absent/already there).
  function relocate(node, dest) {
    if (node && dest && node.parentElement !== dest) dest.appendChild(node);
    return !!node;
  }

  // Hide the Bootstrap .row that holds a native control we've emptied. Never hides
  // the editor row (the only .row carrying input.manhour) or our own containers.
  function hideRowOf(el) {
    const row = el && el.closest('.row');
    if (row && !row.querySelector('input.manhour') && !row.querySelector('#jbe-mh-summary, #jbe-mh-nav')) {
      row.style.display = 'none';
    }
  }

  function getLastUpdatedText() {
    const byId = document.getElementById('last_update');
    if (byId) { const t = (byId.textContent || '').replace(/\s+/g, ' ').trim(); if (t) return t; }
    const lbl = Array.from(document.querySelectorAll('th, td, dt, label, p, div, span'))
      .find((c) => /^最終更新/.test((c.textContent || '').trim()));
    if (lbl && lbl.nextElementSibling) {
      const t = (lbl.nextElementSibling.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    return null;
  }

  // 工数実績 total from the native card (the saved total, computed at page load).
  // Used as the figure's value until the man-hour inputs finish populating.
  function getNativeManhourTotalSeconds() {
    const label = Array.from(document.querySelectorAll('th, td')).find((c) => (c.textContent || '').trim() === '工数実績');
    const cell = label && label.nextElementSibling;
    if (cell) {
      const m = (cell.textContent || '').match(/(\d{1,4}):(\d{2})/);
      if (m) return ((parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0)) * 60;
    }
    return null;
  }

  // Recompute the compact header from live values. No-op until the shell exists;
  // wired into refreshSuggestionChips() so it tracks every edit / add / remove.
  function updateSummary() {
    const root = document.getElementById('jbe-mh-summary');
    if (!root) return;
    // Prefer the live sum of the man-hour inputs; fall back to the native 工数実績
    // cell (the saved total) while the worker is still populating the inputs.
    let entered = getEnteredSeconds();
    if (entered === 0) {
      const nativeTotal = getNativeManhourTotalSeconds();
      if (nativeTotal != null) entered = nativeTotal;
    }
    const actual = getActualWorkSeconds();

    const fig = root.querySelector('.jbe-mh-figure-value');
    if (fig) fig.textContent = secondsToHHMM(entered);

    const sub = root.querySelector('.jbe-mh-subline');
    if (sub) sub.textContent = `実労働時間: ${actual == null ? '--:--' : secondsToHHMM(actual)}`;

    const badge = root.querySelector('.jbe-mh-badge');
    if (badge) {
      badge.classList.remove('jbe-mh-badge--over', 'jbe-mh-badge--under', 'jbe-mh-badge--match');
      if (actual == null) {
        badge.style.display = 'none';
      } else {
        badge.style.display = '';
        const diff = actual - entered; // <0 over-entered (超過), >0 short (不足)
        const mag = secondsToHHMM(Math.abs(diff));
        if (diff === 0) { badge.classList.add('jbe-mh-badge--match'); badge.textContent = '一致'; }
        else if (diff < 0) { badge.classList.add('jbe-mh-badge--over'); badge.textContent = `${mag}超過`; }
        else { badge.classList.add('jbe-mh-badge--under'); badge.textContent = `${mag}不足`; }
      }
    }

    const updated = root.querySelector('.jbe-mh-updated');
    if (updated) {
      const txt = getLastUpdatedText();
      if (txt) { updated.style.display = ''; updated.textContent = `最終更新: ${txt}`; }
      else { updated.style.display = 'none'; }
    }
  }

  // --- date navigation (前の日 / 次の日) -------------------------------------
  // The page carries the date in ?year/month/day (read by manHourEditSearch.js);
  // navigating there reloads cleanly to the adjacent day.
  function getCurrentEditDate() {
    const y = document.getElementById('year');
    const m = document.getElementById('month');
    const d = document.getElementById('day');
    let yy = y && parseInt(y.value, 10);
    let mm = m && parseInt(m.value, 10);
    let dd = d && parseInt(d.value, 10);
    if (!(yy && mm && dd)) {
      const p = new URLSearchParams(location.search);
      yy = parseInt(p.get('year'), 10) || yy;
      mm = parseInt(p.get('month'), 10) || mm;
      dd = parseInt(p.get('day'), 10) || dd;
    }
    return (yy && mm && dd) ? new Date(yy, mm - 1, dd) : null;
  }

  function navigateToDate(dateObj) {
    if (!dateObj) return;
    const p = new URLSearchParams(location.search);
    p.set('year', String(dateObj.getFullYear()));
    p.set('month', String(dateObj.getMonth() + 1));
    p.set('day', String(dateObj.getDate()));
    location.search = p.toString();
  }

  function navigateToDay(delta) {
    const base = getCurrentEditDate();
    if (!base) return;
    base.setDate(base.getDate() + delta);
    navigateToDate(base);
  }

  function makeNavButton(label, handler, extraClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn jbe-mh-nav-btn${extraClass ? ` ${extraClass}` : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => { if (!btn.disabled) handler(); });
    return btn;
  }

  // Disable 次の日 once the edit date reaches today (can't log future days) and
  // 今日 when already on today.
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function updateNavButtonStates() {
    const cur = getCurrentEditDate();
    if (!cur) return;
    const today = startOfDay(new Date()).getTime();
    const curTime = startOfDay(cur).getTime();
    const nextBtn = document.querySelector('.jbe-mh-nav-next');
    const todayBtn = document.querySelector('.jbe-mh-nav-today');
    if (nextBtn) nextBtn.disabled = curTime >= today;
    if (todayBtn) todayBtn.disabled = curTime === today;
  }

  function buildSummaryShell() {
    const summary = document.createElement('div');
    summary.id = 'jbe-mh-summary';
    const main = document.createElement('div');
    main.className = 'jbe-mh-summary-main';
    const figure = document.createElement('div');
    figure.className = 'jbe-mh-figure';
    const figVal = document.createElement('span');
    figVal.className = 'jbe-mh-figure-value';
    const badge = document.createElement('span');
    badge.className = 'jbe-mh-badge';
    figure.appendChild(figVal);
    figure.appendChild(badge);
    const subline = document.createElement('div');
    subline.className = 'jbe-mh-subline';
    const updated = document.createElement('div');
    updated.className = 'jbe-mh-updated';
    main.appendChild(figure);
    main.appendChild(subline);
    main.appendChild(updated);
    const aside = document.createElement('div');
    aside.className = 'jbe-mh-summary-aside';
    summary.appendChild(main);
    summary.appendChild(aside);
    return summary;
  }

  // Idempotent builder, shaped like setupEditActionBar(): build once, then on every
  // later call re-assert the relocations in case Jobcan re-rendered a native node.
  // The native テンプレートから追加 dropdown is wired by Jobcan's own JS at init and
  // breaks if moved out of #template_buttons, so we DON'T move it — instead the
  // native toolbar row (#template_buttons + 削除) is restyled in place as the nav row.
  function setupSummaryHeader() {
    const table = getEditTable();
    if (!table) return false;
    const tableWrap = table.closest('.row') || table.parentElement;
    if (!tableWrap || !tableWrap.parentElement) return false;

    const existing = document.getElementById('jbe-mh-summary');
    if (existing) {
      const aside = existing.querySelector('.jbe-mh-summary-aside');
      if (aside && !aside.querySelector('textarea')) relocate(document.getElementById('note'), aside);
      const navDate = document.querySelector('.jbe-mh-nav-date');
      const form = document.getElementById('search');
      if (navDate && form && form.parentElement !== navDate) {
        navDate.insertBefore(form, navDate.querySelector('.jbe-mh-nav-next'));
      }
      const def = document.getElementById('add_default_manhour');
      if (def) def.style.display = 'none';
      updateNavButtonStates();
      updateSummary();
      return true;
    }

    // --- build once ---
    const summary = buildSummaryShell();
    const aside = summary.querySelector('.jbe-mh-summary-aside');

    // Date controls: 前の日 | native date form | 次の日 | 今日.
    const navDate = document.createElement('div');
    navDate.className = 'jbe-mh-nav-date';
    navDate.appendChild(makeNavButton('前の日', () => navigateToDay(-1)));
    const form = document.getElementById('search');
    if (form) navDate.appendChild(form);
    navDate.appendChild(makeNavButton('次の日', () => navigateToDay(1), 'jbe-mh-nav-next'));
    navDate.appendChild(makeNavButton('今日', () => navigateToDate(new Date()), 'jbe-mh-nav-today'));

    // Reuse the native toolbar row (#template_buttons + 削除) as the nav row so the
    // template dropdown keeps Jobcan's native wiring; slot the date controls in at
    // the front and drop デフォルト工数を追加.
    const tmplBtns = document.getElementById('template_buttons');
    const navRow = tmplBtns ? tmplBtns.closest('.row') : null;
    if (navRow) {
      navRow.classList.add('jbe-mh-navrow');
      navRow.insertBefore(navDate, navRow.firstChild);
      const def = document.getElementById('add_default_manhour');
      if (def) def.style.display = 'none';
      navRow.parentElement.insertBefore(summary, navRow);
    } else {
      // Fallback: standalone nav with just the date controls.
      const standalone = document.createElement('div');
      standalone.id = 'jbe-mh-nav';
      standalone.appendChild(navDate);
      tableWrap.parentElement.insertBefore(summary, tableWrap);
      tableWrap.parentElement.insertBefore(standalone, tableWrap);
    }

    // 備考 -> header aside; hide the cards row only once the textarea is safely moved.
    const note = document.getElementById('note');
    relocate(note, aside);
    const actualCell = document.getElementById('actual_work');
    if (actualCell && note && note.parentElement === aside) hideRowOf(actualCell);

    // Hide the original date row now that the date form lives in the nav.
    const dateSel = document.getElementById('date_selector');
    if (dateSel && form && form.parentElement === navDate) hideRowOf(dateSel);

    updateNavButtonStates();
    updateSummary();
    // The worker fills the inputs + native cells AFTER the table appears, so the
    // first updateSummary() sees empty values. Re-run for a few seconds until the
    // figure (live sum) and 最終更新 are populated.
    if (typeof window.__jbe_startManagedInterval === 'function') {
      window.__jbe_startManagedInterval('manHourEdit:summaryRefresh', (ctx) => {
        updateSummary();
        if (getEnteredSeconds() > 0 && getLastUpdatedText()) ctx.stop();
      }, 500, { maxRuns: 20 });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  function enhanceExistingRows(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('input.manhour').forEach((input) => {
      if (input.closest('table.jbc-table') && !input.closest('#template')) attachDecimalHoursNormalizer(input);
    });
  }

  function setupManHourEditPage() {
    if (window.__jbe_manHourEditPageInited) return;
    window.__jbe_manHourEditPageInited = true;

    setupEditKeyboardShortcuts();

    const init = () => {
      const table = getEditTable();
      if (!table) return false;
      enhanceExistingRows(document);
      setupSummaryHeader();
      refreshSuggestionChips();
      setupEditActionBar();
      return true;
    };

    if (!init()) {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (init() || Date.now() - startedAt > 8000) clearInterval(timer);
      }, 300);
    }

    // React to rows being added/removed (追加 / 削除 / template clone). Observe the
    // tbody's direct children only — chips live deeper, so this won't self-trigger.
    const table = getEditTable();
    const tbody = table ? table.querySelector('tbody') : null;
    if (tbody) {
      const observer = new MutationObserver((mutations) => {
        let rowsChanged = false;
        mutations.forEach((m) => {
          m.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'TR' && node.id !== 'template') {
              enhanceExistingRows(node);
              rowsChanged = true;
            }
          });
          if (Array.from(m.removedNodes).some((n) => n.nodeType === Node.ELEMENT_NODE && n.tagName === 'TR')) {
            rowsChanged = true;
          }
        });
        if (rowsChanged) { refreshSuggestionChips(); setupSummaryHeader(); setupEditActionBar(); }
      });
      observer.observe(tbody, { childList: true });
      if (typeof window.__jbe_registerManagedObserver === 'function') {
        window.__jbe_registerManagedObserver('manHourEdit:tbody', observer);
      }
    }

    document.addEventListener('change', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('manhour')) {
        refreshSuggestionChips();
      }
    });
  }

  window.setupManHourEditPage = setupManHourEditPage;
})();
