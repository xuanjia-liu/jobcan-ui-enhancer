// scripts/manHourApi.js
//
// Client for Jobcan's new man-hour-manage REST API (introduced ~2026-06, served
// from /st/new/js/common/man-hour-manage/). The old man-hour UI scraped the DOM
// and opened a modal per day; the rewritten pages expose a clean JSON API instead,
// which this module wraps. All endpoints are same-origin GETs and rely on the
// user's existing session cookie (credentials: 'include').
//
// Endpoints (base: /employee/man-hour-manage-api):
//   get-achievements-kinds-in-period?from=<unixSec>&to=<unixSec>&params=[]
//       -> { data: [{id, name}], status }   // ordered: [0]=project kind, [1]=task kind
//   get-achievements-list?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
//       -> { data: [{id, date, tz_offset, note,
//                    manhours: [{ items:[{kind_id, unit_id}, ...], note, time }],
//                    last_updated_at}], next, status }
//       // `time` is in SECONDS (10800 === 3h === "03:00")
//   autocomplete-employee-units?kid=<kindUlid>&date=YYYY-MM-DD&tz_offset=<sec>&selected[]=<kindId>%20<unitId>&term=<q>&limit=N
//       -> { data: { "<unitUlid>": "(code)name", ... }, next, pager, status }
//   get-units?params=["<ulid>", ...]   -> resolves unit ulids to detail records

