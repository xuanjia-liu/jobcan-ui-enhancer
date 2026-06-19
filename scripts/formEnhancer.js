// scripts/formEnhancer.js
//
// Collapse-info enhancement for the attendance / man-hour pages: makes the
// summary cards compact, hides zero-value rows, and adds a per-card
// "全項目を表示 / 必要項目のみ表示" toggle.
//
// NOTE: This file used to also hold the pre-2026 man-hour modal/select
// enhancements (modal→side-panel conversion, select-list categorization, decimal
// hour input, MRU project ordering, table-header simplification, …). Jobcan rebuilt
// the man-hour pages (~2026-06) into standalone pages with native autocomplete and
// a REST API, so all of that targeted DOM that no longer exists and was removed in
// the post-rebuild cleanup. The live replacements are in scripts/manHourEdit.js,
// scripts/manHourList.js, scripts/manHourApi.js and scripts/manHourEditSearch.js.

// Enhance the #collapseInfo summary section (attendance + man-hour pages).
function enhanceCollapseInfo() {
  if (window.__jbe_enhanceCollapseInfoInited) return;
  window.__jbe_enhanceCollapseInfoInited = true;
  const observer = new MutationObserver(() => {
    const collapseInfo = document.getElementById('collapseInfo');
    if (collapseInfo && !collapseInfo.dataset.enhanced) {
      collapseInfo.dataset.enhanced = 'true';
      processCollapseInfo(collapseInfo);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also run immediately if collapseInfo already exists
  const collapseInfo = document.getElementById('collapseInfo');
  if (collapseInfo && !collapseInfo.dataset.enhanced) {
    collapseInfo.dataset.enhanced = 'true';
    processCollapseInfo(collapseInfo);
  }
}

// Handle the logic for enhancing collapseInfo
function processCollapseInfo(collapseInfo) {
  // Make cards compact
  collapseInfo.querySelectorAll('.card, .jbc-card').forEach(c => c.classList.add('compact-card'));

  // Remove existing buttons first to avoid duplicates on re-run
  collapseInfo.querySelectorAll('.toggle-zero-values-btn').forEach(btn => btn.remove());

  // Process each card individually
  collapseInfo.querySelectorAll('.card, .jbc-card, .compact-card').forEach(card => {
    // Find zero value rows in this specific card
    const zeroValueRows = [];
    const tables = card.querySelectorAll('table');
    tables.forEach(table => {
      table.querySelectorAll('tr').forEach(row => {
        const valueCell = row.querySelector('td');
        if (valueCell) {
          const value = valueCell.textContent.trim();
          const isZero = value === '0' || value === '0.0' || value.includes('0 日') || value.includes('0 回') ||
                       value.includes('0時間') || value.includes('0分') || value === '00:00' ||
                       /^[0]+$/.test(value.replace(/[^0-9]/g, ''));
          if (isZero) {
            row.classList.add('zero-value-row');
            zeroValueRows.push(row);
          } else {
            row.classList.remove('zero-value-row'); // Ensure class is removed if value changes
          }
        }
      });
    });

    // Hide zero value rows initially in this card
    zeroValueRows.forEach(row => {
      row.style.display = 'none';
    });

    // Add toggle button to this card's header if it has zero value rows
    if (zeroValueRows.length > 0) {
      const header = card.querySelector('.card-header, .jbc-card-header');
      if (header) {
        // Create the toggle button
        const toggleButton = document.createElement('button');
        toggleButton.className = 'toggle-zero-values-btn';
        toggleButton.textContent = '全項目を表示';
        toggleButton.setAttribute('type', 'button');

        // Add event listener for this specific button and its card
        toggleButton.addEventListener('click', () => {
          const isShowing = toggleButton.classList.contains('showing');
          const newDisplay = isShowing ? 'none' : 'table-row';
          const newText = isShowing ? '全項目を表示' : '必要項目のみ表示';

          // Toggle only the zero rows within this card
          zeroValueRows.forEach(row => {
            row.style.display = newDisplay;
          });

          // Update only this button's state
          toggleButton.textContent = newText;
          if (isShowing) {
            toggleButton.classList.remove('showing');
          } else {
            toggleButton.classList.add('showing');
          }
        });

        // Append button to header
        header.appendChild(toggleButton);
      }
    }
  });
}
