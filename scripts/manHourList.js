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

  function parseListDays() {
    const list = getList();
    if (!list) return [];
    const days = [];
    let current = null;

    Array.from(list.querySelectorAll('tr')).forEach((tr) => {
      const dateCell = tr.querySelector('td.date');
      if (dateCell) {
        current = {
          dateText: dateCell.textContent.trim(),
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
    parseListDays().forEach((day) => {
      const mismatch = dayIsMismatch(day);
      day.rows.forEach((row) => row.classList.toggle('jbe-mismatch-row', mismatch));
      const dateCell = day.rows[0] ? day.rows[0].querySelector('td.date') : null;
      if (dateCell) dateCell.classList.toggle('jbe-mismatch-date', mismatch);
    });
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

  // --- report ----------------------------------------------------------------

  function aggregate(days) {
    const agg = {
      projectTotals: {},
      taskByProject: {},
      dayByProject: {},
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
      if (dayIsMismatch(day)) agg.mismatchDays += 1;
      const dayEntryMinutes = day.entries.reduce((sum, e) => sum + e.minutes, 0);
      if (dayEntryMinutes > 0) { agg.activeDays += 1; agg.dayList.push(day.dateText); } else agg.noInputDays += 1;

      day.entries.forEach((entry) => {
        const project = stripCode(entry.project) || '(プロジェクト未選択)';
        const task = stripCode(entry.task) || '(タスク未選択)';
        agg.projectTotals[project] = (agg.projectTotals[project] || 0) + entry.minutes;
        if (!agg.taskByProject[project]) agg.taskByProject[project] = {};
        agg.taskByProject[project][task] = (agg.taskByProject[project][task] || 0) + entry.minutes;
        if (!agg.dayByProject[project]) agg.dayByProject[project] = {};
        agg.dayByProject[project][day.dateText] = (agg.dayByProject[project][day.dateText] || 0) + entry.minutes;
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

    projects.forEach((project) => {
      const row = document.createElement('div');
      row.className = 'jbe-report-bar-row';

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

      row.appendChild(head);
      row.appendChild(track);

      // Expandable detail: per-day vertical bar graph for this project, plus the
      // task breakdown beneath it.
      const dayMap = agg.dayByProject[project] || {};
      const tasks = agg.taskByProject[project] || {};
      const taskNames = Object.keys(tasks).sort((a, b) => tasks[b] - tasks[a]);
      if (agg.dayList.length || taskNames.length) {
        const details = document.createElement('details');
        details.className = 'jbe-report-tasks';
        const summary = document.createElement('summary');
        summary.textContent = taskNames.length ? `日別内訳 ・ ${taskNames.length} タスク` : '日別内訳';
        details.appendChild(summary);

        if (agg.dayList.length) details.appendChild(buildDayColumns(dayMap, agg.dayList));

        taskNames.forEach((task) => {
          const t = document.createElement('div');
          t.className = 'jbe-report-task-row';
          t.innerHTML = `<span>${escapeHtml(task)}</span><span>${minutesToHHMM(tasks[task])}</span>`;
          details.appendChild(t);
        });

        row.appendChild(details);
      }

      wrap.appendChild(row);
    });

    return wrap;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text == null ? '' : text);
    return div.innerHTML;
  }

  // Extract the day-of-month from a list date label ("06/02(火)", "2026/06/02"…)
  // for the compact x-axis labels under each column; the last number is the day.
  function dayNumber(dateText) {
    const nums = String(dateText == null ? '' : dateText).match(/\d+/g);
    return nums && nums.length ? String(parseInt(nums[nums.length - 1], 10)) : String(dateText || '');
  }

  // Vertical bar graph of one project's man-hours across the month's active days.
  // Column heights are normalised to that project's own busiest day; days with no
  // hours for the project keep a faint baseline stub so the timeline reads cleanly.
  function buildDayColumns(dayMap, dayList) {
    const chart = document.createElement('div');
    chart.className = 'jbe-report-daybars';
    const max = dayList.reduce((m, d) => Math.max(m, dayMap[d] || 0), 1);

    dayList.forEach((dateText) => {
      const minutes = dayMap[dateText] || 0;
      const col = document.createElement('div');
      col.className = 'jbe-report-daybar-col';
      col.title = `${dateText}: ${minutesToHHMM(minutes)}`;

      const bar = document.createElement('div');
      bar.className = 'jbe-report-daybar-bar';
      const fill = document.createElement('div');
      fill.className = 'jbe-report-daybar-fill';
      if (minutes > 0) {
        // Cap at 82% so the value printed above the tallest bar still fits.
        fill.style.height = `${Math.max(6, (minutes / max) * 82)}%`;
        const value = document.createElement('span');
        value.className = 'jbe-report-daybar-value';
        value.textContent = minutesToHHMM(minutes);
        fill.appendChild(value);
      } else {
        fill.classList.add('is-empty');
      }
      bar.appendChild(fill);

      const label = document.createElement('div');
      label.className = 'jbe-report-daybar-label';
      label.textContent = dayNumber(dateText);

      col.appendChild(bar);
      col.appendChild(label);
      chart.appendChild(col);
    });

    return chart;
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
    barsTitle.textContent = 'プロジェクト別工数';
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
    highlightMismatches();
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

    // The list renders asynchronously (worker, several seconds, with a spinner).
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (start() || Date.now() - startedAt > 30000) clearInterval(timer);
    }, 400);
  }

  window.setupManHourListPage = setupManHourListPage;
  // Exposed so the floating "工数レポート" action (overlay.js) can open the report
  // directly when already on the list page.
  window.__jbe_openManHourReport = openReport;
})();
