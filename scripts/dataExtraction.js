// scripts/dataExtraction.js

// // Variable for notification throttling - Moved to utils.js
// let lastNotificationTime = 0;

// // Show notification toast message - Moved to utils.js
// function showNotification(message, duration = 3000) { ... }

function extractAttendanceDataFromCollapseInfo(collapseInfo, options = {}) {
  const { logPrefix = '' } = options;
  const tables = collapseInfo.querySelectorAll('table.table.jbc-table.jbc-table-fixed.info-contents');

  const workTimeData = {};
  const userInfoData = {};
  let hasWorkTimeData = false;
  let hasUserInfoData = false;

  tables.forEach((table, tableIndex) => {
    const rows = table.querySelectorAll('tbody tr');
    if (logPrefix) {
      console.log(`${logPrefix}Table ${tableIndex + 1} has ${rows.length} rows`);
    }

    const cardBody = table.closest('.card-body, .jbc-card-body');
    if (!cardBody) return;

    const card = cardBody.closest('.card, .jbc-card');
    if (!card) return;

    const cardHeader = card.querySelector('.card-header, .jbc-card-header');
    const headerText = cardHeader ? cardHeader.textContent.trim() : '';
    const isUserInfo = headerText.includes('ユーザー情報');
    let paidLeaveDetails = [];

    rows.forEach((row) => {
      const labelElement = row.querySelector('th.jbc-text-sub');
      const valueElement = row.querySelector('td span.info-content');
      if (!labelElement || !valueElement) return;

      const labelText = labelElement.textContent.trim();
      const valueText = valueElement.textContent.trim();

      if (isUserInfo) {
        userInfoData[labelText] = valueText;
        hasUserInfoData = true;
        if (logPrefix) console.log(`${logPrefix}Extracted user info: ${labelText} = ${valueText}`);

        if (labelText === '有休日数') {
          const subTextElements = row.querySelectorAll('td .jbc-text-sub');
          if (subTextElements.length > 0) {
            paidLeaveDetails = Array.from(subTextElements).map((el) => el.textContent.trim());
          }
        }
      } else {
        workTimeData[labelText] = valueText;
        hasWorkTimeData = true;
        if (logPrefix) console.log(`${logPrefix}Extracted work time: ${labelText} = ${valueText}`);
      }
    });

    if (isUserInfo && paidLeaveDetails.length > 0) {
      userInfoData['有休詳細'] = paidLeaveDetails;
      if (logPrefix) console.log(`${logPrefix}Extracted paid leave details:`, paidLeaveDetails);
    }
  });

  return {
    workTimeData,
    userInfoData,
    hasWorkTimeData,
    hasUserInfoData,
    tableCount: tables.length
  };
}

function extractMonthInfo(url, doc) {
  let monthInfo = null;
  try {
    const urlParams = new URL(url).searchParams;
    if (urlParams.has('year') && urlParams.has('month')) {
      monthInfo = {
        year: urlParams.get('year'),
        month: urlParams.get('month')
      };
    } else {
      const monthHeader = doc.querySelector('.card-header h5, .jbc-card-header h5');
      if (monthHeader) {
        const headerText = monthHeader.textContent.trim();
        const match = headerText.match(/(\d{4})年(\d{1,2})月/);
        if (match) {
          monthInfo = { year: match[1], month: match[2] };
        }
      }
    }
  } catch (error) {
    console.error('Error extracting month info:', error);
  }
  return monthInfo;
}

