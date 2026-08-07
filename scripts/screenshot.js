// scripts/screenshot.js

// html2canvas (~220KB) is no longer loaded as a content script on every Jobcan
// page — the background worker injects it into this same isolated world the first
// time a capture is actually requested. Resolves true once `html2canvas` is
// callable. A failed load is not cached, so a later attempt can retry.
let html2canvasLoader = null;
function ensureHtml2Canvas() {
  if (typeof html2canvas === 'function') return Promise.resolve(true);
  if (html2canvasLoader) return html2canvasLoader;

  html2canvasLoader = new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'ensureHtml2Canvas' }, (response) => {
        const ok = !chrome.runtime.lastError
          && response && response.success
          && typeof html2canvas === 'function';
        if (!ok) html2canvasLoader = null;
        resolve(ok);
      });
    } catch (error) {
      console.error('Failed to request html2canvas injection:', error);
      html2canvasLoader = null;
      resolve(false);
    }
  });

  return html2canvasLoader;
}

function parseTimeTextToMinutes(raw) {
  const text = String(raw || '').trim();
  if (!text) return 0;

  if (/^\d+$/.test(text)) return Math.max(0, parseInt(text, 10));

  const hhmm = text.match(/^(\d{1,4}):(\d{1,2})$/);
  if (hhmm) {
    const hours = parseInt(hhmm[1], 10) || 0;
    const minutes = parseInt(hhmm[2], 10) || 0;
    return Math.max(0, hours * 60 + minutes);
  }

  const jpHourMin = text.match(/(\d+)\s*時間(?:\s*(\d+)\s*分)?/);
  if (jpHourMin) {
    const hours = parseInt(jpHourMin[1], 10) || 0;
    const minutes = parseInt(jpHourMin[2] || '0', 10) || 0;
    return Math.max(0, hours * 60 + minutes);
  }

  const jpMin = text.match(/(\d+)\s*分/);
  if (jpMin) {
    return Math.max(0, parseInt(jpMin[1], 10) || 0);
  }

  return 0;
}

function formatMinutesToHHMM(minutes) {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function getFabState() {
  if (!window.__jbe_fabState) {
    window.__jbe_fabState = {
      root: null,
      mainButton: null,
      actionsWrap: null,
      actions: new Map(),
      isOpen: false
    };
  }
  return window.__jbe_fabState;
}

function closeFloatingActionMenu() {
  const state = getFabState();
  if (!state.root) return;
  state.isOpen = false;
  state.root.classList.remove('open');
  if (state.mainButton) state.mainButton.setAttribute('aria-expanded', 'false');
}

function ensureFloatingActionMenu() {
  const state = getFabState();
  if (state.root && document.body.contains(state.root)) return state;

  const root = document.createElement('div');
  root.id = 'jobcan-fab-menu';

  // Keep this ID for compatibility with existing positioning logic.
  const mainButton = document.createElement('button');
  mainButton.id = 'screenshot-capture-btn';
  mainButton.className = 'jobcan-fab-main';
  mainButton.type = 'button';
  mainButton.title = 'クイックアクション';
  mainButton.setAttribute('aria-label', 'クイックアクション');
  mainButton.setAttribute('aria-expanded', 'false');
  mainButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'jobcan-fab-actions';

  root.appendChild(actionsWrap);
  root.appendChild(mainButton);
  document.body.appendChild(root);

  mainButton.addEventListener('click', (e) => {
    e.stopPropagation();
    state.isOpen = !state.isOpen;
    root.classList.toggle('open', state.isOpen);
    mainButton.setAttribute('aria-expanded', state.isOpen ? 'true' : 'false');
  });

  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) closeFloatingActionMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFloatingActionMenu();
  });

  // (Removed the #man-hour-manage-modal visibility watcher that used to hide this
  // floating menu while that modal was open — the modal no longer exists after the
  // 2026 man-hour rebuild, so the watcher only polled fruitlessly for ~60s.)

  state.root = root;
  state.mainButton = mainButton;
  state.actionsWrap = actionsWrap;
  return state;
}

