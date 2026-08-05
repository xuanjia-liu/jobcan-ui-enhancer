// scripts/clock.js

/* exported cleanupClockContainer */

// Work hours configuration. The fixed 06:00–24:00 track bounds that used to live
// here are gone — the axis is derived per day now, see getAxisWindow().
const WORK_HOURS = {
  targetMinutes: 8 * 60 // standard daily work target (rest excluded)
};

/**
 * Assumed lunch band in minutes since midnight (13:00–14:00, 1h). Only used as a
 * fallback for days with no recorded 休憩 punches — see applyAssumedNoonBreak().
 */
const NOON_BREAK_MINUTES = {
  start: 13 * 60,
  end: 14 * 60
};

/** Age at which the stored punch data is called out as stale in the status line. */
const STALE_PUNCH_DATA_MINUTES = 10;

/**
 * The track's time window.
 *
 * A fixed 06:00–24:00 spent 18 hours of width on a ~9-hour day, so roughly 60% of
 * the bar was permanently empty and the bands that matter were squeezed into a third
 * of it. The window now starts from a tighter default and only widens to take in
 * punches (plus padding) and the current time, snapped outward to whole hours so the
 * tick labels stay round and the geometry only changes on the hour.
 */
const AXIS_DEFAULT_START_MINUTES = 7 * 60;
const AXIS_DEFAULT_END_MINUTES = 21 * 60;
const AXIS_PAD_MINUTES = 30;

function getAxisWindow(entries) {
  const now = new Date();
  const nowMinutes = Math.min(24 * 60, (now.getHours() * 60) + now.getMinutes());

  let start = AXIS_DEFAULT_START_MINUTES;
  let end = AXIS_DEFAULT_END_MINUTES;

  const points = (entries || [])
    .map((entry) => parsePunchMinutesOfDay(entry?.time))
    .filter((m) => m !== null);
  points.push(nowMinutes);

  points.forEach((point) => {
    start = Math.min(start, point - AXIS_PAD_MINUTES);
    end = Math.max(end, point + AXIS_PAD_MINUTES);
  });

  // Snap outward to whole hours: keeps labels round, and means the mapping only
  // shifts when the clock crosses an hour rather than creeping every 30 seconds.
  start = Math.max(0, Math.floor(start / 60) * 60);
  end = Math.min(24 * 60, Math.ceil(end / 60) * 60);

  // No minimum-span guard: the default window is already 14h and the loop above only
  // ever widens it, so the span cannot come out below that. Verified by sweeping
  // every hour of the day against empty / midnight / midday / 23:59 punch sets —
  // 14h was the minimum observed.
  return { start, end, span: end - start };
}

/** Position of an absolute minute on the axis, as a 0–100 percentage. */
function axisPercent(minutes, axis) {
  if (!axis || axis.span <= 0) return 0;
  return ((minutes - axis.start) / axis.span) * 100;
}

/** Candidate tick spacings, coarsest last. */
const AXIS_TICK_STEPS_MINUTES = [60, 2 * 60, 3 * 60, 4 * 60, 6 * 60];

/** Room a `HH:MM` label needs before it touches its neighbour. */
const AXIS_LABEL_MIN_SPACING_PX = 46;

/**
 * Coarsest-to-finest: the first spacing whose labels all fit the measured track.
 * Driven by pixels rather than by span alone, because the same 14-hour window has
 * room for a label an hour on a wide card and nothing like it on a narrow one.
 */
function getAxisTickStep(axis, trackWidthPx) {
  const budget = Math.max(2, Math.floor(trackWidthPx / AXIS_LABEL_MIN_SPACING_PX));
  for (const step of AXIS_TICK_STEPS_MINUTES) {
    if ((axis.span / step) + 1 <= budget) return step;
  }
  return AXIS_TICK_STEPS_MINUTES[AXIS_TICK_STEPS_MINUTES.length - 1];
}

// Animation durations
const ANIMATION = {
  flip: 600, // Slightly longer for smoother animation
  pulse: 2000,
  transition: 300, // Slightly longer for smoother transitions
  progressBar: 800 // New animation duration for progress bar
};

// Managed-interval keys are per-container, so a page with more than one clock
// does not have its timers overwrite each other in the registry.
let clockInstanceSeq = 0;

// How long after the wall-clock second boundary a tick may fire before it is
// re-aligned instead of left to drift. See startAlignedClockTick().
const ALIGNED_TICK_TOLERANCE_MS = 150;

// Aim just past the boundary, not exactly at it. A tick that lands even 1ms early
// reads the previous second, sees no change and skips, so the update waits a full
// second longer. Overshooting costs a few ms of lateness and removes that class of
// miss entirely.
const ALIGNED_TICK_SAFETY_MS = 5;

// In-memory cache of the three clock settings. applyClockSettings() is called
// from every applyEnhancements() pass — which the debounced body observer
// re-triggers roughly once a second during DOM churn — and each call used to be
// its own chrome.storage.sync.get round-trip. The cache is invalidated by the
// storage.onChanged listener below, so the popup's writes still land immediately.
const CLOCK_SETTING_KEYS = ['clockSize', 'showSeconds', 'showProgressBar'];
let cachedClockSettings = null;
let clockSettingsPromise = null;

function getClockSettings() {
  ensureClockSettingsInvalidation();
  if (cachedClockSettings) return Promise.resolve(cachedClockSettings);
  if (clockSettingsPromise) return clockSettingsPromise;

  clockSettingsPromise = new Promise((resolve) => {
    chrome.storage.sync.get(CLOCK_SETTING_KEYS, (result) => {
      cachedClockSettings = result || {};
      clockSettingsPromise = null;
      resolve(cachedClockSettings);
    });
  });

  return clockSettingsPromise;
}

function ensureClockSettingsInvalidation() {
  if (window.__jbe_clockSettingsListenerInited) return;
  if (!chrome?.storage?.onChanged) return;
  window.__jbe_clockSettingsListenerInited = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (CLOCK_SETTING_KEYS.some((key) => key in changes)) cachedClockSettings = null;
  });
}

// Initialize flip clock and progress bar
function setupFlipClock() {
  ensureClockSettingsInvalidation();
  // Find clock elements
  const clockElements = document.querySelectorAll('#clock, #display-time, .display-2 > div:not(.flip-clock-container)');
  clockElements.forEach(clockElement => {
    if (clockElement.dataset.enhanced === 'true') return;
    clockElement.dataset.enhanced = 'true';
    createSelfAnimatingClock(clockElement);
  });

  if (!window.__jbe_punchStorageListenerInited && chrome?.storage?.onChanged) {
    window.__jbe_punchStorageListenerInited = true;
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.jobcanPunchListData) return;
      document.querySelectorAll('.flip-clock-container').forEach((container) => {
        refreshPunchMarkers(container, true);
      });
    });
  }

  ensureWorkingStatusObserver();
}

// There is deliberately no runtime <style> injection here. Every clock rule lives
// in css/styles.css under `.jobcan-enhanced`. An injected sheet used to duplicate
// them with unscoped selectors, which silently shadowed the stylesheet — the
// status-color block even gave 勤務中 and the neutral fallback the same gradient,
// making `--color-clock-working-*` unreachable. Keep clock CSS in the stylesheet.