function normalizePunchDate(rawDate, monthInfo) {
  if (!rawDate) return '';
  const trimmed = rawDate.trim();

  const ymdMatch = trimmed.match(/(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (ymdMatch) {
    const y = ymdMatch[1];
    const m = ymdMatch[2].padStart(2, '0');
    const d = ymdMatch[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const mdMatch = trimmed.match(/(\d{1,2})[/.-](\d{1,2})/);
  if (mdMatch && monthInfo && monthInfo.year) {
    const y = String(monthInfo.year);
    const m = mdMatch[1].padStart(2, '0');
    const d = mdMatch[2].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return trimmed;
}

function getSelectedDateFromModifyPage(doc, fallbackMonthInfo = null) {
  const selectYear = doc.querySelector('select[name*="year"], select#year');
  const selectMonth = doc.querySelector('select[name*="month"], select#month');
  const selectDay = doc.querySelector('select[name*="day"], select#day');
  const inputDate = doc.querySelector('input[type="date"]');

  if (inputDate && inputDate.value) {
    const dateValue = inputDate.value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return dateValue;
  }

  const year = (selectYear && selectYear.value) || (fallbackMonthInfo && fallbackMonthInfo.year) || '';
  const month = (selectMonth && selectMonth.value) || (fallbackMonthInfo && fallbackMonthInfo.month) || '';
  const day = (selectDay && selectDay.value) || '';

  if (!year || !month || !day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractPunchListFromDocument(doc, monthInfo) {
  const selectedDate = getSelectedDateFromModifyPage(doc, monthInfo);
  const punchEntries = [];
  const aditCard = Array.from(doc.querySelectorAll('.card, .jbc-card')).find((card) => {
    const title = card.querySelector('.card-header, .jbc-card-header');
    return title && title.textContent && title.textContent.includes('打刻一覧');
  });

  const rowSelector = aditCard
    ? 'table tbody tr'
    : 'table tr';
  const rows = aditCard ? aditCard.querySelectorAll(rowSelector) : doc.querySelectorAll(rowSelector);

  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (!cells.length) return;

    const rowText = row.textContent ? row.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!rowText || !/入室|退室|出勤|退勤|休憩|打刻/.test(rowText)) return;

    const typeCellText = (cells[0]?.textContent || '').replace(/\s+/g, ' ').trim();
    const timeCellText = (cells[1]?.textContent || '').replace(/\s+/g, ' ').trim();

    const timesFromCell = timeCellText.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g) || [];
    const timesFromRow = rowText.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g) || [];
    const times = timesFromCell.length ? timesFromCell : timesFromRow;
    if (times.length === 0) return;

    const dateMatch =
      rowText.match(/(\d{4}[/.-]\d{1,2}[/.-]\d{1,2})/) ||
      rowText.match(/(\d{1,2}[/.-]\d{1,2})/);
    const normalizedDate = normalizePunchDate(dateMatch ? dateMatch[1] : selectedDate, monthInfo);

    let type = '';
    if (typeCellText.includes('入室') || rowText.includes('入室')) type = '入室';
    else if (typeCellText.includes('退室') || rowText.includes('退室')) type = '退室';
    else if (typeCellText.includes('出勤') || rowText.includes('出勤')) type = '出勤';
    else if (typeCellText.includes('退勤') || rowText.includes('退勤')) type = '退勤';
    else if (typeCellText.includes('休憩') || rowText.includes('休憩')) type = '休憩';
    else if (rowText.includes('打刻')) type = '打刻';

    times.forEach((time) => {
      punchEntries.push({
        date: normalizedDate,
        time,
        type,
        source: '打刻修正'
      });
    });
  });

  return punchEntries;
}

function buildPunchListCandidateUrls(monthInfo) {
  const base = 'https://ssl.jobcan.jp';
  const query = monthInfo && monthInfo.year && monthInfo.month
    ? `?search_type=month&year=${encodeURIComponent(monthInfo.year)}&month=${encodeURIComponent(monthInfo.month)}`
    : '';

  return [
    `${base}/employee/adit/modify/`,
    `${base}/employee/attendance/adit${query}`,
    `${base}/employee/attendance/edit${query}`,
    `${base}/employee/adit${query}`,
    `${base}/employee/attendance?list_type=adit${query ? `&${query.replace(/^\?/, '')}` : ''}`
  ];
}

// Fetch a Jobcan page and hand back a detached, parsed Document.
//
// This replaces the hidden <iframe> both loaders below used to use. An iframe
// meant a *full page load* — every stylesheet, script and image, plus Jobcan's
// own JS executing — followed by a fixed 1.5–2s sleep to "wait for dynamic
// content", with a 25–30s timeout on top; the punch loader multiplied that by
// five candidate URLs, so the worst case was ~2 minutes of invisible navigation
// on every dashboard load.
//
// Measured on a real account: everything these functions read is server-rendered
// into the initial HTML, so a plain fetch + DOMParser gets it with no rendering
// at all — ~770ms for the attendance page (27 rows across 4 tables) and ~230ms
// for 打刻一覧. DOMParser also cannot run scripts, so the parsed document is
// inert by construction.
const PAGE_FETCH_TIMEOUT_MS = 15000;

async function fetchJobcanDocument(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
  } finally {
    clearTimeout(timer);
  }
}

async function loadPunchListData(monthInfo = null) {
  const urls = buildPunchListCandidateUrls(monthInfo);
  let lastError = null;

  // Candidates are tried in order. The first (/employee/adit/modify/) is the one
  // that actually answers today; the rest are cheap fallbacks now that a miss
  // costs one fetch rather than one iframe load.
  for (const url of urls) {
    try {
      const doc = await fetchJobcanDocument(url);
      const resolvedMonthInfo = monthInfo || extractMonthInfo(url, doc);
      const entries = extractPunchListFromDocument(doc, resolvedMonthInfo);
      if (!entries.length) throw new Error(`No punch entries found: ${url}`);

      await chrome.storage.local.set({
        jobcanPunchListData: {
          monthInfo: resolvedMonthInfo || null,
          entries,
          sourceUrl: url,
          fetchedAt: Date.now()
        }
      });

      return { entries, monthInfo: resolvedMonthInfo || null, sourceUrl: url };
    } catch (error) {
      lastError = error;
      console.debug('Punch list fetch attempt failed:', error.message || error);
    }
  }

  throw lastError || new Error('Unable to fetch punch list data');
}

// Serialized snapshot of the last values actually written to storage. main.js
// calls extractAndStoreCollapseInfoData() on every applyEnhancements() pass —
// which the debounced body observer re-triggers roughly once a second during DOM
// churn — so without this the same unchanged payload was re-written to
// chrome.storage.local over and over.
let lastPersistedCollapseSnapshot = '';

// Extract and store collapseInfo data
async function extractAndStoreCollapseInfoData() {
  const collapseInfo = document.getElementById('collapseInfo');
  if (!collapseInfo) return;
  
  // Log that we're attempting to extract data
  console.log('Extracting work time data from #collapseInfo');
  
  // Find all tables within the collapseInfo section
  const tables = collapseInfo.querySelectorAll('table.table.jbc-table.jbc-table-fixed.info-contents');
  if (!tables.length) {
    console.log('No matching tables found in #collapseInfo');
    return;
  }
  
  console.log(`Found ${tables.length} tables to extract data from`);
  const {
    workTimeData,
    userInfoData,
    hasWorkTimeData,
    hasUserInfoData
  } = extractAttendanceDataFromCollapseInfo(collapseInfo);
  
  // Only save if we have data
  if (hasWorkTimeData || hasUserInfoData) {
    const snapshot = JSON.stringify({ workTimeData, userInfoData });
    if (snapshot === lastPersistedCollapseSnapshot) return; // nothing changed since the last write
    lastPersistedCollapseSnapshot = snapshot;

    try {
      // Store using chrome.storage.local
      if (hasWorkTimeData) {
        await chrome.storage.local.set({ 'jobcanWorkTimeData': workTimeData });
        console.log('Work time data saved:', workTimeData);
      }
      
      if (hasUserInfoData) {
        await chrome.storage.local.set({ 'jobcanUserInfoData': userInfoData });
        console.log('User info data saved:', userInfoData);
      }
      
      // Show brief notification that data has been saved - Use global notification
      const currentTime = Date.now();
      const isAttendancePage = window.location.href.indexOf('https://ssl.jobcan.jp/employee/attendance') === 0;
      
      if (isAttendancePage && (hasWorkTimeData || hasUserInfoData) && (currentTime - window.lastNotificationTime > 10000)) {
        window.lastNotificationTime = currentTime;
        if (typeof window.showNotification === 'function') {
          window.showNotification('勤怠データが保存されました');
        }
      }
    } catch (error) {
      console.error('Error saving data:', error);
    }
  } else {
    console.log('No data found to save');
  }
}

// Evict old month-keyed work-time snapshots. Jobcan data for past months is
// effectively immutable, but `jobcanWorkTimeData_<year>_<month>` keys were
// accumulating in chrome.storage.local without bound and never expiring. Keep
// only the most recent N months.
async function pruneOldWorkTimeData(keepMonths = 13) {
  try {
    const all = await chrome.storage.local.get(null);
    const monthKeys = Object.keys(all).filter(k => /^jobcanWorkTimeData_\d{4}_\d{1,2}$/.test(k));
    if (monthKeys.length <= keepMonths) return;
    const rank = (k) => {
      const m = k.match(/_(\d{4})_(\d{1,2})$/);
      return m ? Number(m[1]) * 12 + Number(m[2]) : 0;
    };
    const toRemove = monthKeys.sort((a, b) => rank(b) - rank(a)).slice(keepMonths);
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch (error) {
    console.debug('pruneOldWorkTimeData skipped:', error && error.message);
  }
}

// Fetch the attendance page and extract the work-time / user-info summary.
// Same return shape as before: { workTimeData, userInfoData, monthInfo, punchListData }.
async function loadAttendanceData(url = 'https://ssl.jobcan.jp/employee/attendance') {
  let loadingNotification = null;
  if (typeof window.showNotification === 'function') {
    loadingNotification = window.showNotification('データを取得中...', 0); // 0 = no auto-hide
  }

  try {
    const doc = await fetchJobcanDocument(url);

    const collapseInfo = doc.getElementById('collapseInfo');
    if (!collapseInfo) throw new Error('No #collapseInfo in the fetched attendance page');

    const {
      workTimeData,
      userInfoData,
      hasWorkTimeData,
      hasUserInfoData,
      tableCount
    } = extractAttendanceDataFromCollapseInfo(collapseInfo);

    if (!tableCount) throw new Error('No info tables in the fetched attendance page');
    if (!hasWorkTimeData && !hasUserInfoData) throw new Error('No data found in the fetched attendance page');

    const monthInfo = extractMonthInfo(url, doc);

    if (hasWorkTimeData) {
      if (monthInfo) workTimeData._monthInfo = monthInfo;
      const storageKey = monthInfo
        ? `jobcanWorkTimeData_${monthInfo.year}_${monthInfo.month}`
        : 'jobcanWorkTimeData';
      await chrome.storage.local.set({ [storageKey]: workTimeData });
      // Also save to the default key for immediate display.
      await chrome.storage.local.set({ jobcanWorkTimeData: workTimeData });
      // Evict stale month snapshots so storage doesn't grow without bound.
      pruneOldWorkTimeData();
    }

    if (hasUserInfoData) {
      await chrome.storage.local.set({ jobcanUserInfoData: userInfoData });
    }

    // Also refresh the punch list (打刻一覧) for the work-progress markers.
    // Non-fatal: the summary above is still worth returning without it.
    try {
      await loadPunchListData(monthInfo);
    } catch (error) {
      console.debug('Punch list fetch skipped:', error.message || error);
    }

    if (loadingNotification) loadingNotification.remove();
    if (typeof window.showNotification === 'function') window.showNotification('勤怠データが取得されました');

    const punchResult = await chrome.storage.local.get(['jobcanPunchListData']);
    return {
      workTimeData,
      userInfoData,
      monthInfo,
      punchListData: punchResult.jobcanPunchListData || null
    };
  } catch (error) {
    if (loadingNotification) loadingNotification.remove();
    if (typeof window.showNotification === 'function') {
      window.showNotification(error.name === 'AbortError'
        ? 'データ取得がタイムアウトしました'
        : 'データ取得に失敗しました');
    }
    console.error('Error fetching attendance data:', error);
    throw error;
  }
}

// Setup observer to watch for #collapseInfo visibility and extract data
function setupCollapseInfoObserver() {
  if (window.__jbe_collapseInfoObserverInited) return;
  window.__jbe_collapseInfoObserverInited = true;

  // Prevent multiple initializations
  if (document.body.dataset.collapseObserverSetup === 'true') {
    return;
  }
  document.body.dataset.collapseObserverSetup = 'true';
  
  // Check if we're on the attendance page
  const isAttendancePage = window.location.href.indexOf('https://ssl.jobcan.jp/employee/attendance') === 0;
  
  // Create a debounce function to avoid rapid firing
  let debounceTimer;
  const debounce = (callback, time) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(callback, time);
  };
  
  // Create the observer
  const observer = new MutationObserver(() => {
    const collapseInfo = document.getElementById('collapseInfo');
    if (collapseInfo && collapseInfo.offsetParent !== null) { // Check if visible
      debounce(() => {
        extractAndStoreCollapseInfoData();
      }, 500); // 500ms debounce
    }
  });
  
  // Start observing
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  // Page-scoped: torn down on SPA navigation. The cleanup callback clears both
  // guards so applyEnhancements() can re-create it on the next attendance page.
  if (typeof window.__jbe_registerManagedObserver === 'function') {
    window.__jbe_registerManagedObserver('watch:collapseInfoData', observer, () => {
      window.__jbe_collapseInfoObserverInited = false;
      if (document.body) delete document.body.dataset.collapseObserverSetup;
    });
  }

  // Also extract data if collapseInfo already exists
  const collapseInfo = document.getElementById('collapseInfo');
  if (collapseInfo && collapseInfo.offsetParent !== null) {
    // On the attendance page, wait a bit longer to ensure the data is fully loaded
    if (isAttendancePage) {
      setTimeout(() => {
        extractAndStoreCollapseInfoData();
      }, 1000);
    } else {
      extractAndStoreCollapseInfoData();
    }
  }
  
  // If on attendance page, check periodically for the collapse info section.
  // Runs through the managed-interval registry (`watch:` prefix) so an SPA
  // navigation stops it; previously this was a bare setInterval that only ever
  // cleared itself on success or after its 10th tick.
  if (isAttendancePage && typeof window.__jbe_startManagedInterval === 'function') {
    window.__jbe_startManagedInterval('watch:collapseInfoPoll', (ctx) => {
      const el = document.getElementById('collapseInfo');
      if (el && el.offsetParent !== null) {
        extractAndStoreCollapseInfoData();
        ctx.stop();
      }
    }, 2000, { maxRuns: 10 }); // Check every 2 seconds, up to 20 seconds total
  }
}

// Expose globally. (These were named *InIframe until the loaders were switched to
// fetch + DOMParser; the names would now be lies.)
window.extractAndStoreCollapseInfoData = extractAndStoreCollapseInfoData;
window.loadAttendanceData = loadAttendanceData;
window.loadPunchListData = loadPunchListData;
window.setupCollapseInfoObserver = setupCollapseInfoObserver;