function registerFloatingAction(options) {
  const state = ensureFloatingActionMenu();
  const { id, title, icon, onClick, order = 100 } = options;
  if (!id || typeof onClick !== 'function') return;

  let actionButton = state.actions.get(id);
  if (!actionButton) {
    actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'jobcan-fab-action';
    actionButton.dataset.actionId = id;
    state.actions.set(id, actionButton);
    state.actionsWrap.appendChild(actionButton);
  }

  actionButton.title = title || '';
  actionButton.setAttribute('aria-label', title || id);
  actionButton.dataset.title = title || id;
  actionButton.dataset.order = String(order);
  actionButton.innerHTML = icon || '';
  actionButton.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeFloatingActionMenu();
    onClick();
  };

  Array.from(state.actionsWrap.children)
    .sort((a, b) => Number(a.dataset.order || 100) - Number(b.dataset.order || 100))
    .forEach((node) => state.actionsWrap.appendChild(node));
}

// Add screenshot capture functionality
function setupScreenshotButton() {
  if (window.__jbe_screenshotButtonSetup) return;
  window.__jbe_screenshotButtonSetup = true;

  registerFloatingAction({
    id: 'capture',
    title: 'スクリーンショット',
    order: 10,
    icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>',
    onClick: initScreenshotCapture
  });
}

// Initialize screenshot capture selection overlay and handlers
function initScreenshotCapture() {
  // Warm the loader while the user is still dragging out a selection, so the
  // injection round-trip is hidden behind their own interaction.
  ensureHtml2Canvas();

  // Store scroll position when starting the capture
  const startScrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const startScrollY = window.pageYOffset || document.documentElement.scrollTop;
  
  // Create overlay for area selection
  const overlay = document.createElement('div');
  overlay.id = 'screenshot-selection-overlay';
  overlay.className = 'screenshot-selection-overlay';
  document.body.appendChild(overlay);
  
  // Create selection area
  const selection = document.createElement('div');
  selection.id = 'screenshot-selection';
  selection.className = 'screenshot-selection';
  selection.style.display = 'none';
  
  // Add span for CSS corners
  const span = document.createElement('span');
  selection.appendChild(span);
  
  overlay.appendChild(selection);

  let isOverlayDisposed = false;

  const cleanupSelectionOverlay = () => {
    if (isOverlayDisposed) return;
    isOverlayDisposed = true;
    document.removeEventListener('keydown', handleEscapeKey);
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  };

  const handleEscapeKey = (e) => {
    if (e.key === 'Escape') cleanupSelectionOverlay();
  };

  document.addEventListener('keydown', handleEscapeKey);
  
  // Variables to track selection
  let startX, startY, isSelecting = false;
  let currentX, currentY;
  
  // Handle mouse down event
  overlay.addEventListener('mousedown', function(e) {
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;
    
    // Position the selection div at the starting point
    selection.style.left = `${startX}px`;
    selection.style.top = `${startY}px`;
    selection.style.width = '0';
    selection.style.height = '0';
    selection.style.display = 'block';
  });
  
  // Handle mouse move event
  overlay.addEventListener('mousemove', function(e) {
    if (!isSelecting) return;
    currentX = e.clientX;
    currentY = e.clientY;
    
    // Calculate width and height of selection
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    // Determine position based on drag direction
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    
    // Update selection div dimensions
    selection.style.left = `${left}px`;
    selection.style.top = `${top}px`;
    selection.style.width = `${width}px`;
    selection.style.height = `${height}px`;
  });
  
  // Handle mouse up event to finalize selection
  overlay.addEventListener('mouseup', function() {
    if (!isSelecting) return;
    isSelecting = false;
    
    const width = parseInt(selection.style.width);
    const height = parseInt(selection.style.height);
    
    if (width > 10 && height > 10) {
      const area = {
        x: parseInt(selection.style.left),
        y: parseInt(selection.style.top),
        w: width,
        h: height,
        scrollX: startScrollX,
        scrollY: startScrollY
      };
      captureScreenshot(area);
    }

    cleanupSelectionOverlay();
  });
}