// Create a new self-animating clock that's more efficient
function createSelfAnimatingClock(clockElement) {
  const parentElement = clockElement.parentElement;
  if (!parentElement) return;
  
  // Clean up any existing clock containers in this parent
  const existingContainers = parentElement.querySelectorAll('.flip-clock-container');
  existingContainers.forEach(container => {
    cleanupClockContainer(container);
    container.remove();
  });
  
  const flipClockContainer = document.createElement('div');
  flipClockContainer.className = 'flip-clock-container';
  flipClockContainer.dataset.clockSize = 'medium';
  clockInstanceSeq += 1;
  flipClockContainer.dataset.clockInstance = String(clockInstanceSeq);
  // The split-flap keyframes read their duration from here, so ANIMATION.flip stays
  // the single source of truth for both the CSS animation and the settle timeout.
  flipClockContainer.style.setProperty('--jbe-flip-duration', `${ANIMATION.flip}ms`);
  const clockDigitsContainer = document.createElement('div');
  clockDigitsContainer.className = 'flip-clock-digits-container';
  flipClockContainer.appendChild(clockDigitsContainer);
  const progressContainer = document.createElement('div');
  progressContainer.className = 'work-progress-container';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'work-progress-track';
  const workScheduleLayer = document.createElement('div');
  workScheduleLayer.className = 'work-schedule-layer';
  progressTrack.appendChild(workScheduleLayer);

  // Moving progress indicator
  const progressIndicator = document.createElement('div');
  progressIndicator.className = 'work-progress-indicator';
  progressTrack.appendChild(progressIndicator);

  // Marks when the daily target is (or was) reached — see renderTargetMarker().
  const targetMarker = document.createElement('div');
  targetMarker.className = 'work-target-marker';
  progressTrack.appendChild(targetMarker);

  // Ticks and their labels are generated from the axis window, not hardcoded
  // percentages, and rebuilt only when the window actually changes.
  const scaleRow = document.createElement('div');
  scaleRow.className = 'work-progress-scale';

  const percentageIndicator = document.createElement('div');
  percentageIndicator.className = 'work-progress-percentage';
  progressContainer.appendChild(progressTrack);
  progressContainer.appendChild(scaleRow);
  progressContainer.appendChild(percentageIndicator);
  if (typeof ResizeObserver !== 'undefined') {
    const scheduleResizeObserver = new ResizeObserver(() => {
      if (!document.body.contains(flipClockContainer)) {
        scheduleResizeObserver.disconnect();
        return;
      }
      const cachedEntries = Array.isArray(flipClockContainer._cachedPunchEntries)
        ? flipClockContainer._cachedPunchEntries
        : [];
      // Band geometry and label density are both computed from pixel widths, so a
      // resize has to redraw the whole track, not just the bands.
      renderProgressTrack(flipClockContainer, cachedEntries);
    });
    scheduleResizeObserver.observe(progressTrack);
    flipClockContainer._scheduleResizeObserver = scheduleResizeObserver;
  }
  getClockSettings().then((settings) => {
    const showProgressBar = settings.showProgressBar !== false;
    progressContainer.classList.toggle('hidden', !showProgressBar);
  });
  flipClockContainer.appendChild(progressContainer);
  const initialTime = clockElement.textContent.trim();
  setupSelfAnimatingClockDigits(clockDigitsContainer, initialTime);
  parentElement.appendChild(flipClockContainer);
  applyClockSettings(flipClockContainer);
  // Initial color sync (apply working status color on load)
  updateFlipClockColors(flipClockContainer);
  // Start self-updating clock (optimized)
  startSelfUpdatingClock(flipClockContainer);
  refreshPunchMarkers(flipClockContainer, true);
  triggerPunchListRefresh();
  updateWorkProgressBar(flipClockContainer);
  startProgressInterval(flipClockContainer);
}

/**
 * Progress bar refresh every 30 seconds, through the managed resource registry so
 * the timer is visible/teardownable like every other one in the extension. Skipped
 * while the tab is hidden — updateWorkProgressBar writes through
 * requestAnimationFrame, which does not run there, so the writes would only pile
 * up. The visibilitychange handler restarts it.
 */
function startProgressInterval(container) {
  if (document.hidden) return;
  startManagedClockInterval(progressIntervalKey(container), () => {
    // Render first so the indicator and the stale-age suffix move every tick, then
    // let the throttled read pull fresh punches and repaint if anything changed.
    updateWorkProgressBar(container);
    refreshPunchMarkers(container, false);
  }, 30000, container);
}

function tickIntervalKey(container) {
  return `clock:tick:${container.dataset.clockInstance || '0'}`;
}

function progressIntervalKey(container) {
  return `clock:progress:${container.dataset.clockInstance || '0'}`;
}

/**
 * Managed interval that also stops itself once its container leaves the DOM —
 * Jobcan's SPA swaps the clock's parent without any teardown hook of ours firing.
 * Falls back to a bare setInterval only if utils/main have not registered the
 * registry yet (manifest order should make that impossible).
 */
function startManagedClockInterval(key, callback, delayMs, container) {
  if (typeof window.__jbe_startManagedInterval === 'function') {
    window.__jbe_startManagedInterval(key, (ctx) => {
      if (!document.body.contains(container)) {
        ctx.stop();
        return;
      }
      callback();
    }, delayMs);
    return;
  }

  const timerId = setInterval(() => {
    if (!document.body.contains(container)) {
      clearInterval(timerId);
      return;
    }
    callback();
  }, delayMs);
}

// Cleanup function to prevent memory leaks
function cleanupClockContainer(container) {
  stopClockTick(container);
  if (typeof window.__jbe_clearManagedInterval === 'function') {
    window.__jbe_clearManagedInterval(progressIntervalKey(container));
  }

  (container._clockDigits || []).forEach((cached) => {
    if (cached.flipTimeoutId) clearTimeout(cached.flipTimeoutId);
  });
  delete container._clockDigits;

  if (container._scheduleResizeObserver) {
    container._scheduleResizeObserver.disconnect();
    delete container._scheduleResizeObserver;
  }

  // Clear any cached elements
  const progressContainer = container.querySelector('.work-progress-container');
  if (progressContainer && progressContainer._cachedElements) {
    delete progressContainer._cachedElements;
  }
}

/**
 * Build HH : MM : SS as three `.flip-group` pairs separated by colons, which is how
 * a real split-flap board reads — the pair is the unit, not the individual digit.
 * Digit order in the DOM is preserved, so the flat `querySelectorAll` used by the
 * tick cache and the colour sync still lines up index-for-index with the time
 * string.
 */
function setupSelfAnimatingClockDigits(container, timeString) {
  container.innerHTML = '';
  const normalizedTime = normalizeTimeFormat(timeString);
  const [hours = '00', minutes = '00', seconds = '00'] = normalizedTime.split(':');

  const appendGroup = (pair, startIndex, isSeconds) => {
    const group = document.createElement('div');
    group.className = isSeconds ? 'flip-group is-seconds' : 'flip-group';
    for (let i = 0; i < pair.length; i++) {
      const digitElement = createSelfAnimatingDigit(pair[i]);
      digitElement.dataset.index = startIndex + i;
      if (isSeconds) digitElement.dataset.position = 'seconds';
      group.appendChild(digitElement);
    }
    container.appendChild(group);
  };

  const appendColon = (isSecondsColon) => {
    const colonElement = document.createElement('div');
    colonElement.className = 'colon';
    colonElement.textContent = ':';
    if (isSecondsColon) colonElement.dataset.position = 'seconds-colon';
    container.appendChild(colonElement);
  };

  appendGroup(hours, 0, false);
  appendColon(false);
  appendGroup(minutes, 3, false);
  appendColon(true);
  appendGroup(seconds, 6, true);
}

/**
 * One split-flap digit.
 *
 * Four glyph copies, all cropped to half the tile, is what makes this read as a
 * mechanical flap rather than a card spinning on its axis:
 *
 *   .flip-digit-half.is-upper   static top    — shows the INCOMING digit, revealed
 *   .flip-digit-half.is-lower   static bottom — shows the OUTGOING digit, covered
 *   .flip-leaf > .is-front      the falling flap, front face: OUTGOING, top crop
 *   .flip-leaf > .is-back       the falling flap, back face:  INCOMING, bottom crop
 *
 * The leaf is hinged on its bottom edge and rotates 0 → -180deg. Its back face is
 * pre-rotated 180deg, so at the end of the travel the two rotations cancel and the
 * incoming digit lands upright over the lower half. At rest all four copies hold
 * the same value, so the leaf sitting at 0deg is indistinguishable from the static
 * top half and there is nothing to hide.
 *
 * No inline styles: geometry, colour, radius and the pre-rotation all live in
 * css/styles.css. This function used to set ~20 inline properties that duplicated
 * the stylesheet and, because inline always wins, made the stylesheet's own
 * declarations unreachable.
 */
