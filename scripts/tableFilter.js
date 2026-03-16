// Function to create table filter buttons and report tools on man-hour-manage page
function setupTableFilterButtons() {
  if (window.__jbe_tableFilterButtonsSetup) return;
  window.__jbe_tableFilterButtonsSetup = true;

  if (!window.location.href.includes('https://ssl.jobcan.jp/employee/man-hour-manage')) return;

  const existing = document.getElementById('table-filter-buttons');
  if (existing) return;

  const tableContainer = document.querySelector('.table-responsive#search-result');
  if (!tableContainer) {
    const checkInterval = setInterval(() => {
      const container = document.querySelector('.table-responsive#search-result');
      if (!container) return;
      clearInterval(checkInterval);
      setupButtons(container);
    }, 500);
    return;
  }

  setupButtons(tableContainer);

  function setupButtons(container) {
    const FILTERS = [
      { key: 'all', id: 'table-filter-all-btn', label: 'すべて', title: '全ての行を表示' },
      { key: 'danger', id: 'table-filter-danger-btn', label: '工数不一致', title: '工数不一致の行のみ表示' },
      { key: 'report', id: 'table-report-btn', label: 'レポート', title: '工数レポートを表示' }
    ];

    let currentFilter = 'all';
    let reportDataCache = null;
    let isCollecting = false;
    let isFixedVisible = false;
    const REPORT_CACHE_ROOT_KEY = 'jbeManHourReportCacheV1';
    const getCurrentReportCacheBucket = () => {
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.search);
      const form = document.getElementById('search');
      const yearInput = form ? form.querySelector('select[name="year"]') : null;
      const monthInput = form ? form.querySelector('select[name="month"]') : null;

      const yearFromForm = yearInput ? String(yearInput.value || '').trim() : '';
      const monthFromForm = monthInput ? String(monthInput.value || '').trim() : '';
      const yearFromQuery = String(params.get('year') || '').trim();
      const monthFromQuery = String(params.get('month') || '').trim();

      const year = yearFromForm || yearFromQuery || '';
      const month = monthFromForm || monthFromQuery || '';
      const searchType = String(params.get('search_type') || '').trim();
      const groupId = String(params.get('group_id') || '').trim();
      const startDate = String(params.get('start_date') || '').trim();
      const endDate = String(params.get('end_date') || '').trim();

      const stableParams = [
        `search_type=${searchType}`,
        `year=${year}`,
        `month=${month}`,
        `start_date=${startDate}`,
        `end_date=${endDate}`,
        `group_id=${groupId}`
      ].join('&');

      return `${url.origin}${url.pathname}?${stableParams}`;
    };

    const buttonContainer = document.createElement('div');
    buttonContainer.id = 'table-filter-buttons';

    const fixedButtonContainer = document.createElement('div');
    fixedButtonContainer.id = 'fixed-table-filter-buttons';

    const buttonRefs = {
      normal: {},
      fixed: {}
    };
    const shouldAutoOpenReportFromUrl = (() => {
      try {
        const params = new URLSearchParams(window.location.search);
        return params.get('jbe_open_report') === '1';
      } catch (_) {
        return false;
      }
    })();

    const clearAutoOpenReportFlagFromUrl = () => {
      try {
        const url = new URL(window.location.href);
        if (!url.searchParams.has('jbe_open_report')) return;
        url.searchParams.delete('jbe_open_report');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      } catch (_) {
        // no-op
      }
    };

    const closeExistingReportModal = () => {
      const existingModal = document.getElementById('table-report-modal-overlay');
      if (existingModal) existingModal.remove();
    };

    const isValidReportDataset = (data) => {
      if (!data || typeof data !== 'object') return false;
      if (!data.meta || !Array.isArray(data.days) || !data.aggregates) return false;
      return true;
    };

    const loadPersistedReportData = () => new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve(null);
        return;
      }
      chrome.storage.local.get([REPORT_CACHE_ROOT_KEY], (result) => {
        if (chrome.runtime?.lastError) {
          resolve(null);
          return;
        }
        const cacheRoot = result?.[REPORT_CACHE_ROOT_KEY];
        const cached = cacheRoot?.[getCurrentReportCacheBucket()] || null;
        resolve(isValidReportDataset(cached) ? cached : null);
      });
    });

    const persistReportData = (data) => new Promise((resolve) => {
      if (!chrome?.storage?.local || !isValidReportDataset(data)) {
        resolve(false);
        return;
      }

      chrome.storage.local.get([REPORT_CACHE_ROOT_KEY], (result) => {
        const cacheRoot = result?.[REPORT_CACHE_ROOT_KEY] && typeof result[REPORT_CACHE_ROOT_KEY] === 'object'
          ? result[REPORT_CACHE_ROOT_KEY]
          : {};
        cacheRoot[getCurrentReportCacheBucket()] = data;
        chrome.storage.local.set({ [REPORT_CACHE_ROOT_KEY]: cacheRoot }, () => {
          resolve(!chrome.runtime?.lastError);
        });
      });
    });

    const parseBucketMonth = (bucket) => {
      try {
        const url = new URL(bucket);
        const params = new URLSearchParams(url.search);
        const year = String(params.get('year') || '').trim();
        const monthRaw = String(params.get('month') || '').trim();
        const month = monthRaw ? monthRaw.padStart(2, '0') : '';
        const monthKey = year && month ? `${year}-${month}` : '';
        const label = year && month ? `${year}/${month}` : '不明';
        return { year, month, monthKey, label };
      } catch (_) {
        return { year: '', month: '', monthKey: '', label: '不明' };
      }
    };

    const loadAllPersistedReports = () => new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve([]);
        return;
      }
      chrome.storage.local.get([REPORT_CACHE_ROOT_KEY], (result) => {
        if (chrome.runtime?.lastError) {
          resolve([]);
          return;
        }
        const cacheRoot = result?.[REPORT_CACHE_ROOT_KEY];
        if (!cacheRoot || typeof cacheRoot !== 'object') {
          resolve([]);
          return;
        }

        const records = Object.entries(cacheRoot)
          .filter(([, data]) => isValidReportDataset(data))
          .map(([bucket, data]) => {
            const parsed = parseBucketMonth(bucket);
            const collectedAtMs = (() => {
              const raw = data?.meta?.collectedAt;
              const ts = raw ? Date.parse(raw) : NaN;
              return Number.isFinite(ts) ? ts : 0;
            })();
            return {
              bucket,
              data,
              monthKey: parsed.monthKey,
              label: parsed.label,
              collectedAtMs
            };
          });

        // Deduplicate same month buckets (e.g. month=3 and month=03) by keeping the newest record.
        const bestByMonth = new Map();
        records.forEach((record) => {
          if (!record.monthKey) {
            // Skip unknown month records in month tabs.
            return;
          }

          const previous = bestByMonth.get(record.monthKey);
          if (!previous || record.collectedAtMs > previous.collectedAtMs) {
            bestByMonth.set(record.monthKey, record);
          }
        });

        const deduped = Array.from(bestByMonth.values())
          .sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1));

        resolve(deduped);
      });
    });

    const getCacheBucketFromDataset = (data) => String(data?.meta?.cacheBucket || '').trim();

    const createEmptyAggregates = () => ({
      projectTotals: {},
      taskTotalsByProject: {},
      grandTotalMinutes: 0,
      totalEntries: 0,
      mismatchDayCount: 0,
      unselectedCounts: {
        project: 0,
        task: 0
      }
    });

    const formatMinutesToHHMM = (minutes) => {
      const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
      const h = Math.floor(safe / 60);
      const m = safe % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const parseMinutesValue = (raw) => {
      const text = String(raw || '').trim();
      if (!text) return 0;

      if (/^-?\d+$/.test(text)) return Math.max(0, parseInt(text, 10));

      const hhmm = text.match(/^(\d{1,4}):(\d{1,2})$/);
      if (hhmm) {
        const h = parseInt(hhmm[1], 10) || 0;
        const m = parseInt(hhmm[2], 10) || 0;
        return Math.max(0, h * 60 + m);
      }

      const jpHourMin = text.match(/(\d+)\s*時間(?:\s*(\d+)\s*分)?/);
      if (jpHourMin) {
        const h = parseInt(jpHourMin[1], 10) || 0;
        const m = parseInt(jpHourMin[2] || '0', 10) || 0;
        return Math.max(0, h * 60 + m);
      }

      const jpMin = text.match(/(\d+)\s*分/);
      if (jpMin) {
        return Math.max(0, parseInt(jpMin[1], 10) || 0);
      }

      const decimalHour = text.match(/^(\d+(?:\.\d+)?)$/);
      if (decimalHour) {
        return Math.max(0, Math.round(parseFloat(decimalHour[1]) * 60));
      }

      return 0;
    };

    const parseMinutesFromTotalText = (raw) => {
      const text = String(raw || '').trim();
      if (!text) return null;
      if (text.includes('入力がありません')) return 0;
      return parseMinutesValue(text);
    };

    const getEntryTotalMinutes = (day) => {
      if (!Array.isArray(day?.entries)) return null;
      return day.entries.reduce((sum, entry) => {
        const minutes = Number.isFinite(entry?.minutesValue) ? entry.minutesValue : 0;
        return sum + minutes;
      }, 0);
    };

    const getDeclaredDayTotalMinutes = (day) => {
      const modalTotal = parseMinutesFromTotalText(day?.modalTotalText);
      if (modalTotal !== null) return modalTotal;
      const dayTotal = parseMinutesFromTotalText(day?.dayTotalText);
      if (dayTotal !== null) return dayTotal;
      const manHourTotal = parseMinutesFromTotalText(day?.manHourTotalText);
      if (manHourTotal !== null) return manHourTotal;
      return null;
    };

    const deriveDayMismatchFlag = (dayLike) => {
      const day = dayLike || {};
      const rowFlags = Array.isArray(day.rowClassFlags) ? day.rowClassFlags : [];
      const rowMismatch = rowFlags.includes('jbc-table-danger') || rowFlags.includes('danger');
      const entryTotal = getEntryTotalMinutes(day);
      const declaredTotal = getDeclaredDayTotalMinutes(day);
      if (entryTotal !== null && declaredTotal !== null) {
        return entryTotal !== declaredTotal;
      }
      return rowMismatch || day.mismatchFlag === true;
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const waitForModalState = (open, timeoutMs = 3500) => new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const modal = document.getElementById('man-hour-manage-modal');
        const isOpen = !!(modal && modal.classList.contains('show'));
        if (isOpen === open) {
          clearInterval(timer);
          resolve(modal);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(open ? 'Modal open timeout' : 'Modal close timeout'));
        }
      }, 80);
    });

    const waitForModalContentReady = (modal, timeoutMs = 1200) => new Promise((resolve) => {
      if (!modal) {
        resolve(false);
        return;
      }

      const hasReadyContent = () => {
        const body = modal.querySelector('.modal-body');
        if (!body) return false;
        if ((body.textContent || '').includes('工数合計')) return true;
        if (body.querySelector('.man-hour-table-edit tr, .jbc-table tr')) return true;
        return false;
      };

      if (hasReadyContent()) {
        resolve(true);
        return;
      }

      const started = Date.now();
      const timer = setInterval(() => {
        if (hasReadyContent()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 60);
    });

    const getRowIdFromRow = (row) => {
      const editButton = row.querySelector('.btn.jbc-btn-primary[onclick^="openEditWindow"]');
      if (!editButton) return null;
      const onclick = editButton.getAttribute('onclick') || '';
      const match = onclick.match(/openEditWindow\((\d+)\)/);
      return match ? match[1] : null;
    };

    const setLastOpenedRowId = (rowId) => {
      const value = String(rowId || '').trim();
      if (!value) return;
      window.__jbe_lastOpenedManHourRowId = value;
    };

    const openEditModalForRow = (target) => {
      const rowIdNum = Number(target?.id);
      setLastOpenedRowId(rowIdNum);
      if (Number.isFinite(rowIdNum) && typeof window.openEditWindow === 'function') {
        try {
          window.openEditWindow(rowIdNum);
          return;
        } catch (_) {
          // Fallback to the original button click path.
        }
      }
      if (target?.button) target.button.click();
    };

    const NO_INPUT_LABEL = '入力がありません';
    const ZERO_MAN_HOUR_LABEL = '00:00';

    const getCellDisplayText = (cell) => {
      if (!cell) return '';
      return String(cell.textContent || '').trim();
    };

    const getCellRawText = (cell) => {
      if (!cell) return '';
      return String(cell.dataset.jbeOriginalManHourTotal || cell.textContent || '').trim();
    };

    const hasNoInputLabel = (text) => String(text || '').includes(NO_INPUT_LABEL);

    const getSearchResultManHourDisplayText = (manHourTotalText, dayTotalText) => {
      if (!hasNoInputLabel(manHourTotalText)) return String(manHourTotalText || '').trim();
      const workingMinutes = parseMinutesValue(dayTotalText);
      return workingMinutes <= 0 ? ZERO_MAN_HOUR_LABEL : NO_INPUT_LABEL;
    };

    const syncSearchResultManHourTotals = () => {
      const rows = Array.from(container.querySelectorAll('tr')).filter((row) => !row.querySelector('th'));

      rows.forEach((row) => {
        const totalCell = row.querySelector('td:nth-child(3)');
        if (!totalCell) return;

        const currentText = getCellDisplayText(totalCell);
        const renderedText = String(totalCell.dataset.jbeRenderedManHourTotal || '').trim();
        const hasOwnRenderedValue = renderedText && currentText === renderedText && totalCell.dataset.jbeOriginalManHourTotal;

        const rawText = hasOwnRenderedValue ? getCellRawText(totalCell) : currentText;
        totalCell.dataset.jbeOriginalManHourTotal = rawText;

        const dayTotalText = getRowTotalText(row);
        const displayText = getSearchResultManHourDisplayText(rawText, dayTotalText);

        totalCell.dataset.jbeRenderedManHourTotal = displayText;
        if (currentText !== displayText) {
          totalCell.textContent = displayText;
        }
      });
    };

    const getRowDateText = (row) => {
      const dateCell = row.querySelector('td:first-child');
      return dateCell ? dateCell.textContent.trim() : '';
    };

    const getRowTotalText = (row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (!cells.length) return '';
      const timeLike = cells
        .filter((_, index) => index !== 2)
        .map((cell) => cell.textContent.trim())
        .filter((text) => /(\d{1,4}:\d{2})|(\d+\s*時間)|(\d+\s*分)/.test(text));
      return timeLike[timeLike.length - 1] || cells[cells.length - 1].textContent.trim();
    };

    const getRowManHourTotalText = (row) => {
      const totalCell = row.querySelector('td:nth-child(3)');
      if (!totalCell) return '';
      return getCellRawText(totalCell);
    };

    const buildDaySignature = (dayLike) => {
      const dateText = String(dayLike?.dateText || '').trim();
      const manHourTotalText = String(dayLike?.manHourTotalText || '').trim();
      const dayTotalText = String(dayLike?.dayTotalText || '').trim();
      const mismatchFlag = deriveDayMismatchFlag(dayLike) ? '1' : '0';
      const skippedNoInput = dayLike?.skippedNoInput ? '1' : '0';
      return `${dateText}|${manHourTotalText}|${dayTotalText}|${mismatchFlag}|${skippedNoInput}`;
    };

    const cloneDayData = (day) => ({
      ...day,
      rowClassFlags: Array.isArray(day?.rowClassFlags) ? [...day.rowClassFlags] : [],
      entries: Array.isArray(day?.entries) ? day.entries.map((entry) => ({ ...entry })) : []
    });

    const isUnselectedText = (text) => {
      const value = String(text || '').trim();
      return value.includes('未選択') || value === '(未選択)';
    };

    const getSelectedText = (row, config) => {
      const { rawSelect, enhancedSelect, fallbackSelect } = config;
      const select = row.querySelector(rawSelect);
      if (select && select.selectedOptions && select.selectedOptions[0]) {
        return select.selectedOptions[0].textContent.trim();
      }

      const enhanced = row.querySelector(enhancedSelect);
      if (enhanced) return enhanced.textContent.trim();

      const fallback = row.querySelector(fallbackSelect);
      if (fallback && fallback.selectedOptions && fallback.selectedOptions[0]) {
        return fallback.selectedOptions[0].textContent.trim();
      }

      return '';
    };

    const extractModalRows = (modal) => {
      const rows = modal.querySelectorAll('.man-hour-table-edit tr, .jbc-table tr');
      const entries = [];

      rows.forEach((tr) => {
        if (tr.querySelector('th')) return;

        const project = getSelectedText(tr, {
          rawSelect: 'select[name="projects[]"]',
          enhancedSelect: '.custom-select-wrapper.project-select .select-display',
          fallbackSelect: 'select[name*="project"]'
        });

        const task = getSelectedText(tr, {
          rawSelect: 'select[name="tasks[]"]',
          enhancedSelect: '.custom-select-wrapper.task-select .select-display',
          fallbackSelect: 'select[name*="task"]'
        });

        const minutesInput = tr.querySelector('input.man-hour-input[name="minutes[]"], input[name="minutes[]"]');
        const minutesRaw = minutesInput ? String(minutesInput.value || '').trim() : '';
        const minutesValue = parseMinutesValue(minutesRaw);

        if (!project && !task && !minutesRaw) return;

        entries.push({
          project,
          task,
          minutesRaw,
          minutesValue,
          isProjectUnselected: isUnselectedText(project),
          isTaskUnselected: isUnselectedText(task)
        });
      });

      return entries;
    };

    const extractModalTotalText = (modal) => {
      const sumEl = modal.querySelector('.man-hour-sum');
      if (sumEl) return sumEl.textContent.trim();

      const txt = (modal.textContent || '').match(/工数合計[:：]\s*([^\n]+)/);
      return txt ? txt[1].trim() : '';
    };

    const createProgressOverlay = (total) => {
      const overlay = document.createElement('div');
      overlay.className = 'project-check-overlay';

      const box = document.createElement('div');
      box.className = 'project-check-message';

      const title = document.createElement('div');
      title.className = 'project-check-title';
      title.textContent = 'レポートデータを収集中...';

      const subtitle = document.createElement('div');
      subtitle.className = 'project-check-subtitle';
      subtitle.textContent = '各日の工数明細を確認しています';

      const progressWrap = document.createElement('div');
      progressWrap.className = 'project-check-progress';
      const progressBar = document.createElement('div');
      progressBar.className = 'project-check-progress-bar';
      progressWrap.appendChild(progressBar);

      const progressText = document.createElement('div');
      progressText.className = 'project-check-progress-text';
      progressText.textContent = `0 / ${total}`;

      const elapsed = document.createElement('div');
      elapsed.className = 'project-check-elapsed';
      elapsed.textContent = '経過: 0秒';

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.textContent = 'キャンセル';
      cancelButton.className = 'project-check-cancel-btn';

      box.appendChild(title);
      box.appendChild(subtitle);
      box.appendChild(progressWrap);
      box.appendChild(progressText);
      box.appendChild(elapsed);
      box.appendChild(cancelButton);
      overlay.appendChild(box);

      return {
        overlay,
        progressBar,
        progressText,
        elapsed,
        cancelButton
      };
    };

    const ensureModalClosed = async () => {
      const modal = document.getElementById('man-hour-manage-modal');
      if (!modal || !modal.classList.contains('show')) return;
      const closeBtn = modal.querySelector('button.close');
      if (closeBtn) closeBtn.click();
      try {
        await waitForModalState(false, 2500);
      } catch (_) {
        // no-op: defensive cleanup only
      }
    };

    const collectManHourReportData = async (forceRefresh = false) => {
      if (!forceRefresh && reportDataCache) {
        const currentBucket = getCurrentReportCacheBucket();
        if (getCacheBucketFromDataset(reportDataCache) === currentBucket) {
          return reportDataCache;
        }
      }

      if (isCollecting) return reportDataCache;
      isCollecting = true;

      const currentBucket = getCurrentReportCacheBucket();
      if (reportDataCache && getCacheBucketFromDataset(reportDataCache) !== currentBucket) {
        reportDataCache = await loadPersistedReportData();
      }

      if (!reportDataCache) {
        const existing = await loadPersistedReportData();
        if (existing) reportDataCache = existing;
      }

      const cachedDaysById = new Map(
        Array.isArray(reportDataCache?.days)
          ? reportDataCache.days.map((day) => [String(day.id), day])
          : []
      );
      const failedDaySet = new Set(
        Array.isArray(reportDataCache?.meta?.failedRowIds)
          ? reportDataCache.meta.failedRowIds.map((id) => String(id))
          : []
      );

      const rows = Array.from(container.querySelectorAll('tr')).filter((row) => !row.querySelector('th'));
      const allTargets = rows
        .map((row) => ({
          id: getRowIdFromRow(row),
          row,
          button: row.querySelector('.btn.jbc-btn-primary[onclick^="openEditWindow"]')
        }))
        .filter((item) => item.id && item.button);

      const dayMap = new Map();
      allTargets.forEach((target) => {
        const rowClassFlags = Array.from(target.row.classList || []);
        const manHourTotalText = getRowManHourTotalText(target.row);
        const dayTotalText = getRowTotalText(target.row);
        dayMap.set(target.id, {
          id: target.id,
          dateText: getRowDateText(target.row),
          rowClassFlags,
          manHourTotalText,
          dayTotalText,
          modalTotalText: '',
          mismatchFlag: rowClassFlags.includes('jbc-table-danger') || rowClassFlags.includes('danger'),
          skippedNoInput: manHourTotalText.includes('入力がありません'),
          entries: []
        });

        const currentDay = dayMap.get(target.id);
        currentDay.signature = buildDaySignature(currentDay);

        const cachedDay = cachedDaysById.get(String(target.id));
        if (!forceRefresh && cachedDay && !failedDaySet.has(String(target.id))) {
          const cachedSignature = cachedDay.signature || buildDaySignature(cachedDay);
          const hasUsableCachedContent = cachedDay.skippedNoInput === true ||
            (Array.isArray(cachedDay.entries) && cachedDay.entries.length > 0);
          if (cachedSignature === currentDay.signature && hasUsableCachedContent) {
            dayMap.set(target.id, cloneDayData({
              ...cachedDay,
              signature: cachedSignature
            }));
          }
        }
      });

      const editTargets = allTargets.filter((target) => {
        const day = dayMap.get(target.id);
        const cachedDay = cachedDaysById.get(String(target.id));
        const hasUsableCachedContent = cachedDay?.skippedNoInput === true ||
          (Array.isArray(cachedDay?.entries) && cachedDay.entries.length > 0);
        const reused = !forceRefresh &&
          cachedDay &&
          hasUsableCachedContent &&
          day &&
          (cachedDay.signature || buildDaySignature(cachedDay)) === day.signature;
        return day && !day.skippedNoInput && !reused;
      });

      const ui = createProgressOverlay(editTargets.length);
      document.body.appendChild(ui.overlay);

      const startTime = Date.now();
      let isCancelled = false;
      const failedRowIds = [];

      ui.cancelButton.addEventListener('click', () => {
        isCancelled = true;
        if (typeof window.showNotification === 'function') {
          window.showNotification('レポートデータの収集をキャンセルしました');
        }
      });

      const elapsedTimer = setInterval(() => {
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        ui.elapsed.textContent = `経過: ${seconds}秒`;
      }, 250);

      const updateProgress = (done) => {
        const total = Math.max(1, editTargets.length);
        const pct = Math.min(100, Math.round((done / total) * 100));
        ui.progressBar.style.width = `${pct}%`;
        ui.progressText.textContent = `${done} / ${editTargets.length} (${pct}%)`;
      };

      const dataset = {
        meta: {
          collectedAt: new Date().toISOString(),
          sourceUrl: window.location.href,
          cacheBucket: getCurrentReportCacheBucket(),
          rowCount: allTargets.length,
          iteratedRowCount: editTargets.length,
          skippedNoInputCount: allTargets.length - editTargets.length,
          processedCount: 0,
          durationMs: 0,
          failedRowIds,
          cancelled: false,
          partial: false
        },
        days: [],
        aggregates: createEmptyAggregates()
      };

      try {
        updateProgress(0);

        const modalHideStyle = document.createElement('style');
        modalHideStyle.id = 'project-check-modal-hide-style';
        modalHideStyle.textContent = `
          #man-hour-manage-modal.show {
            visibility: hidden !important;
            opacity: 0 !important;
          }
          .jobcan-enhanced #man-hour-manage-modal.show ~ .contentsArea,
          .jobcan-enhanced #man-hour-manage-modal.show ~ #main-content,
          .jobcan-enhanced body.modal-open .contentsArea,
          .jobcan-enhanced body.modal-open #main-content,
          .jobcan-enhanced #man-hour-manage-modal.show ~ .jbc-card,
          .jobcan-enhanced body.modal-open .jbc-card {
            width: 100% !important;
            margin: 0 !important;
            transition: none !important;
          }
        `;
        document.head.appendChild(modalHideStyle);

        for (let i = 0; i < editTargets.length; i++) {
          if (isCancelled) break;

          const target = editTargets[i];
          const day = dayMap.get(target.id);
          if (!day) continue;

          let success = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await ensureModalClosed();
              openEditModalForRow(target);
              const modal = await waitForModalState(true, 3500 + attempt * 1000);

              if (!modal) throw new Error('Modal not found');
              await waitForModalContentReady(modal, 1400 + attempt * 600);

              const modalText = modal.textContent || '';
              const isNoInput = /工数合計[:：]\s*入力がありません/.test(modalText);
              day.skippedNoInput = isNoInput;
              if (!isNoInput) {
                day.entries = extractModalRows(modal);
                day.modalTotalText = extractModalTotalText(modal);
              } else {
                day.entries = [];
                day.modalTotalText = '入力がありません';
              }
              day.mismatchFlag = deriveDayMismatchFlag(day);
              day.signature = buildDaySignature(day);

              await ensureModalClosed();
              success = true;
              break;
            } catch (error) {
              if (attempt === 1) {
                failedRowIds.push(target.id);
              } else {
                await sleep(180);
              }
            }
          }

          if (!success) {
            await ensureModalClosed();
          }

          dataset.meta.processedCount = i + 1;
          updateProgress(i + 1);
          await sleep(120);
        }

        dataset.days = allTargets.map((target) => dayMap.get(target.id)).filter(Boolean);
        const skippedNoInputCount = dataset.days.filter((item) => item.skippedNoInput).length;
        dataset.meta.rowCount = dataset.days.length;
        dataset.meta.iteratedRowCount = dataset.days.length - skippedNoInputCount;
        dataset.meta.skippedNoInputCount = skippedNoInputCount;

        dataset.aggregates = computeAggregates(dataset.days);

        dataset.meta.durationMs = Date.now() - startTime;
        dataset.meta.cancelled = isCancelled;

        if (!isCancelled) {
          reportDataCache = dataset;
          await persistReportData(reportDataCache);
          if (typeof window.showNotification === 'function') {
            window.showNotification('工数レポートデータの収集が完了しました');
          }
        }

        if (isCancelled) return reportDataCache;
        return dataset;
      } catch (error) {
        console.error('Error collecting report data:', error);
        if (typeof window.showNotification === 'function') {
          window.showNotification('レポートデータの収集中にエラーが発生しました');
        }
        return reportDataCache;
      } finally {
        isCollecting = false;
        clearInterval(elapsedTimer);

        const modalHideStyle = document.getElementById('project-check-modal-hide-style');
        if (modalHideStyle) modalHideStyle.remove();

        if (ui.overlay && ui.overlay.parentNode) {
          ui.overlay.remove();
        }

        await ensureModalClosed();
      }
    };

    window.__jbe_collectManHourReportData = collectManHourReportData;

    const computeAggregates = (days) => {
      const aggregates = createEmptyAggregates();

      days.forEach((day) => {
        if (day.mismatchFlag) aggregates.mismatchDayCount += 1;
        day.entries.forEach((entry) => {
          const projectKey = entry.project || '(プロジェクト未選択)';
          const taskKey = entry.task || '(タスク未選択)';
          const minutes = Number.isFinite(entry.minutesValue) ? entry.minutesValue : 0;

          aggregates.projectTotals[projectKey] = (aggregates.projectTotals[projectKey] || 0) + minutes;
          if (!aggregates.taskTotalsByProject[projectKey]) {
            aggregates.taskTotalsByProject[projectKey] = {};
          }
          aggregates.taskTotalsByProject[projectKey][taskKey] = (aggregates.taskTotalsByProject[projectKey][taskKey] || 0) + minutes;

          aggregates.grandTotalMinutes += minutes;
          aggregates.totalEntries += 1;

          if (entry.isProjectUnselected) aggregates.unselectedCounts.project += 1;
          if (entry.isTaskUnselected) aggregates.unselectedCounts.task += 1;
        });
      });

      return aggregates;
    };

    const findEditTargetById = (dayId) => {
      const rows = Array.from(container.querySelectorAll('tr')).filter((row) => !row.querySelector('th'));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const id = getRowIdFromRow(row);
        if (!id || String(id) !== String(dayId)) continue;
        const button = row.querySelector('.btn.jbc-btn-primary[onclick^="openEditWindow"]');
        if (!button) return null;
        return { id, row, button };
      }
      return null;
    };

    const createDayFromTarget = (target) => {
      const rowClassFlags = Array.from(target.row.classList || []);
      const manHourTotalText = getRowManHourTotalText(target.row);
      const dayTotalText = getRowTotalText(target.row);
      const day = {
        id: target.id,
        dateText: getRowDateText(target.row),
        rowClassFlags,
        manHourTotalText,
        dayTotalText,
        modalTotalText: '',
        mismatchFlag: rowClassFlags.includes('jbc-table-danger') || rowClassFlags.includes('danger'),
        skippedNoInput: manHourTotalText.includes('入力がありません'),
        signature: '',
        entries: []
      };
      day.mismatchFlag = deriveDayMismatchFlag(day);
      day.signature = buildDaySignature(day);
      return day;
    };

    const collectSingleDayData = async (target, existingFailedRowIds = null) => {
      const day = createDayFromTarget(target);
      day.signature = buildDaySignature(day);
      if (day.skippedNoInput) {
        day.entries = [];
        day.modalTotalText = '入力がありません';
        day.mismatchFlag = deriveDayMismatchFlag(day);
        return { day, success: true };
      }

      let success = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await ensureModalClosed();
          openEditModalForRow(target);
          const modal = await waitForModalState(true, 3500 + attempt * 1000);
          if (!modal) throw new Error('Modal not found');
          await waitForModalContentReady(modal, 1400 + attempt * 600);

          const modalText = modal.textContent || '';
          const isNoInput = /工数合計[:：]\s*入力がありません/.test(modalText);
          day.skippedNoInput = isNoInput;
          if (!isNoInput) {
            day.entries = extractModalRows(modal);
            day.modalTotalText = extractModalTotalText(modal);
          } else {
            day.entries = [];
            day.modalTotalText = '入力がありません';
          }
          day.mismatchFlag = deriveDayMismatchFlag(day);
          day.signature = buildDaySignature(day);
          await ensureModalClosed();
          success = true;
          break;
        } catch (error) {
          if (attempt !== 1) await sleep(180);
        }
      }

      if (!success && Array.isArray(existingFailedRowIds) && !existingFailedRowIds.includes(day.id)) {
        existingFailedRowIds.push(day.id);
      }
      if (!success) await ensureModalClosed();

      return { day, success };
    };

    const refetchDayData = async (dayId) => {
      const target = findEditTargetById(dayId);
      if (!target) return null;

      const failedRowIds = Array.isArray(reportDataCache?.meta?.failedRowIds) ? [...reportDataCache.meta.failedRowIds] : [];
      const { day, success } = await collectSingleDayData(target, failedRowIds);
      if (!reportDataCache) return null;

      const days = (reportDataCache.days || []).map((item) => (String(item.id) === String(day.id) ? day : item));
      const exists = days.some((item) => String(item.id) === String(day.id));
      if (!exists) days.push(day);

      const skippedNoInputCount = days.filter((item) => item.skippedNoInput).length;
      const nextMeta = {
        ...reportDataCache.meta,
        collectedAt: new Date().toISOString(),
        sourceUrl: window.location.href,
        cacheBucket: getCurrentReportCacheBucket(),
        rowCount: days.length,
        iteratedRowCount: days.length - skippedNoInputCount,
        skippedNoInputCount,
        failedRowIds: success ? failedRowIds.filter((id) => String(id) !== String(day.id)) : failedRowIds,
        partial: reportDataCache.meta?.partial === true
      };

      reportDataCache = {
        ...reportDataCache,
        meta: nextMeta,
        days,
        aggregates: computeAggregates(days)
      };
      await persistReportData(reportDataCache);

      return reportDataCache;
    };

    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const findOptionByText = (select, labelText) => {
      if (!select) return null;
      const target = normalizeText(labelText);
      if (!target) return null;
      const options = Array.from(select.options || []);
      let exact = options.find((opt) => normalizeText(opt.textContent) === target);
      if (exact) return exact;
      return options.find((opt) => {
        const text = normalizeText(opt.textContent);
        return text.includes(target) || target.includes(text);
      }) || null;
    };

    const setSelectByText = (select, labelText) => {
      const option = findOptionByText(select, labelText);
      if (!option) return false;
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    };

    const waitForSelectableOption = async (select, labelText, timeoutMs = 1200) => {
      const started = Date.now();
      while (Date.now() - started <= timeoutMs) {
        if (findOptionByText(select, labelText)) return true;
        await sleep(80);
      }
      return false;
    };

    const normalizeMinutesInput = (rawValue) => {
      const mins = parseMinutesValue(rawValue);
      return formatMinutesToHHMM(mins);
    };

    const applyDayEditsToWebsite = async (dayId, editedEntries) => {
      const target = findEditTargetById(dayId);
      if (!target) return null;

      const rowsToApply = Array.isArray(editedEntries) ? editedEntries : [];

      await ensureModalClosed();
      openEditModalForRow(target);
      const modal = await waitForModalState(true, 4200);
      if (!modal) return null;
      await waitForModalContentReady(modal, 2000);

      const getEditableRows = () => {
        const modalRows = Array.from(
          modal.querySelectorAll('.man-hour-table-edit tr, .jbc-table tr')
        ).filter((tr) => !tr.querySelector('th'));
        return modalRows.filter((row) =>
          row.querySelector('input.man-hour-input[name="minutes[]"], input[name="minutes[]"], select[name="projects[]"], select[name="tasks[]"]')
        );
      };

      let editableRows = getEditableRows();
      if (rowsToApply.length > editableRows.length) {
        const addRecordBtn = modal.querySelector(
          'span.btn.jbc-btn-primary[onclick*="addRecord"], .btn.jbc-btn-primary[onclick*="addRecord"]'
        );

        if (addRecordBtn) {
          let guard = 0;
          while (editableRows.length < rowsToApply.length && guard < 40) {
            const prevCount = editableRows.length;
            addRecordBtn.click();
            for (let waitTry = 0; waitTry < 10; waitTry++) {
              await sleep(80);
              editableRows = getEditableRows();
              if (editableRows.length > prevCount) break;
            }
            editableRows = getEditableRows();
            if (editableRows.length <= prevCount) break;
            guard += 1;
          }
        }
      }

      editableRows = getEditableRows();
      const applyCount = Math.min(rowsToApply.length, editableRows.length);
      for (let i = 0; i < applyCount; i++) {
        const src = rowsToApply[i];
        const row = editableRows[i];
        if (!row || !src) continue;

        const projectSelect = row.querySelector('select[name="projects[]"], select[name*="project"]');
        const taskSelect = row.querySelector('select[name="tasks[]"], select[name*="task"]');
        const minutesInput = row.querySelector('input.man-hour-input[name="minutes[]"], input[name="minutes[]"]');

        if (projectSelect && src.project) {
          setSelectByText(projectSelect, src.project);
          await sleep(100);
        }

        if (taskSelect && src.task) {
          await waitForSelectableOption(taskSelect, src.task, 1200);
          setSelectByText(taskSelect, src.task);
        }

        if (minutesInput) {
          minutesInput.value = normalizeMinutesInput(src.minutesRaw || src.minutesValue || '');
          minutesInput.dispatchEvent(new Event('input', { bubbles: true }));
          minutesInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      const saveBtn = modal.querySelector('.jbc-btn-primary[onclick*="pushSave"]');
      if (!saveBtn) {
        await ensureModalClosed();
        return null;
      }

      saveBtn.click();
      try {
        await waitForModalState(false, 5000);
      } catch (_) {
        // Ignore timeout and continue refresh attempt.
      }

      await sleep(280);
      return refetchDayData(dayId);
    };

    const buildReportOptionCatalog = (data) => {
      const projectSet = new Set();
      const taskSet = new Set();

      Object.keys(data?.aggregates?.projectTotals || {}).forEach((name) => {
        const text = String(name || '').trim();
        if (text) projectSet.add(text);
      });

      Object.values(data?.aggregates?.taskTotalsByProject || {}).forEach((taskMap) => {
        Object.keys(taskMap || {}).forEach((taskName) => {
          const text = String(taskName || '').trim();
          if (text) taskSet.add(text);
        });
      });

      (data?.days || []).forEach((day) => {
        (day.entries || []).forEach((entry) => {
          const project = String(entry.project || '').trim();
          const task = String(entry.task || '').trim();
          if (project) projectSet.add(project);
          if (task) taskSet.add(task);
        });
      });

      return {
        projects: Array.from(projectSet).sort((a, b) => a.localeCompare(b, 'ja')),
        tasks: Array.from(taskSet).sort((a, b) => a.localeCompare(b, 'ja'))
      };
    };

    const createReportSelect = (className, options, selectedValue, placeholder) => {
      const select = document.createElement('select');
      select.className = className;

      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = placeholder;
      select.appendChild(emptyOpt);

      const normalizedSelected = String(selectedValue || '').trim();
      const mergedOptions = new Set(options || []);
      if (normalizedSelected) mergedOptions.add(normalizedSelected);

      Array.from(mergedOptions).forEach((text) => {
        const opt = document.createElement('option');
        opt.value = text;
        opt.textContent = text;
        select.appendChild(opt);
      });

      if (normalizedSelected) {
        select.value = normalizedSelected;
      } else {
        select.value = '';
      }

      return select;
    };

    const upsertDayIntoCache = async (day) => {
      if (!day || !day.id) return null;
      const currentBucket = getCurrentReportCacheBucket();
      const inMemoryMatchesBucket = reportDataCache &&
        getCacheBucketFromDataset(reportDataCache) === currentBucket;

      const persistedCurrentBucket = await loadPersistedReportData();
      const baseCache = (inMemoryMatchesBucket ? reportDataCache : null) || persistedCurrentBucket || {
        meta: {
          collectedAt: new Date().toISOString(),
          sourceUrl: window.location.href,
          cacheBucket: currentBucket,
          rowCount: 0,
          iteratedRowCount: 0,
          skippedNoInputCount: 0,
          processedCount: 0,
          durationMs: 0,
          failedRowIds: [],
          cancelled: false,
          partial: true
        },
        days: [],
        aggregates: createEmptyAggregates()
      };

      const existingDays = Array.isArray(baseCache.days) ? baseCache.days : [];
      const nextDays = existingDays
        .map((item) => (String(item.id) === String(day.id) ? cloneDayData(day) : item));
      if (!nextDays.some((item) => String(item.id) === String(day.id))) {
        nextDays.push(cloneDayData(day));
      }

      const skippedNoInputCount = nextDays.filter((item) => item.skippedNoInput).length;
      const rowCountOnPage = Array.from(container.querySelectorAll('tr'))
        .filter((row) => !row.querySelector('th'))
        .length;

      reportDataCache = {
        ...baseCache,
        meta: {
          ...baseCache.meta,
          collectedAt: new Date().toISOString(),
          sourceUrl: window.location.href,
          cacheBucket: currentBucket,
          rowCount: Math.max(Number(baseCache.meta?.rowCount || 0), rowCountOnPage),
          iteratedRowCount: nextDays.length - skippedNoInputCount,
          skippedNoInputCount,
          partial: baseCache.meta?.partial !== false
        },
        days: nextDays,
        aggregates: computeAggregates(nextDays)
      };

      await persistReportData(reportDataCache);

      const reportOverlay = document.getElementById('table-report-modal-overlay');
      const activeBucket = getCacheBucketFromDataset(reportDataCache);
      if (reportOverlay && activeBucket === currentBucket) {
        renderReportModal(reportDataCache);
      }

      return reportDataCache;
    };

    const getDayTotalMinutes = (day) => {
      const entryTotal = getEntryTotalMinutes(day);
      if (entryTotal !== null) return entryTotal;

      const declaredTotal = getDeclaredDayTotalMinutes(day);
      if (declaredTotal !== null) return declaredTotal;

      return 0;
    };

    const extractDayLabel = (dateText) => {
      const text = String(dateText || '').trim();
      if (!text) return '';
      const slash = text.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (slash) return `${slash[1]}/${slash[2]}`;
      const hyphen = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (hyphen) return `${hyphen[2]}/${hyphen[3]}`;
      return text.slice(0, 8);
    };

    const buildDailySummaryKpiItems = (rawDays = []) => {
      const days = (rawDays || []).map((day) => ({
        ...day,
        totalMinutes: getDayTotalMinutes(day),
        label: extractDayLabel(day?.dateText || `ID ${day?.id || ''}`)
      }));

      if (!days.length) return [];

      const totalMinutes = days.reduce((sum, day) => sum + day.totalMinutes, 0);
      const activeDays = days.filter((day) => day.totalMinutes > 0).length;
      const avgMinutes = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;
      const peakDay = days.reduce((best, day) => (day.totalMinutes > (best?.totalMinutes || 0) ? day : best), null);
      const noInputDays = days.filter((day) => day.skippedNoInput || day.totalMinutes <= 0).length;

      return [
        {
          label: 'ピーク日',
          value: peakDay ? formatMinutesToHHMM(peakDay.totalMinutes) : '00:00',
          detail: peakDay ? `${peakDay.dateText || peakDay.label}` : 'データなし'
        },
        {
          label: '平均/稼働日',
          value: formatMinutesToHHMM(avgMinutes),
          detail: `${activeDays}日が稼働`
        },
        {
          label: '未入力日',
          value: `${noInputDays}日`,
          detail: `対象 ${days.length}日`
        }
      ];
    };

    const buildReportVisualSummary = (data, detailHandlers = {}) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-report-visual-summary';
      const renderDayPopoverContent = detailHandlers?.renderDayPopoverContent;

      const days = (data?.days || []).map((day) => ({
        ...day,
        totalMinutes: getDayTotalMinutes(day),
        label: extractDayLabel(day?.dateText || `ID ${day?.id || ''}`)
      }));

      if (!days.length) {
        const empty = document.createElement('div');
        empty.className = 'table-report-empty';
        empty.textContent = '可視化できる日次データがありません';
        wrap.appendChild(empty);
        return wrap;
      }

      const trend = document.createElement('div');
      trend.className = 'table-report-visual-card';
      const trendTitle = document.createElement('h4');
      trendTitle.className = 'table-report-visual-title';
      trendTitle.textContent = '日次トレンド';
      const trendBars = document.createElement('div');
      trendBars.className = 'table-report-trend-bars';
      const maxMinutes = Math.max(...days.map((day) => day.totalMinutes), 1);
      const overtimeThresholdMinutes = 8 * 60;
      const workingDays = days.filter((day) => day.totalMinutes > 0);
      const avgWorkingMinutes = workingDays.length
        ? Math.round(workingDays.reduce((sum, day) => sum + day.totalMinutes, 0) / workingDays.length)
        : 0;
      const avgHeightPct = avgWorkingMinutes > 0
        ? Math.max(0, Math.min(100, (avgWorkingMinutes / maxMinutes) * 100))
        : 0;

      if (avgWorkingMinutes > 0) {
        const avgMeta = document.createElement('span');
        avgMeta.className = 'table-report-trend-average-meta';
        avgMeta.textContent = `平均 ${formatMinutesToHHMM(avgWorkingMinutes)}`;
        trendTitle.appendChild(avgMeta);
      }

      const colorLegend = document.createElement('span');
      colorLegend.className = 'table-report-trend-color-legend';
      const regularLegend = document.createElement('span');
      regularLegend.className = 'table-report-trend-color-legend-item';
      regularLegend.innerHTML = '<i class="is-regular"></i><span>通常（~8h）</span>';
      const overtimeLegend = document.createElement('span');
      overtimeLegend.className = 'table-report-trend-color-legend-item';
      overtimeLegend.innerHTML = '<i class="is-overtime"></i><span>超過（8h+）</span>';
      colorLegend.appendChild(regularLegend);
      colorLegend.appendChild(overtimeLegend);
      trendTitle.appendChild(colorLegend);

      days.forEach((day) => {
        const col = document.createElement('div');
        col.className = 'table-report-trend-col';
        if (day.mismatchFlag) col.classList.add('is-mismatch');
        if (day.totalMinutes <= 0) col.classList.add('is-zero');

        const barBox = document.createElement('div');
        barBox.className = 'table-report-trend-bar-box';
        if (avgWorkingMinutes > 0) {
          barBox.classList.add('has-average');
          barBox.style.setProperty('--avg-height', `${avgHeightPct}%`);
        }
        const bar = document.createElement('div');
        bar.className = 'table-report-trend-bar';
        const fillHeight = day.totalMinutes <= 0 ? 0 : Math.max(4, Math.round((day.totalMinutes / maxMinutes) * 100));
        const regularMinutes = Math.max(0, Math.min(day.totalMinutes, overtimeThresholdMinutes));
        const regularCutoffPct = day.totalMinutes > 0
          ? Math.max(0, Math.min(100, (regularMinutes / day.totalMinutes) * 100))
          : 100;
        bar.style.height = `${fillHeight}%`;
        bar.style.setProperty('--regular-cutoff', `${regularCutoffPct}%`);
        bar.title = `${day.dateText || day.label}: ${formatMinutesToHHMM(day.totalMinutes)}`;
        barBox.appendChild(bar);
        col.appendChild(barBox);

        const label = document.createElement('div');
        label.className = 'table-report-trend-label';
        label.textContent = day.label;
        col.appendChild(label);

        trendBars.appendChild(col);
      });

      const trendScrollWrap = document.createElement('div');
      trendScrollWrap.className = 'table-report-trend-scroll-wrap';
      const trendScrollbar = document.createElement('div');
      trendScrollbar.className = 'table-report-trend-scrollbar';
      const trendScrollThumb = document.createElement('div');
      trendScrollThumb.className = 'table-report-trend-scrollbar-thumb';
      trendScrollbar.appendChild(trendScrollThumb);
      trendScrollWrap.appendChild(trendBars);
      trendScrollWrap.appendChild(trendScrollbar);

      let dragState = null;
      const syncTrendScrollbar = () => {
        const visible = trendBars.clientWidth;
        const total = trendBars.scrollWidth;
        if (!visible || total <= visible + 1) {
          trendScrollbar.classList.add('is-disabled');
          trendScrollThumb.style.width = '100%';
          trendScrollThumb.style.transform = 'translateX(0px)';
          return;
        }

        trendScrollbar.classList.remove('is-disabled');
        const trackWidth = Math.max(1, trendScrollbar.clientWidth);
        const thumbWidth = Math.max(34, Math.round((visible / total) * trackWidth));
        const maxScrollLeft = total - visible;
        const maxThumbOffset = trackWidth - thumbWidth;
        const thumbOffset = maxScrollLeft > 0
          ? Math.round((trendBars.scrollLeft / maxScrollLeft) * maxThumbOffset)
          : 0;

        trendScrollThumb.style.width = `${thumbWidth}px`;
        trendScrollThumb.style.transform = `translateX(${thumbOffset}px)`;
      };

      trendBars.addEventListener('scroll', syncTrendScrollbar);
      trendScrollbar.addEventListener('pointerdown', (event) => {
        if (event.target === trendScrollThumb) return;
        const rect = trendScrollbar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
        trendBars.scrollLeft = (trendBars.scrollWidth - trendBars.clientWidth) * ratio;
      });
      trendScrollThumb.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const trackRect = trendScrollbar.getBoundingClientRect();
        dragState = {
          startX: event.clientX,
          startScrollLeft: trendBars.scrollLeft,
          trackWidth: Math.max(1, trackRect.width),
          maxScroll: Math.max(1, trendBars.scrollWidth - trendBars.clientWidth),
          thumbWidth: Math.max(1, trendScrollThumb.offsetWidth)
        };
        const onPointerMove = (moveEvent) => {
          if (!dragState) return;
          const maxThumbOffset = Math.max(1, dragState.trackWidth - dragState.thumbWidth);
          const deltaRatio = (moveEvent.clientX - dragState.startX) / maxThumbOffset;
          const next = dragState.startScrollLeft + (dragState.maxScroll * deltaRatio);
          trendBars.scrollLeft = Math.max(0, Math.min(dragState.maxScroll, next));
        };
        const onPointerUp = () => {
          dragState = null;
          document.removeEventListener('pointermove', onPointerMove);
          document.removeEventListener('pointerup', onPointerUp);
        };
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
      });

      trend.appendChild(trendTitle);
      trend.appendChild(trendScrollWrap);

      const heatmap = document.createElement('div');
      heatmap.className = 'table-report-visual-card';
      const heatmapTitle = document.createElement('h4');
      heatmapTitle.className = 'table-report-visual-title';
      heatmapTitle.textContent = '稼働ヒートマップ';
      const heatmapWeekdays = document.createElement('div');
      heatmapWeekdays.className = 'table-report-heatmap-weekdays';
      ['日', '月', '火', '水', '木', '金', '土'].forEach((w) => {
        const wd = document.createElement('div');
        wd.className = `table-report-heatmap-weekday${w === '日' ? ' is-sun' : ''}${w === '土' ? ' is-sat' : ''}`;
        wd.textContent = w;
        heatmapWeekdays.appendChild(wd);
      });
      const heatmapGrid = document.createElement('div');
      heatmapGrid.className = 'table-report-heatmap-grid';
      const heatmapPopoverLayer = document.createElement('div');
      heatmapPopoverLayer.className = 'table-report-day-popover-layer';
      let activeHeatmapCell = null;

      const closeDayPopover = () => {
        if (activeHeatmapCell) activeHeatmapCell.classList.remove('is-active');
        activeHeatmapCell = null;
        heatmapPopoverLayer.classList.remove('is-open');
        heatmapPopoverLayer.replaceChildren();
      };

      const parseDayDate = (day) => {
        const rawText = String(day?.dateText || day?.label || '').trim();
        const md = rawText.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
        if (!md) return null;

        const parsed = parseBucketMonth(getCacheBucketFromDataset(data) || data?.meta?.cacheBucket || '');
        const yearNum = Number.parseInt(parsed?.year || '', 10);
        const monthNum = Number.parseInt(md[1], 10);
        const dayNum = Number.parseInt(md[2], 10);
        if (!Number.isFinite(monthNum) || !Number.isFinite(dayNum)) return null;
        const safeYear = Number.isFinite(yearNum) ? yearNum : new Date().getFullYear();
        const dt = new Date(safeYear, monthNum - 1, dayNum);
        if (Number.isNaN(dt.getTime())) return null;
        return dt;
      };

      const sortedDays = [...days].sort((a, b) => {
        const da = parseDayDate(a);
        const db = parseDayDate(b);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da.getTime() - db.getTime();
      });

      const firstDate = sortedDays.length ? parseDayDate(sortedDays[0]) : null;
      const leadingEmptyCount = firstDate ? firstDate.getDay() : 0;
      for (let i = 0; i < leadingEmptyCount; i++) {
        const blank = document.createElement('div');
        blank.className = 'table-report-heatmap-empty-cell';
        heatmapGrid.appendChild(blank);
      }

      sortedDays.forEach((day) => {
        const level = Math.max(0, Math.min(4, Math.round((day.totalMinutes / maxMinutes) * 4)));
        const cell = document.createElement('div');
        cell.className = `table-report-heatmap-cell intensity-${level}${day.mismatchFlag ? ' is-mismatch' : ''}`;
        cell.title = `${day.dateText || day.label}: ${formatMinutesToHHMM(day.totalMinutes)}${day.mismatchFlag ? ' / 工数不一致' : ''}`;
        cell.setAttribute('role', 'button');
        cell.setAttribute('tabindex', '0');

        const dayLabel = document.createElement('span');
        dayLabel.className = 'table-report-heatmap-date';
        dayLabel.textContent = day.label;
        const dayValue = document.createElement('span');
        dayValue.className = 'table-report-heatmap-value';
        dayValue.textContent = formatMinutesToHHMM(day.totalMinutes);

        cell.appendChild(dayLabel);
        cell.appendChild(dayValue);
        const openPopoverForDay = () => {
          if (activeHeatmapCell === cell) {
            closeDayPopover();
            return;
          }

          const popover = document.createElement('div');
          popover.className = 'table-report-day-popover';
          const popoverClose = document.createElement('button');
          popoverClose.type = 'button';
          popoverClose.className = 'table-report-day-popover-close';
          popoverClose.textContent = '×';
          popoverClose.addEventListener('click', (event) => {
            event.stopPropagation();
            closeDayPopover();
          });

          const popoverContent = document.createElement('div');
          popoverContent.className = 'table-report-day-popover-content';
          if (typeof renderDayPopoverContent === 'function') {
            const detailNode = renderDayPopoverContent(day);
            if (detailNode) popoverContent.appendChild(detailNode);
          }
          if (!popoverContent.childNodes.length) {
            const empty = document.createElement('div');
            empty.className = 'table-report-empty';
            empty.textContent = '日別データがありません';
            popoverContent.appendChild(empty);
          }

          popover.appendChild(popoverClose);
          popover.appendChild(popoverContent);
          heatmapPopoverLayer.replaceChildren(popover);
          heatmapPopoverLayer.classList.add('is-open');
          if (activeHeatmapCell) activeHeatmapCell.classList.remove('is-active');
          activeHeatmapCell = cell;
          activeHeatmapCell.classList.add('is-active');
        };

        cell.addEventListener('click', (event) => {
          event.stopPropagation();
          openPopoverForDay();
        });
        cell.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPopoverForDay();
          }
        });
        heatmapGrid.appendChild(cell);
      });

      heatmap.appendChild(heatmapTitle);
      heatmap.appendChild(heatmapWeekdays);
      heatmap.appendChild(heatmapGrid);
      heatmap.appendChild(heatmapPopoverLayer);
      heatmap.addEventListener('click', (event) => {
        if (event.target && event.target.closest('.table-report-day-popover')) return;
        if (event.target && event.target.closest('.table-report-heatmap-cell')) return;
        closeDayPopover();
      });

      setTimeout(syncTrendScrollbar, 0);
      setTimeout(syncTrendScrollbar, 120);

      wrap.appendChild(trend);
      wrap.appendChild(heatmap);
      return wrap;
    };

    const saveModalDaySnapshot = async (dayId, modal) => {
      if (!dayId || !modal) return;
      const target = findEditTargetById(dayId);
      if (!target) return;

      const day = createDayFromTarget(target);
      const modalText = modal.textContent || '';
      const isNoInput = /工数合計[:：]\s*入力がありません/.test(modalText);
      day.skippedNoInput = isNoInput;
      if (!isNoInput) {
        day.entries = extractModalRows(modal);
        day.modalTotalText = extractModalTotalText(modal);
      } else {
        day.entries = [];
        day.modalTotalText = '入力がありません';
      }
      day.mismatchFlag = deriveDayMismatchFlag(day);
      day.signature = buildDaySignature(day);
      await upsertDayIntoCache(day);
    };

    const buildProjectSummaryRows = (data) => {
      const entries = Object.entries(data.aggregates.projectTotals || {})
        .sort((a, b) => b[1] - a[1]);

      const maxMinutes = entries.length ? entries[0][1] : 0;
      const total = Math.max(1, data.aggregates.grandTotalMinutes || 0);

      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'table-report-empty';
        empty.textContent = '対象データがありません';
        return empty;
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'table-report-project-list';

      const escapeXml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

      const sanitizeFileName = (value) => String(value || 'project')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 60) || 'project';

      const downloadProjectDailySvg = (projectName, byDay) => {
        if (!byDay.length) {
          if (typeof window.showNotification === 'function') {
            window.showNotification('ダウンロード対象の日別データがありません');
          }
          return;
        }

        const chartWidth = 820;
        const chartHeight = 420;
        const margin = { top: 74, right: 30, bottom: 110, left: 58 };
        const plotWidth = chartWidth - margin.left - margin.right;
        const plotHeight = chartHeight - margin.top - margin.bottom;
        const maxMinutes = Math.max(...byDay.map((itemDay) => itemDay.minutes), 1);
        const step = plotWidth / Math.max(byDay.length, 1);
        const barWidth = Math.max(10, Math.min(42, Math.floor(step * 0.55)));

        const gridLines = [0, 0.25, 0.5, 0.75, 1].map((pct) => {
          const y = margin.top + Math.round(plotHeight * pct);
          return `<line x1="${margin.left}" y1="${y}" x2="${chartWidth - margin.right}" y2="${y}" stroke="#d7dde6" stroke-width="1" />`;
        }).join('');

        const bars = byDay.map((itemDay, idx) => {
          const h = Math.max(2, Math.round((itemDay.minutes / maxMinutes) * plotHeight));
          const x = Math.round(margin.left + idx * step + (step - barWidth) / 2);
          const y = margin.top + (plotHeight - h);
          const date = escapeXml(itemDay.date);
          const time = formatMinutesToHHMM(itemDay.minutes);
          return `
            <rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="4" fill="#3c73f5" />
            <text x="${x + barWidth / 2}" y="${y - 8}" text-anchor="middle" font-size="11" fill="#1f2937">${time}</text>
            <text x="${x + barWidth / 2}" y="${margin.top + plotHeight + 20}" text-anchor="middle" font-size="11" fill="#475569">${date}</text>
          `;
        }).join('');

        const totalMinutes = byDay.reduce((sum, itemDay) => sum + itemDay.minutes, 0);
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}">
  <rect width="100%" height="100%" fill="#ffffff" />
  <text x="${margin.left}" y="34" font-size="20" font-weight="700" fill="#0f172a">プロジェクト日別工数</text>
  <text x="${margin.left}" y="58" font-size="13" fill="#334155">${escapeXml(projectName)} / 合計 ${formatMinutesToHHMM(totalMinutes)}</text>
  ${gridLines}
  <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${chartWidth - margin.right}" y2="${margin.top + plotHeight}" stroke="#94a3b8" stroke-width="1.2" />
  ${bars}
  <text x="${margin.left}" y="${chartHeight - 16}" font-size="11" fill="#64748b">Generated at ${escapeXml(new Date().toLocaleString('ja-JP'))}</text>
