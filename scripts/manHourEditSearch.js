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
  //
  // get-achievements-kinds-in-period answers for a DEFINED man-hour period, not
  // "any data in this range": querying a month that has no period yet returns an
  // empty array (verified live — 2026-08 returned [], 2026-07 and 2026-06 returned
  // the 2 kinds; a multi-month window also returns []). Because patchSearch bails
  // when it can't resolve a kind id, that made the whole substring search silently
  // dead on any date in such a month — e.g. the 1st of a new month, exactly when
  // you start filling a fresh timesheet.
  //
  // So: try the edit month, then walk back a few months until one answers. Kind ids
  // are stable dimension definitions, not per-month values — a previous month's
  // project kind id returns the full unit list for a current-month date (verified:
  // July's kid + an August date returned 100 units).
  const KIND_LOOKBACK_MONTHS = 3;

  function fetchKindsForMonth(year, monthIndex) {
    const from = Math.floor(new Date(year, monthIndex, 1).getTime() / 1000);
    const to = Math.floor(new Date(year, monthIndex + 1, 1).getTime() / 1000);
    return fetch(`${API_BASE}/get-achievements-kinds-in-period?from=${from}&to=${to}&params=%5B%5D`, { credentials: 'include' })
      .then((r) => r.json())
      .then((j) => (Array.isArray(j.data) ? j.data : []))
      .catch(() => []);
  }

  let kindsPromise = null;
  function getKinds() {
    if (kindsPromise) return kindsPromise;
    const d = new Date(editDate());
    kindsPromise = (async () => {
      for (let back = 0; back <= KIND_LOOKBACK_MONTHS; back += 1) {
        const kinds = await fetchKindsForMonth(d.getFullYear(), d.getMonth() - back);
        if (kinds.length) return kinds;
      }
      return [];
    })();
    return kindsPromise;
  }

  // --- full unit list per kind (all pages), cached ----------------------------
  // The pre-warm below walks the whole cursor-paginated list on every page load.
  // Measured on a real account: 775 units = 9 SEQUENTIAL requests, ~2.9s of
  // round-trips (limit=100, each page needs the previous page's `next` cursor) —
  // for only ~3ms of CPU to build the index. Day-to-day navigation with the
  // 前の日/次の日 arrows re-paid that on every single load.
  //
  // So persist the raw {id: label} map in localStorage per kind and rebuild the
  // norm index locally (cheap). Cached entries are served SYNCHRONOUSLY, so
  // substring search is ready on the first keystroke instead of ~3s in. Entries
  // past LIST_TTL_MS are still served immediately, then refreshed in the
  // background (stale-while-revalidate) so a newly added project appears next
  // load without ever putting the fetch back on the critical path.
  //
  // The key is the KIND ONLY — deliberately not kind+date. It used to include the
  // edit date, which made the cache almost useless in practice: the 前の日/次の日
  // arrows this extension adds make day-hopping the normal workflow, and at 2 kinds
  // per day an LRU of 6 held just THREE days. Walking back a week evicted
  // everything and re-paid the 9-request/~3s sequential prewarm on each day. The
  // unit list barely varies day to day, so the date is kept inside the record as a
  // revalidation hint instead: a cached list built for another date is still served
  // instantly, then refreshed in the background like any other stale entry.
  const LIST_CACHE_PREFIX = 'jbe_mh_units_v2:';
  const LEGACY_CACHE_PREFIX = 'jbe_mh_units_v1:'; // date-keyed; purged on load
  const LIST_TTL_MS = 6 * 60 * 60 * 1000; // refresh at most this often
  const LIST_MAX_ENTRIES = 4;             // one per kind (project/task), plus headroom

  const cacheKey = (kid) => `${LIST_CACHE_PREFIX}${kid}`;

  // One-time removal of the v1 date-keyed entries (~32KB each, up to 6 of them).
  function purgeLegacyListCache() {
    try {
      const stale = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LEGACY_CACHE_PREFIX)) stale.push(k);
      }
      stale.forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) { /* storage unavailable */ }
  }

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
  // Stale when the TTL has lapsed OR the entry was built for a different date;
  // either way the caller serves it immediately and revalidates in the background.
  function readListCache(kid, date) {
    let raw;
    try { raw = localStorage.getItem(cacheKey(kid)); } catch (_) { return null; }
    if (!raw) return null;
    let rec;
    try { rec = JSON.parse(raw); } catch (_) { return null; }
    if (!rec || !rec.d || typeof rec.d !== 'object') return null;
    const items = Object.keys(rec.d).map((id) => {
      const label = String(rec.d[id]);
      return { id, label, norm: normKana(label) };
    });
    if (!items.length) return null;
    const fresh = rec.t > 0 && Date.now() - rec.t < LIST_TTL_MS && rec.date === date;
    return { items, stale: !fresh };
  }

  function writeListCache(kid, date, map) {
    const payload = JSON.stringify({ t: Date.now(), date, d: map });
    try {
      localStorage.setItem(cacheKey(kid), payload);
    } catch (_) {
      // Most likely QuotaExceededError — drop older entries and retry once.
      pruneListCache(1);
      try { localStorage.setItem(cacheKey(kid), payload); } catch (_) { return; }
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

  // --- "recently used" ranking ------------------------------------------------
  //
  // The full project list is ~775 entries, but in practice a person cycles through
  // a handful. get-achievements-list already returns every entry's {kind_id,
  // unit_id} for a date range, so the last 30 days give a frequency ranking for
  // free — no extra endpoint, and the same request the report already understands.
  //
  // Recent units sort to the top (below pins) and are badged 最近 in the dropdown,
  // with a divider after the last one so they read as a section.
  const RECENT_DAYS = 30;
  const RECENT_CACHE_KEY = 'jbe_mh_recent_v1';
  const RECENT_TTL_MS = 60 * 60 * 1000; // 1h — usage shifts slowly

  // { [kindId]: Map(unitId -> { n, last }) }
  let recentByKind = null;
  let activeKid = null; // kind of the field currently being searched (for decoration)
  // reRankOpenMenu bookkeeping: how many times we have corrected the open menu for
  // the current field, so a pathological re-render war can't spin (see MAX_RERANKS).
  let reRankInput = null;
  let reRankCount = 0;

  const dayOffsetYmd = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return ymd(d);
  };

  // localStorage can't hold Maps; persist as { kid: { unitId: [n, last] } }.
  const recentToPlain = (byKind) => {
    const out = {};
    Object.keys(byKind).forEach((kid) => {
      const o = {};
      byKind[kid].forEach((v, unitId) => { o[unitId] = [v.n, v.last]; });
      out[kid] = o;
    });
    return out;
  };

  const recentFromPlain = (plain) => {
    const out = {};
    Object.keys(plain || {}).forEach((kid) => {
      const m = new Map();
      Object.keys(plain[kid] || {}).forEach((unitId) => {
        const pair = plain[kid][unitId] || [];
        m.set(unitId, { n: Number(pair[0]) || 0, last: Number(pair[1]) || 0 });
      });
      out[kid] = m;
    });
    return out;
  };

  function readRecentCache() {
    try {
      const rec = JSON.parse(localStorage.getItem(RECENT_CACHE_KEY) || 'null');
      if (!rec || !rec.d) return null;
      return { data: recentFromPlain(rec.d), stale: !(rec.t > 0 && Date.now() - rec.t < RECENT_TTL_MS) };
    } catch (_) { return null; }
  }

  function writeRecentCache(byKind) {
    try {
      localStorage.setItem(RECENT_CACHE_KEY, JSON.stringify({ t: Date.now(), d: recentToPlain(byKind) }));
    } catch (_) { /* quota or storage unavailable */ }
  }

  async function fetchRecentUsage() {
    const from = dayOffsetYmd(-RECENT_DAYS);
    const to = dayOffsetYmd(1);
    const j = await fetch(`${API_BASE}/get-achievements-list?limit=100&from=${from}&to=${to}`, { credentials: 'include' })
      .then((r) => r.json()).catch(() => ({}));
    const days = Array.isArray(j && j.data) ? j.data : [];
    const out = {};
    days.forEach((day) => {
      const ts = Date.parse(day && day.date) || 0;
      (day.manhours || []).forEach((mh) => {
        (mh.items || []).forEach((it) => {
          if (!it || !it.kind_id || !it.unit_id) return;
          const m = out[it.kind_id] || (out[it.kind_id] = new Map());
          const cur = m.get(it.unit_id) || { n: 0, last: 0 };
          cur.n += 1;
          if (ts > cur.last) cur.last = ts;
          m.set(it.unit_id, cur);
        });
      });
    });
    return out;
  }

  // Served synchronously from cache when possible so the very first dropdown is
  // already ranked; refreshed in the background like the unit lists.
  function loadRecentUsage() {
    const cached = readRecentCache();
    if (cached) {
      recentByKind = cached.data;
      if (!cached.stale) return;
    }
    fetchRecentUsage().then((byKind) => {
      if (Object.keys(byKind).length) {
        recentByKind = byKind;
        writeRecentCache(byKind);
      }
    }).catch(() => {});
  }

  function recentEntry(kid, unitId) {
    const m = recentByKind && recentByKind[kid];
    return (m && m.get(unitId)) || null;
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
  // manHourEdit.js (ISOLATED world) can toggle a pin too, from the row popover on
  // an already-filled project cell. The two worlds share the page's localStorage
  // but not this Set, and a same-document write fires no `storage` event — so
  // whichever side writes announces it with a DOM event, which does cross the
  // world boundary. Keep the key and the event name in sync with that file.
  const PIN_CHANGE_EVENT = 'jbe:manhour-pins-changed';
  function readPins() {
    try { return new Set(JSON.parse(localStorage.getItem(PIN_STORE_KEY) || '[]')); }
    catch (_) { return new Set(); }
  }
  let pins = readPins();
  function savePins() {
    try { localStorage.setItem(PIN_STORE_KEY, JSON.stringify([...pins])); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent(PIN_CHANGE_EVENT)); } catch (_) {}
  }
  window.addEventListener(PIN_CHANGE_EVENT, () => { pins = readPins(); });
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

    // Badge anything used in the last 30 days. The option's data carries the unit
    // id (jQuery-UI stashes the source item on the <li>), which is what the recency
    // index is keyed by — matching on the label would be fragile.
    let item = null;
    try { item = window.jQuery(li).data('ui-autocomplete-item'); } catch (_) { item = null; }
    const recent = item && item.id ? recentEntry(activeKid, item.id) : null;
    if (recent) {
      li.classList.add('jbe-recent-row');
      const tag = document.createElement('span');
      tag.className = 'jbe-opt-recent';
      tag.textContent = '最近';
      tag.title = `直近${RECENT_DAYS}日で ${recent.n} 回使用`;
      nameEl.appendChild(tag);
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
    const items = document.querySelectorAll('ul.ui-autocomplete li.ui-menu-item');
    items.forEach(decorateLi);
    // Draw a divider after the last consecutive 最近 row so the recents read as a
    // section, without injecting a non-item <li> that would break keyboard nav.
    let lastRecent = null;
    for (let i = 0; i < items.length; i += 1) {
      items[i].classList.remove('jbe-recent-last');
      if (items[i].classList.contains('jbe-recent-row')) lastRecent = items[i];
      else break;
    }
    if (lastRecent && lastRecent !== items[items.length - 1]) lastRecent.classList.add('jbe-recent-last');
  }

  // One persistent observer on the dropdown container re-decorates options after
  // every (re-)render. jQuery-UI/Jobcan recreate the menu <ul> and rebuild its
  // <li>s on each keystroke/open, so a per-menu observer doesn't survive — watch
  // the stable #autocomplete-base container instead. Disconnect while decorating
  // so our own DOM writes don't re-trigger the observer.
  function setupMenuDecorator() {
    if (window.__jbeMenuDecorator) return true;
    // Bail (and retry on the next focus) rather than falling back to document.body:
    // the fallback installed a body-wide subtree observer on a page whose table
    // Jobcan re-renders constantly.
    const base = document.getElementById('autocomplete-base');
    if (!base) return false;
    const obs = new MutationObserver(() => {
      obs.disconnect();
      try { decorateAll(); } catch (_) {}
      obs.observe(base, { childList: true, subtree: true });
      // AFTER re-observing, so the menu this may render gets decorated in turn.
      try { reRankOpenMenu(); } catch (_) {}
    });
    obs.observe(base, { childList: true, subtree: true });
    window.__jbeMenuDecorator = obs;
    decorateAll();
    return true;
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
  // The kind (project / task) a unit input belongs to, from its column position.
  function kidForInput(input) {
    if (!kindsCache) return null;
    const idx = rowUnitInputs(input).indexOf(input);
    const kind = idx >= 0 ? kindsCache[idx] : null;
    return (kind && kind.id) || null;
  }

  function patchSearch(input, inst) {
    if (!inst || (inst._search && inst._search.__jbe)) return; // already ours
    if (!kindsCache) return;                                   // kinds not ready yet
    const kid = kidForInput(input);
    if (!kid) return;

    // jQuery-UI checks options.minLength BEFORE it calls _search, so with Jobcan's
    // default the ranked list could never answer an EMPTY term — focusing a blank
    // project cell showed nothing until the first keystroke, even though the whole
    // pinned/最近 ranking was already sitting in the cache. Force it to 0 so
    // openRankedList() below can open the list on focus with no typing. Re-set on
    // every (re)patch: Jobcan recreates the widget with its own options.
    try { inst.options.minLength = 0; } catch (_) { /* not fatal — typing still works */ }
    loadFullList(kid); // warm the cache
    const origSearch = inst._search;
    const patched = function (value) {
      const term = value == null ? this.element.val() : value;
      const nterm = normKana(term || '');
      if (Array.isArray(lists[kid])) {
        try { this.element.removeClass('ui-autocomplete-loading'); } catch (_) {}
        activeKid = kid; // so decorateLi can badge the recent rows
        const matches = lists[kid].filter((o) => o.norm.includes(nterm));
        matches.sort((a, b) => {
          const pa = isPinned(a.label) ? 0 : 1, pb = isPinned(b.label) ? 0 : 1;
          if (pa !== pb) return pa - pb;                          // pinned first
          // then anything used in the last 30 days, most-used first
          const ra = recentEntry(kid, a.id), rb = recentEntry(kid, b.id);
          if (!!ra !== !!rb) return ra ? -1 : 1;
          if (ra && rb) {
            if (rb.n !== ra.n) return rb.n - ra.n;
            if (rb.last !== ra.last) return rb.last - ra.last;
          }
          return a.norm.indexOf(nterm) - b.norm.indexOf(nterm);  // earlier (prefix) match first
        });
        // `__jbe` marks these as ours all the way onto the rendered <li>s: jQuery-UI's
        // _normalize passes an item through untouched when it already has label+value,
        // and stashes it on the <li> as data('ui-autocomplete-item'). menuIsRanked()
        // reads it back to tell a ranked menu from a native one.
        const items = matches.slice(0, 100)
          .map((o) => ({ id: o.id, label: o.label, value: o.label, __jbe: true }));

        // Answer through _response(), NOT __response() directly.
        //
        // _response() increments the widget's requestIndex, and that is the ONLY
        // thing that makes jQuery-UI drop a reply belonging to an earlier search.
        // Jobcan fires its own source request for a field right after 追加 clones the
        // row, so one is typically still in flight when we answer from cache.
        // __response() left requestIndex untouched, so that late reply passed the
        // freshness check and repainted the menu with the native code-prefix list a
        // split second after the ranked list had appeared — the reported bug.
        //
        // pending++ mirrors what jQuery-UI's own _search does before dispatching, so
        // the callback's pending-- keeps the ui-autocomplete-loading bookkeeping
        // balanced (an unpaired decrement leaves pending negative, i.e. truthy, and
        // the loading class stuck on).
        if (typeof this._response === 'function') {
          this.pending = (this.pending || 0) + 1;
          this._response()(items);
        } else {
          this.__response(items); // no _response() to bump — nothing we can do
        }
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

  // --- open the ranked list on focus, no typing required ----------------------
  //
  // On a normal day you book to one of a handful of projects, all of which are
  // already pinned or badged 最近 and therefore already at the top of the ranked
  // list. Requiring a keystroke to see that list was pure friction: focus the cell,
  // and the same list opens by itself, so a normal entry is two clicks.
  //
  // Only fires when the full unit list is already cached for that kind. On a cold
  // start the patched _search falls through to Jobcan's paginated loader, and an
  // empty term there would spend a request per focus on a list we are about to have
  // anyway — worse, it would open a dropdown ranked the native way (code prefix),
  // which is the ordering this feature exists to avoid.
  //
  // Retries because Jobcan creates the widget LAZILY on first focus: at the first
  // tick of a focusin there is often no instance yet, so nothing to patch or open.
  const OPEN_RETRY_MS = [60, 140, 260];

  function openRankedList(input, attempt) {
    const n = attempt || 0;
    if (input.value) return;                      // editing a filled cell — don't cover it
    if (document.activeElement !== input) return; // focus moved on while we waited

    const kid = kidForInput(input);
    if (kid && Array.isArray(lists[kid])) {
      let inst = null;
      try { inst = window.jQuery(input).autocomplete('instance'); } catch (_) { inst = null; }
      // Only once the patch is in place, or we would open the native ranking.
      if (inst && inst._search && inst._search.__jbe) {
        try { window.jQuery(input).autocomplete('search', ''); } catch (_) {}
        return;
      }
    }
    if (n < OPEN_RETRY_MS.length) setTimeout(() => openRankedList(input, n + 1), OPEN_RETRY_MS[n]);
  }

  // 追加 clones a new row and Jobcan focuses its プロジェクト field and searches it
  // ITSELF — on its own schedule, sometimes after every openRankedList retry above
  // has already run and found no widget to patch. The menu that appeared was
  // therefore Jobcan's native code-prefix list, and you had to type or click away
  // and refocus to get the pinned/最近 ranking. Chasing that timing with longer
  // retries is guesswork, so this watches the RESULT instead: called from the menu
  // observer, it re-answers from the cache whenever a menu renders for an empty unit
  // field and the ranking is not what produced it.
  //
  // Loop-free by construction: the menu our correction renders reads as ranked, so
  // the observer pass it triggers returns immediately (and MAX_RERANKS backstops it).
  // Whether the menu on screen right now is the ranked one. Read from the RENDERED
  // items, not from which side searched last: a late native reply repaints the menu
  // without any search of its own, so "we searched most recently" was true at the
  // exact moment the native list was on screen.
  function menuIsRanked() {
    const li = document.querySelector('ul.ui-autocomplete li.ui-menu-item');
    if (!li) return false;
    try {
      const item = window.jQuery(li).data('ui-autocomplete-item');
      return !!(item && item.__jbe);
    } catch (_) { return false; }
  }

  // Cap on corrections per field visit. The _response() fix above should mean this
  // never fires more than once, but if a jQuery-UI version ever strips our `__jbe`
  // marker, menuIsRanked() would read false forever and an uncapped loop would spin
  // the observer against itself and freeze the page.
  const MAX_RERANKS = 4;

  function reRankOpenMenu() {
    const input = document.activeElement;
    if (!input || !input.classList || !input.classList.contains('unit')) return;
    if (!input.closest || !input.closest('table.jbc-table')) return;
    if (input.value) return;   // a term the user typed — leave their results alone
    if (menuIsRanked()) return; // already the ranked list

    // Only when a menu is actually OPEN with items. Without this, the empty render
    // that CLOSING the menu produces would be read as "Jobcan answered" and we would
    // immediately re-open it — Escape would stop working.
    if (!document.querySelector('ul.ui-autocomplete li.ui-menu-item')) return;

    const kid = kidForInput(input);
    if (!kid || !Array.isArray(lists[kid])) return; // cold cache — native list is all there is

    if (input !== reRankInput) { reRankInput = input; reRankCount = 0; }
    if (reRankCount >= MAX_RERANKS) return;

    ensurePatched(input); // the widget Jobcan just built may not carry our patch yet
    let inst = null;
    try { inst = window.jQuery(input).autocomplete('instance'); } catch (_) { inst = null; }
    if (!inst || !inst._search || !inst._search.__jbe) return;
    reRankCount += 1;
    try { window.jQuery(input).autocomplete('search', ''); } catch (_) {}
  }

  // Pre-warm: resolve the kinds (cached for re-patching) and load the full unit
  // lists as early as possible (on page load, before the user focuses a field) so
  // substring search is ready by the time they type — ~600 items / several pages.
  purgeLegacyListCache();
  loadRecentUsage();
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
      // The dropdown container exists by the time a field is focused, so this is
      // also where the (one-shot) menu decorator gets installed.
      setupMenuDecorator();
      ensurePatched(t);
      setTimeout(() => ensurePatched(t), 60);
      setTimeout(() => ensurePatched(t), 200);
      // Focus only — on `input` the user is already typing and jQuery-UI is
      // running its own search; a second one here would fight it.
      if (e.type === 'focusin') openRankedList(t);
    }
  };
  document.addEventListener('focusin', repatchFromEvent, true);
  document.addEventListener('input', repatchFromEvent, true);

  // A fresh visit to the field gets a fresh correction budget.
  document.addEventListener('focusout', (e) => {
    if (e.target === reRankInput) { reRankInput = null; reRankCount = 0; }
  }, true);

  // No polling loop and no body-wide observer here on purpose. Jobcan creates the
  // jQuery-UI autocomplete widget LAZILY on first focus, so `autocomplete('instance')`
  // is null for every input until then — verified live: all 8 unit inputs on a
  // populated page report null. The 500ms/15s setInterval and the un-debounced
  // `MutationObserver(() => scan())` on document.body that used to live here could
  // therefore never patch anything; they only ran full-document querySelectorAll
  // sweeps on a page whose table re-renders constantly. The focusin/input capture
  // listeners above do the real work, and they cover rows added later for free.
  setupMenuDecorator();
})();