(function () {
  if (window.JBE_ManHourApi) return;

  const API_BASE = '/employee/man-hour-manage-api';
  // JST offset in seconds; mirrors what the page itself sends. Fall back to the
  // browser's actual offset so the client stays correct outside Japan.
  const TZ_OFFSET = (() => {
    const fromBrowser = -new Date().getTimezoneOffset() * 60;
    return Number.isFinite(fromBrowser) ? fromBrowser : 32400;
  })();

  const pad2 = (n) => String(n).padStart(2, '0');

  // Accepts a Date, a 'YYYY-MM-DD' string, or {year, month, day} (month 1-based).
  const toDate = (value) => {
    if (value instanceof Date) return value;
    if (value && typeof value === 'object' && 'year' in value) {
      return new Date(Number(value.year), Number(value.month) - 1, Number(value.day || 1));
    }
    if (typeof value === 'string') {
      const m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    return new Date(value);
  };

  const toYmd = (value) => {
    const d = toDate(value);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };

  const toUnixSec = (value) => Math.floor(toDate(value).getTime() / 1000);

  async function jsonFetch(path) {
    const res = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`man-hour API ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  const encodeParams = (arr) => encodeURIComponent(JSON.stringify(arr || []));

  // ---- Kinds (dimensions) ---------------------------------------------------

  // Returns the ordered kind list for a period: [{id, name}], [0]=project, [1]=task.
  async function getKinds(from, to) {
    const f = toUnixSec(from);
    const t = toUnixSec(to);
    const res = await jsonFetch(`/get-achievements-kinds-in-period?from=${f}&to=${t}&params=%5B%5D`);
    return (res && Array.isArray(res.data)) ? res.data : [];
  }

  // Resolves and caches the project/task kind ids around a reference date.
  let _kindCache = null;
  async function resolveKinds(refDate) {
    if (_kindCache) return _kindCache;
    const ref = toDate(refDate || new Date());
    const from = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const to = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
    const kinds = await getKinds(from, to);
    // Order is authoritative (project first, task second); also key by the
    // %project%/%task% name tokens as a fallback.
    const byToken = (token) => kinds.find((k) => String(k.name || '').includes(token));
    const resolved = {
      kinds,
      projectKindId: (byToken('project') || kinds[0] || {}).id || null,
      taskKindId: (byToken('task') || kinds[1] || {}).id || null
    };
    if (resolved.projectKindId && resolved.taskKindId) _kindCache = resolved;
    return resolved;
  }

  // Maps a unit input's `series` attribute (0-based column index) to a kind id.
  async function kindIdForSeries(series, refDate) {
    const { kinds } = await resolveKinds(refDate);
    const idx = Number(series);
    return kinds[idx] ? kinds[idx].id : null;
  }

  // ---- Achievements (the day/entry data) ------------------------------------

  // Returns the raw `data` array of day records for [from, to). A calendar month
  // has <= 31 days, so the default limit of 100 covers a full month with no paging.
  async function getAchievements(from, to, limit = 100) {
    const res = await jsonFetch(`/get-achievements-list?limit=${limit}&from=${toYmd(from)}&to=${toYmd(to)}`);
    return (res && Array.isArray(res.data)) ? res.data : [];
  }

  // Convenience: every man-hour entry for a calendar month (1-based month).
  async function getMonthAchievements(year, month, limit = 100) {
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 1); // exclusive end = first of next month
    return getAchievements(from, to, limit);
  }

  // ---- Unit autocomplete (project/task pickers) -----------------------------

  // `selected` entries scope the search across dimensions (e.g. pass the chosen
  // project when searching tasks). Each may be {kindId, unitId} or a "kindId unitId" string.
  // `next` is the pagination cursor returned by a previous call. Returns
  // { items: [{ id, label }], next: <cursor|null> }.
  async function fetchUnitsPage({ kid, date, term = '', selected = [], limit = 100, next = null } = {}) {
    if (!kid) return { items: [], next: null };
    let path = `/autocomplete-employee-units?kid=${encodeURIComponent(kid)}` +
      `&date=${toYmd(date || new Date())}&tz_offset=${TZ_OFFSET}` +
      `&term=${encodeURIComponent(term)}&limit=${limit}`;
    (selected || []).forEach((sel) => {
      const pair = (sel && typeof sel === 'object') ? `${sel.kindId} ${sel.unitId}` : String(sel);
      path += `&selected[]=${encodeURIComponent(pair)}`;
    });
    if (next) path += `&next=${encodeURIComponent(next)}`;
    const res = await jsonFetch(path);
    const data = (res && res.data && typeof res.data === 'object') ? res.data : {};
    return {
      items: Object.keys(data).map((id) => ({ id, label: String(data[id]) })),
      next: (res && res.next) ? res.next : null
    };
  }

  // Single-page convenience (back-compat): returns just the items array.
  async function autocompleteUnits(opts) {
    return (await fetchUnitsPage(opts)).items;
  }

  // Fetches EVERY matching unit by following the `next` cursor. Used to load the
  // full project list so the picker can do instant client-side substring search
  // (the server only matches by code/name prefix, so middle words never appear).
  async function getAllUnits({ kid, date, term = '', selected = [], maxPages = 20 } = {}) {
    if (!kid) return [];
    const all = [];
    let next = null;
    let pages = 0;
    do {
      const page = await fetchUnitsPage({ kid, date, term, selected, limit: 100, next });
      all.push(...page.items);
      next = page.next;
      pages += 1;
    } while (next && pages < maxPages);
    return all;
  }

  // ---- Unit detail resolution ----------------------------------------------

  async function getUnits(ulids) {
    const list = Array.isArray(ulids) ? ulids : [ulids];
    if (!list.length) return {};
    const res = await jsonFetch(`/get-units?params=${encodeParams(list)}`);
    return (res && res.data) ? res.data : res;
  }

  // ---- Shared helpers exposed for the feature modules -----------------------

  // "(2605AaVz0369-01)瑕疵/..." -> { code: "2605AaVz0369-01", name: "瑕疵/..." }
  function parseUnitLabel(label) {
    const text = String(label || '').trim();
    const m = text.match(/^\(([^)]*)\)\s*([\s\S]*)$/);
    return m ? { code: m[1], name: m[2].trim() } : { code: '', name: text };
  }

  const secondsToHHMM = (seconds) => {
    const safe = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(safe / 60 / 60);
    const m = Math.round((safe - h * 3600) / 60);
    return `${pad2(h)}:${pad2(m)}`;
  };

  const secondsToMinutes = (seconds) => Math.round((Number(seconds) || 0) / 60);

  window.JBE_ManHourApi = {
    TZ_OFFSET,
    toYmd,
    toUnixSec,
    getKinds,
    resolveKinds,
    kindIdForSeries,
    getAchievements,
    getMonthAchievements,
    fetchUnitsPage,
    autocompleteUnits,
    getAllUnits,
    getUnits,
    parseUnitLabel,
    secondsToHHMM,
    secondsToMinutes,
    _clearKindCache() { _kindCache = null; }
  };
})();