// Capture screenshot of the selected area and handle preview and clipboard
async function captureScreenshot(area) {
  // Remove the selection overlay before capturing
  const overlay = document.getElementById('screenshot-selection-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }

  const removeOverlay = () => {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  };

  if (!(await ensureHtml2Canvas())) {
    showNotification('スクリーンショット機能を読み込めませんでした。');
    removeOverlay();
    return;
  }

  // Settle any split-flap digit that is mid-flip, so the capture shows whole
  // numerals rather than a leaf frozen part-way through its travel. Dropping
  // `.is-flipping` ends the CSS animation and returns the leaf to 0deg, where its
  // front face matches the static upper half.
  const settleFlipDigits = (root) => {
    root.querySelectorAll('.flip-clock-digit.is-flipping').forEach((digit) => {
      digit.classList.remove('is-flipping');
    });
  };
  settleFlipDigits(document);

  // Drop the clock card's ambient background from the capture (it is purely
  // decorative — see the "Ambient status background" section in css/styles.css).
  // Two reasons: a single frozen frame of a 30s loop is noise in a screenshot, and
  // the layer leans on color-mix() and mask-image, which html2canvas parses itself
  // rather than handing to the browser. Only the clone is touched, so the live page
  // keeps its background while the capture runs.
  const dropAmbientBackground = (root) => {
    root.querySelectorAll('.jbe-clock-bg').forEach((layer) => {
      layer.style.display = 'none';
    });
  };

  // Use html2canvas without window prefix
  html2canvas(document.body, {
    useCORS: true,
    allowTaint: true,
    foreignObjectRendering: true,
    scale: window.devicePixelRatio,
    scrollX: -window.scrollX,
    scrollY: -window.scrollY,
    windowWidth: document.documentElement.offsetWidth,
    windowHeight: document.documentElement.offsetHeight,
    onclone: function(clonedDoc) {
      // A flip can start between the settle above and the clone being taken.
      settleFlipDigits(clonedDoc);
      dropAmbientBackground(clonedDoc);
    }
  }).then(canvas => {
    // Remove the selection overlay — before capture it was only hidden
    // (display:none), and previously it was removed only on the error path,
    // so a successful capture left it orphaned in the DOM.
    removeOverlay();
    // Remove any existing notification
    const notification = document.querySelector('.screenshot-notification');
    if (notification) {
      notification.remove();
    }

    // Crop to the selected area
    const croppedCanvas = document.createElement('canvas');
    const ctx = croppedCanvas.getContext('2d');
    croppedCanvas.width = area.w;
    croppedCanvas.height = area.h;

    const centerX = area.x + (area.w / 2);
    const centerY = area.y + (area.h / 2);
    const elementAtCenter = document.elementFromPoint(centerX, centerY);
    let isFixed = false;
    let el = elementAtCenter;
    while (el && !isFixed) {
      const position = window.getComputedStyle(el).getPropertyValue('position');
      if (position === 'fixed') {
        isFixed = true;
      }
      el = el.parentElement;
    }

    let cropX, cropY;
    if (isFixed) {
      cropX = area.x * window.devicePixelRatio;
      cropY = area.y * window.devicePixelRatio;
    } else {
      cropX = (area.x + area.scrollX) * window.devicePixelRatio;
      cropY = (area.y + area.scrollY) * window.devicePixelRatio;
    }

    ctx.drawImage(
      canvas,
      cropX,
      cropY,
      area.w * window.devicePixelRatio,
      area.h * window.devicePixelRatio,
      0, 0, area.w, area.h
    );

    // Convert to data URL
    const imageData = croppedCanvas.toDataURL('image/png');

    // --- FIX: ClipboardItem feature detection ---
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
      croppedCanvas.toBlob(function(blob) {
        try {
          const item = new ClipboardItem({ 'image/png': blob });
          navigator.clipboard.write([item]).then(
            () => {
              showNotification('スクリーンショットがコピーされました。');
            },
            (err) => {
              console.error('Could not copy to clipboard: ', err);
              showNotification('Could not copy to clipboard. See console for details.');
            }
          );
        } catch (err) {
          console.error('ClipboardItem not supported or other clipboard error: ', err);
          showNotification('Copy to clipboard not supported in this browser.');
        }
      });
    } else {
      showNotification('このブラウザは画像のクリップボードコピーに対応していません。');
    }

    // Show preview with download option
    showScreenshotPreview(imageData);
  })
  .catch(error => {
    console.error('Screenshot capture failed:', error);
    showNotification('キャプチャに失敗しました');
    removeOverlay();
  });
}