function createSelfAnimatingDigit(digit) {
  const digitElement = document.createElement('div');
  digitElement.className = 'flip-clock-digit';
  digitElement.dataset.currentValue = digit;

  const makeGlyphHost = (className) => {
    const host = document.createElement('div');
    host.className = className;
    const glyph = document.createElement('div');
    glyph.className = 'flip-digit-glyph';
    glyph.textContent = digit;
    host.appendChild(glyph);
    return host;
  };

  const upper = makeGlyphHost('flip-digit-half is-upper');
  const lower = makeGlyphHost('flip-digit-half is-lower');

  const leaf = document.createElement('div');
  leaf.className = 'flip-leaf';
  const leafFront = makeGlyphHost('flip-leaf-face is-front');
  const leafBack = makeGlyphHost('flip-leaf-face is-back');
  leaf.appendChild(leafFront);
  leaf.appendChild(leafBack);

  digitElement.appendChild(upper);
  digitElement.appendChild(lower);
  digitElement.appendChild(leaf);
  return digitElement;
}

function formatClockTime(date) {
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}`;
}

// Begin optimized self-updating clock function
function startSelfUpdatingClock(container) {
  // The rendered time is tracked on the element object, not in a data-* attribute:
  // it changes every second and nothing outside this file reads it, so writing it
  // to the DOM only fed the body-wide MutationObserver in main.js.
  container._displayTime = formatClockTime(new Date());

  // Cache DOM elements to avoid repeated queries
  const digitsContainer = container.querySelector('.flip-clock-digits-container');
  if (!digitsContainer) return;

  const digitElements = Array.from(digitsContainer.querySelectorAll('.flip-clock-digit'));
  const cachedElements = digitElements.map(el => ({
    element: el,
    upper: el.querySelector('.is-upper .flip-digit-glyph'),
    lower: el.querySelector('.is-lower .flip-digit-glyph'),
    leafFront: el.querySelector('.is-front .flip-digit-glyph'),
    leafBack: el.querySelector('.is-back .flip-digit-glyph'),
    currentValue: el.dataset.currentValue,
    isAnimating: false
  }));

  container._clockDigits = cachedElements;
  startAlignedClockTick(container);
  bindClockVisibilityGate();
}

/**
 * Render `timeStr` into the cached digits. `animate` false swaps the faces with no
 * flip — used when resyncing after a hidden stretch, where animating six digits
 * through a stale value would just look broken.
 */
function renderClockTime(container, timeStr, animate) {
  const cachedElements = container._clockDigits;
  if (!cachedElements) return;

  container._displayTime = timeStr;
  const newParts = normalizeTimeFormat(timeStr).split('').filter(char => char !== ':');

  for (let i = 0; i < Math.min(newParts.length, cachedElements.length); i++) {
    const newDigit = newParts[i];
    const cached = cachedElements[i];
    if (cached.currentValue === newDigit) continue;

    if (animate) {
      if (!cached.isAnimating) animateDigitChangeOptimized(cached, newDigit);
    } else {
      setDigitValueImmediate(cached, newDigit);
    }
  }
}

/**
 * Second-aligned tick.
 *
 * A plain setInterval(1000) starts wherever the page happened to load and drifts
 * from there, so a digit could render up to a second after the second it shows
 * actually began. Instead: sleep to the next wall-clock second boundary, then run
 * a managed 1000ms interval from that point, and re-align whenever a tick lands
 * more than ALIGNED_TICK_TOLERANCE_MS past the boundary (timer jitter, throttling,
 * sleep/wake). Simulated across perfect / ±3ms / +8ms / +40ms / +300ms timer lag:
 * no second is ever skipped, and realistic jitter renders within ~15ms.
 */
function startAlignedClockTick(container) {
  stopClockTick(container);
  if (document.hidden) return; // resumed by the visibilitychange handler

  const msToBoundary = 1000 - (Date.now() % 1000) + ALIGNED_TICK_SAFETY_MS;
  container._tickAlignTimeoutId = setTimeout(() => {
    delete container._tickAlignTimeoutId;
    if (!document.body.contains(container) || document.hidden) return;

    tickClock(container);
    startManagedClockInterval(tickIntervalKey(container), () => {
      // How far past the second boundary this tick fired. Deliberately not the
      // distance to the *nearest* boundary: a tick landing at .851 is only 149ms
      // from the next boundary but still renders its own second 851ms late (it
      // reads the not-yet-incremented second, skips as unchanged, and the visible
      // update waits for the following tick). Only lateness after the boundary is
      // acceptable, so measure exactly that.
      const msPastBoundary = Date.now() % 1000;
      if (msPastBoundary > ALIGNED_TICK_TOLERANCE_MS) {
        // Render before re-aligning. Re-aligning sleeps to the *next* boundary, so
        // skipping this render would drop the current second from the display
        // entirely — the clock would jump N-1 → N+1. Late beats missing.
        tickClock(container);
        startAlignedClockTick(container);
        return;
      }
      tickClock(container);
    }, 1000, container);
  }, msToBoundary);
}

function tickClock(container) {
  const newTimeStr = formatClockTime(new Date());
  if (newTimeStr === container._displayTime) return;
  renderClockTime(container, newTimeStr, true);
}

function stopClockTick(container) {
  if (container._tickAlignTimeoutId) {
    clearTimeout(container._tickAlignTimeoutId);
    delete container._tickAlignTimeoutId;
  }
  if (typeof window.__jbe_clearManagedInterval === 'function') {
    window.__jbe_clearManagedInterval(tickIntervalKey(container));
  }
}

/**
 * Stop every clock timer while the tab is hidden and hard-resync on the way back.
 * Nothing the timers do is observable in a hidden tab — Chrome throttles the
 * timers themselves, requestAnimationFrame never fires (so updateWorkProgressBar's
 * DOM writes would just queue up), and the flip animations paint nothing.
 */
function bindClockVisibilityGate() {
  if (window.__jbe_clockVisibilityGateInited) return;
  window.__jbe_clockVisibilityGateInited = true;

  document.addEventListener('visibilitychange', () => {
    document.querySelectorAll('.flip-clock-container').forEach((container) => {
      if (document.hidden) {
        stopClockTick(container);
        if (typeof window.__jbe_clearManagedInterval === 'function') {
          window.__jbe_clearManagedInterval(progressIntervalKey(container));
        }
        return;
      }

      // Jump straight to the current time with no flips, then re-align.
      renderClockTime(container, formatClockTime(new Date()), false);
      startAlignedClockTick(container);
      refreshPunchMarkers(container, true);
      startProgressInterval(container);
    });
  });
}

/** Set all four glyph copies of a digit to the same value. */
function setDigitFaces(cachedDigit, value) {
  if (cachedDigit.upper) cachedDigit.upper.textContent = value;
  if (cachedDigit.lower) cachedDigit.lower.textContent = value;
  if (cachedDigit.leafFront) cachedDigit.leafFront.textContent = value;
  if (cachedDigit.leafBack) cachedDigit.leafBack.textContent = value;
}

/** Set a digit with no flip animation, cancelling one in flight if needed. */
function setDigitValueImmediate(cachedDigit, newDigit) {
  // Must cancel the pending face swap: it closes over the digit it was started
  // with, so letting it fire would overwrite this value with a stale one.
  if (cachedDigit.flipTimeoutId) {
    clearTimeout(cachedDigit.flipTimeoutId);
    cachedDigit.flipTimeoutId = null;
  }
  cachedDigit.element.classList.remove('is-flipping');
  setDigitFaces(cachedDigit, newDigit);
  cachedDigit.currentValue = newDigit;
  cachedDigit.element.dataset.currentValue = newDigit;
  cachedDigit.isAnimating = false;
}

/**
 * Drive one split-flap cycle from `currentValue` to `newDigit`.
 *
 * Order matters. The incoming digit goes on the static upper half and the leaf's
 * back face *before* the leaf starts moving: the upper half is hidden behind the
 * leaf at 0deg and the back face is turned away, so neither is visible yet, and
 * both are already correct by the time the leaf uncovers them. The outgoing digit
 * stays on the static lower half so it remains visible until the leaf lands on it.
 *
 * The animation itself is CSS (`.is-flipping`), reading its duration from the
 * --jbe-flip-duration custom property that createSelfAnimatingClock sets from
 * ANIMATION.flip — so the keyframes and the settle timeout below cannot drift apart.
 */
function animateDigitChangeOptimized(cachedDigit, newDigit) {
  if (cachedDigit.isAnimating || !cachedDigit.element) return;

  cachedDigit.isAnimating = true;

  if (cachedDigit.upper) cachedDigit.upper.textContent = newDigit;
  if (cachedDigit.leafBack) cachedDigit.leafBack.textContent = newDigit;

  cachedDigit.element.classList.add('is-flipping');

  // Settle once the leaf has landed. The id is kept so a resync can cancel it.
  cachedDigit.flipTimeoutId = setTimeout(() => {
    cachedDigit.flipTimeoutId = null;

    // The leaf ends at -180deg showing the incoming digit over the lower half.
    // Copying it onto the static lower half first means removing .is-flipping —
    // which snaps the leaf back to 0deg — swaps between two identical frames.
    setDigitFaces(cachedDigit, newDigit);
    cachedDigit.element.classList.remove('is-flipping');

    cachedDigit.currentValue = newDigit;
    cachedDigit.element.dataset.currentValue = newDigit;
    cachedDigit.isAnimating = false;
  }, ANIMATION.flip);
}

// Optimized work progress bar update with cached elements
function updateWorkProgressBar(container) {
  const progressContainer = container.querySelector('.work-progress-container'); 
  if (!progressContainer) return;
  
  // Cache elements if not already cached. There is no `.work-progress-fill` any
  // more: it had no CSS at all (no height, no background), so it rendered nothing
  // — the coloured bands come from `.work-schedule-layer`. Its `progress-state-*`
  // classes were equally unstyled.
  if (!progressContainer._cachedElements) {
    progressContainer._cachedElements = {
      track: progressContainer.querySelector('.work-progress-track'),
      indicator: progressContainer.querySelector('.work-progress-indicator'),
      percentage: progressContainer.querySelector('.work-progress-percentage')
    };
  }

  const { indicator, percentage } = progressContainer._cachedElements;
  if (!percentage) return;

  const now = new Date();
  const currentMinOfDay = now.getHours() * 60 + now.getMinutes();
  const entries = container._cachedPunchEntries || [];

  // The window takes in the current time, so crossing an hour can widen it. Redraw
  // the axis-dependent layers when that happens — renderAxisScale() and the segment
  // signature make a no-change pass cheap.
  const axis = getAxisWindow(entries);
  const previousAxis = container._axis;
  if (!previousAxis || previousAxis.start !== axis.start || previousAxis.end !== axis.end) {
    renderProgressTrack(container, entries);
  }

  const progress = Math.max(0, Math.min(100, axisPercent(currentMinOfDay, axis)));

  const state = container._punchDataState || 'loading';
  const statusText = describeWorkProgress(state, container);
  const hasAnomaly = state === 'ok' && getPunchAnomalies(container._cachedPunchEntries || []).length > 0;

  // Batch DOM updates to avoid multiple reflows
  requestAnimationFrame(() => {
    progressContainer.dataset.punchState = state;
    progressContainer.dataset.punchAnomaly = hasAnomaly ? 'true' : 'false';

    // Update indicator position if it exists
    if (indicator) {
      indicator.style.left = `${progress}%`;
      indicator.title = `現在時刻 ${now.toTimeString().slice(0,5)}`;
    }

    // Update text content
    renderProgressText(percentage, statusText);
  });
}

/**
 * The status line. The bar is wall-clock time-of-day; this text reports WORKED time
 * against the daily target, so 経過 / 残り / 本日勤務 all describe the same quantity.
 *
 * Each data state gets its own wording. Previously only the `ok` wording existed:
 * a failed storage read, a day with no punches yet, and a genuine 0分 all rendered
 * as `本日勤務 0分`, so there was no way to tell "nothing recorded" from "could not
 * read the data".
 */
function describeWorkProgress(state, container) {
  if (state === 'loading') return '勤務データを読み込み中…';
  if (state === 'unavailable') return '勤務データを取得できませんでした';
  if (state === 'empty') return '本日の打刻はまだありません';

  const punchEntries = container._cachedPunchEntries || [];

  // A contradicted punch means Jobcan itself will not settle the day, so leading
  // with a worked-time figure would be presenting a number that is going to change.
  const anomalies = getPunchAnomalies(punchEntries);
  if (anomalies.length > 0) {
    const first = anomalies[0];
    return `打刻エラー: ${formatMinutesAsClock(first.minutes)} の${first.type}が入室として扱われています`;
  }

  const workedMinutes = getWorkedMinutesToday(punchEntries);
  const target = WORK_HOURS.targetMinutes;
  let text;

  if (workedMinutes >= target) {
    const over = workedMinutes - target;
    text = `本日勤務 ${formatWorkedDurationMinutes(workedMinutes)} • 目標達成${over > 0 ? ` (+${formatWorkedDurationMinutes(over)})` : ''}`;
  } else {
    const pct = target > 0 ? Math.min(100, (workedMinutes / target) * 100) : 0;
    text = `本日勤務 ${formatWorkedDurationMinutes(workedMinutes)} • ${pct.toFixed(0)}% • 残り ${formatWorkedDurationMinutes(target - workedMinutes)}`;
  }

  // Surface staleness rather than presenting old numbers as current. fetchedAt was
  // already being stored by the punch loader and never shown anywhere.
  const ageMinutes = getPunchDataAgeMinutes(container);
  if (ageMinutes !== null && ageMinutes >= STALE_PUNCH_DATA_MINUTES) {
    text += ` • ${ageMinutes}分前の記録`;
  }

  return text;
}

function getPunchDataAgeMinutes(container) {
  const fetchedAt = Number(container._punchFetchedAt) || 0;
  if (!fetchedAt) return null;
  return Math.max(0, Math.floor((Date.now() - fetchedAt) / 60000));
}

/**
 * The status line. The axis ends used to be pinned here as fixed 06:00 / 24:00
 * labels; the scale row under the track now carries them (and every tick between),
 * so the status text gets the full width instead of a squeezed middle column.
 */
function renderProgressText(percentageElement, statusText) {
  if (!percentageElement) return;

  let status = percentageElement.querySelector('.work-progress-inline-status');
  if (!status) {
    percentageElement.innerHTML = '';
    status = document.createElement('span');
    status.className = 'work-progress-inline-status';
    percentageElement.appendChild(status);
  }

  // Only touch the DOM when the wording actually changes — this runs every 30s.
  if (status.textContent !== statusText) {
    status.textContent = statusText;
    status.title = statusText;
  }
}

function getTodayDateKeys() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return new Set([
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
    `${month}/${day}`,
    `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`
  ]);
}

function normalizePunchTime(value) {
  const match = (value || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * Minutes since midnight for a punch time, 0–1439, or null if unparseable.
 *
 * Deliberately NOT limited to the 06:00–24:00 display axis. This used to return
 * null outside that window, which did far more than hide an off-axis dot: the
 * segment builder dropped the event too, so a 05:45 出勤 left the builder with no
 * start at all, the whole day rendered as `off`, and 本日勤務 read 0分. The axis is
 * a drawing concern, so clamping now happens at draw time only — see
 * clampSegmentToAxis().
 */
function parsePunchMinutesOfDay(time) {
  const normalized = normalizePunchTime(time);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(':').map(Number);
  return (hour * 60) + minute;
}

function getPunchMarkerColor(type) {
  if ((type || '').includes('入室')) return 'var(--color-success)';
  if ((type || '').includes('退室')) return 'var(--color-danger)';
  if ((type || '').includes('出勤')) return 'var(--color-success)';
  if ((type || '').includes('退勤')) return 'var(--color-danger)';
  if ((type || '').includes('休憩')) return 'var(--color-warning)';
  return 'var(--color-info)';
}

function getCelebrationColors() {
  const styles = getComputedStyle(document.body);
  return [
    styles.getPropertyValue('--color-celebration-1').trim() || '#0066DD',
    styles.getPropertyValue('--color-celebration-2').trim() || '#28A745',
    styles.getPropertyValue('--color-celebration-3').trim() || '#FFC107',
    styles.getPropertyValue('--color-celebration-4').trim() || '#DC3545',
    styles.getPropertyValue('--color-celebration-5').trim() || '#17A2B8',
    styles.getPropertyValue('--color-celebration-6').trim() || '#6F42C1'
  ];
}

function filterTodayPunchEntries(entries) {
  const todayKeys = getTodayDateKeys();
  return entries.filter((entry) => entry && entry.date && todayKeys.has(entry.date));
}

function renderPunchMarkers(track, entries, axis) {
  if (!track) return;

  track.querySelectorAll('.work-punch-marker').forEach((node) => node.remove());
  if (!Array.isArray(entries) || entries.length === 0) return;

  const markerMap = new Map();

  entries.forEach((entry) => {
    const time = normalizePunchTime(entry.time);
    const minutes = parsePunchMinutesOfDay(time);
    if (!time || minutes === null) return;
    const key = `${time}-${entry.type || ''}`;
    if (markerMap.has(key)) return;
    markerMap.set(key, {
      time,
      type: entry.type || '',
      minutes
    });
  });

  markerMap.forEach((item) => {
    const marker = document.createElement('div');
    marker.className = 'work-punch-marker';
    // getAxisWindow() widens the window to cover every punch, so this clamp is not
    // expected to bite; it stays as cheap insurance against a future change to the
    // axis rules silently pushing a dot off the end of the bar.
    const percent = Math.max(0, Math.min(100, axisPercent(item.minutes, axis)));
    marker.style.left = `${percent}%`;
    marker.style.backgroundColor = getPunchMarkerColor(item.type);
    const markerTitle = `${item.time}${item.type ? ` ${item.type}` : ''}`;
    // No `title` attribute here: it raced the custom tooltip below, so hovering a
    // marker produced two tooltips — the styled one immediately, then the native
    // one about a second later, offset from it.
    marker.addEventListener('mouseenter', (e) => {
      showPunchMarkerTooltip(markerTitle, e.clientX, e.clientY);
    });
    marker.addEventListener('mousemove', (e) => {
      showPunchMarkerTooltip(markerTitle, e.clientX, e.clientY);
    });
    marker.addEventListener('mouseleave', hidePunchMarkerTooltip);
    track.appendChild(marker);
  });
}

function isWorkStartType(type) {
  return (type || '').includes('入室') || (type || '').includes('出勤');
}

function isWorkEndType(type) {
  return (type || '').includes('退室') || (type || '').includes('退勤');
}

function isBreakType(type) {
  return (type || '').includes('休憩');
}

function hasRecordedBreaks(entries) {
  return (entries || []).some((entry) => isBreakType(entry?.type) && parsePunchMinutesOfDay(entry?.time) !== null);
}

/**
 * Walk the day's punches and produce spans plus any punch anomalies.
 *
 * Jobcan's punch model is a positional in/out TOGGLE, not a set of labelled
 * transitions. A 休憩 punch takes you out exactly as a 退勤 does — which is why the
 * punch after a break-start is read as an entry no matter how it is labelled. So
 * `退勤` arriving while already out is not a clock-out at all: Jobcan treats it as
 * 入室 and flags the day as a punch error. The label only decides how an out-span is
 * *described* (break vs off) and whether it contradicts the toggle.
 *
 * Spans are in absolute minutes since midnight, up to now — not clamped to the
 * 06:00–24:00 axis, because worked-time totals come from them and clamping here
 * silently discarded real work before 06:00. clampSegmentToAxis() applies the axis
 * for drawing only.
 *
 * States: `working`, `break` (out via 休憩), `off` (out via 退勤/退室, or not yet in).
 */
function analyzePunchDay(entries) {
  const dayEnd = 24 * 60;
  const now = new Date();
  const effectiveNow = Math.min(dayEnd, (now.getHours() * 60) + now.getMinutes());
  const events = [];

  (entries || []).forEach((entry) => {
    const type = entry?.type || '';
    if (!isWorkStartType(type) && !isWorkEndType(type) && !isBreakType(type)) return;
    const minutes = parsePunchMinutesOfDay(entry?.time);
    if (minutes === null) return;
    // Do not project work/off state from future punch records.
    if (minutes > effectiveNow) return;
    events.push({ minutes, type });
  });

  // Sort by time only. Direction is positional, so a label-based tiebreak would be
  // guessing; a stable sort keeps Jobcan's own row order for same-minute punches.
  events.sort((a, b) => a.minutes - b.minutes);

  const segments = [];
  const anomalies = [];
  let cursor = 0;
  let isIn = false;
  // How the current out-span was entered, so a break reads differently from a
  // clock-out even though both are simply "not working".
  let outState = 'off';

  events.forEach((event) => {
    if (event.minutes > cursor) {
      segments.push({ start: cursor, end: event.minutes, state: isIn ? 'working' : outState });
      cursor = event.minutes;
    }

    const goingIn = !isIn;
    // A label that contradicts the toggle is the punch error Jobcan reports. 休憩 is
    // exempt: both ends of a break carry the same type, so it never contradicts.
    if (goingIn && isWorkEndType(event.type)) {
      anomalies.push({ minutes: event.minutes, type: event.type, reason: 'end-while-out' });
    } else if (!goingIn && isWorkStartType(event.type)) {
      anomalies.push({ minutes: event.minutes, type: event.type, reason: 'start-while-in' });
    }

    isIn = goingIn;
    if (!isIn) outState = isBreakType(event.type) ? 'break' : 'off';
  });

  // Draw factual state only up to current time.
  if (cursor < effectiveNow) {
    segments.push({ start: cursor, end: effectiveNow, state: isIn ? 'working' : outState });
    cursor = effectiveNow;
  }

  // Future area is always off (unknown/not-yet-worked), never working.
  if (cursor < dayEnd) {
    segments.push({ start: cursor, end: dayEnd, state: 'off' });
  }

  return { segments, anomalies };
}

/**
 * Apply the assumed lunch band.
 *
 * Only a fallback now. The old behaviour marked 13:00–14:00 as a rest band
 * unconditionally and subtracted it from worked time, which made the headline
 * 本日勤務 figure right only when lunch happened to be exactly one hour: a straight
 * 09:00–18:00 with no break was reported as 8h instead of 9h. When the day has real
 * 休憩 punches those are authoritative and this is skipped entirely.
 *
 * Also only ever converts `working` time — the previous version rewrote whatever
 * overlapped the window, so a day with no attendance at all still drew a lunch band.
 */
function applyAssumedNoonBreak(segments) {
  const nb = NOON_BREAK_MINUTES.start;
  const ne = NOON_BREAK_MINUTES.end;
  const out = [];

  for (const segment of segments) {
    const { start, end, state } = segment;
    if (end <= start) continue;
    if (state !== 'working' || end <= nb || start >= ne) {
      out.push(segment);
      continue;
    }
    if (start < nb) out.push({ start, end: Math.min(end, nb), state });
    const lunchStart = Math.max(start, nb);
    const lunchEnd = Math.min(end, ne);
    if (lunchStart < lunchEnd) out.push({ start: lunchStart, end: lunchEnd, state: 'noon' });
    if (end > ne) out.push({ start: Math.max(start, ne), end, state });
  }

  return out;
}

/**
 * The day's spans with rest time resolved: real 休憩 punches when present,
 * otherwise the assumed noon band.
 */
function getResolvedDaySegments(entries) {
  const { segments } = analyzePunchDay(entries);
  return hasRecordedBreaks(entries) ? segments : applyAssumedNoonBreak(segments);
}

/** Punches whose label contradicts Jobcan's in/out toggle — a 打刻エラー day. */
function getPunchAnomalies(entries) {
  return analyzePunchDay(entries).anomalies;
}

/** Clip a segment to the drawable axis window; returns null if fully outside. */
function clampSegmentToAxis(segment, axis) {
  const start = Math.max(axis.start, segment.start);
  const end = Math.min(axis.end, segment.end);
  if (end <= start) return null;
  return { start, end, state: segment.state };
}

/**
 * When the 8-hour target is (or was) reached.
 *
 * Historical when it has already happened — walk the working spans until the target
 * is consumed, which gives the actual minute it was hit. Otherwise projected forward
 * from now, assuming work continues uninterrupted; the caller labels it as an
 * estimate. Returns null before any work is recorded, since there is nothing to
 * project from.
 */
function getTargetCompletion(entries) {
  const target = WORK_HOURS.targetMinutes;
  if (target <= 0) return null;

  const working = getResolvedDaySegments(entries).filter((s) => s.state === 'working');
  let accumulated = 0;

  for (const span of working) {
    const length = span.end - span.start;
    if (accumulated + length >= target) {
      return { minutes: span.start + (target - accumulated), projected: false };
    }
    accumulated += length;
  }

  if (accumulated <= 0) return null;

  // Only project while the person is actually at work. Projecting forward from now
  // for someone who clocked out hours ago advertises a finish time for a day that
  // has already ended.
  const stateNow = getWorkStateAtNow(entries);
  if (stateNow !== 'working' && stateNow !== 'break') return null;

  const now = new Date();
  const projected = (now.getHours() * 60) + now.getMinutes() + (target - accumulated);
  if (projected > 24 * 60) return null;
  return { minutes: projected, projected: true };
}

/** The day's state as of this minute: `working`, `break`, `noon` or `off`. */
function getWorkStateAtNow(entries) {
  const now = new Date();
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  if (nowMinutes <= 0) return 'off';
  // The segment list is split at `now`, so look just before it for the live state.
  const probe = nowMinutes - 1;
  const current = getResolvedDaySegments(entries)
    .find((segment) => segment.start <= probe && segment.end > probe);
  return current ? current.state : 'off';
}

function renderTargetMarker(track, entries, axis) {
  const marker = track.querySelector('.work-target-marker');
  if (!marker) return;

  const completion = getTargetCompletion(entries);
  const percent = completion ? axisPercent(completion.minutes, axis) : -1;

  if (!completion || percent < 0 || percent > 100) {
    marker.classList.remove('is-visible');
    marker.removeAttribute('title');
    return;
  }

  marker.classList.add('is-visible');
  marker.classList.toggle('is-projected', completion.projected);
  marker.style.left = `${percent}%`;
  marker.title = completion.projected
    ? `${formatWorkedDurationMinutes(WORK_HOURS.targetMinutes)}到達見込み ${formatMinutesAsClock(completion.minutes)}`
    : `${formatWorkedDurationMinutes(WORK_HOURS.targetMinutes)}到達 ${formatMinutesAsClock(completion.minutes)}`;
}

/**
 * Ticks on the track plus their labels underneath. Both ends are always labelled so
 * the window is readable at a glance, with interior labels at round intervals;
 * interior ticks that would collide with an end label are dropped.
 */
function renderAxisScale(progressContainer, axis) {
  const track = progressContainer.querySelector('.work-progress-track');
  const scaleRow = progressContainer.querySelector('.work-progress-scale');
  if (!track || !scaleRow) return;

  const trackWidthPx = Math.max(track.clientWidth || 0, 1);
  const step = getAxisTickStep(axis, trackWidthPx);

  // Width is part of the signature (bucketed, so a pixel of resize is not a
  // rebuild) because label density depends on it.
  const signature = `${axis.start}-${axis.end}-${step}-${Math.round(trackWidthPx / 24)}`;
  if (track.dataset.axisSignature === signature) return;
  track.dataset.axisSignature = signature;

  track.querySelectorAll('.time-scale-marker').forEach((node) => node.remove());
  scaleRow.innerHTML = '';

  const points = [{ minutes: axis.start, edge: 'first' }];
  for (let minutes = Math.ceil(axis.start / step) * step; minutes < axis.end; minutes += step) {
    if (minutes > axis.start) points.push({ minutes, edge: null });
  }
  points.push({ minutes: axis.end, edge: 'last' });

  points.forEach((point) => {
    const percent = axisPercent(point.minutes, axis);

    // The tick is a hairline and never collides, so every step position gets one.
    const tick = document.createElement('div');
    tick.className = 'time-scale-marker';
    tick.style.left = `${percent}%`;
    track.appendChild(tick);

    // The label is ~40px wide and the two ends are aligned inward, so an interior
    // label too close to an end would overlap it — that is what put "21:0022:00" on
    // the card. Drop the label, keep the tick.
    const distanceFromEndPx = Math.min(percent, 100 - percent) / 100 * trackWidthPx;
    if (!point.edge && distanceFromEndPx < AXIS_LABEL_MIN_SPACING_PX) return;

    const label = document.createElement('span');
    label.className = 'work-progress-scale-label';
    if (point.edge) label.classList.add(`is-${point.edge}`);
    label.style.left = `${percent}%`;
    label.textContent = formatMinutesAsClock(point.minutes);
    scaleRow.appendChild(label);
  });
}

function formatMinutesAsClock(totalMinutes) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatWorkedDurationMinutes(totalMinutes) {
  const m = Math.max(0, Math.floor(totalMinutes));
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h > 0 && min > 0) return `${h}時間 ${min}分`;
  if (h > 0) return `${h}時間`;
  return `${min}分`;
}

/**
 * Worked minutes today: `working` spans only, so both recorded 休憩 and the assumed
 * noon band drop out. Uses the unclamped segments, so work before 06:00 counts.
 */
function getWorkedMinutesToday(entries) {
  return getResolvedDaySegments(entries)
    .filter((s) => s.state === 'working')
    .reduce((acc, s) => acc + (s.end - s.start), 0);
}

function getOrCreateWorkScheduleLayer(track) {
  let layer = track.querySelector('.work-schedule-layer');
  if (layer) return layer;

  layer = document.createElement('div');
  layer.className = 'work-schedule-layer';
  track.prepend(layer);
  return layer;
}

function renderWorkScheduleSegments(track, entries, axis) {
  if (!track) return;
  const layer = getOrCreateWorkScheduleLayer(track);
  layer.innerHTML = '';

  const trackWidth = Math.max(track.clientWidth || 0, 1);
  void layer.offsetWidth;
  const computedTrackStyle = window.getComputedStyle(track);
  const boundaryGapPxFromVar = parseFloat(computedTrackStyle.getPropertyValue('--work-segment-boundary-gap')) || 0;
  const dotNormal =
    parseFloat(computedTrackStyle.getPropertyValue('--work-dot-normal-width')) || 0;
  const boundaryGapPx = Math.max(boundaryGapPxFromVar, dotNormal);
  const layerWidthPx = Math.max(layer.clientWidth || trackWidth - dotNormal - 2, 1);
  const boundaryGapPercent = (boundaryGapPx / layerWidthPx) * 100;
  // Segments are built in absolute minutes, so clip them to the axis for drawing.
  const visibleSegments = getResolvedDaySegments(entries)
    .map((segment) => clampSegmentToAxis(segment, axis))
    .filter(Boolean);

  visibleSegments.forEach((segment, visIndex) => {
    const segmentNode = document.createElement('div');
    segmentNode.className = `work-schedule-segment segment-${segment.state}`;
    if (segment.state === 'noon') {
      segmentNode.title = '昼休憩 13:00–14:00（打刻がないため推定）';
    } else if (segment.state === 'break') {
      segmentNode.title = `休憩 ${formatMinutesAsClock(segment.start)}–${formatMinutesAsClock(segment.end)}`;
    }

    let left = axisPercent(segment.start, axis);
    let right = axisPercent(segment.end, axis);

    // Visible gaps only between consecutive *drawn* bands (avoids wrong edges when array slots are skipped).
    if (visIndex > 0) left += boundaryGapPercent / 2;
    if (visIndex < visibleSegments.length - 1) right -= boundaryGapPercent / 2;

    left = Math.max(0, Math.min(100, left));
    right = Math.max(0, Math.min(100, right));
    const width = Math.max(0, right - left);
    segmentNode.style.left = `${left}%`;
    segmentNode.style.width = `${width}%`;

    layer.appendChild(segmentNode);
  });
}

function getPunchMarkerTooltipElement() {
  let tooltip = document.getElementById('jbe-punch-tooltip');
  if (tooltip) return tooltip;

  tooltip = document.createElement('div');
  tooltip.id = 'jbe-punch-tooltip';
  tooltip.className = 'jbe-punch-tooltip';
  document.body.appendChild(tooltip);
  return tooltip;
}

function showPunchMarkerTooltip(text, clientX, clientY) {
  const tooltip = getPunchMarkerTooltipElement();
  tooltip.textContent = text;
  tooltip.classList.add('visible');

  const gap = 12;
  const rect = tooltip.getBoundingClientRect();
  let left = clientX - (rect.width / 2);
  let top = clientY - rect.height - gap;

  if (left < 8) left = 8;
  if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if (top < 8) top = clientY + gap;

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function hidePunchMarkerTooltip() {
  const tooltip = document.getElementById('jbe-punch-tooltip');
  if (!tooltip) return;
  tooltip.classList.remove('visible');
}

/**
 * Read today's punches from storage and repaint the track.
 *
 * Strictly one-directional: fetch -> cache -> render. It used to end by calling
 * updateWorkProgressBar(), which itself ended by calling back into here; that only
 * terminated because the throttle stamp is written before the async read, so any
 * reordering of those two lines would have turned it into an unbounded loop.
 * updateWorkProgressBar() is now render-only and never fetches.
 */
function refreshPunchMarkers(container, force) {
  const progressContainer = container.querySelector('.work-progress-container');
  const track = progressContainer ? progressContainer.querySelector('.work-progress-track') : null;
  if (!track) return;

  if (!chrome?.storage?.local?.get) {
    container._punchDataState = 'unavailable';
    updateWorkProgressBar(container);
    return;
  }

  const now = Date.now();
  const lastFetchAt = Number(container.dataset.lastPunchRenderAt || '0');
  if (!force && now - lastFetchAt < 60 * 1000) return;
  container.dataset.lastPunchRenderAt = String(now);

  chrome.storage.local.get(['jobcanPunchListData'], (result) => {
    const payload = result.jobcanPunchListData;
    const hasPayload = !!(payload && Array.isArray(payload.entries));
    const targetEntries = hasPayload ? filterTodayPunchEntries(payload.entries) : [];

    container._cachedPunchEntries = targetEntries;
    container._punchFetchedAt = hasPayload ? Number(payload.fetchedAt) || 0 : 0;
    // `unavailable` and `empty` used to be indistinguishable from a normal day with
    // no work yet: all three drew a full-width off bar and read 本日勤務 0分.
    container._punchDataState = !hasPayload
      ? 'unavailable'
      : (targetEntries.length === 0 ? 'empty' : 'ok');

    renderProgressTrack(container, targetEntries);
    updateWorkProgressBar(container);
  });
}

/**
 * Repaint everything on the track that depends on the axis window. Single entry
 * point so the axis is resolved once and every layer is mapped with the same window.
 */
function renderProgressTrack(container, entries) {
  const progressContainer = container.querySelector('.work-progress-container');
  const track = progressContainer ? progressContainer.querySelector('.work-progress-track') : null;
  if (!track) return;

  const axis = getAxisWindow(entries);
  container._axis = axis;

  renderAxisScale(progressContainer, axis);
  renderWorkScheduleSegments(track, entries, axis);
  renderPunchMarkers(track, entries, axis);
  renderTargetMarker(track, entries, axis);
}

function triggerPunchListRefresh() {
  if (window.__jbe_punchListRefreshRequested) return;
  window.__jbe_punchListRefreshRequested = true;

  if (typeof window.loadPunchListData === 'function') {
    window.loadPunchListData().catch((error) => {
      console.debug('Punch list refresh skipped:', error?.message || error);
    });
  }
}

// Normalize time format to HH:MM:SS
function normalizeTimeFormat(timeString) {
  if (/^\d{2}:\d{2}:\d{2}$/.test(timeString)) return timeString;
  const parts = timeString.split(':');
  if (parts.length === 2) return `${parts[0].padStart(2,'0')}:${parts[1].padStart(2,'0')}:00`;
  return '00:00:00';
}

function applyClockSettingsToContainer(container, settings) {
  const clockSize = settings.clockSize || 'medium';
  const showSeconds = settings.showSeconds !== false;
  const showProgressBar = settings.showProgressBar !== false;

  // Every setting is expressed as one attribute on the container and resolved by
  // CSS (see the [data-show-seconds='false'] rules in styles.css). This function
  // runs on every applyEnhancements() pass — roughly once a second — so it must
  // not walk the digits: it used to write 8 inline styles per digit per pass, all
  // of which the stylesheet could do for free. Writing an unchanged dataset value
  // is a no-op in the DOM, so the steady-state path now costs nothing.
  container.dataset.clockSize = clockSize;
  container.dataset.showSeconds = showSeconds ? 'true' : 'false';

  const prog = container.querySelector('.work-progress-container');
  if (prog) prog.classList.toggle('hidden', !showProgressBar);

  updateFlipClockColors(container);
}

// Apply saved clock settings (size, seconds toggle, progress bar visibility)
function applyClockSettings(specificContainer = null) {
  // Bail before touching storage when there is no clock on the page — this runs
  // on every applyEnhancements() pass, including on pages that have no clock.
  const containers = specificContainer
    ? [specificContainer]
    : Array.from(document.querySelectorAll('.flip-clock-container'));
  if (!containers.length) return;

  getClockSettings().then((settings) => {
    containers.forEach((container) => {
      applyClockSettingsToContainer(container, settings);
    });
  });
}

function updateClockSettings(settings = {}) {
  getClockSettings().then((stored) => {
    const merged = {
      clockSize: settings.clockSize ?? stored.clockSize ?? 'medium',
      showSeconds: settings.showSeconds ?? stored.showSeconds,
      showProgressBar: settings.showProgressBar ?? stored.showProgressBar
    };

    // The popup writes to storage.sync and messages us in parallel, so seed the
    // cache with what it just told us rather than racing the onChanged event.
    cachedClockSettings = { ...stored, ...merged };

    document.querySelectorAll('.flip-clock-container').forEach((container) => {
      applyClockSettingsToContainer(container, merged);
    });
  });
}

/**
 * Map #working_status label to flip-digit color class.
 * Keeps previous class when text is momentarily empty (DOM churn) so colors stay stable.
 */
function resolveClockColorClassFromStatus(statusEl, fallbackClass) {
  const safeFallback = fallbackClass || 'style-gradient';
  if (!statusEl) return safeFallback;

  const raw = (statusEl.textContent || '').replace(/\s+/g, ' ').trim();
  if (!raw) return safeFallback;

  const lower = raw.toLowerCase();

  // On duty: Jobcan may show 勤務中 or 入室中 (or 出勤中); any of these → working colors
  const isWorking =
    raw.includes('勤務中') ||
    raw.includes('入室中') ||
    raw.includes('出勤中') ||
    lower.includes('working');

  const isNotWorking =
    raw.includes('退室中') ||
    raw.includes('未出勤') ||
    lower.includes('not arrived');

  if (isWorking) return 'style-working';
  if (isNotWorking) return 'style-not-working';
  return 'style-gradient';
}

function ensureWorkingStatusObserver() {
  if (window.__jbe_workingStatusObserverInited) return;

  const bind = (el) => {
    if (!el || el.dataset.jbeStatusObserved === 'true') return;
    el.dataset.jbeStatusObserved = 'true';
    const obs = new MutationObserver(() => {
      document.querySelectorAll('.flip-clock-container').forEach((c) => {
        updateFlipClockColors(c);
        celebrateTransitionOnce(c);
      });
    });
    obs.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'data-status', 'title']
    });
    window.__jbe_workingStatusObserverInited = true;
  };

  const tryBind = () => {
    const el = document.getElementById('working_status');
    if (el) {
      bind(el);
      return true;
    }
    return false;
  };

  if (tryBind()) return;

  const mo = new MutationObserver(() => {
    if (tryBind()) mo.disconnect();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

// New function to determine working status colors and update the clock
function updateFlipClockColors(container) {
  // Remember previously applied color to detect changes
  const previousColorClass = container?.dataset?.clockColorClass || '';
  const workingStatus = document.getElementById('working_status');
  const colorClass = resolveClockColorClassFromStatus(workingStatus, previousColorClass);
  
  // Find the digits container
  const digitsContainer = container.querySelector('.flip-clock-digits-container');
  if (!digitsContainer) return;

  // Steady-state fast path: this is reached from applyClockSettings() on every
  // applyEnhancements() pass as well as from the #working_status observer, and the
  // status almost never changes between calls. The digit check keeps the guard
  // honest if the digits were rebuilt after the class was recorded.
  const firstDigit = digitsContainer.querySelector('.flip-clock-digit');
  if (previousColorClass === colorClass && firstDigit && firstDigit.classList.contains(colorClass)) {
    return;
  }

  // Update digit colors by changing classes
  const digitElements = digitsContainer.querySelectorAll('.flip-clock-digit');
  digitElements.forEach(digit => {
    // Remove existing style classes
    digit.classList.remove('style-gradient', 'style-working', 'style-not-working');
    // Apply the new class
    digit.classList.add(colorClass);
  });
  
  // Update colon colors by class
  const colonElements = digitsContainer.querySelectorAll('.colon');
  colonElements.forEach(colon => {
    colon.classList.remove('colon-default', 'colon-working', 'colon-not-working');
    const colonClass =
      colorClass === 'style-gradient'
        ? 'colon-default'
        : colorClass.replace('style-', 'colon-');
    colon.classList.add(colonClass || 'colon-default');
  });

  // Persist the applied color class. Confetti is intentionally NOT triggered here:
  // this runs on every #working_status mutation (Jobcan re-renders the status on its
  // SPA), so firing on color change made the confetti loop for minutes. Celebration
  // is gated through celebrateTransitionOnce() instead.
  container.dataset.clockColorClass = colorClass;
}

/**
 * Coarse work state derived from #working_status: 'working' | 'not-working' | 'unknown'.
 * 'unknown' covers the transient empty/gradient states during Jobcan's DOM churn.
 */
function getCoarseWorkState() {
  const el = document.getElementById('working_status');
  const cls = resolveClockColorClassFromStatus(el, '');
  if (cls === 'style-working') return 'working';
  if (cls === 'style-not-working') return 'not-working';
  return 'unknown';
}

/**
 * Fire the celebration confetti at most once per genuine clock-in/out transition.
 * Guards against the old runaway loop: ignores 'unknown' churn, only fires on a
 * known -> known state change, and applies a cooldown so multiple observers/handlers
 * firing for the same punch celebrate once. The baseline persists in sessionStorage
 * so reloading the page while already 勤務中 does not re-celebrate.
 */
function celebrateTransitionOnce(container) {
  if (!container) return;
  const state = getCoarseWorkState();
  if (state === 'unknown') return; // transient churn: never celebrate, never move baseline

  let prev = window.__jbe_lastCelebratedWorkState;
  if (prev === undefined) {
    try { prev = sessionStorage.getItem('jbe_lastCelebratedWorkState') || undefined; } catch (_) { /* sessionStorage unavailable */ }
  }

  // Advance the baseline to the latest known state.
  window.__jbe_lastCelebratedWorkState = state;
  try { sessionStorage.setItem('jbe_lastCelebratedWorkState', state); } catch (_) { /* ignore */ }

  // No prior baseline (first known observation) or no change -> just initialize, no confetti.
  if (!prev || prev === state) return;

  // A hidden tab paints nothing, and canvas-confetti drives itself off
  // requestAnimationFrame — the burst would sit queued and then fire minutes later
  // when the tab is revealed. The baseline has already advanced above, so the
  // transition is simply recorded as celebrated and no stale burst is owed.
  if (document.hidden) return;

  // Genuine transition: cooldown de-dupes the observer + click backups for one punch.
  const now = Date.now();
  if (window.__jbe_lastCelebrateTs && now - window.__jbe_lastCelebrateTs < 4000) return;
  window.__jbe_lastCelebrateTs = now;

  setTimeout(() => {
    createParticleEffect(container);
    setTimeout(() => createBurstParticleEffect(container), 200);
  }, 50);
}

// Helper function for random values
function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

// Create confetti effects around the clock
function createParticleEffect(clockContainer) {
  if (!clockContainer) return;
  
  // Check if confetti is available
  if (typeof confetti === 'undefined') {
    console.warn('Confetti library not loaded');
    return;
  }
  
  // Get the position of the clock container relative to the viewport
  const clockRect = clockContainer.getBoundingClientRect();
  const originX = (clockRect.left + clockRect.width / 2) / window.innerWidth;
  const originY = (clockRect.top + clockRect.height / 2) / window.innerHeight;
  
  // Trigger confetti with random direction
  confetti({
    angle: randomInRange(55, 125),
    spread: randomInRange(50, 70),
    particleCount: randomInRange(50, 100),
    origin: { x: originX, y: originY },
    colors: getCelebrationColors(),
    ticks: 200,
    gravity: 1,
    decay: 0.94,
    startVelocity: 30,
    shapes: ['circle', 'square'],
    scalar: 1
  });
  
  // Add celebration effect to the clock
  clockContainer.classList.add('celebrating');
  
  // Remove celebration class after animation
  setTimeout(() => {
    clockContainer.classList.remove('celebrating');
  }, 600);
}

// Enhanced confetti effect with burst animation
function createBurstParticleEffect(clockContainer) {
  if (!clockContainer) return;
  
  // Check if confetti is available
  if (typeof confetti === 'undefined') {
    console.warn('Confetti library not loaded');
    return;
  }
  
  // Get the position of the clock container relative to the viewport
  const clockRect = clockContainer.getBoundingClientRect();
  const originX = (clockRect.left + clockRect.width / 2) / window.innerWidth;
  const originY = (clockRect.top + clockRect.height / 2) / window.innerHeight;
  
  // Create burst effect with multiple random confetti bursts
  const burstCount = 3;
  for (let i = 0; i < burstCount; i++) {
    setTimeout(() => {
      confetti({
        angle: randomInRange(55, 125),
        spread: randomInRange(50, 70),
        particleCount: randomInRange(30, 50),
        origin: { x: originX, y: originY },
        colors: getCelebrationColors(),
        ticks: 150,
        gravity: 1.2,
        decay: 0.92,
        startVelocity: 25,
        shapes: ['circle', 'square'],
        scalar: 0.8
      });
    }, i * 100);
  }
}

// Expose public API. createParticleEffect / createBurstParticleEffect used to be
// exposed here too, but their only external consumer was ui.js's unreachable
// `testParticleEffects` debug handler; clock.js calls them directly as file-scope
// globals. addPushButtonParticleEffects went with them — it was documented as
// "kept for the popup's debug/test hook", and that hook never existed. The
// delegated click listener below is what actually wires push-button celebrations.
window.setupFlipClock = setupFlipClock;
window.applyClockSettings = applyClockSettings;
window.updateClockSettings = updateClockSettings;

// On initial load, refresh clock colors and wire push-button particle effects.
document.addEventListener('DOMContentLoaded', () => {
  // Initial color sync. celebrateTransitionOnce here only sets the baseline state
  // (no confetti on first observation), so a fresh load never celebrates on its own.
  document.querySelectorAll('.flip-clock-container').forEach(container => {
    updateFlipClockColors(container);
    celebrateTransitionOnce(container);
  });

  // Trigger particle effects on push-button clicks via ONE delegated listener.
  // This replaces the old approach (attach per-button listeners, then re-scan
  // every 2s with setInterval to catch dynamically-added buttons): delegation
  // covers current and future buttons with no polling.
  if (!window.__jbe_particleDelegationBound) {
    window.__jbe_particleDelegationBound = true;
    const PUSH_SELECTOR = '#adit-button-push, .adit-button-push, [id*="push"], [class*="push"], button[onclick*="push"], input[type="submit"][value*="出勤"], input[type="submit"][value*="退勤"]';
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(PUSH_SELECTOR) : null;
      if (!btn) return;
      document.querySelectorAll('.flip-clock-container').forEach(container => {
        // The #working_status MutationObserver is the primary celebration trigger;
        // these are a defensive backup for the post-punch status flip. The cooldown
        // in celebrateTransitionOnce prevents any double-fire.
        updateFlipClockColors(container);
        setTimeout(() => celebrateTransitionOnce(container), 500);
        setTimeout(() => { updateFlipClockColors(container); celebrateTransitionOnce(container); }, 1500);
      });
    });
  }
});
