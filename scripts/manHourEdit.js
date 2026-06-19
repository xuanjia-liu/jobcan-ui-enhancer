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
      refreshSuggestionChips();
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
        if (rowsChanged) refreshSuggestionChips();
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