// Show a small preview of the captured screenshot with controls
function showScreenshotPreview(imageData, options = {}) {
  const {
    alt = 'Screenshot preview',
    downloadBaseName = 'screenshot',
    extension = 'png',
    downloadNotification = 'Screenshot downloaded',
    autoDownload = false
  } = options;

  // Remove existing preview if any
  const existingPreview = document.getElementById('screenshot-preview-container');
  if (existingPreview) {
    const existingImage = existingPreview.querySelector('.screenshot-preview-image');
    if (existingImage && existingImage.dataset.objectUrl === 'true') {
      URL.revokeObjectURL(existingImage.src);
    }
    existingPreview.remove();
  }
  
  // Create preview container
  const previewContainer = document.createElement('div');
  previewContainer.id = 'screenshot-preview-container';
  
  // Create preview wrapper (for positioning the close button)
  const previewWrapper = document.createElement('div');
  previewWrapper.className = 'preview-wrapper';
  
  // Create image preview
  const previewImage = document.createElement('img');
  previewImage.src = imageData;
  previewImage.alt = alt;
  previewImage.className = 'screenshot-preview-image';
  if (typeof imageData === 'string' && imageData.startsWith('blob:')) {
    previewImage.dataset.objectUrl = 'true';
  }
  
  // Add click event listener to preview image
  previewImage.addEventListener('click', () => {
    showFullSizeImage(imageData);
  });
  
  // Create preview close button
  const previewCloseBtn = document.createElement('button');
  previewCloseBtn.className = 'sidepanel-close';
  previewCloseBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4L4 12M4 4L12 12"/></svg>';
  previewCloseBtn.title = 'Close preview';
  previewCloseBtn.classList.add('screenshot-preview-close');
  
  // Close button click handler
  previewCloseBtn.addEventListener('click', () => {
    previewContainer.classList.add('closing');
    setTimeout(() => {
      if (previewImage.dataset.objectUrl === 'true') {
        URL.revokeObjectURL(previewImage.src);
      }
      if (previewContainer.parentNode) {
        previewContainer.parentNode.removeChild(previewContainer);
      }
    }, 300);
  });
  
  // Add image and close button to wrapper
  previewWrapper.appendChild(previewImage);
  previewWrapper.appendChild(previewCloseBtn);
  
  // Create controls container
  const controlsContainer = document.createElement('div');
  controlsContainer.className = 'screenshot-preview-controls';
  
  // Create download button
  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'screenshot-preview-btn download-btn';
  downloadBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 保存';
  
  // Download button click handler
  downloadBtn.addEventListener('click', () => {
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `${downloadBaseName}-${timestamp}.${extension}`;
    
    const link = document.createElement('a');
    link.href = imageData;
    link.download = filename;
    link.click();
    
    showNotification(downloadNotification);
  });
  
  // Create close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'screenshot-preview-btn close-btn';
  closeBtn.innerText = 'Close';
  
  // Close button click handler
  closeBtn.addEventListener('click', () => {
    previewContainer.classList.add('closing');
    setTimeout(() => {
      if (previewImage.dataset.objectUrl === 'true') {
        URL.revokeObjectURL(previewImage.src);
      }
      if (previewContainer.parentNode) {
        previewContainer.parentNode.removeChild(previewContainer);
      }
    }, 300);
  });
  
  // Add controls to container
  controlsContainer.appendChild(downloadBtn);
  controlsContainer.appendChild(closeBtn);
  
  // Add wrapper and controls to preview container
  previewContainer.appendChild(previewWrapper);
  previewContainer.appendChild(controlsContainer);
  
  // Add preview to body
  document.body.appendChild(previewContainer);
  
  // Position preview in the bottom right corner
  const captureBtn = document.getElementById('screenshot-capture-btn');
  let rightPosition = 20;
  let bottomPosition = 20;
  if (captureBtn && captureBtn.style.display !== 'none') {
    const captureBtnRect = captureBtn.getBoundingClientRect();
    rightPosition = window.innerWidth - captureBtnRect.right;
    bottomPosition = window.innerHeight - captureBtnRect.top + 10;
  }
  previewContainer.style.right = `${rightPosition}px`;
  previewContainer.style.bottom = `${bottomPosition}px`;
  
  // Animate opening
  setTimeout(() => {
    previewContainer.classList.add('open');
  }, 10);

  if (autoDownload) {
    setTimeout(() => {
      downloadBtn.click();
    }, 80);
  }
}

