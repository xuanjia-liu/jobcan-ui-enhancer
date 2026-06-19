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
  const listPromises = {}; // kid -> Promise
  const lists = {};        // kid -> resolved [{id,label}] (sync access in source cb)
  function loadFullList(kid) {
    if (listPromises[kid]) return listPromises[kid];
    listPromises[kid] = (async () => {
      const date = editDate();
      let next = null, all = [], pages = 0;
      do {
        let url = `${API_BASE}/autocomplete-employee-units?kid=${encodeURIComponent(kid)}&date=${date}&tz_offset=${TZ}&term=&limit=100`;
        if (next) url += `&next=${encodeURIComponent(next)}`;
        const r = await fetch(url, { credentials: 'include' }).then((x) => x.json()).catch(() => ({}));
        const data = (r && r.data && typeof r.data === 'object') ? r.data : {};
        Object.keys(data).forEach((id) => all.push({ id, label: String(data[id]) }));
        next = (r && r.next) ? r.next : null;
        pages += 1;
      } while (next && pages < 25);
      lists[kid] = all;
      return all;
    })();
    return listPromises[kid];
  }

  function rowUnitInputs(input) {
    const tr = input.closest('tr');
    return tr ? Array.from(tr.querySelectorAll('input.unit')) : [];
  }

  // --- override the native autocomplete source for one input ------------------
  async function overrideInput(input) {
    if (input.__jbeSearchOverride) return;
    const $ = window.jQuery;
    if (!$ || !$.fn || !$.fn.autocomplete) return;
    let inst;
    try { inst = $(input).autocomplete('instance'); } catch (_) { inst = null; }
    if (!inst) return; // widget not attached yet — caller will retry
    input.__jbeSearchOverride = true;

    const kinds = await getKinds();
    const idx = rowUnitInputs(input).indexOf(input);
    const kid = kinds[idx] ? kinds[idx].id : null;
    if (!kid) { input.__jbeSearchOverride = false; return; }

    loadFullList(kid); // warm the cache

    const origSource = inst.options.source;
    const widened = function (request, response) {
      const self = this;
      const term = String((request && request.term) || '').toLowerCase();
      let answered = false;
      const finish = (nativeItems) => {
        if (answered) return;
        answered = true;
        const native = Array.isArray(nativeItems) ? nativeItems : [];
        const seen = new Set(native.map((i) => (i && (i.label || i.value)) || ''));
        const extras = (lists[kid] || [])
          .filter((o) => o.label.toLowerCase().includes(term) && !seen.has(o.label))
          .slice(0, 100)
          .map((o) => ({ id: o.id, label: o.label, value: o.label }));
        response(native.concat(extras));
      };
      // Keep Jobcan's own (correctly-formatted, context-aware) prefix results,
      // then append our substring matches. Fall back to substring-only if the
      // original source is slow/throws.
      try { origSource.call(self, request, finish); }
      catch (_) { finish([]); }
      setTimeout(() => finish([]), 800);
    };

    // Use the option setter so jQuery-UI rebuilds its internal source wrapper.
    try { $(input).autocomplete('option', 'source', widened); }
    catch (_) { inst.options.source = widened; }
  }

  function scan() {
    document.querySelectorAll('table.jbc-table tbody tr:not(#template) input.unit').forEach((input) => {
      overrideInput(input);
    });
  }

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
