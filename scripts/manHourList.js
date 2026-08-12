// scripts/manHourList.js
//
// Enhancements for the rebuilt man-hour list page
// (/employee/man-hour-manage/achievement-list). Jobcan now renders the list
// asynchronously via a Web Worker into <tbody id="list">, as a flat list of
// entries grouped by day (the date / 合計 / 総労働時間 / 最終更新 cells span the
// day's rows via rowspan). The old per-day "open the modal and scrape it" report
// is unnecessary now: every entry (project / task / per-entry hours) is already
// in the rendered table, so the report reads straight from the DOM.
//
// Features:
//   * waits for the worker-rendered rows before enhancing
//   * filter buttons: すべて / 工数不一致 / レポート
//   * highlights days whose 工数実績 (合計) differs from 総労働時間
//   * a report modal with KPIs and per-project / per-task aggregates

(function () {
  if (window.__jbe_manHourListModuleReady) return;
  window.__jbe_manHourListModuleReady = true;

  const getList = () => document.getElementById('list');

  // --- time helpers ----------------------------------------------------------

  function parseHHMMToMinutes(text) {
    const m = String(text == null ? '' : text).trim().match(/^(\d{1,4}):(\d{1,2})$/);
    return m ? (parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0) : null;
  }

  function minutesToHHMM(minutes) {
    const v = Math.max(0, Math.round(minutes || 0));
    return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
  }

  function stripCode(label) {
    const api = window.JBE_ManHourApi;
    if (api && api.parseUnitLabel) {
      const parsed = api.parseUnitLabel(label);
      return parsed.name || label || '';
    }
    return String(label || '').replace(/^\([^)]*\)\s*/, '');
  }

  // --- parse the rendered list into day groups + entries ---------------------

  // Jobcan tags each date cell with a weekday class (sun … sat); weekends are
  // never "missing input", they are simply days that were not worked.
  const WEEKEND_CLASSES = ['sat', 'sun'];

  // The date cell is decorated in place by decorateDateCell — the date becomes an
  // .jbe-day-link and a mismatch day gains a "−0:43" .jbe-day-delta badge — so the
  // cell's whole textContent is no longer just the date. Reading it whole made
  // "08/04" + a "−1:23" badge parse as day 23 in the report's day-bar labels (and
  // would break dayEditUrl on any re-parse). Read the link when it is there.
  function dateCellText(cell) {
    if (!cell) return '';
    const link = cell.querySelector('.jbe-day-link');
    return ((link || cell).textContent || '').trim();
  }

  function parseListDays() {
    const list = getList();
    if (!list) return [];
    const days = [];
    let current = null;

    Array.from(list.querySelectorAll('tr')).forEach((tr) => {
      const dateCell = tr.querySelector('td.date');
      if (dateCell) {
        current = {
          dateText: dateCellText(dateCell),
          dateCell,
          isWeekend: WEEKEND_CLASSES.some((c) => dateCell.classList.contains(c)),
          sumMinutes: parseHHMMToMinutes((tr.querySelector('td.sum') || {}).textContent),
          workMinutes: parseHHMMToMinutes((tr.querySelector('td.work') || {}).textContent),
          lastUpdate: ((tr.querySelector('td.last_update') || {}).textContent || '').trim(),
          rows: [],
          entries: []
        };
        days.push(current);
      }
      if (!current) return;
      current.rows.push(tr);

      const unitCells = Array.from(tr.children).filter((td) => td.classList.contains('unit'));
      const timeCell = tr.querySelector('td.time');
      const project = unitCells[0] ? (unitCells[0].getAttribute('title') || unitCells[0].textContent).trim() : '';
      const task = unitCells[1] ? (unitCells[1].getAttribute('title') || unitCells[1].textContent).trim() : '';
      const minutes = timeCell ? parseHHMMToMinutes(timeCell.textContent) : null;
      if (project || task || minutes != null) {
        current.entries.push({ project, task, minutes: minutes || 0 });
      }
    });

    return days;
  }

  function dayIsMismatch(day) {
    const sum = day.sumMinutes == null ? 0 : day.sumMinutes;
    const work = day.workMinutes == null ? 0 : day.workMinutes;
    return sum !== work;
  }

  // Signed shortfall in minutes: >0 means 工数 is short of 総労働時間.
  function dayDeltaMinutes(day) {
    return (day.workMinutes || 0) - (day.sumMinutes || 0);
  }

  // A day you still owe input for: it was actually worked (総労働時間 > 0) but no
  // man-hours were entered. Weekends with no work never qualify.
  function dayIsMissing(day) {
    return (day.workMinutes || 0) > 0 && (day.sumMinutes || 0) === 0;
  }

  // "07/01" + the year from the search form -> the edit page for that day.
  function dayEditUrl(day) {
    const nums = String(day.dateText || '').match(/\d+/g);
    if (!nums || nums.length < 2) return null;
    const form = document.getElementById('search');
    const year = (form && (form.querySelector('[name="year"]') || {}).value) || String(new Date().getFullYear());
    const month = parseInt(nums[nums.length - 2], 10);
    const dayNum = parseInt(nums[nums.length - 1], 10);
    if (!month || !dayNum) return null;
    return `/employee/man-hour-manage/edit-achievement?year=${year}&month=${month}&day=${dayNum}`;
  }

  // --- filtering + highlighting ----------------------------------------------

  const FILTERS = [
    { key: 'all', label: 'すべて', title: '全ての日を表示' },
    { key: 'mismatch', label: '工数不一致', title: '工数実績と総労働時間が一致しない日のみ表示' },
    { key: 'report', label: 'レポート', title: '工数レポートを表示' }
  ];
  let currentFilter = 'all';

  function applyFilter() {
    parseListDays().forEach((day) => {
      const hide = currentFilter === 'mismatch' && !dayIsMismatch(day);
      day.rows.forEach((row) => { row.style.display = hide ? 'none' : ''; });
    });
  }

  function highlightMismatches() {
    parseListDays().forEach((day, index) => {
      const mismatch = dayIsMismatch(day);
      day.rows.forEach((row) => {
        row.classList.toggle('jbe-mismatch-row', mismatch);
        // Tag every row of the day with its group id so hovering any one of them
        // can light the whole day (see bindDayHover).
        row.dataset.jbeDay = String(index);
      });
      const dateCell = day.dateCell;
      if (dateCell) dateCell.classList.toggle('jbe-mismatch-date', mismatch);
      decorateDateCell(day, mismatch);
    });
  }

  // --- day-group hover --------------------------------------------------------
  //
  // A day's date / 合計 / 総労働時間 / 最終更新 cells are rowspan'd onto the day's
  // FIRST <tr>, so the browser's own tr:hover repaints only the single row under
  // the cursor: on a multi-entry day that reads as "one entry is highlighted"
  // rather than "this is the day I'm pointing at". Mirror the hover across every
  // row carrying the same data-jbe-day.
  let hoverBoundList = null;

  function setDayHover(key, on) {
    const list = getList();
    if (!list) return;
    Array.from(list.children).forEach((row) => {
      if (row.dataset && row.dataset.jbeDay === key) row.classList.toggle('jbe-day-hover', on);
    });
  }

  function bindDayHover() {
    const list = getList();
    // The worker refills #list rather than replacing it, so this normally binds
    // once; the identity check only matters if Jobcan ever swaps the tbody.
    if (!list || hoverBoundList === list) return;
    hoverBoundList = list;

    let activeKey = null;
    const clear = () => {
      if (activeKey === null) return;
      setDayHover(activeKey, false);
      activeKey = null;
    };

    list.addEventListener('mouseover', (event) => {
      const node = event.target;
      const row = node && node.closest ? node.closest('tr[data-jbe-day]') : null;
      const key = row && row.parentNode === list ? row.dataset.jbeDay : null;
      if (key === activeKey) return;
      clear();
      if (key != null) {
        activeKey = key;
        setDayHover(key, true);
      }
    });
    list.addEventListener('mouseleave', clear);
  }

  // --- per-day delta + jump-to-editor (feature 4) -----------------------------
  //
  // Jobcan renders the date as bare text, so the only way from "this day is off by
  // 1:30" to fixing it was to read the date, open the editor yourself and re-find
  // the day. Turn the cell into a link to that day's editor and print the signed
  // delta under it. Jobcan's own per-row 調整 button applies the balance once there.
  function decorateDateCell(day, mismatch) {
    const cell = day.dateCell;
    if (!cell) return;

    // Wrap the date text in a link exactly once; keyed on our own class so it is
    // idempotent across the worker's re-renders.
    let link = cell.querySelector('.jbe-day-link');
    if (!link) {
      const url = dayEditUrl(day);
      if (!url) return;
      const text = dateCellText(cell);
      link = document.createElement('a');
      link.className = 'jbe-day-link';
      link.href = url;
      link.textContent = text;
      link.title = `${text} の工数を編集`;
      cell.textContent = '';
      cell.appendChild(link);
    }

    decorateDayShotButton(day, cell);

    let badge = cell.querySelector('.jbe-day-delta');
    if (!mismatch) {
      if (badge) badge.remove();
      return;
    }

    const delta = dayDeltaMinutes(day);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'jbe-day-delta';
      // Above the camera, which decorateDayShotButton has already appended.
      cell.insertBefore(badge, cell.querySelector('.jbe-day-shot'));
    }
    // >0 => 工数 short of actual work (不足); <0 => over-entered (超過).
    badge.classList.toggle('jbe-day-delta--under', delta > 0);
    badge.classList.toggle('jbe-day-delta--over', delta < 0);
    const label = `${delta > 0 ? '−' : '+'}${minutesToHHMM(Math.abs(delta))}`;
    if (badge.textContent !== label) badge.textContent = label;
    badge.title = delta > 0
      ? `工数が ${minutesToHHMM(delta)} 不足しています`
      : `工数が ${minutesToHHMM(-delta)} 超過しています`;
  }

  // --- per-day 工数レポート screenshot ------------------------------------------
  //
  // The list already renders every entry of every day, so the same report the
  // editor's スクリーンショット button produces can be shot straight from here —
  // no round-trip through 工数実績入力. The camera sits in the date cell and is
  // revealed by the day-group hover (CSS keys off .jbe-day-hover).
  const CAMERA_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>'
    + '<circle cx="12" cy="13" r="4"/></svg>';

  function decorateDayShotButton(day, cell) {
    let shot = cell.querySelector('.jbe-day-shot');
    // A day with nothing entered has no report to shoot.
    if (!day.entries.length) {
      if (shot) shot.remove();
      return;
    }
    if (!shot) {
      shot = document.createElement('button');
      shot.type = 'button';
      shot.className = 'jbe-day-shot';
      shot.innerHTML = CAMERA_SVG;
      // The handler re-reads the day at click time: `day` here belongs to one
      // parse pass and goes stale as soon as the worker re-renders the list.
      shot.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        captureDayReport(shot.dataset.jbeDate || '');
      });
      cell.appendChild(shot);
    }
    shot.dataset.jbeDate = day.dateText;
    shot.title = `${day.dateText} の工数レポートを作成`;
    shot.setAttribute('aria-label', shot.title);
  }

  function captureDayReport(dateText) {
    const day = parseListDays().find((d) => d.dateText === dateText);
    const entries = day ? day.entries : [];
    if (!entries.length) {
      showNotification('工数が入力されていません。', 2500);
      return;
    }
    const total = entries.reduce((sum, e) => sum + e.minutes, 0);
    if (typeof captureManHourReport !== 'function') {
      showNotification('スクリーンショット機能を読み込めませんでした。');
      return;
    }
    captureManHourReport({
      rows: entries.map((e) => ({
        project: stripCode(e.project),
        task: stripCode(e.task),
        work: minutesToHHMM(e.minutes)
      })),
      totalText: `合計: ${Math.floor(total / 60)}時間${total % 60}分`,
      subtitle: dateText
    });
  }

  // --- month completion header (feature 3) ------------------------------------
  //
  // The list is 31 rows; "which days do I still owe?" was a manual scan. Summarise
  // it once at the top, with a chip per outstanding day that scrolls to its row.
  function buildMonthHeader() {
    const days = parseListDays();
    if (!days.length) return;

    const bar = document.getElementById('jbe-manhour-list-filters');
    if (!bar) return;

    let host = document.getElementById('jbe-mh-monthstat');
    if (!host) {
      host = document.createElement('div');
      host.id = 'jbe-mh-monthstat';
      bar.parentNode.insertBefore(host, bar);
    }

    const worked = days.filter((d) => (d.workMinutes || 0) > 0);
    const missing = days.filter(dayIsMissing);
    const mismatched = days.filter((d) => dayIsMismatch(d) && !dayIsMissing(d));
    const filled = worked.length - missing.length;

    host.textContent = '';

    const summary = document.createElement('div');
    summary.className = 'jbe-mh-monthstat-summary';

    const count = document.createElement('span');
    count.className = 'jbe-mh-monthstat-count';
    count.textContent = `工数入力 ${filled}/${worked.length} 日`;
    summary.appendChild(count);

    const state = document.createElement('span');
    state.className = 'jbe-mh-monthstat-state';
    if (!worked.length) {
      state.textContent = '対象の稼働日がありません';
    } else if (!missing.length && !mismatched.length) {
      state.classList.add('is-done');
      state.textContent = 'すべて入力済み';
    } else {
      const parts = [];
      if (missing.length) parts.push(`${missing.length} 日未入力`);
      if (mismatched.length) parts.push(`${mismatched.length} 日不一致`);
      state.classList.add('is-todo');
      state.textContent = parts.join(' ・ ');
    }
    summary.appendChild(state);

    const track = document.createElement('div');
    track.className = 'jbe-mh-monthstat-track';
    const fill = document.createElement('div');
    fill.className = 'jbe-mh-monthstat-fill';
    fill.style.width = `${worked.length ? Math.round((filled / worked.length) * 100) : 0}%`;
    track.appendChild(fill);

    host.appendChild(summary);
    host.appendChild(track);

    const chipRow = document.createElement('div');
    chipRow.className = 'jbe-mh-monthstat-chips';
    const addChips = (list, cls, titleFor) => {
      list.forEach((day) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `jbe-mh-daychip ${cls}`;
        chip.textContent = day.dateText;
        chip.title = titleFor(day);
        chip.addEventListener('click', () => jumpToDay(day.dateText));
        chipRow.appendChild(chip);
      });
    };
    addChips(missing, 'jbe-mh-daychip--missing', (d) => `${d.dateText}: 工数未入力（総労働時間 ${minutesToHHMM(d.workMinutes || 0)}）`);
    addChips(mismatched, 'jbe-mh-daychip--mismatch', (d) => {
      const delta = dayDeltaMinutes(d);
      return `${d.dateText}: ${minutesToHHMM(Math.abs(delta))} ${delta > 0 ? '不足' : '超過'}`;
    });
    if (chipRow.children.length) host.appendChild(chipRow);
  }

  // Scroll a day's row into view and flash it, so a chip click lands somewhere
  // obvious in a 31-row table.
  function jumpToDay(dateText) {
    const day = parseListDays().find((d) => d.dateText === dateText);
    const row = day && day.rows[0];
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    day.rows.forEach((r) => {
      r.classList.remove('jbe-day-flash');
      // Force a reflow so re-adding the class restarts the animation.
      void r.offsetWidth;
      r.classList.add('jbe-day-flash');
    });
    setTimeout(() => day.rows.forEach((r) => r.classList.remove('jbe-day-flash')), 1800);
  }

  function buildFilterBar() {
    if (document.getElementById('jbe-manhour-list-filters')) return;
    const table = document.querySelector('table.jbc-table');
    if (!table) return;

    const bar = document.createElement('div');
    bar.id = 'jbe-manhour-list-filters';

    FILTERS.forEach((filter) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `jbe-list-filter-btn${filter.key === 'all' ? ' active' : ''}`;
      btn.textContent = filter.label;
      btn.title = filter.title;
      btn.dataset.filter = filter.key;
      btn.addEventListener('click', () => {
        if (filter.key === 'report') { openReport(); return; }
        currentFilter = filter.key;
        bar.querySelectorAll('.jbe-list-filter-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.filter === filter.key);
        });
        applyFilter();
      });
      bar.appendChild(btn);
    });

    // Place the bar directly above the table. The table sits in a CSS-grid
    // container (#dsbd), so insert it *inside* the table's wrapper (a grid cell)
    // rather than as a sibling — otherwise it lands in its own narrow grid cell.
    const wrapper = table.closest('.table-responsive');
    if (wrapper) {
      wrapper.insertBefore(bar, table);
    } else if (table.parentNode) {
      table.parentNode.insertBefore(bar, table);
    }
  }

  // --- dashboard action buttons ------------------------------------------------
  //
  // Jobcan scatters the three dashboard actions down the #dsbd grid: PDFダウンロード
  // gets a full-width row above the charts, CSVダウンロード + its ⚙ options toggle get
  // another one below them — ~600px and two graphs apart. Collect all three into
  // #dsbd-buttons (already `display:flex; justify-content:space-between`, so they
  // land right of the 集計軸 selects) and drop the two emptied grid rows.
  //
  // Two constraints, both read out of Jobcan's own bundle rather than guessed:
  //   * `const $dsbd = $("#dsbd, #dsbd-buttons")` then `$dsbd.on('click', '#pdf'…)`
  //     / `'#csv'` — the downloads are DELEGATED, and #dsbd-buttons is already one
  //     of the two roots, so moving the buttons there keeps them wired. exportPDF
  //     reads `$dsbd.find('.pie'|'.bar')`, which still resolves for the same reason.
  //   * the ⚙ handler is `$(t.currentTarget).next()` — #csv-options must stay the
  //     gear's IMMEDIATE next sibling or the toggle silently stops working
  //     (verified live: reorder it and nothing happens).
  // Hence the order below is load-bearing; #csv-options must come last.
  const DSBD_ACTION_IDS = ['pdf', 'csv', 'show-csv-options', 'csv-options'];

  function groupDashboardButtons() {
    const bar = document.getElementById('dsbd-buttons');
    if (!bar) return;

    // Whichever of the four Jobcan actually rendered — enhance() re-runs on every
    // worker re-render, so bail before touching the DOM once they are all home.
    const present = DSBD_ACTION_IDS.map((id) => document.getElementById(id)).filter(Boolean);
    if (!present.length) return;

    let actions = document.getElementById('jbe-dsbd-actions');
    if (actions && actions.parentNode === bar && present.every((el) => el.parentNode === actions)) return;
    if (!actions) {
      actions = document.createElement('div');
      actions.id = 'jbe-dsbd-actions';
    }
    if (actions.parentNode !== bar) bar.appendChild(actions);

    present.forEach((el) => {
      const wrapper = el.parentNode;
      actions.appendChild(el);
      // An emptied wrapper is still a #dsbd grid item and still eats a row.
      if (wrapper && wrapper.parentNode && wrapper.parentNode.id === 'dsbd'
        && !wrapper.querySelector('button, input, select, a')) {
        wrapper.classList.add('jbe-dsbd-emptied');
      }
    });
  }

  // --- search bar ---------------------------------------------------------------
  //
  // The 表示月度 row is mostly air: a caption that repeats the 年 / 月度 already printed
  // between the selects, two 27px icon buttons next to 38px selects, and a wide empty
  // gap on the right. Tighten it and park the download actions in that gap.
  //
  // The actions ride along inside #dsbd-buttons rather than being moved on their own:
  // Jobcan delegates their clicks from `$("#dsbd, #dsbd-buttons")`, so #dsbd-buttons
  // has to stay their ancestor or the downloads go dead (see groupDashboardButtons).
  function restyleSearchBar() {
    const wrapper = document.querySelector('.search_wrapper');
    if (!wrapper) return;
    // Marker class: this module only runs on the list page, so it keeps the CSS off
    // any other page that happens to render a .search_wrapper.
    wrapper.classList.add('jbe-mh-searchbar');

    const bar = document.getElementById('dsbd-buttons');
    if (bar && bar.parentNode !== wrapper) wrapper.appendChild(bar);
  }

  // --- 集計軸 controls ------------------------------------------------------------
  //
  // Jobcan puts the two 集計軸 selects in a row of their own above the dashboard, far
  // from the charts they drive. Move them to the top of #dsbd, centred over the pie
  // and the bar, and turn 集計軸1 into a tab strip — it picks between two or three
  // named dimensions, which is a segmented control, not a dropdown.
  //
  // #axis1 itself stays in the DOM, hidden: Jobcan reads `$("#axis1").val()` and its
  // dsbd_render step does `$("#axis1").add($("#axis2")).empty()` then re-appends the
  // <option>s on EVERY summary render, so the tabs are rebuilt from the select rather
  // than the other way round. Both selects must also stay inside #dsbd or
  // #dsbd-buttons — that pair is the delegation root for their change handler.
  function axisOptions(select) {
    // Jobcan d-none's the option 集計軸1 has taken, so 集計軸2 cannot duplicate it.
    return Array.from(select.options).filter((option) => !option.classList.contains('d-none'));
  }

  function renderAxisTabs(select, tabs) {
    const options = axisOptions(select);
    // Jobcan's render step empties both selects before re-appending the <option>s;
    // don't wipe the strip if we happen to look during that window.
    if (!options.length) return;
    const signature = options.map((option) => `${option.value}${option.text}`).join('');
    if (tabs.dataset.jbeSig !== signature) {
      tabs.dataset.jbeSig = signature;
      tabs.textContent = '';
      options.forEach((option) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'jbe-axis-tab';
        tab.setAttribute('role', 'tab');
        tab.dataset.value = option.value;
        tab.textContent = option.text;
        tab.addEventListener('click', () => {
          if (select.value === option.value) return;
          select.value = option.value;
          // Jobcan's handler is a jQuery delegated one, i.e. a native listener on
          // #dsbd — a bubbling native change event reaches it.
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        tabs.appendChild(tab);
      });
    }
    Array.from(tabs.children).forEach((tab) => {
      const active = tab.dataset.value === select.value;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  // The 集計軸1 / 集計軸2 captions are bare text nodes inside the <label>s, so CSS
  // cannot hide them on their own. Take them out, and carry the wording over to the
  // controls as aria-label + title so removing the visible text does not also remove
  // the only thing naming them.
  function stripAxisCaption(label, targets) {
    if (!label || label.dataset.jbeCaption) return;
    const nodes = Array.from(label.childNodes).filter((node) => node.nodeType === 3);
    const caption = nodes.map((node) => node.textContent.trim()).filter(Boolean).join(' ');
    if (!caption) return;
    nodes.forEach((node) => node.remove());
    label.dataset.jbeCaption = caption;
    targets.filter(Boolean).forEach((target) => {
      target.setAttribute('aria-label', caption);
      target.title = caption;
    });
  }

  function setupAxisControls() {
    const axis1 = document.getElementById('axis1');
    const axis2 = document.getElementById('axis2');
    const dsbd = document.getElementById('dsbd');
    if (!dsbd || (!axis1 && !axis2)) return;

    const group = (axis1 || axis2).closest('.unload-no-track') || (axis1 || axis2).parentNode;

    let host = document.getElementById('jbe-axis-bar');
    if (!host) {
      host = document.createElement('div');
      host.id = 'jbe-axis-bar';
    }
    if (host.parentNode !== dsbd || dsbd.firstElementChild !== host) {
      dsbd.insertBefore(host, dsbd.firstChild);
    }
    if (group && group.parentNode !== host) host.appendChild(group);

    if (axis1) {
      const label = axis1.closest('label') || axis1.parentNode;
      let tabs = document.getElementById('jbe-axis1-tabs');
      if (!tabs) {
        tabs = document.createElement('div');
        tabs.id = 'jbe-axis1-tabs';
        tabs.setAttribute('role', 'tablist');
      }
      if (tabs.parentNode !== label) label.appendChild(tabs);
      stripAxisCaption(label, [tabs, axis1]);
      renderAxisTabs(axis1, tabs);
    }

    if (axis2) {
      stripAxisCaption(axis2.closest('label'), [axis2]);
      // With only two dimensions defined, 集計軸2 always has exactly one option left —
      // a dropdown that cannot be dropped. Strip the affordance instead.
      axis2.classList.toggle('jbe-axis-static', axisOptions(axis2).length <= 1);
    }

    if (!host.dataset.jbeAxisBound) {
      host.dataset.jbeAxisBound = '1';
      // Jobcan rebuilds both option lists while handling the change; re-read them
      // once its handler has run. enhance() re-syncs again when the list re-renders.
      host.addEventListener('change', () => { setTimeout(setupAxisControls, 0); });
    }

    watchAxisOptions(axis1, axis2);
  }

  // enhance() alone is not enough to keep the tab strip filled. Jobcan's showSummary
  // writes the table rows first (`await setAchievement()` → tableRender) and only then
  // fills the <option>s (`dsbd_render`), so the #list observer that drives enhance()
  // has already fired by the time the options exist — measured: the strip was created,
  // read zero options, and never ran again, leaving an empty 8px pill. Watch the
  // selects themselves so the tabs follow whenever Jobcan repopulates them.
  let axisWatchBound = false;

  function watchAxisOptions(axis1, axis2) {
    if (axisWatchBound) return;
    const targets = [axis1, axis2].filter(Boolean);
    if (!targets.length) return;
    axisWatchBound = true;

    // setupAxisControls never touches the selects' children, so this cannot re-trigger
    // itself. Both selects are emptied and refilled in one synchronous pass, and the
    // observer callback runs after it, so it always sees the finished list.
    const observer = new MutationObserver(() => setupAxisControls());
    targets.forEach((target) => observer.observe(target, { childList: true }));
    if (typeof window.__jbe_registerManagedObserver === 'function') {
      window.__jbe_registerManagedObserver('watch:manHourAxis', observer, () => {
        axisWatchBound = false;
      });
    }
  }

  // --- report ----------------------------------------------------------------

  function aggregate(days) {
    const agg = {
      projectTotals: {},
      // Task names are the same dimension across projects (デザイン, その他 …), so
      // one colour per task holds for the whole report and the legend can live
      // once next to the section title.
      taskTotals: {},
      taskByProject: {},
      dayByProject: {},
      // project -> date -> task -> minutes, for the stacked day columns.
      dayTaskByProject: {},
      dayList: [],
      grandMinutes: 0,
      entryCount: 0,
      totalWork: 0,
      mismatchDays: 0,
      activeDays: 0,
      noInputDays: 0,
      unselectedProject: 0,
      unselectedTask: 0,
      dayCount: days.length
    };

    days.forEach((day) => {
      if (day.workMinutes) agg.totalWork += day.workMinutes;
      const mismatch = dayIsMismatch(day);
      const missing = dayIsMissing(day);
      if (mismatch) agg.mismatchDays += 1;
      const dayEntryMinutes = day.entries.reduce((sum, e) => sum + e.minutes, 0);
      if (dayEntryMinutes > 0) agg.activeDays += 1; else agg.noInputDays += 1;
      // The x-axis carries the days that were worked: those with entries, plus the
      // 未入力 ones — a day you owe input for is exactly what the graph should not
      // silently drop. Weekends with no work stay off the axis.
      if (dayEntryMinutes > 0 || missing) {
        agg.dayList.push({
          key: day.dateText,
          dayNumber: dayNumber(day.dateText),
          weekday: weekdayLabel(day),
          isWeekend: !!day.isWeekend,
          mismatch,
          missing,
          delta: dayDeltaMinutes(day)
        });
      }

      day.entries.forEach((entry) => {
        const project = stripCode(entry.project) || '(プロジェクト未選択)';
        const task = stripCode(entry.task) || '(タスク未選択)';
        agg.projectTotals[project] = (agg.projectTotals[project] || 0) + entry.minutes;
        if (!agg.taskByProject[project]) agg.taskByProject[project] = {};
        agg.taskByProject[project][task] = (agg.taskByProject[project][task] || 0) + entry.minutes;
        agg.taskTotals[task] = (agg.taskTotals[task] || 0) + entry.minutes;
        if (!agg.dayByProject[project]) agg.dayByProject[project] = {};
        agg.dayByProject[project][day.dateText] = (agg.dayByProject[project][day.dateText] || 0) + entry.minutes;
        if (!agg.dayTaskByProject[project]) agg.dayTaskByProject[project] = {};
        const perDay = agg.dayTaskByProject[project];
        if (!perDay[day.dateText]) perDay[day.dateText] = {};
        perDay[day.dateText][task] = (perDay[day.dateText][task] || 0) + entry.minutes;
        agg.grandMinutes += entry.minutes;
        agg.entryCount += 1;
        if (!entry.project || /未選択/.test(entry.project)) agg.unselectedProject += 1;
        if (!entry.task || /未選択/.test(entry.task)) agg.unselectedTask += 1;
      });
    });

    return agg;
  }

  function getMonthLabel() {
    const form = document.getElementById('search');
    const year = form ? (form.querySelector('[name="year"]') || {}).value : '';
    const month = form ? (form.querySelector('[name="month"]') || {}).value : '';
    if (year && month) return `${year}/${String(month).padStart(2, '0')}`;
    return '';
  }

  function makeKpi(label, value, detail) {
    const card = document.createElement('div');
    card.className = 'jbe-report-kpi';
    const v = document.createElement('div');
    v.className = 'jbe-report-kpi-value';
    v.textContent = value;
    const l = document.createElement('div');
    l.className = 'jbe-report-kpi-label';
    l.textContent = label;
    card.appendChild(v);
    card.appendChild(l);
    if (detail) {
      const d = document.createElement('div');
      d.className = 'jbe-report-kpi-detail';
      d.textContent = detail;
      card.appendChild(d);
    }
    return card;
  }

  function buildProjectBars(agg) {
    const wrap = document.createElement('div');
    wrap.className = 'jbe-report-bars';
    const projects = Object.keys(agg.projectTotals).sort((a, b) => agg.projectTotals[b] - agg.projectTotals[a]);
    const max = projects.reduce((m, p) => Math.max(m, agg.projectTotals[p]), 1);

    if (!projects.length) {
      const empty = document.createElement('div');
      empty.className = 'jbe-report-empty';
      empty.textContent = '集計できる工数がありません';
      wrap.appendChild(empty);
      return wrap;
    }

    const taskColors = taskColorMap(agg);

    projects.forEach((project) => {
      const dayTaskMap = agg.dayTaskByProject[project] || {};
      const tasks = agg.taskByProject[project] || {};
      const taskNames = Object.keys(tasks).sort((a, b) => tasks[b] - tasks[a]);
      const expandable = !!(agg.dayList.length || taskNames.length);

      // The whole project row is the <summary>: name, total and track all toggle
      // the breakdown, with a caret at the left as the affordance. A row with
      // nothing to show stays a plain <div> so it gets no caret and no pointer.
      const row = document.createElement(expandable ? 'details' : 'div');
      row.className = expandable ? 'jbe-report-bar-row jbe-report-tasks' : 'jbe-report-bar-row';

      const head = document.createElement('div');
      head.className = 'jbe-report-bar-head';
      const name = document.createElement('span');
      name.className = 'jbe-report-bar-name';
      name.textContent = project;
      name.title = project;
      const time = document.createElement('span');
      time.className = 'jbe-report-bar-time';
      const pct = agg.grandMinutes ? Math.round((agg.projectTotals[project] / agg.grandMinutes) * 100) : 0;
      time.textContent = `${minutesToHHMM(agg.projectTotals[project])} (${pct}%)`;
      head.appendChild(name);
      head.appendChild(time);

      const track = document.createElement('div');
      track.className = 'jbe-report-bar-track';
      const fill = document.createElement('div');
      fill.className = 'jbe-report-bar-fill';
      fill.style.width = `${Math.max(2, (agg.projectTotals[project] / max) * 100)}%`;
      track.appendChild(fill);

      const main = document.createElement('div');
      main.className = 'jbe-report-bar-main';
      main.appendChild(head);
      main.appendChild(track);

      if (!expandable) {
        row.appendChild(main);
        wrap.appendChild(row);
        return;
      }

      const summary = document.createElement('summary');
      summary.className = 'jbe-report-bar-summary';
      const caret = document.createElement('span');
      caret.className = 'jbe-report-bar-caret';
      caret.setAttribute('aria-hidden', 'true');
      summary.appendChild(caret);
      summary.appendChild(main);
      row.appendChild(summary);

      // Detail: the per-day graph. Each column is stacked by task, so the task
      // split is read off the bars themselves instead of a list under them.
      const detail = document.createElement('div');
      detail.className = 'jbe-report-bar-detail';
      if (agg.dayList.length) detail.appendChild(buildDayColumns(dayTaskMap, agg.dayList, taskColors));

      row.appendChild(detail);
      wrap.appendChild(row);
    });

    return wrap;
  }

  // Extract the day-of-month from a list date label ("06/02(火)", "2026/06/02"…)
  // for the compact x-axis labels under each column; the last number is the day.
  function dayNumber(dateText) {
    const nums = String(dateText == null ? '' : dateText).match(/\d+/g);
    return nums && nums.length ? String(parseInt(nums[nums.length - 1], 10)) : String(dateText || '');
  }

  // 曜日 for the x-axis. Jobcan tags the date cell with a weekday class, which is
  // the same signal WEEKEND_CLASSES reads; fall back to a "(火)" in the label for
  // layouts that print it and leave the class off.
  const WEEKDAY_BY_CLASS = { sun: '日', mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土' };

  function weekdayLabel(day) {
    const cell = day && day.dateCell;
    if (cell) {
      const hit = Object.keys(WEEKDAY_BY_CLASS).find((c) => cell.classList.contains(c));
      if (hit) return WEEKDAY_BY_CLASS[hit];
    }
    const m = /[（(]\s*([日月火水木金土])\s*[）)]/.exec(String((day && day.dateText) || ''));
    return m ? m[1] : '';
  }

  // One colour per task name for the whole report. Task names are a shared
  // dimension (デザイン, その他 …), so the same task keeps its colour in every
  // project's chart and a single legend covers them all. The palette cycles.
  const TASK_COLOR_COUNT = 8;

  function taskColorMap(agg) {
    const map = {};
    Object.keys(agg.taskTotals)
      .sort((a, b) => agg.taskTotals[b] - agg.taskTotals[a])
      .forEach((task, i) => { map[task] = `jbe-task-c${(i % TASK_COLOR_COUNT) + 1}`; });
    return map;
  }

  // Vertical bar graph of one project's man-hours across the month's active days,
  // each column stacked by task. Column heights are normalised to that project's
  // own busiest day; days with no hours for the project keep a faint baseline stub
  // so the timeline reads cleanly.
  function buildDayColumns(dayTaskMap, dayList, taskColors) {
    const chart = document.createElement('div');
    chart.className = 'jbe-report-daybars';
    const dayTotal = (key) => Object.values(dayTaskMap[key] || {}).reduce((s, v) => s + v, 0);
    const max = dayList.reduce((m, d) => Math.max(m, dayTotal(d.key)), 1);

    dayList.forEach((day) => {
      const byTask = dayTaskMap[day.key] || {};
      const taskNames = Object.keys(byTask).sort((a, b) => byTask[b] - byTask[a]);
      const minutes = dayTotal(day.key);
      const col = document.createElement('div');
      col.className = 'jbe-report-daybar-col';
      // 不一致 / 未入力 are properties of the DAY, not of this project, so a day can
      // be flagged while this project's own bar is perfectly normal.
      if (day.missing) col.classList.add('is-missing');
      else if (day.mismatch) col.classList.add('is-mismatch');
      const flagNote = day.missing
        ? ' ・ 未入力'
        : (day.mismatch ? ` ・ 工数不一致 (${day.delta > 0 ? '−' : '+'}${minutesToHHMM(Math.abs(day.delta))})` : '');
      const taskNote = taskNames.map((t) => `\n  ${t}: ${minutesToHHMM(byTask[t])}`).join('');
      col.title = `${day.key}: ${minutesToHHMM(minutes)}${flagNote}${taskNote}`;

      const bar = document.createElement('div');
      bar.className = 'jbe-report-daybar-bar';
      const fill = document.createElement('div');
      fill.className = 'jbe-report-daybar-fill';
      // The value label is positioned above the fill and must not be the fill's
      // last child — that slot is what rounds the top segment.
      const value = document.createElement('span');
      value.className = 'jbe-report-daybar-value';
      if (minutes === 0) value.classList.add('is-zero');
      value.textContent = minutesToHHMM(minutes);
      fill.appendChild(value);
      if (minutes > 0) {
        // Cap at 82% so the value printed above the tallest bar still fits.
        fill.style.height = `${Math.max(6, (minutes / max) * 82)}%`;
        // Stacked segments, largest task at the bottom (the fill stacks upward).
        taskNames.forEach((task) => {
          const seg = document.createElement('div');
          seg.className = `jbe-report-daybar-seg ${taskColors[task] || 'jbe-task-c1'}`;
          seg.style.height = `${(byTask[task] / minutes) * 100}%`;
          seg.title = `${task}: ${minutesToHHMM(byTask[task])}`;
          fill.appendChild(seg);
        });
      } else {
        fill.classList.add('is-empty');
      }
      bar.appendChild(fill);

      const label = document.createElement('div');
      label.className = 'jbe-report-daybar-label';
      const num = document.createElement('span');
      num.className = 'jbe-report-daybar-day';
      num.textContent = day.dayNumber;
      label.appendChild(num);
      if (day.weekday) {
        const dow = document.createElement('span');
        dow.className = 'jbe-report-daybar-dow';
        if (day.isWeekend) dow.classList.add('is-weekend');
        dow.textContent = day.weekday;
        label.appendChild(dow);
      }
      col.appendChild(bar);
      col.appendChild(label);
      chart.appendChild(col);
    });

    return chart;
  }

  // One legend for the whole report, next to the section title: the task colours
  // used by the stacked columns, then the day flags. Both mean the same thing in
  // every project's chart. Null when there is nothing to explain.
  function buildReportLegend(agg, taskColors) {
    const taskNames = Object.keys(agg.taskTotals).sort((a, b) => agg.taskTotals[b] - agg.taskTotals[a]);
    const hasMissing = agg.dayList.some((d) => d.missing);
    const hasMismatch = agg.dayList.some((d) => d.mismatch && !d.missing);
    if (!taskNames.length && !hasMissing && !hasMismatch) return null;

    const legend = document.createElement('span');
    legend.className = 'jbe-report-daybar-legend';
    taskNames.forEach((task) => {
      legend.appendChild(makeLegendItem(taskColors[task] || 'jbe-task-c1', task, minutesToHHMM(agg.taskTotals[task])));
    });
    if (hasMismatch) legend.appendChild(makeLegendItem('is-mismatch', '工数不一致'));
    if (hasMissing) legend.appendChild(makeLegendItem('is-missing', '未入力'));
    return legend;
  }

  function makeLegendItem(variant, text, detail) {
    const item = document.createElement('span');
    item.className = 'jbe-report-daybar-legend-item';
    const swatch = document.createElement('span');
    // The variant class is the colour, and it is the same class the stacked
    // segments carry — so a legend swatch cannot drift from its bars.
    swatch.className = `jbe-report-daybar-swatch ${variant}`;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(text));
    if (detail) {
      const d = document.createElement('span');
      d.className = 'jbe-report-legend-detail';
      d.textContent = detail;
      item.appendChild(d);
    }
    item.title = detail ? `${text}: ${detail}` : text;
    return item;
  }

  function openReport() {
    closeReport();
    const days = parseListDays();
    const agg = aggregate(days);
    const monthLabel = getMonthLabel();

    const overlay = document.createElement('div');
    overlay.id = 'jbe-manhour-report';
    overlay.className = 'jbe-report-overlay';
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeReport(); });

    const modal = document.createElement('div');
    modal.className = 'jbe-report-modal';

    const header = document.createElement('div');
    header.className = 'jbe-report-header';
    const title = document.createElement('h3');
    title.textContent = monthLabel ? `工数レポート ${monthLabel}` : '工数レポート';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'jbe-report-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', closeReport);
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'jbe-report-body';

    const kpis = document.createElement('div');
    kpis.className = 'jbe-report-kpis';
    kpis.appendChild(makeKpi('工数実績', minutesToHHMM(agg.grandMinutes), `${agg.entryCount} 件`));
    kpis.appendChild(makeKpi('総労働時間', minutesToHHMM(agg.totalWork), `${agg.activeDays} 稼働日`));
    const diff = agg.totalWork - agg.grandMinutes;
    kpis.appendChild(makeKpi('差分', `${diff < 0 ? '+' : ''}${minutesToHHMM(Math.abs(diff))}`, diff > 0 ? '工数不足' : (diff < 0 ? '工数超過' : '一致')));
    kpis.appendChild(makeKpi('工数不一致', `${agg.mismatchDays} 日`, `対象 ${agg.dayCount} 日`));
    if (agg.unselectedProject || agg.unselectedTask) {
      kpis.appendChild(makeKpi('未選択', `${agg.unselectedProject + agg.unselectedTask} 件`, `P:${agg.unselectedProject} / T:${agg.unselectedTask}`));
    }
    body.appendChild(kpis);

    const barsTitle = document.createElement('h4');
    barsTitle.className = 'jbe-report-section-title';
    const barsTitleText = document.createElement('span');
    barsTitleText.textContent = 'プロジェクト別工数';
    barsTitle.appendChild(barsTitleText);
    // The day-flag colours mean the same thing in every project's 日別内訳, so the
    // legend belongs once next to the section title rather than under each chart.
    const legend = buildReportLegend(agg, taskColorMap(agg));
    if (legend) barsTitle.appendChild(legend);
    body.appendChild(barsTitle);
    body.appendChild(buildProjectBars(agg));

    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onReportKeydown);
  }

  function onReportKeydown(e) {
    if (e.key === 'Escape') closeReport();
  }

  function closeReport() {
    const existing = document.getElementById('jbe-manhour-report');
    if (existing) existing.remove();
    document.removeEventListener('keydown', onReportKeydown);
  }

  // --- orchestration: wait for the worker, then enhance ----------------------

  function enhance() {
    buildFilterBar();
    restyleSearchBar();
    groupDashboardButtons();
    setupAxisControls();
    highlightMismatches();
    bindDayHover();
    buildMonthHeader();
    applyFilter();
  }

  function listHasRows() {
    const list = getList();
    return !!(list && list.querySelector('tr'));
  }

  // Open the report when arriving via the floating "工数レポート" action
  // (overlay.js navigates here with ?jbe_open_report=1).
  let reportAutoOpenChecked = false;
  function maybeAutoOpenReport() {
    if (reportAutoOpenChecked) return;
    reportAutoOpenChecked = true;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('jbe_open_report') !== '1') return;
      openReport();
      params.delete('jbe_open_report');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    } catch (_) { /* no-op */ }
  }

  function setupManHourListPage() {
    if (window.__jbe_manHourListPageInited) return;
    window.__jbe_manHourListPageInited = true;

    // The search bar, the download buttons and the 集計軸 selects are all
    // server-rendered and do not wait on the worker, so lay them out now rather than
    // leaving them as-is for the ~40s the list can take. The poll below re-runs this
    // in case Jobcan injects any of it late.
    restyleSearchBar();
    groupDashboardButtons();
    setupAxisControls();

    const start = () => {
      if (!listHasRows()) return false;
      enhance();
      maybeAutoOpenReport();
      // Keep highlights/filters in sync if the worker re-renders the list.
      const list = getList();
      if (list) {
        const observer = new MutationObserver(() => {
          // Avoid reacting to our own style/class toggles.
          enhance();
        });
        observer.observe(list, { childList: true });
        if (typeof window.__jbe_registerManagedObserver === 'function') {
          window.__jbe_registerManagedObserver('manHourList:list', observer);
        }
      }
      return true;
    };

    if (start()) return;

    // The list renders asynchronously (Web Worker, spinner, several seconds).
    //
    // This used to be a bare 400ms poll capped at 30s. Measured on a real account
    // the worker can take ~40s, and when it overruns the cap the page silently
    // ends up with NO extension enhancements at all (verified live: no filter bar,
    // no highlighting). So watch #list directly — the observer fires whenever the
    // worker finally writes rows, however long that takes — and keep a slow poll
    // purely as a backstop in case the rows arrive without a childList mutation.
    const list = getList();
    if (list) {
      const readyObserver = new MutationObserver(() => {
        if (start()) {
          readyObserver.disconnect();
          if (typeof window.__jbe_clearManagedInterval === 'function') {
            window.__jbe_clearManagedInterval('watch:manHourListReady');
          }
        }
      });
      readyObserver.observe(list, { childList: true, subtree: true });
      if (typeof window.__jbe_registerManagedObserver === 'function') {
        window.__jbe_registerManagedObserver('watch:manHourListReady', readyObserver, () => {
          window.__jbe_manHourListPageInited = false;
          hoverBoundList = null;
        });
      }
    }

    if (typeof window.__jbe_startManagedInterval === 'function') {
      window.__jbe_startManagedInterval('watch:manHourListReady', (ctx) => {
        restyleSearchBar();
        groupDashboardButtons();
        setupAxisControls();
        if (start()) ctx.stop();
      }, 1000, { maxRuns: 120 });
    }
  }

  window.setupManHourListPage = setupManHourListPage;
  // Exposed so the floating "工数レポート" action (overlay.js) can open the report
  // directly when already on the list page.
  window.__jbe_openManHourReport = openReport;
})();