// Show full-size screenshot in a modal overlay
function showFullSizeImage(imageData) {
  // Remove existing modal if any
  const existingModal = document.getElementById('screenshot-fullsize-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Create modal overlay
  const modal = document.createElement('div');
  modal.id = 'screenshot-fullsize-modal';
  
  // Create full-size image
  const fullImage = document.createElement('img');
  fullImage.src = imageData;
  fullImage.alt = 'Full size screenshot';
  
  // Create close button
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6L18 18"/></svg>';
  closeBtn.title = 'Close fullscreen view';
  
  // Create a small hint for keyboard shortcut
  const hint = document.createElement('div');
  hint.className = 'fullsize-hint';
  hint.textContent = 'ESCキーで戻る';
  
  // Close button click handler
  closeBtn.addEventListener('click', () => {
    closeModal();
  });
  
  // Click outside the image to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  // Close modal function
  function closeModal() {
    modal.style.opacity = '0';
    setTimeout(() => {
      if (modal.parentNode) {
        modal.parentNode.removeChild(modal);
      }
      document.removeEventListener('keydown', handleKeyDown);
    }, 300);
  }
  
  // Keyboard support - close on Escape key
  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      closeModal();
    }
  }
  
  document.addEventListener('keydown', handleKeyDown);
  
  // Add elements to modal
  modal.appendChild(fullImage);
  modal.appendChild(closeBtn);
  modal.appendChild(hint);
  
  // Add modal to body
  document.body.appendChild(modal);
  
  // Animate opening
  setTimeout(() => {
    modal.style.opacity = '1';
  }, 10);
}

// showNotification lives in scripts/utils.js (loaded first by the manifest). This
// file used to carry a byte-identical second copy of it; two `function` declarations
// of the same name in the shared content-script scope meant manifest load order
// silently decided which one every caller got.

function getScreenshotTheme() {
  const styles = getComputedStyle(document.body);
  const darkMode = document.body.classList.contains('dark-mode');
  const getColor = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;

  return {
    canvasBackground: getColor('--color-background', darkMode ? '#1e1e2e' : '#ffffff'),
    containerBackground: getColor('--color-card', darkMode ? '#272736' : '#ffffff'),
    containerText: getColor('--color-text-primary', darkMode ? '#e4e6eb' : '#333333'),
    accent: getColor('--color-primary', '#1a73e8'),
    accentSoft: darkMode ? '#2d3345' : '#f1f8ff',
    border: getColor('--color-border', darkMode ? '#3a3a4c' : '#eaeaea'),
    mutedText: getColor('--color-text-secondary', darkMode ? '#b0b3b8' : '#5f6368'),
    headerText: getColor('--color-text-secondary', darkMode ? '#dbe2ea' : '#3c4043'),
    headerBackgrounds: darkMode
      ? ['#323246', '#2d3345', '#2b313f']
      : ['#f6f8fa', '#f0f4f9', '#ebf1f5'],
    rowBackgroundEven: getColor('--color-card', darkMode ? '#272736' : '#ffffff'),
    rowBackgroundOdd: getColor('--color-surface', darkMode ? '#2a2a3c' : '#f9fafc'),
    valueText: darkMode ? '#7ee2a8' : '#137333',
    containerShadow: getColor(
      '--shadow',
      darkMode ? '0 4px 12px rgba(0, 0, 0, 0.3)' : '0 4px 12px rgba(0, 0, 0, 0.05)'
    ),
    gridShadow: darkMode ? '0 1px 3px rgba(0, 0, 0, 0.22)' : '0 1px 3px rgba(0, 0, 0, 0.04)'
  };
}

