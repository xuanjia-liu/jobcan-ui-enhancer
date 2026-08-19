// scripts/aditApi.js
//
// Client for the 打刻修正 page's own per-day summary endpoint.
//
//   GET /employee/adit/get-summary/?year=<y>&month=<m>&day=<d>
//     -> { time_table: "<table>…</table>", late_apply_link: "<a>…</a>" }
//
// Found by reading Jobcan's own /st/js/employee/adit.js, where setSummary()
// calls it to repaint #time-table after every punch edit. See
// docs/jobcan-endpoints.md.
//
// Why this exists: everything else in the extension that wants worked-time
// figures goes through dataExtraction.js, which fetches a whole Jobcan page and
// runs it through DOMParser — ~770ms for the month attendance page. That page
// only carries *month* aggregates, so per-day figures were not available at all
// without opening 打刻修正 for the day in question. This endpoint answers for one
// date and returns a single small table.
//
// The response is JSON wrapping HTML fragments, not structured data, so there is
// still a parse step — but it is one table, not a document.

(function () {
  if (window.JBE_AditApi) return;

  const ENDPOINT = '/employee/adit/get-summary/';
  const REQUEST_TIMEOUT_MS = 10000;

  // Same-day figures change on every punch; a long cache would show stale
  // numbers right after clocking out. Past days never change, but they are also
  // cheap to re-fetch, so one TTL covers both.
  const CACHE_TTL_MS = 60 * 1000;
  const cache = new Map();

  const pad2 = (n) => String(n).padStart(2, '0');

  // Accepts a Date, 'YYYY-MM-DD', or {year, month, day} (month 1-based).
  // Mirrors JBE_ManHourApi.toYmd's input handling so callers can pass either
  // module the same value.
  function toParts(value) {
    let d;
    if (value instanceof Date) {
      d = value;
    } else if (value && typeof value === 'object' && 'year' in value) {
      return {
        year: Number(value.year),
        month: Number(value.month),
        day: Number(value.day)
      };
    } else if (typeof value === 'string') {
      const m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
      d = new Date(value);
    } else if (value == null) {
      d = new Date();
    } else {
      d = new Date(value);
    }

    if (Number.isNaN(d.getTime())) throw new Error(`aditApi: unparseable date: ${value}`);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }

  const toYmd = ({ year, month, day }) => `${year}-${pad2(month)}-${pad2(day)}`;

  // Turn Jobcan's `<table><tr><th>label</th><td>value</td></tr>…</table>` fragment
  // into { label: value }. Measured shape (2026-08):
  //
  //   労働時間 / 休憩時間 / シフト外労働時間 / 残業時間 / 深夜労働時間 / 状態
  //
  // Rows that don't have both cells are skipped rather than throwing, so a
  // layout change degrades to fewer fields instead of an error.
  function parseTimeTable(html) {
    const fields = {};
    if (typeof html !== 'string' || !html.trim()) return fields;

    // Jobcan sends a complete <table> element. Wrapping that in another <table>
    // would nest them and let the parser foster-parent the rows out; only wrap
    // when the fragment is bare rows.
    const markup = /<table[\s>]/i.test(html) ? html : `<table>${html}</table>`;
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    doc.querySelectorAll('tr').forEach((row) => {
      const labelCell = row.querySelector('th');
      const valueCell = row.querySelector('td');
      if (!labelCell || !valueCell) return;

      const label = labelCell.textContent.replace(/\s+/g, ' ').trim();
      const value = valueCell.textContent.replace(/\s+/g, ' ').trim();
      // adit.js pads the loading state with blank &nbsp; rows; drop those.
      if (!label || label === ' ') return;

      fields[label] = value;
    });

    return fields;
  }

  // '9時間15分' -> 555. Jobcan pads single digits with a space (' 0時間 0分'),
  // so the digits are matched around optional whitespace rather than by slicing.
  // Falls back to 'H:MM' in case a future layout switches format, and returns
  // null for anything else — including the '-' shown for a day with no punches.
  function durationToMinutes(text) {
    if (typeof text !== 'string') return null;
    const normalized = text.replace(/[\s　]+/g, '');

    const hours = normalized.match(/(\d+)時間/);
    const minutes = normalized.match(/(\d+)分/);
    if (hours || minutes) {
      return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
    }

    const clock = normalized.match(/(\d{1,3}):([0-5]\d)/);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

    return null;
  }

  async function requestSummary(parts) {
    const query = `year=${parts.year}&month=${parts.month}&day=${parts.day}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${ENDPOINT}?${query}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error(`adit get-summary ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Returns:
  //   { date, fields, workMinutes, breakMinutes, overtimeMinutes,
  //     nightMinutes, offShiftMinutes, status, lateApplyLink, raw }
  //
  // `fields` is the parsed table keyed by Jobcan's own Japanese labels, kept
  // verbatim: the label set depends on the employer's 勤務形態, so the named
  // reads below are a convenience over `fields`, not a replacement for it. Any
  // label this account has but this list doesn't is still in `fields`.
  async function getDaySummary(date, { force = false } = {}) {
    const parts = toParts(date);
    const ymd = toYmd(parts);

    const hit = cache.get(ymd);
    if (!force && hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.value;

    const json = await requestSummary(parts);
    if (!json || typeof json !== 'object') {
      throw new Error('adit get-summary: unexpected response');
    }

    const fields = parseTimeTable(json.time_table);
    const minutesFor = (...labels) => {
      for (const label of labels) {
        const parsed = durationToMinutes(fields[label]);
        if (parsed !== null) return parsed;
      }
      return null;
    };

    const value = {
      date: ymd,
      fields,
      workMinutes: minutesFor('労働時間', '実労働時間'),
      breakMinutes: minutesFor('休憩時間'),
      overtimeMinutes: minutesFor('残業時間'),
      nightMinutes: minutesFor('深夜労働時間'),
      offShiftMinutes: minutesFor('シフト外労働時間'),
      // '-' on a day with nothing recorded.
      status: fields['状態'] || '',
      lateApplyLink: typeof json.late_apply_link === 'string' ? json.late_apply_link : '',
      raw: json
    };

    cache.set(ymd, { value, fetchedAt: Date.now() });
    return value;
  }

  window.JBE_AditApi = {
    getDaySummary,
    parseTimeTable,
    durationToMinutes,
    clearCache() { cache.clear(); }
  };
})();