</svg>`;

        const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `project-daily-hours-${sanitizeFileName(projectName)}.svg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };

      const downloadProjectDailyCsv = (projectName, byDay) => {
        if (!byDay.length) {
          if (typeof window.showNotification === 'function') {
            window.showNotification('ダウンロード対象の日別データがありません');
          }
          return;
        }

        const escapeCsv = (value) => {
          const text = String(value ?? '');
          if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
          return text;
        };

        const rows = [
          ['project', 'date', 'minutes', 'hhmm']
        ];

        byDay.forEach((itemDay) => {
          rows.push([
            projectName,
            itemDay.date,
            String(itemDay.minutes),
            formatMinutesToHHMM(itemDay.minutes)
          ]);
        });

        const csv = `${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}\n`;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `project-daily-hours-${sanitizeFileName(projectName)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };

      entries.forEach(([name, minutes]) => {
        const item = document.createElement('div');
        item.className = 'table-report-project-item';

        const top = document.createElement('div');
        top.className = 'table-report-project-top';

        const label = document.createElement('div');
        label.className = 'table-report-project-name';
        label.textContent = name;

        const value = document.createElement('div');
        value.className = 'table-report-project-value';
        const pct = Math.round((minutes / total) * 100);
        value.textContent = `${formatMinutesToHHMM(minutes)} (${pct}%)`;

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'table-report-project-toggle';
        toggleBtn.textContent = '詳細';

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'table-report-project-download';
        downloadBtn.textContent = 'SVG';

        const downloadCsvBtn = document.createElement('button');
        downloadCsvBtn.type = 'button';
        downloadCsvBtn.className = 'table-report-project-download';
        downloadCsvBtn.textContent = 'CSV';

        const byDay = data.days.map((day) => {
          const dayMinutes = day.entries
            .filter((entry) => (entry.project || '(プロジェクト未選択)') === name)
            .reduce((sum, entry) => sum + (Number.isFinite(entry.minutesValue) ? entry.minutesValue : 0), 0);
          return {
            date: day.dateText || `ID ${day.id}`,
            minutes: dayMinutes
          };
        }).filter((itemDay) => itemDay.minutes > 0);

        downloadBtn.addEventListener('click', () => {
          downloadProjectDailySvg(name, byDay);
        });
        downloadCsvBtn.addEventListener('click', () => {
          downloadProjectDailyCsv(name, byDay);
        });

        const actions = document.createElement('div');
        actions.className = 'table-report-project-actions';
        actions.appendChild(downloadBtn);
        actions.appendChild(downloadCsvBtn);
        actions.appendChild(toggleBtn);

        top.appendChild(label);
        top.appendChild(value);
        top.appendChild(actions);

        const barWrap = document.createElement('div');
        barWrap.className = 'table-report-project-bar';
        const bar = document.createElement('div');
        bar.className = 'table-report-project-bar-fill';
        const widthPct = maxMinutes ? Math.max(5, Math.round((minutes / maxMinutes) * 100)) : 0;
        bar.style.width = `${widthPct}%`;
        barWrap.appendChild(bar);

        const detail = document.createElement('div');
        detail.className = 'table-report-project-detail';

        const chartWrap = document.createElement('div');
        chartWrap.className = 'table-report-project-day-chart';

        if (!byDay.length) {
          const empty = document.createElement('div');
          empty.className = 'table-report-empty';
          empty.textContent = 'このプロジェクトの日別データはありません';
          chartWrap.appendChild(empty);
        } else {
          const maxDayMinutes = Math.max(...byDay.map((itemDay) => itemDay.minutes), 1);
          byDay.forEach((itemDay) => {
            const col = document.createElement('div');
            col.className = 'table-report-vbar-col';
            const barBox = document.createElement('div');
            barBox.className = 'table-report-vbar-box';
            const barFill = document.createElement('div');
            barFill.className = 'table-report-vbar-fill';
            barFill.style.height = `${Math.max(6, Math.round((itemDay.minutes / maxDayMinutes) * 100))}%`;
            barBox.appendChild(barFill);
            const lbl = document.createElement('div');
            lbl.className = 'table-report-vbar-label';
            lbl.textContent = itemDay.date;
            const val = document.createElement('div');
            val.className = 'table-report-vbar-value';
            val.textContent = formatMinutesToHHMM(itemDay.minutes);
            col.appendChild(barBox);
            col.appendChild(lbl);
            col.appendChild(val);
            chartWrap.appendChild(col);
          });
        }

        const taskDetail = document.createElement('div');
        taskDetail.className = 'table-report-project-task-detail';
        const taskMap = data.aggregates.taskTotalsByProject[name] || {};
        const taskEntries = Object.entries(taskMap).sort((a, b) => b[1] - a[1]);
        if (!taskEntries.length) {
          const empty = document.createElement('div');
          empty.className = 'table-report-empty';
          empty.textContent = 'タスク内訳はありません';
          taskDetail.appendChild(empty);
        } else {
          const taskTable = document.createElement('table');
          taskTable.className = 'table-report-task-table';
          taskTable.innerHTML = '<thead><tr><th>タスク</th><th>工数</th><th>比率</th></tr></thead>';
          const taskBody = document.createElement('tbody');
          taskEntries.forEach(([taskName, taskMinutes]) => {
            const tr = document.createElement('tr');
            const taskPct = minutes ? Math.round((taskMinutes / minutes) * 100) : 0;
            const tdTask = document.createElement('td');
            tdTask.textContent = taskName;
            const tdMinutes = document.createElement('td');
            tdMinutes.textContent = formatMinutesToHHMM(taskMinutes);
            const tdPct = document.createElement('td');
            tdPct.textContent = `${taskPct}%`;
            tr.appendChild(tdTask);
            tr.appendChild(tdMinutes);
            tr.appendChild(tdPct);
            taskBody.appendChild(tr);
          });
          taskTable.appendChild(taskBody);
          taskDetail.appendChild(taskTable);
        }

        detail.appendChild(chartWrap);
        detail.appendChild(taskDetail);

        const toggleProjectDetail = () => {
          item.classList.toggle('is-open');
          toggleBtn.textContent = item.classList.contains('is-open') ? '閉じる' : '詳細';
        };

        toggleBtn.addEventListener('click', () => {
          toggleProjectDetail();
        });

        top.style.cursor = 'pointer';
        top.setAttribute('role', 'button');
        top.setAttribute('tabindex', '0');
        top.addEventListener('click', (event) => {
          // Skip toggling when clicking action buttons in the header row.
          if (event.target && event.target.closest && event.target.closest('.table-report-project-actions')) return;
          toggleProjectDetail();
        });
        top.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleProjectDetail();
          }
        });

        item.appendChild(top);
        item.appendChild(barWrap);
        item.appendChild(detail);
        wrapper.appendChild(item);
      });

      return wrapper;
    };

    const buildDayDetailRows = (data, onRefetchDay, onApplyDay, optionCatalog) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-report-day-list';

      if (!data.days.length) {
        const empty = document.createElement('div');
        empty.className = 'table-report-empty';
        empty.textContent = '日別データがありません';
        return empty;
      }

      data.days.forEach((day) => {
        const buildEditableDayRow = (entryLike = {}) => {
          const entry = {
            project: entryLike.project || '',
            task: entryLike.task || '',
            minutesValue: Number.isFinite(entryLike.minutesValue) ? entryLike.minutesValue : parseMinutesValue(entryLike.minutesRaw || ''),
            isProjectUnselected: entryLike.isProjectUnselected === true
          };

          const line = document.createElement('div');
          line.className = `table-report-day-row${entry.isProjectUnselected ? ' is-project-unselected' : ''}`;
          const projectCell = document.createElement('div');
          projectCell.className = 'table-report-day-cell table-report-day-project-cell';
          const taskCell = document.createElement('div');
          taskCell.className = 'table-report-day-cell table-report-day-task-cell';
          const minutesCell = document.createElement('div');
          minutesCell.className = 'table-report-day-cell table-report-day-minutes-cell';
          const actionCell = document.createElement('div');
          actionCell.className = 'table-report-day-cell table-report-day-row-action-cell';

          const projectDisplay = document.createElement('div');
          projectDisplay.className = 'table-report-day-project table-report-day-display';
          projectDisplay.textContent = entry.project || '(プロジェクト未選択)';
          const project = createReportSelect(
            'table-report-day-project table-report-day-project-select table-report-day-editor',
            optionCatalog?.projects || [],
            entry.project || '',
            '(プロジェクト未選択)'
          );
          const taskDisplay = document.createElement('div');
          taskDisplay.className = 'table-report-day-task table-report-day-display';
          taskDisplay.textContent = entry.task || '(タスク未選択)';
          const task = createReportSelect(
            'table-report-day-task table-report-day-task-select table-report-day-editor',
            optionCatalog?.tasks || [],
            entry.task || '',
            '(タスク未選択)'
          );
          const minutesDisplay = document.createElement('div');
          minutesDisplay.className = 'table-report-day-minutes table-report-day-display';
          minutesDisplay.textContent = formatMinutesToHHMM(entry.minutesValue);
          const minutes = document.createElement('input');
          minutes.type = 'text';
          minutes.className = 'table-report-day-minutes table-report-day-minutes-input table-report-day-editor';
          minutes.value = formatMinutesToHHMM(entry.minutesValue);
          minutes.placeholder = '00:00';

          projectCell.appendChild(projectDisplay);
          projectCell.appendChild(project);
          taskCell.appendChild(taskDisplay);
          taskCell.appendChild(task);
          minutesCell.appendChild(minutesDisplay);
          minutesCell.appendChild(minutes);
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'table-report-day-row-delete table-report-day-editor table-report-day-icon-btn';
          deleteBtn.setAttribute('aria-label', '行を削除');
          deleteBtn.title = '削除';
          deleteBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M6 1h4l.5 1H14v1H2V2h3.5L6 1Zm-2 4h8l-.7 9H4.7L4 5Zm2 2v5h1V7H6Zm3 0v5h1V7H9Z"/></svg>';
          deleteBtn.addEventListener('click', () => {
            line.remove();
          });
          actionCell.appendChild(deleteBtn);
          line.appendChild(projectCell);
          line.appendChild(taskCell);
          line.appendChild(minutesCell);
          line.appendChild(actionCell);
          return line;
        };

        const card = document.createElement('div');
        card.className = `table-report-day-card${day.mismatchFlag ? ' is-mismatch' : ''}`;
        const originalEntries = Array.isArray(day.entries) ? day.entries.map((entry) => ({ ...entry })) : [];

        const head = document.createElement('div');
        head.className = 'table-report-day-head';
        const dayDateWrap = document.createElement('div');
        dayDateWrap.className = 'table-report-day-date-wrap';
        const dayDate = document.createElement('div');
        dayDate.className = 'table-report-day-date';
        dayDate.textContent = day.dateText || `ID ${day.id}`;
        const dayRefetchBtn = document.createElement('button');
        dayRefetchBtn.type = 'button';
        dayRefetchBtn.className = 'table-report-day-refetch-btn';
        dayRefetchBtn.textContent = '再取得';
        dayRefetchBtn.addEventListener('click', async () => {
          if (typeof onRefetchDay !== 'function') return;
          dayRefetchBtn.disabled = true;
          dayRefetchBtn.textContent = '取得中...';
          try {
            await onRefetchDay(day.id);
          } finally {
            dayRefetchBtn.disabled = false;
            dayRefetchBtn.textContent = '再取得';
          }
        });
        const dayEditBtn = document.createElement('button');
        dayEditBtn.type = 'button';
        dayEditBtn.className = 'table-report-day-edit-btn';
        dayEditBtn.textContent = '編集';
        const dayFooter = document.createElement('div');
        dayFooter.className = 'table-report-day-footer';
        const daySaveBtn = document.createElement('button');
        daySaveBtn.type = 'button';
        daySaveBtn.className = 'table-report-day-save-btn';
        daySaveBtn.textContent = '保存';
        const dayCancelBtn = document.createElement('button');
        dayCancelBtn.type = 'button';
        dayCancelBtn.className = 'table-report-day-cancel-btn';
        dayCancelBtn.textContent = 'キャンセル';
        const dayAddBtn = document.createElement('button');
        dayAddBtn.type = 'button';
        dayAddBtn.className = 'table-report-day-add-btn table-report-day-icon-btn';
        dayAddBtn.title = '追加';
        dayAddBtn.setAttribute('aria-label', '行を追加');
        dayAddBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z"/></svg>';
        const dayActions = document.createElement('div');
        dayActions.className = 'table-report-day-actions';
        dayActions.appendChild(dayRefetchBtn);
        dayActions.appendChild(dayEditBtn);
        dayFooter.appendChild(daySaveBtn);
        dayFooter.appendChild(dayCancelBtn);
        dayFooter.appendChild(dayAddBtn);

        const rows = document.createElement('div');
        rows.className = 'table-report-day-rows';
        const renderRows = (entries = []) => {
          rows.replaceChildren();
          entries.forEach((entry) => {
            rows.appendChild(buildEditableDayRow(entry));
          });
        };
        renderRows(originalEntries);

        dayCancelBtn.addEventListener('click', () => {
          renderRows(originalEntries);
          card.classList.remove('is-editing');
          dayEditBtn.disabled = false;
        });

        dayAddBtn.addEventListener('click', () => {
          if (!card.classList.contains('is-editing')) return;
          const newRow = buildEditableDayRow({
            project: '',
            task: '',
            minutesRaw: '',
            minutesValue: 0,
            isProjectUnselected: false
          });
          rows.appendChild(newRow);
        });

        dayEditBtn.addEventListener('click', () => {
          card.classList.add('is-editing');
          dayEditBtn.disabled = true;
        });

        daySaveBtn.addEventListener('click', async () => {
          if (typeof onApplyDay !== 'function') return;
          const lines = card.querySelectorAll('.table-report-day-row');
          const editedEntries = Array.from(lines).map((line) => ({
            project: (line.querySelector('.table-report-day-project-select')?.value || '').trim(),
            task: (line.querySelector('.table-report-day-task-select')?.value || '').trim(),
            minutesRaw: (line.querySelector('.table-report-day-minutes-input')?.value || '').trim()
          }));

          daySaveBtn.disabled = true;
          daySaveBtn.textContent = '保存中...';
          dayCancelBtn.disabled = true;
          dayAddBtn.disabled = true;
          try {
            const ok = await onApplyDay(day.id, editedEntries);
            if (ok) {
              card.classList.remove('is-editing');
              dayEditBtn.disabled = false;
            }
          } finally {
            daySaveBtn.disabled = false;
            daySaveBtn.textContent = '保存';
            dayCancelBtn.disabled = false;
            dayAddBtn.disabled = false;
          }
        });
        const dayTotal = document.createElement('div');
        dayTotal.className = 'table-report-day-total';
        const hasEntries = Array.isArray(day.entries) && day.entries.length > 0;
        if (hasEntries) {
          dayTotal.textContent = day.modalTotalText || day.dayTotalText || '-';
        } else {
          dayTotal.textContent = '';
          const noData = document.createElement('div');
          noData.className = 'table-report-day-no-data';
          noData.textContent = '入力データなし';
          dayTotal.appendChild(noData);
        }
        dayDateWrap.appendChild(dayDate);
        dayDateWrap.appendChild(dayActions);
        head.appendChild(dayDateWrap);
        head.appendChild(dayTotal);

        card.appendChild(head);
        card.appendChild(rows);
        card.appendChild(dayFooter);
        wrap.appendChild(card);
      });

      return wrap;
    };

    const buildReportMonthTabs = async (activeData, onSelect) => {
      const tabs = document.createElement('div');
      tabs.className = 'table-report-month-tabs';

      const records = await loadAllPersistedReports();
      if (!records.length) return tabs;

      const activeBucket = getCacheBucketFromDataset(activeData) || getCurrentReportCacheBucket();
      const activeParsed = parseBucketMonth(activeBucket);
      records.forEach((record) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'table-report-month-tab';
        tab.textContent = record.label;
        const isActive = record.bucket === activeBucket ||
          (!!record.monthKey && record.monthKey === activeParsed.monthKey);
        if (isActive) tab.classList.add('active');
        tab.addEventListener('click', () => {
          if (isActive) return;
          if (typeof onSelect === 'function') onSelect(record.data);
        });
        tabs.appendChild(tab);
      });

      return tabs;
    };

    const renderReportModal = (data) => {
      if (!data) {
        if (typeof window.showNotification === 'function') {
          window.showNotification('レポートデータを取得できませんでした');
        }
        return;
      }

      closeExistingReportModal();

      const overlay = document.createElement('div');
      overlay.id = 'table-report-modal-overlay';
      overlay.className = 'table-report-modal-overlay';

      const panel = document.createElement('div');
      panel.className = 'table-report-modal';

      const header = document.createElement('div');
      header.className = 'table-report-header';
      header.innerHTML = `
        <div class="table-report-title-wrap">
          <h2 class="table-report-title">工数レポート</h2>
          <div class="table-report-timestamp">更新: ${new Date(data.meta.collectedAt).toLocaleString('ja-JP')}</div>
        </div>
      `;

      const actions = document.createElement('div');
      actions.className = 'table-report-actions';

      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'table-report-action-btn';
      refreshBtn.textContent = '再取得';
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '再取得中...';
        const latest = await collectManHourReportData(true);
        refreshBtn.disabled = false;
        refreshBtn.textContent = '再取得';
        renderReportModal(latest || data);
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'table-report-close-btn';
      closeBtn.textContent = '閉じる';
      closeBtn.addEventListener('click', () => {
        overlay.remove();
        updateButtonVisibility();
      });

      actions.appendChild(refreshBtn);
      actions.appendChild(closeBtn);
      header.appendChild(actions);

      const body = document.createElement('div');
      body.className = 'table-report-body';

      const monthTabsHost = document.createElement('div');
      monthTabsHost.className = 'table-report-month-tabs-host';
      body.appendChild(monthTabsHost);

      buildReportMonthTabs(data, (selectedData) => {
        reportDataCache = selectedData;
        renderReportModal(selectedData);
      }).then((tabs) => {
        monthTabsHost.replaceChildren(tabs);
      });

      const kpis = document.createElement('div');
      kpis.className = 'table-report-kpis';

      const totalMinutes = data.aggregates.grandTotalMinutes || 0;
      const manDaysRaw = totalMinutes / 480;
      const manDays = Number.isFinite(manDaysRaw) ? manDaysRaw.toFixed(2).replace(/\.00$/, '') : '0';
      const projectCount = Object.keys(data.aggregates.projectTotals || {}).length;
      const mismatchDays = (data.days || [])
        .filter((day) => day.mismatchFlag)
        .map((day) => day.dateText || `ID ${day.id}`);
      const mismatchDetail = mismatchDays.length
        ? `${mismatchDays.slice(0, 5).join(' / ')}${mismatchDays.length > 5 ? ` 他${mismatchDays.length - 5}日` : ''}`
        : 'なし';

      const pjUnselectedItems = [];
      (data.days || []).forEach((day) => {
        (day.entries || []).forEach((entry) => {
          if (!entry.isProjectUnselected) return;
          const dateText = day.dateText || `ID ${day.id}`;
          const taskText = entry.task || '(タスク未選択)';
          pjUnselectedItems.push(`${dateText}: ${taskText}`);
        });
      });
      const uniquePjUnselectedItems = Array.from(new Set(pjUnselectedItems));
      const pjUnselectedDetail = uniquePjUnselectedItems.length
        ? `${uniquePjUnselectedItems.slice(0, 4).join(' / ')}${uniquePjUnselectedItems.length > 4 ? ` 他${uniquePjUnselectedItems.length - 4}件` : ''}`
        : 'なし';

      const kpiItems = [
        { label: '合計工数', value: formatMinutesToHHMM(totalMinutes), detail: `${manDays}人日` },
        { label: '工数不一致日', value: String(data.aggregates.mismatchDayCount || 0), detail: mismatchDetail },
        { label: 'PJ未選択', value: String(data.aggregates.unselectedCounts.project || 0), detail: pjUnselectedDetail }
      ];

      kpiItems.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'table-report-kpi-card';
        const label = document.createElement('div');
        label.className = 'table-report-kpi-label';
        label.textContent = item.label;
        const value = document.createElement('div');
        value.className = 'table-report-kpi-value';
        value.textContent = item.value;
        card.appendChild(label);
        card.appendChild(value);
        if (item.detail) {
          const detail = document.createElement('div');
          detail.className = 'table-report-kpi-detail';
          detail.textContent = item.detail;
          card.appendChild(detail);
        }
        kpis.appendChild(card);
      });
      buildDailySummaryKpiItems(data.days || []).forEach((item) => {
        const card = document.createElement('div');
        card.className = 'table-report-kpi-card table-report-kpi-card-visual';
        const label = document.createElement('div');
        label.className = 'table-report-kpi-label';
        label.textContent = item.label;
        const value = document.createElement('div');
        value.className = 'table-report-kpi-value';
        value.textContent = item.value;
        card.appendChild(label);
        card.appendChild(value);
        if (item.detail) {
          const detail = document.createElement('div');
          detail.className = 'table-report-kpi-detail';
          detail.textContent = item.detail;
          card.appendChild(detail);
        }
        kpis.appendChild(card);
      });

      const section1 = document.createElement('section');
      section1.className = 'table-report-section';
      section1.innerHTML = `<h3 class="table-report-section-title">プロジェクト別サマリー（${projectCount}件）</h3>`;
      section1.appendChild(buildProjectSummaryRows(data));

      const section2 = document.createElement('section');
      section2.className = 'table-report-section table-report-section-visual';
      section2.innerHTML = '<h3 class="table-report-section-title">日次サマリー</h3>';
      const optionCatalog = buildReportOptionCatalog(data);
      const handleRefetchDay = async (dayId) => {
        const latest = await refetchDayData(dayId);
        if (latest) {
          renderReportModal(latest);
          if (typeof window.showNotification === 'function') {
            window.showNotification('対象日のデータを再取得しました');
          }
        } else if (typeof window.showNotification === 'function') {
          window.showNotification('対象日の再取得に失敗しました');
        }
      };
      const handleApplyDay = async (dayId, editedEntries) => {
        const latest = await applyDayEditsToWebsite(dayId, editedEntries);
        if (latest) {
          renderReportModal(latest);
          if (typeof window.showNotification === 'function') {
            window.showNotification('対象日の編集内容を反映しました');
          }
          return true;
        } else if (typeof window.showNotification === 'function') {
          window.showNotification('対象日の反映に失敗しました');
        }
        return false;
      };

      section2.appendChild(buildReportVisualSummary(data, {
        renderDayPopoverContent: (day) => {
          const node = buildDayDetailRows({ days: [day] }, handleRefetchDay, handleApplyDay, optionCatalog);
          if (node && node.classList) node.classList.add('is-popover-list');
          return node;
        }
      }));

      body.appendChild(kpis);
      body.appendChild(section2);
      body.appendChild(section1);

      panel.appendChild(header);
      panel.appendChild(body);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove();
          updateButtonVisibility();
        }
      });

      updateButtonVisibility();
    };

    const getReportData = async (forceRefresh = false) => {
      if (!forceRefresh && reportDataCache) {
        const currentBucket = getCurrentReportCacheBucket();
        const cachedBucket = getCacheBucketFromDataset(reportDataCache);
        if (cachedBucket === currentBucket) return reportDataCache;
      }

      if (!forceRefresh) {
        const cached = await loadPersistedReportData();
        if (cached) {
          reportDataCache = cached;
          return reportDataCache;
        }
      }

      return collectManHourReportData(forceRefresh);
    };

    const openReport = async (forceRefresh = false) => {
      const data = await getReportData(forceRefresh);
      renderReportModal(data);
    };

    const createReportLabel = (withReload) => {
      const labelWrap = document.createElement('span');
      labelWrap.className = 'table-filter-label-wrap';

      const text = document.createElement('span');
      text.textContent = 'レポート';
      labelWrap.appendChild(text);

      if (withReload) {
        const reloadIcon = document.createElement('span');
        reloadIcon.id = 'report-reload-icon';
        reloadIcon.className = 'project-reload-icon';
        reloadIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38" /></svg>';
        reloadIcon.addEventListener('click', async (e) => {
          e.stopPropagation();
          reloadIcon.classList.add('spinning');
          await openReport(true);
          reloadIcon.classList.remove('spinning');
        });
        labelWrap.appendChild(reloadIcon);
      }

      return labelWrap;
    };

    const createButton = (filter, isFixed = false) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = isFixed ? `${filter.id}-fixed` : filter.id;
      button.className = 'table-filter-btn';
      button.dataset.filter = filter.key;
      button.title = filter.title;

      if (filter.key === 'report') {
        button.appendChild(createReportLabel(!isFixed));
      } else {
        button.textContent = filter.label;
      }

      button.addEventListener('click', async () => {
        if (filter.key === 'report') {
          await openReport(false);
          return;
        }

        currentFilter = filter.key;
        renderFilterState();
        applyCurrentFilter();
      });

      return button;
    };

    FILTERS.forEach((filter) => {
      const normalButton = createButton(filter, false);
      const fixedButton = createButton(filter, true);
      buttonRefs.normal[filter.key] = normalButton;
      buttonRefs.fixed[filter.key] = fixedButton;
      buttonContainer.appendChild(normalButton);
      fixedButtonContainer.appendChild(fixedButton);
    });

    container.parentNode.insertBefore(buttonContainer, container);
    document.body.appendChild(fixedButtonContainer);

    if (shouldAutoOpenReportFromUrl) {
      clearAutoOpenReportFlagFromUrl();
      setTimeout(async () => {
        try {
          await openReport(false);
        } catch (error) {
          console.error('Auto-open report failed:', error);
        }
      }, 150);
    }

    container.addEventListener('click', (event) => {
      const trigger = event.target && event.target.closest
        ? event.target.closest('.btn.jbc-btn-primary[onclick^="openEditWindow"]')
        : null;
      if (!trigger) return;
      const onclick = trigger.getAttribute('onclick') || '';
      const match = onclick.match(/openEditWindow\((\d+)\)/);
      if (match && match[1]) setLastOpenedRowId(match[1]);
    }, true);

    const setupOpenEditWindowTracking = () => {
      if (window.__jbe_openEditWindowTrackingReady) return;

      const tryWrap = () => {
        if (typeof window.openEditWindow !== 'function') return false;
        if (window.__jbe_openEditWindowTrackingReady) return true;

        const original = window.openEditWindow;
        window.openEditWindow = function(...args) {
          if (args.length > 0 && args[0] !== undefined && args[0] !== null) {
            window.__jbe_lastOpenedManHourRowId = String(args[0]);
          }
          return original.apply(this, args);
        };
        window.__jbe_openEditWindowTrackingReady = true;
        return true;
      };

      if (tryWrap()) return;

      const wrapInterval = setInterval(() => {
        if (tryWrap()) clearInterval(wrapInterval);
      }, 400);
    };

    const setupModalDayCacheSync = () => {
      let wasOpen = false;
      let observedModal = null;

      const dayCacheObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') return;
          const modal = mutation.target;
          const isOpen = modal.classList.contains('show');

          if (isOpen) {
            if (!wasOpen) {
              setTimeout(() => captureCurrentModalDay(modal), 140);
              setTimeout(() => captureCurrentModalDay(modal), 520);
            }
            wasOpen = true;
            return;
          }

          if (!isOpen && wasOpen) {
            wasOpen = false;
            if (isCollecting) return;
            const openedId = String(window.__jbe_lastOpenedManHourRowId || '').trim();
            if (!openedId) return;
            saveModalDaySnapshot(openedId, modal).catch(() => {});
          }
        });
      });

      const captureCurrentModalDay = (modal) => {
        if (!modal || isCollecting || !modal.classList.contains('show')) return;
        const openedId = String(window.__jbe_lastOpenedManHourRowId || '').trim();
        if (!openedId) return;
        saveModalDaySnapshot(openedId, modal).catch(() => {});
      };

      const bindModalSaveHooks = (modal) => {
        if (!modal || modal.__jbeDayCacheSaveHooksBound) return;
        modal.__jbeDayCacheSaveHooksBound = 'true';

        // Capture just before the form submits so edited values are not lost.
        modal.addEventListener('submit', () => {
          captureCurrentModalDay(modal);
        }, true);

        // Capture on explicit save/update button clicks in footer.
        modal.addEventListener('click', (event) => {
          const trigger = event.target && event.target.closest
            ? event.target.closest('button, input[type="submit"]')
            : null;
          if (!trigger) return;
          if (trigger.matches('button.close, [data-dismiss="modal"]')) return;
          const onclickText = String(trigger.getAttribute('onclick') || '');
          const isPushSavePrimary = trigger.classList.contains('jbc-btn-primary') &&
            /pushSave\s*\(/.test(onclickText);
          if (isPushSavePrimary) {
            captureCurrentModalDay(modal);
            setTimeout(() => captureCurrentModalDay(modal), 180);
            return;
          }
          const inFooter = !!trigger.closest('.modal-footer, .jbc-modal-footer');
          const isSubmit = (trigger.type || '').toLowerCase() === 'submit';
          if (!inFooter && !isSubmit) return;
          captureCurrentModalDay(modal);
        }, true);

        // Capture one step earlier for pushSave buttons.
        modal.addEventListener('pointerdown', (event) => {
          const trigger = event.target && event.target.closest
            ? event.target.closest('.jbc-btn-primary[onclick*="pushSave"]')
            : null;
          if (!trigger) return;
          captureCurrentModalDay(modal);
        }, true);
      };

      const attachObserver = () => {
        const modal = document.getElementById('man-hour-manage-modal');
        if (!modal || modal === observedModal) return false;
        dayCacheObserver.disconnect();
        observedModal = modal;
        dayCacheObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
        bindModalSaveHooks(modal);
        return true;
      };

      if (typeof window.__jbe_startManagedInterval === 'function') {
        window.__jbe_startManagedInterval('watch:table-filter-day-cache-modal', () => {
          attachObserver();
        }, 500);
      } else {
        setInterval(() => {
          attachObserver();
        }, 500);
      }
    };

    setupOpenEditWindowTracking();
    setupModalDayCacheSync();

    const renderFilterState = () => {
      ['normal', 'fixed'].forEach((scope) => {
        Object.entries(buttonRefs[scope]).forEach(([key, button]) => {
          const isActive = key !== 'report' && key === currentFilter;
          button.classList.toggle('active', isActive);
          button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
      });
    };

    const applyFilterRows = (rows, predicate) => {
      rows.forEach((row) => {
        if (row.querySelector('th')) {
          row.style.display = '';
          return;
        }
        row.style.display = predicate(row) ? '' : 'none';
      });
    };

    const applyCurrentFilter = () => {
      const rows = container.querySelectorAll('tr');
      if (!rows.length) return;

      if (currentFilter === 'all') {
        applyFilterRows(rows, () => true);
        return;
      }

      if (currentFilter === 'danger') {
        applyFilterRows(rows, (row) => row.classList.contains('jbc-table-danger'));
      }
    };

    let buttonContainerPosition = buttonContainer.getBoundingClientRect().top;

    const updateInitialPosition = () => {
      buttonContainerPosition = buttonContainer.getBoundingClientRect().top + window.scrollY;
    };

    const isAnyManagedModalOpen = () => {
      const jobcanModal = document.getElementById('man-hour-manage-modal');
      const jobcanOpen = !!(jobcanModal && jobcanModal.classList.contains('show'));
      const reportOpen = !!document.getElementById('table-report-modal-overlay');
      return jobcanOpen || reportOpen;
    };

    const updateButtonVisibility = () => {
      const hide = isAnyManagedModalOpen();
      buttonContainer.style.display = hide ? 'none' : 'flex';
      fixedButtonContainer.style.display = hide ? 'none' : (isFixedVisible ? 'flex' : 'none');
    };

    const updateFixedVisibility = () => {
      const shouldFix = window.scrollY > buttonContainerPosition;
      if (shouldFix === isFixedVisible) {
        updateButtonVisibility();
        return;
      }
      isFixedVisible = shouldFix;
      updateButtonVisibility();
    };

    let isSyncingSearchResultTotals = false;
    const syncSearchResultManHourTotalsSafely = () => {
      if (isSyncingSearchResultTotals) return;
      isSyncingSearchResultTotals = true;
      try {
        syncSearchResultManHourTotals();
      } finally {
        isSyncingSearchResultTotals = false;
      }
    };

    updateInitialPosition();
    setTimeout(updateInitialPosition, 500);
    syncSearchResultManHourTotalsSafely();
    renderFilterState();
    applyCurrentFilter();

    window.addEventListener('resize', updateInitialPosition);
    window.addEventListener('scroll', updateFixedVisibility);

    const tableObserver = new MutationObserver(() => {
      syncSearchResultManHourTotalsSafely();
    });
    tableObserver.observe(container, {
      childList: true,
      characterData: true,
      subtree: true
    });

    const modalObserver = new MutationObserver(() => {
      updateButtonVisibility();
    });

    if (typeof window.__jbe_registerManagedObserver === 'function') {
      window.__jbe_registerManagedObserver('watch:table-filter-modal', modalObserver);
    }

    if (typeof window.__jbe_startManagedInterval === 'function') {
      window.__jbe_startManagedInterval('watch:table-filter-modal-find', ({ stop }) => {
        const modal = document.getElementById('man-hour-manage-modal');
        if (!modal) return;
        stop();
        modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
        updateButtonVisibility();
      }, 500, { maxRuns: 120 });
    } else {
      let attempts = 0;
      const checkForModal = setInterval(() => {
        attempts += 1;
        const modal = document.getElementById('man-hour-manage-modal');
        if (modal) {
          clearInterval(checkForModal);
          modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
          updateButtonVisibility();
        } else if (attempts >= 120) {
          clearInterval(checkForModal);
        }
      }, 500);
    }
  }
}

// Expose function globally
window.setupTableFilterButtons = setupTableFilterButtons;