// Build the 工数レポート card from extracted data ({ totalText, rows: [{project, task, work}] }).
function buildScreenshotLayout(reportData = {}) {
  const theme = getScreenshotTheme();
  const rowsData = (reportData && reportData.rows) || [];
  const totalText = (reportData && reportData.totalText) || '';

  const container = document.createElement('div');
  container.style.padding = '32px';
  container.style.backgroundColor = theme.containerBackground;
  container.style.color = theme.containerText;
  container.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  container.style.borderRadius = '8px';
  container.style.boxShadow = theme.containerShadow;
  container.style.maxWidth = '900px';

  // Header: title + total badge
  const headerDiv = document.createElement('div');
  headerDiv.style.display = 'flex';
  headerDiv.style.justifyContent = 'space-between';
  headerDiv.style.alignItems = 'center';
  headerDiv.style.marginBottom = '24px';
  headerDiv.style.borderBottom = `1px solid ${theme.border}`;
  headerDiv.style.paddingBottom = '20px';

  const titleDiv = document.createElement('div');
  titleDiv.textContent = '工数レポート';
  titleDiv.style.fontSize = '20px';
  titleDiv.style.fontWeight = '600';
  titleDiv.style.color = theme.accent;

  const totalDiv = document.createElement('div');
  totalDiv.textContent = totalText;
  totalDiv.style.fontSize = '26px';
  totalDiv.style.fontWeight = 'bold';
  totalDiv.style.color = theme.accent;
  totalDiv.style.padding = '6px 16px';
  totalDiv.style.backgroundColor = theme.accentSoft;
  totalDiv.style.borderRadius = '6px';

  headerDiv.appendChild(titleDiv);
  headerDiv.appendChild(totalDiv);
  container.appendChild(headerDiv);

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '4fr 1fr 0.8fr';
  grid.style.gap = '0';
  grid.style.borderRadius = '8px';
  grid.style.overflow = 'hidden';
  grid.style.border = `1px solid ${theme.border}`;
  grid.style.boxShadow = theme.gridShadow;

  const headerBgColors = theme.headerBackgrounds;
  let i = 0;
  ['プロジェクト一覧', 'タスク', '工数'].forEach((headerText) => {
    const headerCell = document.createElement('div');
    headerCell.textContent = headerText;
    headerCell.style.fontSize = '14px';
    headerCell.style.fontWeight = '600';
    headerCell.style.backgroundColor = headerBgColors[i++];
    headerCell.style.color = theme.headerText;
    headerCell.style.padding = '12px 16px';
    headerCell.style.borderBottom = `1px solid ${theme.border}`;
    grid.appendChild(headerCell);
  });

  let rowIndex = 0;
  rowsData.forEach((r) => {
    const projectText = r.project || '';
    const taskText = r.task || '';
    const workText = r.work || '';
    if (!projectText && !taskText && !workText) return;
    const rowBgColor = rowIndex % 2 === 0 ? theme.rowBackgroundEven : theme.rowBackgroundOdd;
    rowIndex++;
    [projectText, taskText, workText].forEach((text, index) => {
      const cell = document.createElement('div');
      cell.textContent = text;
      cell.style.fontSize = '14px';
      cell.style.padding = '12px 16px';
      cell.style.borderBottom = `1px solid ${theme.border}`;
      cell.style.backgroundColor = rowBgColor;
      cell.style.color = index === 2 ? theme.valueText : theme.containerText;
      if (index === 0) {
        cell.style.fontWeight = '500';
      } else if (index === 2) {
        cell.style.fontWeight = '600';
        cell.style.textAlign = 'center';
      }
      grid.appendChild(cell);
    });
  });

  const footerDiv = document.createElement('div');
  footerDiv.style.marginTop = '16px';
  footerDiv.style.fontSize = '12px';
  footerDiv.style.color = theme.mutedText;
  footerDiv.style.textAlign = 'right';
  footerDiv.textContent = `作成日時: ${new Date().toLocaleString('ja-JP')}`;

  container.appendChild(grid);
  container.appendChild(footerDiv);
  return container;
}

