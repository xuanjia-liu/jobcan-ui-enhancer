// scripts/manHourEditSearch.js
//
// Runs in the MAIN world (declared with "world": "MAIN" in the manifest) so it can
// reach the page's own jQuery and the native jQuery-UI autocomplete instances that
// Jobcan attaches to the project/task inputs on the rebuilt edit page.
//
// Why this exists: Jobcan's native autocomplete only matches by code/name PREFIX
// and paginates (so middle words like "ベネッセ" in "継続/ベネッセ/…" are unfindable).
// We can't replace the field from an extension — selections only count when made
// through Jobcan's own native widget (it validates against its internal model).
// So instead we keep the native widget (selection + save stay 100% native/valid)
// and only widen its SEARCH: override the autocomplete `source` to also return
// full-list substring matches. The user still picks from the native dropdown.

(function () {
  if (window.__jbeManHourSearchReady) return;
  if (!/\/employee\/man-hour-manage\/edit-achievement/.test(location.pathname)) return;
  window.__jbeManHourSearchReady = true;

  const API_BASE = '/employee/man-hour-manage-api';
  const TZ = (() => { const f = -new Date().getTimezoneOffset() * 60; return Number.isFinite(f) ? f : 32400; })();
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  // Normalize a string for kana-insensitive substring matching: NFKC folds
  // half-width kana (ﾄｷｱｶ) to full-width, then katakana (U+30A1-U+30F6) is mapped
  // to hiragana by the fixed 0x60 offset, so "ときあか" and "トキアカ" compare equal.
  function normKana(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
      .toLowerCase();
  }

  function editDate() {
    try {
      const p = new URLSearchParams(location.search);
      const y = p.get('year'), m = p.get('month'), d = p.get('day');
      if (y && m && d) return `${y}-${pad2(m)}-${pad2(d)}`;
    } catch (_) { /* fall through */ }
    return ymd(new Date());
  }

  // --- kind ids (project / task), discovered once -----------------------------
  let kindsPromise = null;
  function getKinds() {
    if (kindsPromise) return kindsPromise;
    const d = new Date(editDate());
    const from = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000);
    const to = Math.floor(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() / 1000);
    kindsPromise = fetch(`${API_BASE}/get-achievements-kinds-in-period?from=${from}&to=${to}&params=%5B%5D`, { credentials: 'include' })
      .then((r) => r.json()).then((j) => (Array.isArray(j.data) ? j.data : [])).catch(() => []);
    return kindsPromise;
  }

  // --- full unit list per kind (all pages), cached ----------------------------
  // The pre-warm below walks the whole cursor-paginated list on every page load.
  // Measured on a real account: 775 units = 9 SEQUENTIAL requests, ~2.9s of
  // round-trips (limit=100, each page needs the previous page's `next` cursor) —
  // for only ~3ms of CPU to build the index. Day-to-day navigation with the
  // 前の日/次の日 arrows re-paid that on every single load.
  //
  // So persist the raw {id: label} map in localStorage per kid+date and rebuild
  // the norm index locally (cheap). Cached entries are served SYNCHRONOUSLY, so
  // substring search is ready on the first keystroke instead of ~3s in. Entries
  // past LIST_TTL_MS are still served immediately, then refreshed in the
  // background (stale-while-revalidate) so a newly added project appears next
  // load without ever putting the fetch back on the critical path.
  const LIST_CACHE_PREFIX = 'jbe_mh_units_v1:';
  const LIST_TTL_MS = 6 * 60 * 60 * 1000; // refresh at most this often
  const LIST_MAX_ENTRIES = 6;             // LRU cap (~32KB each) to bound quota

  const cacheKey = (kid, date) => `${LIST_CACHE_PREFIX}${kid}:${date}`;

  // Keep only the newest LIST_MAX_ENTRIES of our own keys; also used to make room
  // after a quota error.
  function pruneListCache(keepNewest) {
    try {
      const mine = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LIST_CACHE_PREFIX)) {
          let t = 0;
          try { t = (JSON.parse(localStorage.getItem(k)) || {}).t || 0; } catch (_) { t = 0; }
          mine.push({ k, t });
        }
      }
      mine.sort((a, b) => b.t - a.t); // newest first
      mine.slice(Math.max(0, keepNewest)).forEach((e) => { try { localStorage.removeItem(e.k); } catch (_) {} });
    } catch (_) { /* storage unavailable */ }
  }

  // -> { items:[{id,label,norm}], stale:boolean } | null
  function readListCache(kid, date) {
    let raw;
    try { raw = localStorage.getItem(cacheKey(kid, date)); } catch (_) { return null; }
    if (!raw) return null;
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { return null; }
    if (!rec || !rec.d || typeof rec.d !== 'object') return null;
    const items = Object.keys(rec.d).map((id) => {
      const label = String(rec.d[id]);
      return { id, label, norm: normKana(label) };
    });
    if (!items.length) return null;
    return { items, stale: !(rec.t > 0 && Date.now() - rec.t < LIST_TTL_MS) };
  }

  function writeListCache(kid, date, map) {
    const payload = JSON.stringify({ t: Date.now(), d: map });
    try {
      localStorage.setItem(cacheKey(kid, date), payload);
    } catch (_) {
      // Most likely QuotaExceededError — drop older entries and retry once.
      pruneListCache(1);
      try { localStorage.setItem(cacheKey(kid, date), payload); } catch (_) { return; }
    }
    pruneListCache(LIST_MAX_ENTRIES);
  }

  // Walk every page of the cursor-paginated endpoint. Resolves to the raw
  // {id: label} map so it can be cached verbatim.
  async function fetchFullList(kid, date) {
    let next = null, map = {}, pages = 0;
    do {
      let url = `${API_BASE}/autocomplete-employee-units?kid=${encodeURIComponent(kid)}&date=${date}&tz_offset=${TZ}&term=&limit=100`;
      if (next) url += `&next=${encodeURIComponent(next)}`;
      const r = await fetch(url, { credentials: 'include' }).then((x) => x.json()).catch(() => ({}));
      const data = (r && r.data && typeof r.data === 'object') ? r.data : {};
      Object.keys(data).forEach((id) => { map[id] = String(data[id]); });
      next = (r && r.next) ? r.next : null;
      pages += 1;
    } while (next && pages < 25);
    return map;
  }

  const toItems = (map) => Object.keys(map).map((id) => {
    const label = String(map[id]);
    return { id, label, norm: normKana(label) };
  });

  const listPromises = {}; // kid -> Promise
  const lists = {};        // kid -> resolved [{id,label,norm}] (sync access in _search)
  function loadFullList(kid) {
    if (listPromises[kid]) return listPromises[kid];
    const date = editDate();

    const cached = readListCache(kid, date);
    if (cached) {
      lists[kid] = cached.items;                       // available synchronously
      listPromises[kid] = Promise.resolve(cached.items);
      if (cached.stale) {
        // Background refresh; never blocks search, which is already answerable.
        fetchFullList(kid, date).then((map) => {
          const items = toItems(map);
          if (items.length) { lists[kid] = items; writeListCache(kid, date, map); }
        }).catch(() => {});
      }
      return listPromises[kid];
    }

    listPromises[kid] = fetchFullList(kid, date).then((map) => {
      const items = toItems(map);
      lists[kid] = items;
      if (items.length) writeListCache(kid, date, map);
      return items;
    }).catch(() => {
      // Don't poison the slot — a later focus can retry.
      delete listPromises[kid];
      return [];
    });
    return listPromises[kid];
  }

  function rowUnitInputs(input) {
    const tr = input.closest('tr');
    return tr ? Array.from(tr.querySelectorAll('input.unit')) : [];
  }

  // --- pinning + per-option actions (pin-to-top, copy) ------------------------
  // Pins are stored by trimmed label in localStorage and shared across rows; a
  // pinned project label only appears in project dropdowns anyway, so one set is
  // enough for both プロジェクト and タスク.
  const PIN_STORE_KEY = 'jbe_manhour_pins';
  let pins;
  try { pins = new Set(JSON.parse(localStorage.getItem(PIN_STORE_KEY) || '[]')); }
  catch (_) { pins = new Set(); }
  function savePins() { try { localStorage.setItem(PIN_STORE_KEY, JSON.stringify([...pins])); } catch (_) {} }
  const pinKey = (label) => String(label == null ? '' : label).trim();
  const isPinned = (label) => pins.has(pinKey(label));
  function togglePin(label) { const k = pinKey(label); if (!k) return; if (pins.has(k)) pins.delete(k); else pins.add(k); savePins(); }

  const PIN_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .354.854L10.707 2H11.5a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-.5l-.5 4 1.5 1.5a.5.5 0 0 1-.354.854H8.5v3a.5.5 0 0 1-1 0v-3H4.354A.5.5 0 0 1 4 11.854L5.5 10.354 5 6h-.5A.5.5 0 0 1 4 5.5v-3a.5.5 0 0 1 .5-.5h.793L4.146.854A.5.5 0 0 1 4.146.146z"/></svg>';
  const COPY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h1V2zm1 1h5a2 2 0 0 1 2 2v6a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v1zM4 4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H4z"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M13.485 1.929a1 1 0 0 1 0 1.414l-7.071 7.071a1 1 0 0 1-1.414 0L1.515 6.929a1 1 0 1 1 1.414-1.414l2.778 2.778 6.364-6.364a1 1 0 0 1 1.414 0z"/></svg>';

  function copyToClipboard(text, btn) {
    const done = () => { btn.classList.add('copied'); btn.innerHTML = CHECK_SVG; setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_SVG; }, 1100); };
    const fallback = () => { try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;left:-9999px;'; document.body.appendChild(ta); ta.focus(); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch (_) {} };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
      else fallback();
    } catch (_) { fallback(); }
  }

  // Decorate one option: re-lay it as two rows (project name on top, smaller
  // "ID:…" below) and add pin/copy buttons. Idempotent and self-healing — it
  // re-decorates if Jobcan re-renders/resets the option (keyed on the presence of
  // our .jbe-opt-name, not a one-shot flag).
  function decorateLi(li) {
    const wrapper = li.querySelector('.ui-menu-item-wrapper') || li;
    if (!wrapper || wrapper.querySelector('.jbe-opt-name')) return; // already decorated
    const label = (wrapper.textContent || '').replace(/　+$/, '').trim();
    if (!label) return;
    if (isPinned(label)) li.classList.add('jbe-pinned-row');

    // Two rows: name (primary) over a smaller "ID:<code>" line, so the name is
    // readable instead of being pushed off-screen by the leading "(code)".
    const m = label.match(/^\(([^)]*)\)\s*([\s\S]*)$/);
    const code = m ? m[1].trim() : '';
    const name = m ? (m[2].trim() || label) : label;
    wrapper.textContent = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'jbe-opt-name';
    nameEl.textContent = name;
    wrapper.appendChild(nameEl);
    if (code) {
      const idEl = document.createElement('div');
      idEl.className = 'jbe-opt-id';
      idEl.textContent = 'ID:' + code;
      wrapper.appendChild(idEl);
    }

    const actions = document.createElement('span');
    actions.className = 'jbe-opt-actions';
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'jbe-opt-btn jbe-opt-pin' + (isPinned(label) ? ' is-pinned' : '');
    pinBtn.title = isPinned(label) ? 'ピン留めを解除' : '上部にピン留め';
    pinBtn.innerHTML = PIN_SVG;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'jbe-opt-btn jbe-opt-copy';
    copyBtn.title = '名称をコピー';
    copyBtn.innerHTML = COPY_SVG;
    actions.appendChild(pinBtn);
    actions.appendChild(copyBtn);
    // Anchor to the <li> (full width), NOT the wrapper (inline-block, shrink-wraps).
    li.appendChild(actions);

    // Keep clicks on the buttons from selecting/closing the option; preventDefault
    // on mousedown also stops the input from blurring, so the menu stays open.
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    [pinBtn, copyBtn].forEach((b) => { b.addEventListener('mousedown', stop); b.addEventListener('mouseup', stop); });
    pinBtn.addEventListener('click', (e) => {
      stop(e);
      togglePin(label);
      // Re-run the search on the focused unit input so the pinned row jumps to top
      // (mousedown preventDefault kept the input focused, so activeElement is it).
      const inp = document.activeElement;
      if (inp && inp.classList && inp.classList.contains('unit')) {
        try { window.jQuery(inp).autocomplete('search', inp.value); } catch (_) {}
      }
    });
    copyBtn.addEventListener('click', (e) => { stop(e); copyToClipboard(label, copyBtn); });
  }

  function decorateAll() {
    document.querySelectorAll('ul.ui-autocomplete li.ui-menu-item').forEach(decorateLi);
  }

  // One persistent observer on the dropdown container re-decorates options after
  // every (re-)render. jQuery-UI/Jobcan recreate the menu <ul> and rebuild its
  // <li>s on each keystroke/open, so a per-menu observer doesn't survive — watch
  // the stable #autocomplete-base container instead. Disconnect while decorating
  // so our own DOM writes don't re-trigger the observer.
  function setupMenuDecorator() {
    if (window.__jbeMenuDecorator) return;
    const base = document.getElementById('autocomplete-base') || document.body;
    const obs = new MutationObserver(() => {
      obs.disconnect();
      try { decorateAll(); } catch (_) {}
      obs.observe(base, { childList: true, subtree: true });
    });
    obs.observe(base, { childList: true, subtree: true });
    window.__jbeMenuDecorator = obs;
    decorateAll();
  }

  // --- patch the widget's _search to answer from our cached full list ---------
  // Resolved kinds (project/task ids), cached so we can re-patch synchronously.
  let kindsCache = null;

  // Patch one widget instance's _search. We override _search (not the `source`
  // option) because Jobcan owns `source` and re-assigns it to its own async loader.
  // Jobcan ALSO recreates the whole widget (resetting _search to the jQuery-UI
  // default + source to its loader) every time the field is re-focused/reopened —
  // so this is RE-APPLIED on each focus/keystroke (see ensurePatched + listeners),
  // not once. Once the full unit list is cached, answer SYNCHRONOUSLY from it
  // (prefix + substring + kana-folded). The cached items carry the same
  // {id,label,value} as the native ones (same API), so selection/save is unaffected.
  function patchSearch(input, inst) {
    if (!inst || (inst._search && inst._search.__jbe)) return; // already ours
    if (!kindsCache) return;                                   // kinds not ready yet
    const idx = rowUnitInputs(input).indexOf(input);
    const kid = kindsCache[idx] ? kindsCache[idx].id : null;
    if (!kid) return;
    loadFullList(kid); // warm the cache
    const origSearch = inst._search;
    const patched = function (value) {
      const term = value == null ? this.element.val() : value;
      const nterm = normKana(term || '');
      if (Array.isArray(lists[kid])) {
        try { this.element.removeClass('ui-autocomplete-loading'); } catch (_) {}
        const matches = lists[kid].filter((o) => o.norm.includes(nterm));
        matches.sort((a, b) => {
          const pa = isPinned(a.label) ? 0 : 1, pb = isPinned(b.label) ? 0 : 1;
          if (pa !== pb) return pa - pb;                          // pinned first
          return a.norm.indexOf(nterm) - b.norm.indexOf(nterm);  // earlier (prefix) match first
        });
        this.__response(matches.slice(0, 100).map((o) => ({ id: o.id, label: o.label, value: o.label })));
        return;
      }
      // List not cached yet (cold start, ~2s): use Jobcan's native search now, then
      // re-run once the list resolves so substring matches fill in automatically.
      loadFullList(kid).then(() => {
        if (this.element.val() === term) { try { this._search(term); } catch (_) {} }
      });
      return origSearch.call(this, value);
    };
    patched.__jbe = true;
    inst._search = patched;
  }

  function ensurePatched(input) {
    const $ = window.jQuery;
    if (!$ || !$.fn || !$.fn.autocomplete) return;
    let inst;
    try { inst = $(input).autocomplete('instance'); } catch (_) { inst = null; }
    if (inst) patchSearch(input, inst);
  }

  function scan() {
    setupMenuDecorator();
    document.querySelectorAll('table.jbc-table tbody tr:not(#template) input.unit').forEach(ensurePatched);
  }

  // Pre-warm: resolve the kinds (cached for re-patching) and load the full unit
  // lists as early as possible (on page load, before the user focuses a field) so
  // substring search is ready by the time they type — ~600 items / several pages.
  getKinds().then((kinds) => {
    kindsCache = kinds;
    kinds.forEach((k) => { if (k && k.id) loadFullList(k.id); });
  });

  // Re-apply the _search patch whenever a unit field is focused or typed into:
  // Jobcan recreates the autocomplete widget (wiping our patch) on every reopen, so
  // a one-time patch is lost after the first open. The capture-phase `input` listener
  // re-patches BEFORE jQuery-UI's (debounced) search runs; focusin (+ short retries)
  // covers the widget being (re)created lazily on focus.
  const repatchFromEvent = (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('unit') && t.closest && t.closest('table.jbc-table')) {
      ensurePatched(t);
      setTimeout(() => ensurePatched(t), 60);
      setTimeout(() => ensurePatched(t), 200);
    }
  };
  document.addEventListener('focusin', repatchFromEvent, true);
  document.addEventListener('input', repatchFromEvent, true);

  // The form + rows render asynchronously; retry for a while and watch for new rows.
  const startedAt = Date.now();
  const timer = setInterval(() => {
    scan();
    if (Date.now() - startedAt > 15000) clearInterval(timer);
  }, 500);

  const observer = new MutationObserver(() => scan());
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();
