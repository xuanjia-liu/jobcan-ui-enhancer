// scripts/manHourEdit.js
//
// Enhancements for the rebuilt man-hour edit page
// (/employee/man-hour-manage/edit-achievement). Jobcan replaced the old modal +
// <select> dropdowns with a standalone page whose project/task fields are plain
// text inputs (input.unit) backed by jQuery-UI autocomplete and a REST API.
//
// This module:
//   * normalizes decimal-hour entry on input.manhour ("3" -> "3:00", "3.5" -> "3:30")
//   * replaces the per-field autocomplete with the richer searchable side panel
//     (search, category tabs, usage-sorting, copy) driven by JBE_ManHourApi
//   * shows per-row "suggestion chips" proposing the value that balances the day
//
// Selection contract (verified live): the page stores the chosen unit in
// jQuery data('selectedItem') = { id, label, value } and reacts to the
// 'autocompleteselect' event. Writing a value back therefore means: set
// input.value + title, then $(input).trigger('autocompleteselect', { item }).

(function () {
  if (window.__jbe_manHourEditModuleReady) return;
  window.__jbe_manHourEditModuleReady = true;

  const Api = () => window.JBE_ManHourApi;
  const jq = () => window.jQuery || window.$;

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  function getEditDate() {
    try {
      const params = new URLSearchParams(window.location.search);
      const y = params.get('year');
      const m = params.get('month');
      const d = params.get('day');
      if (y && m && d) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    } catch (_) { /* fall through */ }
    return Api() ? Api().toYmd(new Date()) : '';
  }

  function getEditTable() {
    return document.querySelector('table.jbc-table');
  }

  function getRowUnitInputs(row) {
    return row ? Array.from(row.querySelectorAll('input.unit')) : [];
  }

  // 0 === project, 1 === task (column order is authoritative; the `series`
  // attribute is NOT a stable column index, so we use position instead).
  function unitColumnIndex(input) {
    const row = input.closest('tr');
    return getRowUnitInputs(row).indexOf(input);
  }

  function parseHHMMToSeconds(text) {
    const m = String(text || '').trim().match(/^(\d{1,4}):(\d{1,2})$/);
    if (!m) return null;
    return ((parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0)) * 60;
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
  // 2. Project usage stats (most-used-first ordering for the project picker)
  // ---------------------------------------------------------------------------

  const PROJECT_USAGE_STORAGE_KEY = 'jbeProjectUsageStats';

  function readProjectUsageStats() {
    try {
      const raw = window.localStorage.getItem(PROJECT_USAGE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function recordProjectUsage(label, id) {
    const key = String(label || '').trim();
    if (!key || /未選択|選択してください/.test(key)) return;
    try {
      const stats = readProjectUsageStats();
      const current = stats[key] && typeof stats[key] === 'object' ? stats[key] : {};
      stats[key] = {
        count: Number.isFinite(current.count) ? current.count + 1 : 1,
        lastUsedAt: Date.now(),
        id: id || current.id || ''
      };
      window.localStorage.setItem(PROJECT_USAGE_STORAGE_KEY, JSON.stringify(stats));
    } catch (_) { /* ignore quota / serialization errors */ }
  }

  function sortOptionsByUsage(options) {
    const stats = readProjectUsageStats();
    return [...options].sort((a, b) => {
      const sa = stats[a.label] || null;
      const sb = stats[b.label] || null;
      const ca = sa && Number.isFinite(sa.count) ? sa.count : 0;
      const cb = sb && Number.isFinite(sb.count) ? sb.count : 0;
      if (ca !== cb) return cb - ca;
      const la = sa && Number.isFinite(sa.lastUsedAt) ? sa.lastUsedAt : 0;
      const lb = sb && Number.isFinite(sb.lastUsedAt) ? sb.lastUsedAt : 0;
      if (la !== lb) return lb - la;
      return a.label.localeCompare(b.label, 'ja');
    });
  }

  // ---------------------------------------------------------------------------
  // 3. Category generation from option labels
  // ---------------------------------------------------------------------------

  function generateCategories(options) {
    const counts = {};
    const order = [];
    options.forEach((opt) => {
      const name = Api().parseUnitLabel(opt.label).name;
      const words = name
        .split(/[/\s,、・【】[\]()]+/g)
        .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !['選択', '未分類'].includes(w));
      // de-dup within a single option so one option can't inflate a count
      new Set(words).forEach((w) => {
        if (!(w in counts)) { counts[w] = 0; order.push(w); }
        counts[w] += 1;
      });
    });
    return order
      .filter((w) => counts[w] >= 2)
      .sort((a, b) => counts[b] - counts[a])
      .slice(0, 10)
      .map((w, i) => ({ id: `cat_${i}`, name: w, word: w }));
  }

  function categoriesForOption(label, categories) {
    const name = Api().parseUnitLabel(label).name;
    return categories.filter((c) => name.includes(c.word)).map((c) => c.id);
  }

  // ---------------------------------------------------------------------------
  // 4. The searchable side-panel picker
  // ---------------------------------------------------------------------------

  let activePanel = null;
  // Full project list per kind, loaded once and reused (≈600 items, ~7 requests).
  // Lets the picker search the whole catalog client-side by substring, instead of
  // the server's prefix-only match (which can't find middle words like "ベネッセ"
  // in "継続/ベネッセ/…" no matter how far the native dropdown is scrolled).
  const projectListCache = {};

  function closeUnitPicker() {
    document.body.classList.remove('jbe-unit-picker-open');
    if (!activePanel) return;
    const panel = activePanel;
    activePanel = null;
    panel.classList.remove('open');
    setTimeout(() => { if (panel.parentNode) panel.remove(); }, 250);
  }

  function applyUnitSelection(input, option) {
    const $ = jq();
    const item = { id: option.id, label: option.label, value: option.label };
    input.value = option.label;
    input.setAttribute('title', option.label);
    if ($) {
      $(input).data('selectedItem', item);
      // Native code path: the page persists the value via this event.
      $(input).trigger('autocompleteselect', { item });
      $(input).trigger('change');
    } else {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function openUnitPicker(input) {
    if (!Api()) return;
    // Toggle off if re-opening for the same input.
    if (activePanel && activePanel.__jbeInput === input) { closeUnitPicker(); return; }
    closeUnitPicker();

    const colIndex = unitColumnIndex(input);
    const isProject = colIndex === 0;
    const date = getEditDate();

    const kinds = await Api().resolveKinds(date);
    const kindList = kinds.kinds || [];
    const kid = (kindList[colIndex] && kindList[colIndex].id) ||
      (isProject ? kinds.projectKindId : kinds.taskKindId);
    if (!kid) return;

    // Scope the search using the other already-chosen units in this row
    // (e.g. tasks scoped to the selected project).
    const $ = jq();
    const selected = getRowUnitInputs(input.closest('tr'))
      .filter((u) => u !== input)
      .map((u) => {
        const item = $ ? $(u).data('selectedItem') : null;
        const otherKind = kindList[unitColumnIndex(u)];
        return item && item.id && otherKind ? { kindId: otherKind.id, unitId: item.id } : null;
      })
      .filter(Boolean);

    const panel = buildPanel(input, { isProject });
    activePanel = panel;
    panel.__jbeInput = input;
    document.body.appendChild(panel);
    document.body.classList.add('jbe-unit-picker-open');
    requestAnimationFrame(() => panel.classList.add('open'));

    const ctx = { input, kid, date, selected, isProject, panel, searchTerm: '', activeCategory: 'all' };
    panel.__jbeCtx = ctx; // delegated handlers (search/keyboard) read this
    await loadOptions(ctx);
    const search = panel.querySelector('.sidepanel-search');
    if (search) setTimeout(() => search.focus(), 120);
  }

  function buildPanel(input, { isProject }) {
    const panel = document.createElement('div');
    panel.className = `select-sidepanel jbe-anchored-right ${isProject ? 'project-panel' : 'task-panel'}`;

    const header = document.createElement('div');
    header.className = 'sidepanel-header';

    const title = document.createElement('h3');
    title.textContent = isProject ? 'プロジェクト選択' : 'タスク選択';
    title.style.whiteSpace = 'nowrap';

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'sidepanel-search';
    search.placeholder = '検索...';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'sidepanel-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4L4 12M4 4L12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    closeBtn.addEventListener('click', closeUnitPicker);

    header.appendChild(title);
    header.appendChild(search);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const tabs = document.createElement('div');
    tabs.className = 'tabs-container';
    panel.appendChild(tabs);

    const count = document.createElement('div');
    count.className = 'sidepanel-count';
    panel.appendChild(count);

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'options-container';
    const optionsList = document.createElement('ul');
    optionsList.className = 'options-list';
    optionsContainer.appendChild(optionsList);
    panel.appendChild(optionsContainer);

    if (typeof window.makeTabsContainerDraggable === 'function') {
      window.makeTabsContainerDraggable(tabs);
    }

    // Copy buttons (event-delegated).
    optionsContainer.addEventListener('click', (event) => {
      const btn = event.target.closest('.copy-option-btn');
      if (!btn) return;
      event.stopPropagation();
      const item = btn.closest('.option-item');
      const text = item ? (item.dataset.label || item.textContent.replace('コピー', '').trim()) : '';
      navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = 'コピー済み';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1000);
      }).catch(() => { /* clipboard unavailable */ });
    });

    return panel;
  }

  // Loads the FULL unit list (all pages) so search can filter client-side by
  // substring. Projects are cached per kind for the session.
  async function loadOptions(ctx) {
    const list = ctx.panel.querySelector('.options-list');
    list.innerHTML = '<li class="no-options">読み込み中...</li>';
    let options;
    try {
      if (ctx.isProject && projectListCache[ctx.kid]) {
        options = projectListCache[ctx.kid];
      } else {
        options = await Api().getAllUnits({ kid: ctx.kid, date: ctx.date, selected: ctx.selected });
        if (ctx.isProject) projectListCache[ctx.kid] = options;
      }
    } catch (_) {
      if (activePanel === ctx.panel) list.innerHTML = '<li class="no-options">読み込みに失敗しました</li>';
      return;
    }
    if (activePanel !== ctx.panel) return; // panel closed/replaced while loading

    ctx.allOptions = ctx.isProject ? sortOptionsByUsage(options) : options;
    renderTabs(ctx);
    renderOptions(ctx);
  }

  function renderTabs(ctx) {
    const tabsContainer = ctx.panel.querySelector('.tabs-container');
    const categories = ctx.isProject ? generateCategories(ctx.allOptions) : [];
    ctx.categories = categories;
    tabsContainer.innerHTML = '';

    const makeTab = (cat, active) => {
      const tab = document.createElement('div');
      tab.className = `tab${active ? ' active' : ''}`;
      tab.dataset.category = cat.id;
      tab.textContent = cat.name;
      tab.addEventListener('click', () => {
        tabsContainer.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        ctx.activeCategory = cat.id;
        renderOptions(ctx);
      });
      return tab;
    };

    tabsContainer.appendChild(makeTab({ id: 'all', name: 'すべて' }, true));
    categories.forEach((cat) => tabsContainer.appendChild(makeTab(cat, false)));
    ctx.activeCategory = 'all';
    tabsContainer.style.display = categories.length ? '' : 'none';
  }

  function renderOptions(ctx) {
    const list = ctx.panel.querySelector('.options-list');
    list.innerHTML = '';
    const all = ctx.allOptions || [];
    const term = (ctx.searchTerm || '').trim().toLowerCase();

    // Filter the full list by the active category AND the search term (substring,
    // case-insensitive, across the whole "(code)name" label).
    const options = all.filter((opt) => {
      if (ctx.activeCategory && ctx.activeCategory !== 'all') {
        if (!categoriesForOption(opt.label, ctx.categories).includes(ctx.activeCategory)) return false;
      }
      if (term && !opt.label.toLowerCase().includes(term)) return false;
      return true;
    });

    const countEl = ctx.panel.querySelector('.sidepanel-count');
    if (countEl) countEl.textContent = all.length ? `${options.length} / ${all.length} 件` : '';

    if (!options.length) {
      const empty = document.createElement('li');
      empty.className = 'no-options';
      empty.textContent = all.length ? '該当する項目がありません' : (ctx.isProject ? 'プロジェクトがありません' : 'タスクがありません');
      list.appendChild(empty);
      return;
    }

    const currentId = (() => {
      const $ = jq();
      const item = $ ? $(ctx.input).data('selectedItem') : null;
      return item ? item.id : null;
    })();

    options.forEach((opt) => {
      const li = document.createElement('li');
      li.className = 'option-item';
      li.dataset.value = opt.id;
      li.dataset.label = opt.label;
      li.textContent = opt.label;
      if (opt.id === currentId) li.classList.add('selected');

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-option-btn';
      copyBtn.textContent = 'コピー';
      li.appendChild(copyBtn);

      li.addEventListener('click', () => {
        applyUnitSelection(ctx.input, opt);
        if (ctx.isProject) recordProjectUsage(opt.label, opt.id);
        list.querySelectorAll('.option-item').forEach((o) => o.classList.remove('selected'));
        li.classList.add('selected');

        if (ctx.isProject) {
          // Move focus toward the task field for the same row.
          const taskInput = getRowUnitInputs(ctx.input.closest('tr'))[1];
          closeUnitPicker();
          if (taskInput) setTimeout(() => openUnitPicker(taskInput), 120);
        } else {
          const timeInput = ctx.input.closest('tr').querySelector('input.manhour');
          closeUnitPicker();
          if (timeInput) setTimeout(() => timeInput.focus(), 120);
        }
      });
      list.appendChild(li);
    });

    if (!list.children.length) {
      const empty = document.createElement('li');
      empty.className = 'no-options';
      empty.textContent = '該当する項目がありません';
      list.appendChild(empty);
    }
  }

  function wireUnitInput(input) {
    if (!input || input.dataset.jbeUnitPicker === '1') return;
    input.dataset.jbeUnitPicker = '1';

    const open = (event) => {
      event.preventDefault();
      // Close the native jQuery-UI menu if it tried to open.
      const $ = jq();
      if ($) { try { $(input).autocomplete('close'); } catch (_) { /* not an autocomplete */ } }
      openUnitPicker(input);
    };

    input.addEventListener('mousedown', open);
    input.addEventListener('focus', () => {
      if (!activePanel || activePanel.__jbeInput !== input) openUnitPicker(input);
    });
  }

  // Debounced server search + live keyboard navigation, bound once per panel via
  // delegation on the document (panels are created/destroyed frequently).
  function setupPanelInteractions() {
    if (window.__jbe_unitPanelInteractions) return;
    window.__jbe_unitPanelInteractions = true;

    document.addEventListener('input', (event) => {
      const search = event.target.closest && event.target.closest('.sidepanel-search');
      if (!search || !activePanel) return;
      const ctx = activePanel.__jbeCtx;
      if (!ctx) return;
      // Full client-side substring filter over the already-loaded list — instant,
      // and finds matches anywhere in the code/name (not just prefixes).
      ctx.searchTerm = search.value;
      renderOptions(ctx);
    });

    document.addEventListener('keydown', (event) => {
      if (!activePanel) return;
      if (event.key === 'Escape') { event.preventDefault(); closeUnitPicker(); return; }
      const search = activePanel.querySelector('.sidepanel-search');
      if (event.target !== search) return;
      const visible = Array.from(activePanel.querySelectorAll('.option-item')).filter((o) => o.style.display !== 'none');
      if (!visible.length) return;
      let idx = visible.findIndex((o) => o.classList.contains('keyboard-focused'));
      const clear = () => visible.forEach((o) => o.classList.remove('keyboard-focused'));
      if (event.key === 'ArrowDown') {
        event.preventDefault(); clear();
        idx = (idx + 1) % visible.length;
        visible[idx].classList.add('keyboard-focused');
        visible[idx].scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'ArrowUp') {
        event.preventDefault(); clear();
        idx = idx <= 0 ? visible.length - 1 : idx - 1;
        visible[idx].classList.add('keyboard-focused');
        visible[idx].scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && idx >= 0) {
        event.preventDefault(); visible[idx].click();
      }
    });

    // Click-away closes the panel.
    document.addEventListener('mousedown', (event) => {
      if (!activePanel) return;
      if (activePanel.contains(event.target)) return;
      if (event.target.closest && event.target.closest('input.unit')) return;
      closeUnitPicker();
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Suggestion chips: propose the man-hour value that balances the day
  // ---------------------------------------------------------------------------

  function getActualWorkSeconds() {
    // The 工数情報 panel lists 実労働時間 in an adjacent cell.
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
        const show = () => { chip.style.display = 'block'; };
        const hide = () => { if (document.activeElement !== input && !chip.matches(':hover')) chip.style.display = 'none'; };
        input.addEventListener('mouseover', show);
        input.addEventListener('focus', show);
        input.addEventListener('mouseout', hide);
        input.addEventListener('blur', () => setTimeout(hide, 50));
        chip.addEventListener('mouseover', show);
        chip.addEventListener('mouseout', hide);
        chip.addEventListener('click', () => {
          input.value = Api().secondsToHHMM(Number(chip.dataset.seconds) || 0);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          chip.style.display = 'none';
          refreshSuggestionChips();
        });
      }
      chip.dataset.seconds = String(suggestedSecs);
      chip.textContent = `提案: ${Api().secondsToHHMM(suggestedSecs)}`;
    });
  }

  // ---------------------------------------------------------------------------
  // 6. Keyboard shortcuts for the standalone edit page
  // ---------------------------------------------------------------------------

  function setupEditKeyboardShortcuts() {
    if (window.__jbe_manHourEditShortcuts) return;
    window.__jbe_manHourEditShortcuts = true;
    document.addEventListener('keydown', (e) => {
      if (!(window.location.pathname || '').startsWith('/employee/man-hour-manage/edit-achievement')) return;
      if (activePanel) return; // panel handles its own keys
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

  // Works whether `root` is the document, the table, or a single newly-added row.
  function enhanceExistingRows(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('input.unit').forEach((input) => {
      if (input.closest('table.jbc-table') && !input.closest('#template')) wireUnitInput(input);
    });
    scope.querySelectorAll('input.manhour').forEach((input) => {
      if (input.closest('table.jbc-table') && !input.closest('#template')) attachDecimalHoursNormalizer(input);
    });
  }

  function setupManHourEditPage() {
    if (window.__jbe_manHourEditPageInited) return;
    if (!Api()) return; // API client must be loaded first
    window.__jbe_manHourEditPageInited = true;

    setupPanelInteractions();
    setupEditKeyboardShortcuts();

    const init = () => {
      const table = getEditTable();
      if (!table) return false;
      enhanceExistingRows(document);
      refreshSuggestionChips();
      return true;
    };

    if (!init()) {
      // The form may still be rendering; retry briefly.
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (init() || Date.now() - startedAt > 8000) clearInterval(timer);
      }, 300);
    }

    // React to rows being added/removed (追加 / 削除 / template clone). Observe the
    // tbody's *direct* children only (no subtree): rows are direct tbody children,
    // whereas the suggestion chips we inject live deep inside cells — watching the
    // subtree would make our own chip writes re-trigger the observer in a loop.
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

    // Recompute suggestions whenever a man-hour value changes.
    document.addEventListener('change', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('manhour')) {
        refreshSuggestionChips();
      }
    });
  }

  window.setupManHourEditPage = setupManHourEditPage;
})();