// One-click "工数レポート" for the rebuilt edit page: read the day's rows straight
// from the live table (autocomplete inputs + input.manhour — no select markup),
// render the report card, copy it to the clipboard, and show a download preview.
// This restores the pre-rebuild behavior without the user selecting an area.
async function captureManHourDayReport() {
  if (!(await ensureHtml2Canvas())) {
    showNotification('スクリーンショット機能を読み込めませんでした。');
    return;
  }

  const rows = [];
  let totalMinutes = 0;
  document.querySelectorAll('table.jbc-table tbody tr').forEach((tr) => {
    if (tr.id === 'template') return;
    const units = tr.querySelectorAll('input.unit');
    const project = units[0] ? units[0].value.trim() : '';
    const task = units[1] ? units[1].value.trim() : '';
    const hoursInput = tr.querySelector('input.manhour');
    const workRaw = hoursInput ? hoursInput.value.trim() : '';
    if (!project && !task && !workRaw) return;
    const mins = parseTimeTextToMinutes(workRaw) || 0;
    totalMinutes += mins;
    rows.push({ project, task, work: workRaw ? formatMinutesToHHMM(mins) : '' });
  });

  if (!rows.length) {
    showNotification('工数が入力されていません。', 2500);
    return;
  }

  const totalText = `合計: ${Math.floor(totalMinutes / 60)}時間${totalMinutes % 60}分`;
  const layoutElem = buildScreenshotLayout({ totalText, rows });
  layoutElem.style.position = 'fixed';
  layoutElem.style.top = '0';
  layoutElem.style.left = '0';
  layoutElem.style.zIndex = '9999';
  document.body.appendChild(layoutElem);

  showNotification('工数レポートを作成中…', 0);

  const screenshotTheme = getScreenshotTheme();
  html2canvas(layoutElem, {
    allowTaint: true,
    useCORS: true,
    backgroundColor: screenshotTheme.canvasBackground,
    scale: 2,
    logging: false
  }).then((canvas) => {
    if (layoutElem.parentNode) layoutElem.parentNode.removeChild(layoutElem);
    const notification = document.querySelector('.screenshot-notification');
    if (notification) notification.remove();

    const imageData = canvas.toDataURL('image/png');

    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
      canvas.toBlob((blob) => {
        try {
          const item = new ClipboardItem({ 'image/png': blob });
          navigator.clipboard.write([item]).then(
            () => showNotification('工数レポートをクリップボードにコピーしました。'),
            (err) => {
              console.error('Could not copy man-hour report to clipboard: ', err);
              showNotification('クリップボードにコピーできませんでした。プレビューから保存してください。');
            }
          );
        } catch (err) {
          console.error('ClipboardItem not supported: ', err);
          showNotification('このブラウザはクリップボードコピーに対応していません。プレビューから保存してください。');
        }
      });
    } else {
      showNotification('このブラウザはクリップボードコピーに対応していません。プレビューから保存してください。');
    }

    showScreenshotPreview(imageData);
  }).catch((error) => {
    console.error('Error capturing man-hour report:', error);
    if (layoutElem.parentNode) layoutElem.parentNode.removeChild(layoutElem);
    showNotification('工数レポートの作成に失敗しました。', 2500);
  });
}

// Expose the functions globally
window.captureManHourDayReport = captureManHourDayReport;
window.registerFloatingAction = registerFloatingAction;
window.closeFloatingActionMenu = closeFloatingActionMenu;
window.setupScreenshotButton = setupScreenshotButton;
