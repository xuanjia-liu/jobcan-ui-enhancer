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

// In-memory cache of the clock settings. applyClockSettings() is called from
// every applyEnhancements() pass — which the debounced body observer
// re-triggers roughly once a second during DOM churn — and each call used to be
// its own chrome.storage.sync.get round-trip. The cache is invalidated by the
// storage.onChanged listener below, so the popup's writes still land immediately.
const CLOCK_SETTING_KEYS = ['clockSize', 'showProgressBar', 'clockBackground'];
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
  // The two :not() exclusions are our own rows, which live in the same
  // `.display-2` as the clock now: the stats row permanently, the PUSH row
  // transiently while a clock rebuild evacuates it. Without them this selector
  // matches those divs as "clock elements" and consumes them.
  const clockElements = document.querySelectorAll('#clock, #display-time, .display-2 > div:not(.flip-clock-container):not(.jbe-work-stats):not(.jbe-punch-actions)');
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
    // The PUSH row is Jobcan's own controls, moved inside the card by
    // punchCard.js — park it back outside first so a clock rebuild can never
    // destroy the native button. punchCard re-places it on its next pass.
    const actions = container.querySelector('.jbe-punch-actions');
    if (actions) parentElement.insertBefore(actions, container);
    cleanupClockContainer(container);
    container.remove();
  });
  // The stats row is a sibling of the container (see below), so the rebuild has
  // to remove it explicitly — removing the container no longer takes it along.
  parentElement.querySelectorAll(':scope > .jbe-work-stats').forEach((row) => row.remove());

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

  progressContainer.appendChild(progressTrack);
  progressContainer.appendChild(scaleRow);
  progressContainer.appendChild(createProgressLegend());
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
  // Summary tiles sit above the card, on the page background, as their own row.
  // .jbe-work-stats is its own container-query context now (same width as the
  // card, so the tiles' cqi values resolve as before), and the rebuild cleanup
  // above removes it together with the clock container.
  parentElement.appendChild(createWorkStatsRow());
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
    if (!isSeconds) {
      container.appendChild(group);
      return;
    }
    // The seconds pair sits at the bottom of the row with the working-status pill
    // stacked above it (punchCard.js fills the slot). Wrapping rather than
    // positioning keeps the digits in document order, which the tick cache and the
    // colour sync both rely on — they read a flat querySelectorAll.
    const stack = document.createElement('div');
    stack.className = 'flip-seconds-stack';
    stack.appendChild(group);
    container.appendChild(stack);
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
  // The summary tiles are outside the progress panel and must refresh even when the
  // panel is hidden by the popup's setting, so they are updated before the bail-outs.
  updateWorkStatsRow(container, container._punchDataState || 'loading');

  const progressContainer = container.querySelector('.work-progress-container');
  if (!progressContainer) return;

  // Cache elements if not already cached. There is no `.work-progress-fill` any
  // more: it had no CSS at all (no height, no background), so it rendered nothing
  // — the coloured bands come from `.work-schedule-layer`. Its `progress-state-*`
  // classes were equally unstyled. The `.work-progress-percentage` status line is
  // gone too: worked time, progress and remaining time all read off the summary
  // tiles now, and the two wordings could only ever repeat each other.
  if (!progressContainer._cachedElements) {
    progressContainer._cachedElements = {
      track: progressContainer.querySelector('.work-progress-track'),
      indicator: progressContainer.querySelector('.work-progress-indicator')
    };
  }

  const { indicator } = progressContainer._cachedElements;

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

  // Batch DOM updates to avoid multiple reflows. The `data-punch-state` /
  // `data-punch-anomaly` attributes that used to be written here are gone with the
  // panel's surface: both cues now live on the summary tiles, which is where the
  // wording they annotated ended up.
  requestAnimationFrame(() => {
    // Update indicator position if it exists
    if (indicator) {
      indicator.style.left = `${progress}%`;
      indicator.title = `現在時刻 ${now.toTimeString().slice(0,5)}`;
    }
  });
}

/* ---- Timeline legend ------------------------------------------------------
 * Row under the axis: one entry per segment state ACTUALLY DRAWN on the bar,
 * plus the current-time indicator (which is always on the track). The swatches
 * are colored by the same tokens as the segments themselves (see
 * .work-legend-swatch in styles.css), so the legend can never drift from the bar.
 *
 * Every entry is built once and then shown/hidden per render rather than
 * rebuilt: renderWorkScheduleSegments() runs on every tick and every resize, and
 * a legend that re-created its nodes would feed the body-wide MutationObserver in
 * main.js each time.
 */

const PROGRESS_LEGEND_ITEMS = [
  { state: 'working', label: '勤務時間' },
  { state: 'break', label: '休憩時間' },
  { state: 'noon', label: '休憩（推定）' },
  { state: 'off', label: '未確定' },
  { state: 'now', label: '現在時刻' }
];

function createProgressLegend() {
  const legend = document.createElement('div');
  legend.className = 'work-progress-legend';
  PROGRESS_LEGEND_ITEMS.forEach((item) => {
    const entry = document.createElement('span');
    entry.className = 'work-legend-item';
    entry.dataset.legendState = item.state;
    // Hidden until a render reports which states the bar drew — otherwise the
    // full row would flash on load and settle to a shorter one.
    entry.hidden = item.state !== 'now';
    const swatch = document.createElement('span');
    swatch.className = `work-legend-swatch legend-${item.state}`;
    entry.appendChild(swatch);
    entry.appendChild(document.createTextNode(item.label));
    legend.appendChild(entry);
  });
  return legend;
}

/**
 * Show only the entries whose state appears on the bar. `now` always stays: the
 * indicator is created unconditionally and is never hidden.
 * @param {HTMLElement} track the .work-progress-track the segments were drawn in
 * @param {Set<string>} drawnStates segment states present in this render
 */
function syncProgressLegend(track, drawnStates) {
  const container = track && track.closest('.work-progress-container');
  const legend = container && container.querySelector('.work-progress-legend');
  if (!legend) return;
  legend.querySelectorAll('.work-legend-item').forEach((entry) => {
    const state = entry.dataset.legendState;
    const shouldShow = state === 'now' || drawnStates.has(state);
    if (entry.hidden === !shouldShow) return; // no-op writes still cost a mutation record
    entry.hidden = !shouldShow;
  });
}

/* ---- Summary tiles -------------------------------------------------------
 * A four-tile readout above the digits: worked time, progress against the daily
 * target, remaining time, and when the target is (or was) reached. Every figure
 * comes from the same punch entries and the same segment analysis as the progress
 * bar's status line, so the two can never disagree.
 */

const WORK_STAT_TILES = [
  { key: 'worked', label: '本日勤務時間', icon: 'clock' },
  { key: 'progress', label: '定時進捗率', icon: 'pie' },
  { key: 'remaining', label: '残り時間', icon: 'flag' },
  { key: 'finish', label: '目標達成時刻', icon: 'calendar' }
];

/** Inline SVGs — no external assets, and `currentColor` follows the theme. */
const WORK_STAT_ICONS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M12 3v9h9A9 9 0 0 0 12 3z"/>',
  flag: '<path d="M5 21V4"/><path d="M5 5h11l-1.6 3L16 11H5z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'
};

function createWorkStatsRow() {
  const row = document.createElement('div');
  row.className = 'jbe-work-stats';

  WORK_STAT_TILES.forEach((tile) => {
    const node = document.createElement('div');
    node.className = 'jbe-stat-tile';
    node.dataset.stat = tile.key;

    const icon = document.createElement('span');
    icon.className = 'jbe-stat-icon';
    icon.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
      `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WORK_STAT_ICONS[tile.icon]}</svg>`;

    const body = document.createElement('div');
    body.className = 'jbe-stat-body';

    const label = document.createElement('span');
    label.className = 'jbe-stat-label';
    label.textContent = tile.label;

    const value = document.createElement('span');
    value.className = 'jbe-stat-value';
    value.textContent = '—';

    const sub = document.createElement('span');
    sub.className = 'jbe-stat-sub';

    body.appendChild(label);
    body.appendChild(value);

    if (tile.key === 'progress') {
      const bar = document.createElement('span');
      bar.className = 'jbe-stat-bar';
      const fill = document.createElement('span');
      fill.className = 'jbe-stat-bar-fill';
      bar.appendChild(fill);
      body.appendChild(bar);
    } else {
      body.appendChild(sub);
    }

    node.appendChild(icon);
    node.appendChild(body);
    row.appendChild(node);
  });

  return row;
}

/** Write `text` only when it differs — this runs on every progress tick. */
function setStatText(tile, selector, text) {
  const node = tile ? tile.querySelector(selector) : null;
  if (!node) return;
  if (node.textContent !== text) node.textContent = text;
}

function updateWorkStatsRow(container, state) {
  // The stats row is a sibling of the clock container, not a child — see
  // createSelfAnimatingClock.
  const scope = container.parentElement || container;
  const row = scope.querySelector('.jbe-work-stats');
  if (!row) return;

  const tiles = {};
  WORK_STAT_TILES.forEach((tile) => {
    tiles[tile.key] = row.querySelector(`.jbe-stat-tile[data-stat="${tile.key}"]`);
  });

  if (row.dataset.punchState !== state) row.dataset.punchState = state;

  // Anything other than a successful read has no numbers to show. Blanking the
  // values and saying why beats presenting 0時間 as if it were measured.
  if (state !== 'ok') {
    const reason = state === 'loading'
      ? '読み込み中'
      : state === 'empty' ? '打刻なし' : '取得できません';
    WORK_STAT_TILES.forEach((tile) => {
      setStatText(tiles[tile.key], '.jbe-stat-value', '—');
      setStatText(tiles[tile.key], '.jbe-stat-sub', reason);
    });
    const fill = row.querySelector('.jbe-stat-bar-fill');
    if (fill) fill.style.width = '0%';
    return;
  }

  const entries = container._cachedPunchEntries || [];
  const target = WORK_HOURS.targetMinutes;
  const worked = getWorkedMinutesToday(entries);
  const percent = target > 0 ? Math.round((worked / target) * 100) : 0;
  const remaining = Math.max(0, target - worked);
  const over = Math.max(0, worked - target);
  const workState = getWorkStateAtNow(entries);

  setStatText(tiles.worked, '.jbe-stat-value', formatWorkedDurationMinutes(worked));
  setStatText(tiles.worked, '.jbe-stat-sub', describeWorkedSpan(entries, workState, container));
  // The two warnings the removed status line used to carry. A contradicted punch
  // means Jobcan will not settle the day, so the figures above it are provisional.
  const anomalies = getPunchAnomalies(entries);
  if (tiles.worked) {
    tiles.worked.dataset.warn = anomalies.length > 0 ? 'anomaly' : '';
    const first = anomalies[0];
    const warning = first
      ? `打刻エラー: ${formatMinutesAsClock(first.minutes)} の${first.type}が入室として扱われています`
      : '';
    if (tiles.worked.title !== warning) tiles.worked.title = warning;
  }

  setStatText(tiles.progress, '.jbe-stat-value', `${percent}%`);
  const fill = row.querySelector('.jbe-stat-bar-fill');
  if (fill) {
    const width = `${Math.max(0, Math.min(100, percent))}%`;
    if (fill.style.width !== width) fill.style.width = width;
    fill.classList.toggle('is-complete', worked >= target);
  }

  setStatText(
    tiles.remaining,
    '.jbe-stat-value',
    over > 0 ? `+${formatWorkedDurationMinutes(over)}` : formatWorkedDurationMinutes(remaining)
  );
  setStatText(
    tiles.remaining,
    '.jbe-stat-sub',
    over > 0 ? `目標 ${formatWorkedDurationMinutes(target)} 超過` : `目標 ${formatWorkedDurationMinutes(target)}`
  );

  const completion = getTargetCompletion(entries);
  setStatText(tiles.finish, '.jbe-stat-value', completion ? formatMinutesAsClock(completion.minutes) : '—');
  setStatText(
    tiles.finish,
    '.jbe-stat-sub',
    completion ? (completion.projected ? '到達見込み' : '到達済み') : '見込み未定'
  );
}

/**
 * The `06:00 - 現在` style sub-line on the worked-time tile: first punch of the day
 * through either now (still on the clock) or the last recorded punch.
 *
 * Also where staleness is surfaced — showing an hour-old figure as `現在` would be
 * presenting a stale number as live. fetchedAt is written by the punch loader.
 */
function describeWorkedSpan(entries, workState, container) {
  const working = getResolvedDaySegments(entries).filter((s) => s.state === 'working');
  if (!working.length) return '打刻なし';

  const start = formatMinutesAsClock(working[0].start);
  const end = workState === 'working' ? '現在' : formatMinutesAsClock(working[working.length - 1].end);

  const ageMinutes = getPunchDataAgeMinutes(container);
  const stale = ageMinutes !== null && ageMinutes >= STALE_PUNCH_DATA_MINUTES
    ? ` • ${ageMinutes}分前`
    : '';

  return `${start} - ${end}${stale}`;
}

function getPunchDataAgeMinutes(container) {
  const fetchedAt = Number(container._punchFetchedAt) || 0;
  if (!fetchedAt) return null;
  return Math.max(0, Math.floor((Date.now() - fetchedAt) / 60000));
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
 * The axis labels under the track. Both ends are always labelled so the window is
 * readable at a glance, with interior labels at round intervals; an interior label
 * that would collide with an end label is dropped.
 *
 * Each label carries its own dot marking the position on the track (a ::before in
 * styles.css) — the track itself used to hold hairline `.time-scale-marker` divs,
 * which drew over the schedule bands. A dropped label therefore drops its dot too.
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

  scaleRow.innerHTML = '';

  const points = [{ minutes: axis.start, edge: 'first' }];
  for (let minutes = Math.ceil(axis.start / step) * step; minutes < axis.end; minutes += step) {
    if (minutes > axis.start) points.push({ minutes, edge: null });
  }
  points.push({ minutes: axis.end, edge: 'last' });

  points.forEach((point) => {
    const percent = axisPercent(point.minutes, axis);

    // The label is ~40px wide and the two ends are aligned inward, so an interior
    // label too close to an end would overlap it — that is what put "21:0022:00" on
    // the card.
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

/**
 * Tooltip text for one band: what it is, when it ran, and how long it lasted.
 *
 * The `off` band that runs to midnight is the day's remaining time rather than a
 * recorded absence, so it is worded as such — labelling it 退勤 would be asserting
 * a clock-out that has not happened.
 */
function describeScheduleSegment(segment) {
  const span = `${formatMinutesAsClock(segment.start)}–${formatMinutesAsClock(segment.end)}`;
  const duration = formatWorkedDurationMinutes(segment.end - segment.start);

  if (segment.state === 'working') return `勤務 ${span}（${duration}）`;
  if (segment.state === 'break') return `休憩 ${span}（${duration}）`;
  if (segment.state === 'noon') return `昼休憩 ${span}（打刻がないため推定）`;

  const now = new Date();
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  if (segment.start >= nowMinutes) return `未経過 ${span}（${duration}）`;
  return `勤務外 ${span}（${duration}）`;
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
  // `source` is the unclipped span: geometry uses the clamped one, the tooltip
  // reports the real times so a band cut off by the axis edge does not read as if
  // it ended there.
  const visibleSegments = getResolvedDaySegments(entries)
    .map((segment) => {
      const clamped = clampSegmentToAxis(segment, axis);
      return clamped ? { ...clamped, source: segment } : null;
    })
    .filter(Boolean);

  visibleSegments.forEach((segment, visIndex) => {
    const segmentNode = document.createElement('div');
    segmentNode.className = `work-schedule-segment segment-${segment.state}`;

    // Every band gets the same hover treatment, and since the punch dots were
    // removed this is the only way to read a time off the bar. No `title` attribute:
    // it races the styled tooltip below — you would get the custom one immediately
    // and the native one a second later, offset from it.
    const description = describeScheduleSegment(segment.source || segment);
    segmentNode.addEventListener('mouseenter', (e) => {
      showPunchMarkerTooltip(description, e.clientX, e.clientY);
    });
    segmentNode.addEventListener('mousemove', (e) => {
      showPunchMarkerTooltip(description, e.clientX, e.clientY);
    });
    segmentNode.addEventListener('mouseleave', hidePunchMarkerTooltip);

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

  // The legend names what is on the bar, so it follows the bands: a day with no
  // break punch drew no teal band and must not advertise 休憩時間.
  syncProgressLegend(track, new Set(visibleSegments.map((segment) => segment.state)));
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

/* ---- Ambient status background ------------------------------------------
   Four selectable backdrops for the clock card (popup → 表示設定 → 背景アニメーション),
   plus 'none'. Each one is a single <div class="jbe-clock-bg"> prepended to the
   container, and the variant decides what goes inside it:

   * メッシュグラデーション and ゴッドレイ are DOM figures. The builders here lay out the
     pieces (blur orbs, light shafts) and hand their per-element randomness over as
     inline custom properties; css/styles.css does everything else off
     [data-variant]. Nothing runs after mount — every moving part animates transform
     or opacity in CSS, so they cost no JS frames and no layout.
   * ウェーブメッシュ and パーティクル are a single <canvas>, driven by the shared runtime
     below (startClockCanvas). Both port an effect whose look IS per-point maths — a
     lit surface in perspective, a cursor force field — which CSS has no way to
     express. The runtime's block comment covers what that costs and what was cut to
     get it down to a few hundred points at 30fps.

   Colour is NOT decided here. The layer reads --jbe-bg-tint / --jbe-bg-strength,
   which css/styles.css derives from the container's own [data-clock-color-class] —
   the attribute updateFlipClockColors() already maintains from #working_status. So
   勤務中 / 退室中 / pending each tint the background for free, and the tokens stay
   the single source of truth for the state colours. */
const CLOCK_BACKGROUNDS = ['none', 'wave', 'particles', 'mesh', 'godray'];
const DEFAULT_CLOCK_BACKGROUND = 'mesh';

// Old ids, kept so a value already sitting in storage.sync resolves to the rebuilt
// variant instead of silently falling back to the default.
//   aurora → godray: was a striped light-beam wash before it became god rays.
//   blob   → mesh:   was four drifting radial stains ("ブラーブロブ"); it is now a
//                    bottom-anchored mesh gradient, so neither the name nor the id
//                    described it any more.
// 'pulse' (パルス／同心円) and 'orbit' (オービット) were REMOVED, not renamed, so they
// deliberately get no alias — normalizeClockBackground() drops them to the default.
const CLOCK_BACKGROUND_ALIASES = { aurora: 'godray', blob: 'mesh' };

function normalizeClockBackground(value) {
  const resolved = CLOCK_BACKGROUND_ALIASES[value] || value;
  return CLOCK_BACKGROUNDS.includes(resolved) ? resolved : DEFAULT_CLOCK_BACKGROUND;
}

/**
 * Deterministic pseudo-random in [0, 1) from an integer seed.
 *
 * Math.random() is deliberately not used: the clock is rebuilt from scratch on
 * every SPA navigation, so a random field would re-scatter its dots each time and
 * read as the background twitching for no reason. Same seed → same layout, always.
 */
function clockBgNoise(seed) {
  let x = (seed * 1103515245 + 12345) & 0x7fffffff;
  x ^= x >>> 7;
  x = (x * 16807) & 0x7fffffff;
  return x / 0x7fffffff;
}

/* ---- メッシュグラデーション ------------------------------------------------
   Ported from a ParticleSystemWeb export (Downloads/particle-export.svg, emitter
   "Glow", 21 particles). What that file actually is: a wide arc of plain circles
   sitting BELOW the bottom edge, each one Gaussian-blurred so hard
   (stdDeviation 120 against a 66–197px shape) that no particle is legible on its
   own — they only exist as the overlapping wash they add up to. Four properties
   carry the look, and they are the four this builder reproduces:

   1. EMITTED FROM A BOTTOM ARC, NOT SCATTERED. The export's emitter is a circle
      of radius 559 with ratio 0.12, i.e. a ~43° arc at the bottom; every particle
      starts at y 547–710 in a 644-high frame. So the field is dense and bright
      along the bottom edge and thins out upward, which is why it reads as one
      gradient rather than as four separate stains (what this variant used to be).
   2. HUGE SIZE SPREAD. Particle Size 115 with Size Variance 66 → the largest orb
      is ~3× the smallest. A uniform set of blobs reads as a pattern; this does not.
   3. LOW, VARIED ALPHA. Max Opacity 50 with Opacity Variance 64 — no single orb
      is ever more than half-opaque, so the colour everywhere is an accumulation of
      several. Peak alpha per orb is randomised over roughly that same range.
   4. COLOUR RAMPS ALONG THE TRAVEL. The export goes #003BFF → #00EAFF over each
      particle's life (Color Fade Method 2). We must not name colours (see the
      section head in styles.css), so --mix is the per-orb blend position between
      --jbe-bg-tint and --jbe-bg-tint-2 — the same two-stop ramp expressed in the
      state tokens, biased so the higher an orb rides the further along it is.

   Deviations, deliberate:
   * No `filter: blur()`. The export blurs solid circles because SVG has no other
     soft edge; a radial-gradient IS the blurred circle, and it costs nothing to
     move. A real filter on a moving element re-blurs the whole surface per frame.
   * 4.5s lifetime → 30–60s loops, and the rise is a slow drift rather than a
     launch. The export is a marketing render; this sits behind the digits. */
function buildClockBgMesh() {
  // The export's 21, raised: at 18 the orbs read as separate lobes with white
  // between them rather than as one gradient. The export gets away with fewer
  // because its blur radius is larger than its shapes, so every particle's tail
  // reaches its neighbours; a radial-gradient's tail dies at its own box, so the
  // coverage has to come from spacing instead. Two rows (below) do most of that
  // work — this only has to keep each row's own spacing under one orb radius.
  const COUNT = 15;

  // Two rows, and they are what closes the gaps — raising the count of a single row
  // does not. One row's orbs share a rise and a scale cycle, so wherever two
  // neighbours are momentarily apart the hole between them runs the full height of
  // the field and no amount of crowding along the arc fills it. The back row is
  // offset half a slot horizontally (`phase`) so it sits over exactly those seams,
  // and is larger, deeper, fainter and slower, so it also reads as depth rather than
  // as a second copy.
  // Back row FIRST: these are painted in document order, so the front row's smaller,
  // brighter orbs need to come second to sit on top.
  //
  // riseMul is what keeps the closed field from flattening into a stripe. Coverage
  // and structure pull against each other here: enough orbs to leave no holes is
  // also enough to average out into one even band, which is what the first two-row
  // pass did. Giving the front row a much longer travel than the back row puts the
  // two rows at different heights at any moment, so the field keeps a lumpy upper
  // edge — the lobes — while its base stays solid.
  const ROWS = [
    { phase: 0.5, depth: 1, sizeMin: 30, sizeVar: 38, drop: 9,
      alphaMul: 0.72, durMul: 1.45, riseMul: 0.7 },
    { phase: 0, depth: 0, sizeMin: 16, sizeVar: 34, drop: 2,
      alphaMul: 1.15, durMul: 1, riseMul: 1.6 }
  ];

  let html = '';

  for (const row of ROWS) {
    for (let i = 0; i < COUNT; i++) {
      const noise = (offset) => clockBgNoise(6101 + row.depth * 733 + i * 17 + offset);

      // Along the arc: -0.5 … 0.5 of the card width, with the ends pushed outward so
      // the wash bleeds past both edges instead of stopping inside them.
      //
      // The jitter is kept to 0.8 of a slot deliberately. Fully random x would clump —
      // a Poisson gap can be several slots wide, and one such gap is the hole the eye
      // lands on. Even spacing plus a sub-slot wobble is what a blue-noise scatter
      // buys you, without needing one.
      const t = (i + row.phase + noise(1) * 0.8) / COUNT - 0.5;
      const x = (50 + t * 128).toFixed(1);
      // Sagitta of the emitter arc — the ends of a shallow arc sit lower than its
      // middle, which is what keeps the bottom edge from being a straight line.
      // Measured DOWN from the card's bottom edge (CSS uses it as a negative
      // `bottom`), so every orb starts outside and only its upper falloff is in shot.
      const y = (row.drop + t * t * 9 + noise(2) * 4).toFixed(1);

      // 115 ± 66 in the export's units — a 1:3 spread — as a share of the card width.
      //
      // The absolute figures are well below the export's, and deliberately so. Its
      // frame is 938×644; this card is nearer 3:1, and because a container-query unit
      // can only be cqi here (inline-size container), an orb sized to the export's
      // proportions is about three times the card's HEIGHT. Every orb then covers the
      // whole card, the overlaps stop varying, and the mesh flattens into a plain
      // vertical gradient — measured, that is exactly what the first pass did.
      const size = (row.sizeMin + noise(3) * row.sizeVar).toFixed(1);
      // How far up this orb travels over its loop. The small ones go furthest: in the
      // export the near/large particles barely move within the frame and the far ones
      // cross it, which is the whole parallax cue.
      //
      // cqi, NOT %: a percentage inside translate() resolves against the ELEMENT's own
      // size, so a big orb and a small orb given the same figure would travel wildly
      // different distances and the parallax would invert. cqi is a share of the card
      // width — the same basis --sz above is on, which is why the two stay in step at
      // any card size. (cqi and not cqh because .flip-clock-container is
      // `container-type: inline-size`; there is no block-size container here.)
      const rise = ((6 + (1 - noise(3)) * 14) * row.riseMul).toFixed(1);
      const sway = ((noise(4) - 0.5) * 10).toFixed(1);

      const duration = (30 + noise(5) * 30) * row.durMul;
      const delay = (-noise(6) * duration).toFixed(1);
      // Max Opacity 50, Opacity Variance 64. Trimmed from the single-row figures: two
      // rows means roughly twice as many orbs stacked over any given pixel, and left
      // alone the extra coverage reads as the wash getting heavier rather than fuller.
      const alpha = ((0.16 + noise(7) * 0.28) * row.alphaMul).toFixed(2);
      // Blue at the source, cyan by the top — the export's colour-over-life ramp,
      // here as this orb's position between --jbe-bg-tint and --jbe-bg-tint-2. The
      // arc's centre (t≈0) rides highest and so lands furthest along the ramp; a flat
      // random mix reads as one colour with noise on it rather than as a gradient.
      const mix = Math.round(8 + noise(8) * 38 + (1 - t * t) * 44);

      html += `<i class="jbe-bg-orb" style="--sz:${size}cqi;--x:${x}%;--y:${y}cqi;`
        + `--rise:${rise}cqi;--sway:${sway}cqi;--dur:${duration.toFixed(1)}s;`
        + `--delay:${delay}s;--o:${alpha};--mix:${mix}%"></i>`;
    }
  }

  return html;
}

/* ---- God rays -------------------------------------------------------------
   Ported from the God Ray mode of the Shadow Studio Figma plugin
   (~/Desktop/figma plugin/Shadow Studio…/code.ts: buildGodRayPlan,
   godRayShaftPath, godRayMotePaths, godRayStopsFor). Four ideas carry over; the
   rest of that code is Figma vector/gradient plumbing with no CSS analogue.

   1. ONE APEX BEHIND THE SOURCE. Every shaft's centre line converges on a single
      point outside the card, which is what makes the set read as a pencil of rays
      from one light rather than as bands that merely lean. Here that is literal:
      the shafts share a 0×0 wrapper positioned at the apex and each is rotated
      about it, so the geometry cannot drift out of agreement (the plugin has to
      compute `1 + s/D` per shaft to get the same thing).
   2. THE SHAFT IS A TRIANGLE FROM THE APEX, not a trapezoid — width exactly zero
      where the centre lines meet — necking to 12% over its last 12%
      (GODRAY_TIP_FRACTION / GODRAY_TIP_WIDTH there, the clip-path polygon here).
   3. MOTES TRAVEL ALONG THEIR OWN RAY. In the plugin a mote's lateral position is
      `offset * scale(s) ± 0.85 * halfWidth(s)`, i.e. proportional to distance from
      the apex. A CSS transform interpolating `translate(0, 0)` →
      `translate(lateral, length)` is that same proportionality for free, so a mote
      tracks the widening beam exactly instead of drifting out through its edge.
   4. WHITE CORE → TINT → DEEP TINT along the axis, alpha falling as (1-t)^gamma
      (godRayStopsFor's ramp), which is why a shaft reads as light and not as a
      coloured wedge.

   Deviation, deliberate: the plugin's axial ripple is strictly SUBTRACTIVE ("uneven
   dust occludes light, it never adds any") because it composites with SCREEN over
   dark artwork. This card is light, where a dark overlay would just soil it, so the
   ripple here is a bright band travelling up the beam instead. Same read — light
   pulsing through uneven air — in the blend mode we actually have. */
function buildClockBgGodRay() {
  // tilt: degrees clockwise from straight down (the aim axis) — CSS negates it, see
  // .jbe-bg-shaft. hw: the shaft's own HALF-ANGLE of divergence in degrees, which is
  // what the feathered conic mask is cut from. len: multiple of --jbe-ray-scale.
  // alpha: peak brightness. ripple: period. blur: share of the ray scale.
  //
  // Widths are angles rather than lengths because that is what a shaft's width
  // actually is — a pencil of rays from a point source diverges by a fixed angle,
  // and expressing it that way is why the beam keeps its proportions at any card
  // size instead of getting relatively fatter as the card grows.
  //
  // Uneven on purpose — this is the plugin's 'graduated' offset pattern with its
  // irregularity dial well up. Equal shafts at equal spacing read as a printed
  // sunburst, not as light: what sells it is that no two are alike. The 6°-50°
  // spread puts the fan across the whole card rather than bunching it in one corner.
  const shafts = [
    { tilt: 6, hw: 2.8, len: 1.05, alpha: 0.70, ripple: 15, blur: 0.044 },
    { tilt: 17, hw: 1.8, len: 0.86, alpha: 0.44, ripple: 21, blur: 0.034 },
    { tilt: 27, hw: 4.2, len: 1.15, alpha: 0.80, ripple: 13, blur: 0.056 },
    { tilt: 38, hw: 1.4, len: 0.80, alpha: 0.36, ripple: 26, blur: 0.028 },
    { tilt: 50, hw: 3.3, len: 1.00, alpha: 0.56, ripple: 18, blur: 0.048 }
  ];

  // The shaft's box only has to hold its wedge — half-width len*tan(hw) at the far
  // end — plus a little slack for the feathered tail. It does NOT need room for the
  // core's blur bleed: that bleed lands outside the wedge, where the mask discards it
  // anyway, so a wide box would just enlarge the surface being blurred for nothing.
  // tan() has no CSS equivalent, which is the one reason this is computed here.
  const BOX_MARGIN = 1.35;
  const boxWidthMultiple = (halfAngleDeg) =>
    2 * Math.tan((halfAngleDeg * Math.PI) / 180) * BOX_MARGIN;
  // Lateral spread of the motes, as a fraction of the box width. Solves
  // f * boxWidth = 0.85 * wedgeHalfWidth — the plugin's ±0.85 × halfWidth — so
  // widening the box above does not quietly push the dust out of the lit core.
  const MOTE_SPREAD = 0.85 / (2 * BOX_MARGIN);

  const shaftHtml = shafts.map((shaft, k) => {
    const noise = (offset) => clockBgNoise(517 + k * 31 + offset);
    // Breathing and ripple both start part-way in, so the five shafts are never
    // in step — in step reads as one translucent sheet rather than as separate
    // shafts through the same air (the plugin's per-shaft streakPhase).
    const breathe = 12 + noise(1) * 9;
    const style = `--tilt:${shaft.tilt};--hw:${shaft.hw}deg;`
      + `--wmul:${boxWidthMultiple(shaft.hw).toFixed(4)};--len:${shaft.len};`
      + `--blur:${shaft.blur};--alpha:${shaft.alpha};--dur:${breathe.toFixed(1)}s;`
      + `--delay:${(-noise(2) * breathe).toFixed(1)}s;--ripple:${shaft.ripple}s;`
      + `--ripple-delay:${(-noise(3) * shaft.ripple).toFixed(1)}s`;

    // Dust count scales with the shaft's divergence, so density per unit of beam is
    // even across the fan — a flat count per shaft leaves the wide ones looking
    // empty and the narrow ones crowded. ~93 motes over the five shafts; they are the
    // only crisp thing in the figure, so this is where the detail budget goes.
    const moteCount = Math.round(10 + shaft.hw * 4);

    let motes = '';
    for (let j = 0; j < moteCount; j++) {
      const mn = (offset) => clockBgNoise(2311 + k * 47 + j * 13 + offset);
      const lateral = ((mn(1) - 0.5) * 2 * MOTE_SPREAD).toFixed(4);
      const duration = 16 + mn(2) * 10;
      // Stratified start (`t = (j + rnd()) / perShaft` there) as a negative delay,
      // so the motes are already strung out along the beam on the first frame
      // instead of setting off as one clump.
      const delay = (-((j + mn(3)) / moteCount) * duration).toFixed(2);
      // Every third mote is the plugin's "bright" dust tier: fewer, larger, hotter.
      const bright = j % 3 === 0;
      const size = ((bright ? 4.6 : 2.8) + mn(4) * 2.2).toFixed(1);
      const peak = ((bright ? 0.8 : 0.45) * (0.7 + mn(5) * 0.3)).toFixed(2);
      motes += `<i class="jbe-bg-mote" style="--f:${lateral};--sz:${size}px;`
        + `--dur:${duration.toFixed(1)}s;--delay:${delay}s;--op:${peak}"></i>`;
    }

    // The core is its own element so the blur can sit on something STATIC: the
    // ripple and the motes are siblings, outside the blurred subtree, so their
    // animation never forces the blur to be recomputed.
    return `<i class="jbe-bg-shaft" style="${style}">`
      + '<i class="jbe-bg-core"></i>'
      + '<i class="jbe-bg-ripple"><i class="jbe-bg-ripple-band"></i></i>'
      + `${motes}</i>`;
  }).join('');

  // Haze (flat volumetric lift) under the fan; the bloom is inside the fan so it is
  // anchored to the apex — it is the glare AT the light source, and pinning it in
  // card percentages instead let it drift off the apex whenever the card's aspect
  // ratio changed.
  return '<i class="jbe-bg-haze"></i>'
    + `<div class="jbe-bg-fan"><i class="jbe-bg-bloom"></i>${shaftHtml}</div>`;
}

/* ---- Canvas backdrops: shared runtime -------------------------------------
   Two of the four variants are a <canvas> rather than a CSS figure, and for the
   same reason: the effect each one ports is per-point maths CSS has no way to
   express — the nebula's cursor force field, the wave's perspective-projected lit
   surface. Everything the two have in common lives here (sizing at a capped DPR, a
   per-palette asset table built from the state tokens, a 30fps clock, idling while
   the card is unseen, and tearing all of it down again), so a variant is a
   `buildAssets`, a `layout`, a `step` and a `paint`.

   The section's rules still hold across both: no colour is named — the palette is
   derived from --jbe-bg-tint / --jbe-bg-tint-2, so 勤務中 / 退室中 tint the canvas
   for free — and nothing outside the canvas is touched, so neither variant can
   invalidate layout or repaint the digits.

   The budget, and why it has this shape. Both source sketches are full-screen
   marketing pieces; the card is a wide, short strip behind the digits.

   * NOTHING SOFT IS BUILT INSIDE THE FRAME. Whatever a variant needs per colour is
     built once, when the palette changes, and looked up after that: the nebula's
     glows are radial gradients rendered into small offscreen canvases and blitted,
     the mesh's are rgba strings in a ramp table. This is the single biggest cut
     from both sources — one rebuilds its blur every frame through `ctx.filter`
     over three full-canvas layers, the other through a fragment shader.
   * 30fps, NOT 60. A straight 2× saving, and neither figure has anything in it
     fast enough to show the seam.
   * DEVICE PIXEL RATIO CAPPED AT 1.25. Both figures are soft glows; there is
     nothing in either that a retina backing store would resolve.
   * COUNTS SCALE WITH THE CARD, and are two orders of magnitude below the sources
     (800 and 48,000 respectively → a few hundred).
   * IDLE WHEN UNSEEN. The rAF loop is cancelled outright while the card is
     scrolled off (IntersectionObserver) or the tab is hidden — the clock card sits
     at the top of a long attendance list, so this is the common case, not an edge
     one. */
const CLOCK_CANVAS = {
  fps: 30,
  maxDpr: 1.25,
  // How often, in frames, the runtime re-checks the card's size and state colour.
  // 60 frames at 30fps = 2s. Reading the attribute is free; rebuilding the sprite
  // atlas is not, so that only happens when the value actually changed.
  recheckFrames: 60
};

// One live instance at a time — the card only ever has one background layer.
let clockCanvasRun = null;

function clockCanvasParseColor(value) {
  const text = String(value || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3
      ? hex[1].split('').map((c) => c + c).join('')
      : hex[1];
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16)
    ];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts;
  }
  return null;
}

const clockCanvasMix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clockCanvasLighten = (rgb, t) => clockCanvasMix(rgb, [255, 255, 255], t);

/**
 * Five points along --jbe-bg-tint-2 → --jbe-bg-tint, the last two lifted toward
 * white so a field has highlights. Index 0 is the deepest, 4 the brightest. The
 * nebula picks from it at random; the mesh builds its ramp along it, in whichever
 * direction the card's own surface calls for (see waveRamp).
 *
 * The lift stays modest on purpose: the card is light, and a genuinely white
 * particle is invisible on it — see the light-mode note in styles.css.
 */
function clockCanvasPalette(container) {
  const style = getComputedStyle(container);
  const tint = clockCanvasParseColor(style.getPropertyValue('--jbe-bg-tint')) || [0, 150, 220];
  const tint2 = clockCanvasParseColor(style.getPropertyValue('--jbe-bg-tint-2')) || tint;
  return [
    tint2,
    clockCanvasMix(tint, tint2, 0.55),
    tint,
    clockCanvasLighten(tint, 0.3),
    clockCanvasLighten(clockCanvasMix(tint, tint2, 0.3), 0.55)
  ];
}

/**
 * Is the card itself light? Read off the container's own resolved background
 * rather than off `body.dark-mode`, so the answer stays right if the card ever
 * takes a surface of its own; the class is only the fallback for a background
 * that does not resolve to a plain colour.
 *
 * Which way a variant should run its palette depends on this and on nothing else:
 * over a light card, pigment can only ever DARKEN, so brightness has to be spent
 * as more colour rather than as more white (see the mesh gradient's light-mode
 * note in styles.css for the same argument at greater length).
 */
function clockCanvasOnLightSurface(container) {
  const rgb = clockCanvasParseColor(getComputedStyle(container).backgroundColor);
  if (!rgb) return !document.body.classList.contains('dark-mode');
  return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 140;
}

/**
 * Rule 3 of the section — 退室中 should be quieter than 勤務中 — reaches the canvas
 * variants through the same token the CSS ones use. It is a multiplier on a
 * duration there, so here it divides the clock: 1.4 means everything takes 1.4×
 * as long.
 */
function clockCanvasSpeed(container) {
  const raw = parseFloat(getComputedStyle(container).getPropertyValue('--jbe-bg-speed'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** `stops` is [[position, alpha], …] — one pre-blurred glow, drawn once. */
function clockCanvasGlowSprite(rgb, stops, px) {
  const sprite = document.createElement('canvas');
  sprite.width = px;
  sprite.height = px;
  const ctx = sprite.getContext('2d');
  const half = px / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  stops.forEach(([at, alpha]) => {
    gradient.addColorStop(at, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`);
  });
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, px, px);
  return sprite;
}

function stopClockCanvas() {
  if (!clockCanvasRun) return;
  clockCanvasRun.running = false;
  if (clockCanvasRun.raf) cancelAnimationFrame(clockCanvasRun.raf);
  clockCanvasRun.teardown();
  clockCanvasRun = null;
}

function clockCanvasResize(state) {
  const rect = state.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (width === state.width && height === state.height) return;

  const dpr = Math.min(window.devicePixelRatio || 1, CLOCK_CANVAS.maxDpr);
  state.width = width;
  state.height = height;
  state.canvas.width = Math.round(width * dpr);
  state.canvas.height = Math.round(height * dpr);
  // One transform, set once per resize, so every figure in a variant stays in CSS
  // pixels and nothing has to know the backing store exists.
  state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.spec.layout(state);
}

/**
 * Idempotent per canvas: ensureClockBackground() calls this on every pass, and the
 * markup is only rebuilt when the variant actually changed, so the common path is
 * the identity check on the first line.
 */
function startClockCanvas(canvas, container, spec) {
  if (!canvas || !container || !spec) return;
  if (clockCanvasRun && clockCanvasRun.canvas === canvas && clockCanvasRun.spec === spec) return;
  stopClockCanvas();

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const palette = clockCanvasPalette(container);
  const state = {
    canvas,
    ctx,
    spec,
    width: 0,
    height: 0,
    palette,
    assets: spec.buildAssets(palette, container),
    colorClass: container.dataset.clockColorClass || '',
    // Both of these can change under a running loop — a punch rewrites the colour
    // class, the dark-mode toggle flips the surface — and both feed buildAssets, so
    // the recheck below watches them together.
    onLight: clockCanvasOnLightSurface(container),
    speed: clockCanvasSpeed(container),
    // Pointer position in canvas CSS pixels; x is null whenever the cursor is off
    // the card.
    mouse: { x: null, y: null, down: false },
    // Seconds, advanced by the fixed frame step rather than read from a clock:
    // the figure is a function of t, and a wall-clock t would make it jump
    // whenever the loop is paused and resumed.
    t: 0,
    frame: 0,
    data: {},
    running: true,
    visible: true,
    raf: 0,
    last: 0,
    teardown: null
  };
  clockCanvasResize(state);

  const reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Pointer state comes off the CONTAINER, not the canvas: the background layer is
  // `pointer-events: none` at z-index -1 under the whole card, so it never sees an
  // event of its own. Passive throughout — none of this can cancel a scroll or a
  // click on the PUSH button.
  const toLocal = (event) => {
    const rect = canvas.getBoundingClientRect();
    state.mouse.x = event.clientX - rect.left;
    state.mouse.y = event.clientY - rect.top;
  };
  const onMove = (event) => toLocal(event);
  const onLeave = () => { state.mouse.x = null; state.mouse.y = null; state.mouse.down = false; };
  const onDown = (event) => { toLocal(event); state.mouse.down = true; };
  const onUp = () => { state.mouse.down = false; };

  if (spec.pointer && !reduced) {
    container.addEventListener('pointermove', onMove, { passive: true });
    container.addEventListener('pointerleave', onLeave, { passive: true });
    container.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
  }

  const interval = 1000 / CLOCK_CANVAS.fps;
  const frame = (now) => {
    if (!state.running) return;
    if (!canvas.isConnected) { stopClockCanvas(); return; }
    state.raf = requestAnimationFrame(frame);
    if (now - state.last < interval) return;
    state.last = now;

    if ((state.frame % CLOCK_CANVAS.recheckFrames) === 0) {
      // Both inputs to the asset table can change under us: a 出勤 punch rewrites
      // [data-clock-color-class], and the dark-mode toggle swaps the card's surface
      // without touching it. Reading the two is free; rebuilding is not, so that
      // only happens when one of them actually moved.
      const colorClass = container.dataset.clockColorClass || '';
      const onLight = clockCanvasOnLightSurface(container);
      if (colorClass !== state.colorClass || onLight !== state.onLight) {
        state.colorClass = colorClass;
        state.onLight = onLight;
        state.palette = clockCanvasPalette(container);
        state.assets = spec.buildAssets(state.palette, container);
        state.speed = clockCanvasSpeed(container);
      }
      clockCanvasResize(state);
    }

    state.frame++;
    // Accumulated rather than derived from the frame count, so a change of speed
    // shifts the rate from here on instead of jumping the whole figure.
    state.t += 1 / (CLOCK_CANVAS.fps * state.speed);
    spec.step(state);
    spec.paint(state);
  };

  const start = () => {
    if (!state.running || state.raf) return;
    state.last = 0;
    state.raf = requestAnimationFrame(frame);
  };
  const pause = () => {
    if (!state.raf) return;
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  };

  const intersectionObserver = new IntersectionObserver((entries) => {
    state.visible = entries.some((entry) => entry.isIntersecting);
    if (state.visible && !document.hidden) start(); else pause();
  }, { threshold: 0 });
  intersectionObserver.observe(canvas);

  const onVisibility = () => {
    if (!document.hidden && state.visible) start(); else pause();
  };
  document.addEventListener('visibilitychange', onVisibility);

  state.teardown = () => {
    intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerleave', onLeave);
    container.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
  };

  clockCanvasRun = state;

  if (reduced) {
    // One frame, then nothing: the figure is still itself, it just is not moving.
    spec.step(state);
    spec.paint(state);
    state.running = false;
    return;
  }

  // `watch:` so an SPA navigation tears the whole thing down. The loop would also
  // notice the detached canvas on its next frame, but this stops it a frame sooner
  // and releases the sprite atlas with it.
  if (typeof window.__jbe_registerManagedObserver === 'function') {
    window.__jbe_registerManagedObserver('watch:clockCanvas', intersectionObserver, () => {
      stopClockCanvas();
    });
  }

  start();
}

/* ---- 01 ウェーブメッシュ ----------------------------------------------------
   A wireframe surface: one perspective ground plane drawn AS the mesh — rows
   running across the card, columns converging on a vanishing point above it — with
   three superimposed swells rolling through it.

   This is a rebuild, not a retune. The variant used to be a point cloud ported
   from a Three.js sketch (48,000 glowing sprites on a displaced plane, cut down to
   a few hundred). It read as a dot field that happened to undulate: at this card's
   size the dots never joined into the surface the sketch gets for free from sheer
   density, and the name promised a mesh the figure never drew. Drawing the mesh
   itself is both truer to the name and cheaper — ~55 stroked paths a frame against
   ~760 sprite blits.

   What makes it read as a surface rather than as a grid pattern:

   1. THE COLUMNS ARE ANCHORED IN THE WORLD, NOT ON SCREEN. Each column holds a
      fixed world x and is projected once per row, so the columns converge with
      depth and the whole figure resolves to one vanishing point. Columns at fixed
      screen x — the cheap version — read as a curtain, not as ground.
   2. ROWS ARE EVENLY SPACED ON SCREEN, and their depth is solved back out of the
      projection. An evenly spaced WORLD grid spends most of its rows crushed into
      the last few pixels before the horizon; this puts a row wherever there are
      pixels to draw one with.
   3. THREE SWELLS at unrelated frequencies and speeds, so the surface never
      visibly repeats. One sine reads as a mechanism; three read as water.
   4. SHADING FROM THE SURFACE SLOPE. The swell sum is analytic, so both partial
      derivatives are too — the same three cosines give the exact normal, with no
      neighbour sampling at all. Slope drives the brightness and swings a point up
      or down the palette, which is what makes crests catch the light.
   5. THE COLOUR TRAVELS WITH DEPTH. The slope from (4) does not index the whole
      palette — it swings a WINDOW of it, and the window itself slides from the
      deep tint at the far edge to the bright one at the near edge, plus a little
      across the width. So the mesh runs a real gradient into the distance rather
      than being one hue lit unevenly, and crests still catch the light — they
      catch it in the colour of their own depth. Both ends of that gradient are
      state tints, so 勤務中 and 退室中 each get their own two-colour ramp for free
      and no colour is named here (rule 2 of the section).
   6. A FAINT FILL BETWEEN ADJACENT ROWS. Two percent of the ink, and it is what
      gives the lattice a front and a back: the bands are laid down far-to-near, so
      each one veils the lines behind it.
   7. THE CURSOR IS A TORCH, not a camera. The figure holds still and the pointer
      lights it: within a soft radius the mesh is pulled toward full alpha and up
      the palette, so the parts the fades had dissolved come back into view under
      the cursor and sink again behind it. An earlier pass moved the camera instead
      (a world-space pan, so near rows swung further than far ones); the parallax
      was convincing but it slid the whole figure around under the digits, and the
      reveal says more with less motion. Position and intensity are both eased, so
      arriving and leaving fade rather than blink.

      THE ONE THING THE TORCH MAY NOT REVEAL IS THE GRID'S OWN BOUNDARY. The side
      taper and the horizon fade are not only depth cues — they are what stops the
      sheet from reading as a finite rectangle, and a torch strong enough to lift a
      point out of its fade is strong enough to draw the last column and the last
      row as hard lines. So the torch carries a mask that falls to zero over the
      outermost stretch of each: it can light everything the fades had hidden
      except the place where the mesh actually stops.

   8. DEPTH OF FIELD, WITHOUT A BLUR. A focal plane sits just in front of the middle
      of the field; a row's distance outside the sharp band gives it a 0…1 defocus,
      and that number widens its stroke, drains its core and grows its bloom. That
      is what a lens does to a line — the same ink spread over a wider band with no
      hard centre — and it costs nothing, because a row was already drawn as two
      concentric strokes and this only changes their widths and alphas. All four
      numbers are solved per row at layout, so a defocused row costs a sharp one.
      Columns cross every depth and a stroke has one width for its length, so they
      are cut into bands of quantised blur instead (~3 short strokes each, sharing
      the one gradient). The real thing — `ctx.filter = 'blur()'`, or an offscreen
      layer blurred per frame — is precisely the cost the runtime's block comment
      says was cut from both source sketches, and a two-stroke profile at this size
      is indistinguishable from it.

   Cost, against the budget in the runtime's block comment above:
   * ~400 grid points of trigonometry a frame, then ~12 row strokes, ~12 bloom
     strokes, ~11 band fills and ~100 short column segments. Everything else is a
     table lookup.
   * NO COLOUR STRING IS BUILT INSIDE THE LOOP. Lighting travels as gradients — one
     across each row, one down each column — and every stop comes out of a ramp
     table (colour level × alpha level) built once per palette, the same trade the
     nebula makes with its sprite atlas. Quantising to 12 × 18 is invisible:
     consecutive stops interpolate, so the error never exceeds half a step.
   * No `shadowBlur` and no `filter` — not for the bloom and not for the depth of
     field. Both are the same path stroked twice, wide and faint under thin and
     bright, with only the widths and alphas changing between them.

   Colour is never named here (rule 2 of the section): every stroke comes out of the
   ramp, and the ramp comes out of the state palette. */
const WAVE = {
  // Field placement, as shares of the card height. The far edge stops well short of
  // the vanishing point — rows packed into the last pixels before it cost points,
  // add nothing, and sit exactly where the digits are.
  topOfField: 0.34,
  bottomOfField: 1.06,
  /* Depth of the far edge in units of the near edge's. This single number IS the
     strength of the perspective: the far row is drawn 1/depthRatio as wide as the
     near one, and the focal length and horizon are solved from it (see
     waveLayout). Raising it pushes the vanishing point further above the card and
     makes the taper steeper. */
  depthRatio: 2.35,
  camHeight: 1,
  /* How far past the card's own width the world grid runs at the near edge. Above 1
     so the bottom of the mesh is full-bleed: at exactly 1 the near row would end on
     the card's edge and the taper would begin inside it. */
  worldOverscan: 1.38,
  // Target on-screen gaps, in CSS px, from which the row and column counts follow —
  // so density holds and the counts track the card's size instead of being fixed.
  rowSpacing: 13,
  colSpacing: 30,
  minRows: 8,
  maxRows: 18,
  minCols: 12,
  maxCols: 34,
  /* Where the side fade starts, in grid u (-1…1 across the OVERSCANNED width).
     Being in u rather than in screen x is what shapes the figure: u is anchored in
     the world, so the same fade sits off the card at the near rows — which
     therefore run edge to edge — and well inside it at the far ones. The mesh
     tapers into a soft wedge instead of ending on two vertical lines. */
  edgeStart: 0.5,
  /* The spatial colour ramp (point 5 above): where the far edge and the near edge
     sit in the palette, how much further the right-hand side gets than the left,
     and how wide a window around that the point's own lighting may swing. The two
     depth figures are deliberately more than a window apart, so the far half of the
     mesh works the deep end of the palette and the near half the bright end. */
  tintFar: 0.1,
  tintNear: 0.92,
  tintSide: 0.34,
  tintSwing: 0.44,
  lineWidth: 1.7,
  minLine: 0.5,
  maxLine: 2.2,
  /* Depth of field (point 8 below). `focus` is the depth the mesh is sharp at — 1
     is the near edge, depthRatio the far one — `focusRange` how deep the sharp band
     runs, and `focusFalloff` how much further a row has to be before it is fully
     soft. Sitting the plane just in front of the middle puts the crisp band where
     the figure has the most ink, and leaves BOTH ends soft: distance melting away
     at the top, a foreground blur along the bottom edge. */
  focus: 1.6,
  focusRange: 0.52,
  focusFalloff: 0.68,
  /* What a fully defocused line does. Widen and soften are the whole effect: the
     same ink spread over a wider band with no hard centre left, which is what a
     lens does to a line. Glow lets the bloom grow with it, since the light that
     leaves the core has to land somewhere. */
  dofWiden: 2.2,
  dofSoften: 0.62,
  dofGlow: 0.9,
  // Ceiling for the whole figure. Every other alpha below is a share of this one,
  // and the per-point fades ride in the ramp rather than here — which is what lets
  // the torch overcome them (a globalAlpha could only scale a whole path at once).
  peakAlpha: 0.72,
  // The bloom pass: the same path, this much wider, at this share of the ink.
  haloWidth: 4.5,
  haloAlpha: 0.16,
  // The columns are the cross-hatch, not the subject: a third of the ink, so the
  // rows stay the figure even though both carry the same lighting.
  colAlpha: 0.34,
  bandAlpha: 0.075,
  /* The cursor torch. `radius` is in card heights and clamped, so the lit pool is
     the same size relative to the card whatever the clock size is. `lift` and `lum`
     are how far a fully lit point is pulled toward opaque and toward the crest end
     of the ramp — both expressed as a share of the distance REMAINING, so the torch
     can only ever add. `smoothing` eases both the pool's position and its
     intensity, at half the source sketch's rate because we run at half its fps.

     `edgeGuard` and `depthGuard` are the boundary mask from point 7: the share of
     the grid's half-width and of its depth over which the torch ramps away to
     nothing at the outer end. They are wide enough that the mask is already zero
     well before the last column and the last row, and narrow enough that the
     reveal still reaches deep into the tapered part. */
  torchRadius: 1.1,
  torchMin: 150,
  torchMax: 420,
  torchLift: 0.85,
  torchLum: 0.8,
  edgeGuard: 0.36,
  depthGuard: 0.3,
  smoothing: 0.1
};

/* [amplitude in world units, cycles across the grid, cycles into its depth, speed
   in radians/second]. The two cycle counts are resolved against the grid's actual
   world size at layout, so the figure holds its shape on a narrow card instead of
   flattening into a single tilt. Amplitudes sum to 0.1 of the eye height — about
   26px of travel at the near edge and 11px at the far one, against rows ~13px
   apart; the depth cycle counts are kept low for the same reason, so neighbouring
   rows stay close to in phase and never cross. */
const WAVE_SWELLS = [
  [0.052, 1.15, 0.55, 0.4],
  [0.03, 2.05, -0.95, 0.62],
  [0.018, 0.6, 1.15, 0.27]
];

/* Ramp resolution: colour levels × alpha levels of pre-built rgba strings. The
   alpha axis is the finer of the two because it carries the depth fade as well as
   the lighting — the far rows sit at a twentieth of the ink, and quantising that
   with a coarse step would band the horizon. */
const WAVE_RAMP_LEVELS = 12;
const WAVE_RAMP_ALPHAS = 18;

/**
 * The mesh's answer to the nebula's sprite atlas: every colour a stroke can take,
 * built once per palette so the frame loop never concatenates a string. Level 0 is
 * a trough, the last level a lit crest; alpha 0 is fully transparent, which is what
 * the side fade resolves to.
 *
 * WHICH END OF THE PALETTE A CREST TAKES DEPENDS ON THE CARD. On a dark card a lit
 * face is the palette's own bright end, as everywhere else. On a light one that end
 * is nearly white and therefore invisible — a line only exists on white by being
 * pigment — so the ramp is walked backwards and a crest becomes the deepest, most
 * saturated tint while the troughs are what dissolve. The figure is the same
 * either way: the eye reads the high-contrast points as the lit ones. The gamma
 * does the matching job for alpha, since a hairline needs more of it on white than
 * a glow needs on black.
 */
function waveRamp(palette, container) {
  const onLight = clockCanvasOnLightSurface(container);
  const ordered = onLight ? palette.slice().reverse() : palette;
  const alphaGamma = onLight ? 0.62 : 1;
  const last = ordered.length - 1;
  const ramp = [];
  for (let i = 0; i < WAVE_RAMP_LEVELS; i++) {
    const at = (i / (WAVE_RAMP_LEVELS - 1)) * last;
    const lo = Math.min(last, Math.floor(at));
    const rgb = clockCanvasMix(ordered[lo], ordered[Math.min(last, lo + 1)], at - lo);
    const levels = [];
    for (let a = 0; a < WAVE_RAMP_ALPHAS; a++) {
      const alpha = ((a / (WAVE_RAMP_ALPHAS - 1)) ** alphaGamma).toFixed(3);
      levels.push(`rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`);
    }
    ramp.push(levels);
  }
  return ramp;
}

/**
 * Rebuild the grid. Everything here depends only on the card's size, so it is
 * computed once per resize and never per frame — the per-frame pass reads `rows`,
 * `cols` and `swells` and writes into the typed arrays allocated at the end.
 */
function waveLayout(state) {
  const { width, height } = state;
  const topY = height * WAVE.topOfField;
  const bottomY = height * WAVE.bottomOfField;
  const far = WAVE.depthRatio;

  // Solve the camera from the two edges of the field: py(depth) = horizonY +
  // camHeight * focal / depth, with the near edge (depth 1) landing on bottomY and
  // the far edge (depth `far`) on topY. The horizon usually falls above the card,
  // which is correct — the vanishing point is where the mesh WOULD converge.
  const focal = (bottomY - topY) / (WAVE.camHeight * (1 - 1 / far));
  const horizonY = bottomY - WAVE.camHeight * focal;
  const halfW = width / 2;
  const halfWorld = (halfW / focal) * WAVE.worldOverscan;

  const rowCount = Math.max(WAVE.minRows, Math.min(WAVE.maxRows,
    Math.round((bottomY - topY) / WAVE.rowSpacing)));
  const colCount = Math.max(WAVE.minCols, Math.min(WAVE.maxCols,
    Math.round((width * WAVE.worldOverscan) / WAVE.colSpacing)));

  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    // 0 at the far edge, 1 at the near one — which is also the painter's order, so
    // no depth sort is needed anywhere below.
    const t = rowCount === 1 ? 1 : r / (rowCount - 1);
    const restY = topY + t * (bottomY - topY);
    const depth = (WAVE.camHeight * focal) / Math.max(1, restY - horizonY);
    const scale = focal / depth;
    // How far outside the sharp band this row's depth falls, 0…1. Solved here and
    // never again: every DoF term below is a function of it alone.
    const blur = Math.max(0, Math.min(1,
      (Math.abs(depth - WAVE.focus) - WAVE.focusRange / 2) / WAVE.focusFalloff));
    const sharpWidth = Math.max(WAVE.minLine,
      Math.min(WAVE.maxLine, WAVE.lineWidth * (scale / focal)));
    const coreWidth = sharpWidth * (1 + blur * WAVE.dofWiden);
    rows.push({
      depth,
      scale,
      // Dissolve into the card toward the horizon instead of ending on a line. A
      // share of the ink, not an alpha: it is multiplied into the per-point value
      // the ramp is indexed with, so the torch can lift a far row out of it.
      fade: 0.06 + 0.94 * t ** 1.4,
      // Where this row's colour window sits in the palette.
      tint: WAVE.tintFar + (WAVE.tintNear - WAVE.tintFar) * t,
      // …and how much of the torch it may receive: nothing at the far edge, so the
      // last row can never be drawn as the boundary it is.
      reveal: Math.min(1, t / WAVE.depthGuard),
      blur,
      // The two strokes a row is made of, already defocused. Alphas are shares of
      // peakAlpha; widths are absolute. Nothing per-frame touches any of this.
      coreWidth,
      coreAlpha: 1 - blur * WAVE.dofSoften,
      bloomWidth: coreWidth * WAVE.haloWidth,
      bloomAlpha: WAVE.haloAlpha * (1 + blur * WAVE.dofGlow)
    });
  }

  /* Columns cross every depth, and a stroke has one width for its whole length, so
     a column cannot be defocused the way a row can. It is cut into bands instead:
     runs of rows that share a quantised blur, each stroked at its own width. Four
     buckets keeps a band's own spread narrow enough that averaging its rows does
     not smear the effect back out, and still costs only ~5 short strokes per column
     instead of one long one. Each band starts a row early so the segments overlap
     and the line has no seam. */
  const bands = [];
  for (let r = 0; r < rowCount; r++) {
    const bucket = Math.min(3, Math.floor(rows[r].blur * 4));
    const open = bands[bands.length - 1];
    if (open && open.bucket === bucket) {
      open.end = r;
      open.sum += rows[r].blur;
      open.n++;
    } else {
      bands.push({ bucket, start: Math.max(0, r - 1), end: r, sum: rows[r].blur, n: 1 });
    }
  }
  const colSharp = Math.max(WAVE.minLine, WAVE.lineWidth * 0.6);
  for (const band of bands) {
    const blur = band.sum / band.n;
    band.width = colSharp * (1 + blur * WAVE.dofWiden);
    band.alpha = WAVE.colAlpha * (1 - blur * WAVE.dofSoften);
  }

  const cols = [];
  for (let c = 0; c < colCount; c++) {
    const u = colCount === 1 ? 0 : (c / (colCount - 1)) * 2 - 1;
    const over = Math.max(0, (Math.abs(u) - WAVE.edgeStart) / (1 - WAVE.edgeStart));
    cols.push({
      worldX: u * halfWorld,
      edge: Math.max(0, 1 - over * over),
      // This column's contribution to the colour window: the right-hand side of the
      // grid sits a little further along the palette than the left.
      tint: WAVE.tintSide * u * 0.5,
      // Torch mask — zero at the outermost column, so lighting the taper can never
      // draw the sheet's own edge.
      reveal: Math.min(1, (1 - Math.abs(u)) / WAVE.edgeGuard),
      // Where this column sits in a row's gradient. The projection is affine along
      // a row, so the stop is just the column's share of the span — the camera pan
      // shifts a whole row by one constant and cannot bend it.
      stop: colCount === 1 ? 0 : c / (colCount - 1)
    });
  }

  const depthSpan = Math.max(0.001, far - 1);
  const swells = WAVE_SWELLS.map(([amp, cyclesX, cyclesZ, speed]) => ({
    amp,
    fx: (cyclesX * Math.PI * 2) / (halfWorld * 2),
    fz: (cyclesZ * Math.PI * 2) / depthSpan,
    speed
  }));

  const points = rowCount * colCount;
  state.data = {
    horizonY,
    halfW,
    rows,
    cols,
    bands,
    swells,
    maxAmp: swells.reduce((sum, s) => sum + s.amp, 0),
    // The largest either analytic slope can reach, so the shading can be normalised
    // against it. Without this the lighting silently flattens whenever the swells
    // are retuned — the raw slope of a long gentle wave is a few hundredths, which
    // is no contrast at all.
    maxSlopeX: swells.reduce((sum, s) => sum + s.amp * Math.abs(s.fx), 0),
    maxSlopeZ: swells.reduce((sum, s) => sum + s.amp * Math.abs(s.fz), 0),
    // One pass solves the surface into these four; the two draw passes only read
    // them. Allocated per resize, never per frame.
    px: new Float32Array(points),
    py: new Float32Array(points),
    level: new Uint8Array(points),
    alpha: new Uint8Array(points),
    // The torch: where the lit pool is, how strong it is, and how big. Position and
    // intensity are carried across a resize so a card that reflows under the
    // pointer does not go dark for a moment.
    torchX: state.data?.torchX || 0,
    torchY: state.data?.torchY || 0,
    glow: state.data?.glow || 0,
    // Squared, because the falloff below compares squared distances and never needs
    // the root.
    torchR2: Math.max(WAVE.torchMin,
      Math.min(WAVE.torchMax, height * WAVE.torchRadius)) ** 2
  };
}

function waveStep(state) {
  const data = state.data;
  const { mouse } = state;
  const lit = mouse.x === null ? 0 : 1;
  if (lit) {
    if (data.glow < 0.02) {
      // Arriving cold: light up under the cursor rather than sweeping across the
      // card from wherever the pointer last left it.
      data.torchX = mouse.x;
      data.torchY = mouse.y;
    } else {
      data.torchX += (mouse.x - data.torchX) * WAVE.smoothing;
      data.torchY += (mouse.y - data.torchY) * WAVE.smoothing;
    }
  }
  // Intensity eases both ways, so leaving the card dims the pool out instead of
  // snapping it off.
  data.glow += (lit - data.glow) * WAVE.smoothing;
}

function wavePaint(state) {
  const ctx = state.ctx;
  const { width, height, t, data, assets } = state;
  const { rows, cols, swells, px, py, level, alpha } = data;
  const rowCount = rows.length;
  const colCount = cols.length;

  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ---- Pass 1: solve the surface. Projection, lighting and the two table indices
  // for every grid point, so neither draw pass has to do any maths.
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r];
    const base = r * colCount;
    for (let c = 0; c < colCount; c++) {
      const col = cols[c];
      let y = 0;
      let slopeX = 0;
      let slopeZ = 0;
      for (let i = 0; i < swells.length; i++) {
        const s = swells[i];
        const theta = col.worldX * s.fx + row.depth * s.fz + t * s.speed;
        const cos = Math.cos(theta);
        y += s.amp * Math.sin(theta);
        // The analytic partials — the surface normal, without sampling a neighbour.
        slopeX += s.amp * s.fx * cos;
        slopeZ += s.amp * s.fz * cos;
      }

      const at = base + c;
      px[at] = data.halfW + col.worldX * row.scale;
      py[at] = data.horizonY + (WAVE.camHeight - y) * row.scale;

      // Light from one side and a little from the front: a face tilted toward it is
      // brighter. Both terms are normalised against the slope maxima above.
      const light = Math.max(0, Math.min(1, 0.5
        + (data.maxSlopeX === 0 ? 0 : (slopeX / data.maxSlopeX) * 0.34)
        + (data.maxSlopeZ === 0 ? 0 : (slopeZ / data.maxSlopeZ) * 0.18)));
      const elevation = data.maxAmp === 0 ? 0.5 : (y / data.maxAmp) * 0.5 + 0.5;
      // Where this point sits in the palette: its depth and side decide the window,
      // its own lighting swings it within that window (point 5 of the note above).
      // Clamped here and not at the lookup: the torch below lerps toward 1, which
      // only stays a lift while this is already inside the range.
      let lum = Math.max(0, Math.min(1, row.tint + col.tint
        + (0.3 * elevation + 0.7 * light - 0.5) * WAVE.tintSwing));
      // Everything that dims a point, multiplied together: how far into the
      // distance it is, how far out to the side, and which way it faces.
      let ink = row.fade * col.edge * (0.34 + 0.66 * light);

      // The torch. Squared falloff on the squared distance, so the pool has a soft
      // shoulder and no root is needed; both lifts are toward what is LEFT, so the
      // cursor can only ever add — a point already at full ink stays there. The
      // reveal masks keep it off the grid's last column and last row.
      if (data.glow > 0.002) {
        const dx = px[at] - data.torchX;
        const dy = py[at] - data.torchY;
        const reach = 1 - Math.min(1, (dx * dx + dy * dy) / data.torchR2);
        if (reach > 0) {
          const torch = data.glow * reach * reach * row.reveal * col.reveal;
          ink += torch * (1 - ink) * WAVE.torchLift;
          lum += torch * (1 - lum) * WAVE.torchLum;
        }
      }

      level[at] = Math.round(lum * (WAVE_RAMP_LEVELS - 1));
      alpha[at] = Math.round(ink * (WAVE_RAMP_ALPHAS - 1));
    }
  }

  // ---- Pass 2: the columns, under everything else. A gradient down each one, from
  // the same tables the rows use: the cross-hatch has to light up with the surface
  // it belongs to, and one flat colour per column could not follow the torch. The
  // gradient is positional, so every band of the column can share the one object.
  const bands = data.bands;
  const lastRow = (rowCount - 1) * colCount;
  for (let c = 0; c < colCount; c++) {
    const top = py[c];
    const span = py[lastRow + c] - top;
    const gradient = ctx.createLinearGradient(0, top, 0, top + (span || 1));
    for (let r = 0; r < rowCount; r++) {
      const at = r * colCount + c;
      const stop = span > 0 ? (py[at] - top) / span : r / Math.max(1, rowCount - 1);
      gradient.addColorStop(Math.max(0, Math.min(1, stop)), assets[level[at]][alpha[at]]);
    }
    ctx.strokeStyle = gradient;
    for (const band of bands) {
      ctx.globalAlpha = WAVE.peakAlpha * band.alpha;
      ctx.lineWidth = band.width;
      ctx.beginPath();
      ctx.moveTo(px[band.start * colCount + c], py[band.start * colCount + c]);
      for (let r = band.start + 1; r <= band.end; r++) {
        const at = r * colCount + c;
        ctx.lineTo(px[at], py[at]);
      }
      ctx.stroke();
    }
  }

  // ---- Pass 3: the rows, far to near. Each one lays its band down before its own
  // line, so the fill veils what is already behind it (point 5 of the note above).
  // Every fade is already inside the gradient, so globalAlpha only ever carries the
  // figure's ceiling and which pass this is.
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r];
    const base = r * colCount;
    const gradient = ctx.createLinearGradient(px[base], 0, px[base + colCount - 1], 0);
    for (let c = 0; c < colCount; c++) {
      gradient.addColorStop(cols[c].stop, assets[level[base + c]][alpha[base + c]]);
    }

    if (r > 0) {
      const prev = base - colCount;
      ctx.globalAlpha = WAVE.peakAlpha * WAVE.bandAlpha;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(px[prev], py[prev]);
      for (let c = 1; c < colCount; c++) ctx.lineTo(px[prev + c], py[prev + c]);
      for (let c = colCount - 1; c >= 0; c--) ctx.lineTo(px[base + c], py[base + c]);
      ctx.closePath();
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(px[base], py[base]);
    for (let c = 1; c < colCount; c++) ctx.lineTo(px[base + c], py[base + c]);
    ctx.strokeStyle = gradient;
    // Bloom first — wide and faint — then the core over it. Same path either way,
    // which is why this is cheaper than a shadowBlur as well as softer, and it is
    // also where the depth of field lands: all four numbers were solved per row at
    // layout, so a defocused row costs exactly what a sharp one does.
    ctx.globalAlpha = WAVE.peakAlpha * row.bloomAlpha;
    ctx.lineWidth = row.bloomWidth;
    ctx.stroke();
    ctx.globalAlpha = WAVE.peakAlpha * row.coreAlpha;
    ctx.lineWidth = row.coreWidth;
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

const WAVE_SPEC = {
  pointer: true,
  buildAssets: waveRamp,
  layout: waveLayout,
  step: waveStep,
  paint: wavePaint
};

/* ---- 02 パーティクル（ネビュラ） -------------------------------------------
   Ported from the "Short Trail Attracting Blue Nebula" canvas sketch
   (~/Documents/案件以外/AI/html/Dynamic bg_shader/HTML Interactive Nebula
   Simulation.html).

   What carries over: perspective depth (z shrinking toward the viewer, x/y
   projected through it), gravity toward the centre, depth-of-field by distance
   from a focal plane, a short motion trail, cursor repulsion and press-to-attract,
   and the fade-in / lifespan / fade-out cycle.

   Beyond the shared cuts listed above the runtime, one deviation is specific to
   this variant: the sketch paints its trail by flooding the canvas with an
   opaque-ish background colour every frame, which works because it owns the whole
   page background. Here the canvas sits over the card, so a flood fill would paint
   a rectangle across it. The fade is `destination-out` instead — it decays the
   alpha of what is already there and leaves the canvas transparent. */
const NEBULA = {
  maxDepth: 5,
  focalDepth: 1.8,
  focusRange: 2,
  spritePx: 64,
  // Per-frame alpha decay of the existing image. Higher = shorter trail. The
  // sketch's 0.6 at 60fps is roughly this at 30.
  trailFade: 0.34,
  peakOpacity: 0.55,
  mouseRadius: 90,
  repelForce: 1.0,
  attractRadius: 220,
  attractForce: 0.14,
  minAttractDist: 14,
  // Everything here that is a per-frame delta is the sketch's 60fps figure ×2.
  zStep: 0.02,
  gravity: 0.004
};

/* The three depth-of-field tiers, as gradient stop tables. `spread` is how far the
   sprite is drawn beyond the particle's nominal radius: a blurred particle is not
   just softer, it covers more ground, and scaling the draw is how that happens for
   free. Tier 0 keeps a near-solid core so an in-focus particle still reads as a
   point rather than as a small smudge. */
const NEBULA_TIERS = [
  { spread: 1.2, stops: [[0, 1], [0.34, 0.95], [0.47, 0.38], [1, 0]] },
  { spread: 2.1, stops: [[0, 0.9], [0.18, 0.55], [1, 0]] },
  { spread: 3.4, stops: [[0, 0.58], [0.12, 0.36], [1, 0]] }
];

// Distance from the focal plane that one blur tier covers. The sketch's formula:
// the depth outside the in-focus band, split over the tiers in both directions.
const NEBULA_DEPTH_STEP =
  Math.max(0, NEBULA.maxDepth - NEBULA.focusRange) / (NEBULA_TIERS.length * 2);

/**
 * (Re)seat a particle. `seed` is non-null only for the initial fill, where
 * clockBgNoise keeps the opening layout identical across SPA rebuilds — same
 * reasoning as the CSS variants. Respawns during the run use Math.random: by then
 * the field is in motion and there is nothing for a fixed layout to stabilise.
 */
function nebulaReset(p, state, seed) {
  const rnd = seed === null
    ? Math.random
    : (() => { let i = 0; return () => clockBgNoise(seed + (i++) * 13); })();

  p.lifespan = 200 + rnd() * 300;
  p.fadeIn = 30;
  p.fadeOut = 40;
  p.age = seed === null ? 0 : Math.floor(rnd() * p.lifespan * 0.8);
  p.opacity = 0;
  // A fresh particle enters at the back; the initial fill is spread through the
  // volume so the field does not have to rush in from the horizon on first paint.
  p.z = seed === null ? NEBULA.maxDepth : rnd() * NEBULA.maxDepth;
  const safeZ = Math.max(0.1, p.z);
  p.x = (rnd() - 0.5) * state.width * (NEBULA.maxDepth / safeZ);
  p.y = (rnd() - 0.5) * state.height * (NEBULA.maxDepth / safeZ);
  p.vx = (rnd() - 0.5) * 0.2;
  p.vy = (rnd() - 0.5) * 0.2;
  p.baseRadius = 1.2 + rnd() * 1.6;
  p.color = Math.floor(rnd() * state.assets.length) % state.assets.length;
  p.tier = 0;
  p.px = 0;
  p.py = 0;
  p.radius = 0;
}

function nebulaLayout(state) {
  if (!state.data.particles) state.data.particles = [];
  const particles = state.data.particles;
  const target = Math.max(36, Math.min(80, Math.round((state.width * state.height) / 3500)));
  while (particles.length > target) particles.pop();
  while (particles.length < target) {
    const p = {};
    nebulaReset(p, state, 9011 + particles.length * 97);
    particles.push(p);
  }
}

function nebulaStep(state) {
  const { width, height, mouse } = state;
  // 退室中 slows the whole field (see clockCanvasSpeed): ages advance more slowly,
  // so lifespans stretch and the drift settles down with them.
  const rate = 1 / state.speed;
  const halfW = width / 2;
  const halfH = height / 2;
  const margin = 30;

  for (const p of state.data.particles) {
    p.age += rate;

    if (p.age >= p.lifespan) {
      nebulaReset(p, state, null);
      continue;
    }

    if (p.age < p.fadeIn) {
      p.opacity = (p.age / p.fadeIn) * NEBULA.peakOpacity;
    } else if (p.age > p.lifespan - p.fadeOut) {
      p.opacity = NEBULA.peakOpacity * ((p.lifespan - p.age) / p.fadeOut);
    } else {
      p.opacity = NEBULA.peakOpacity;
    }

    // Toward the viewer. A particle that reaches the near plane is pushed into its
    // fade-out rather than popped, so nothing ever vanishes mid-brightness.
    p.z -= NEBULA.zStep / state.speed;
    if (p.z <= 0.2) {
      p.z = 0.2;
      p.age = Math.max(p.age, p.lifespan - p.fadeOut);
    }

    const scale = NEBULA.maxDepth / (p.z + NEBULA.maxDepth * 0.2);
    p.px = p.x * scale + halfW;
    p.py = p.y * scale + halfH;
    p.x += p.vx * rate;
    p.y += p.vy * rate;

    // Gravity toward the world origin — what makes the field a nebula rather than
    // a snowfall.
    const distSq = p.x * p.x + p.y * p.y;
    if (distSq > 1) {
      const dist = Math.sqrt(distSq);
      const pull = (NEBULA.gravity * rate) / (dist * 0.5);
      p.vx += (p.x / dist) * -pull;
      p.vy += (p.y / dist) * -pull;
    }

    if (mouse.x !== null) {
      const dx = p.px - mouse.x;
      const dy = p.py - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (mouse.down && dist < NEBULA.attractRadius && dist > NEBULA.minAttractDist) {
        // Force divided by scale: a near particle covers more screen per world
        // unit, so an equal world force would fling it far faster than a distant
        // one and the swarm would come apart.
        const force = NEBULA.attractForce * (1 - dist / NEBULA.attractRadius)
          / Math.max(0.05, scale);
        p.vx -= (dx / dist) * force;
        p.vy -= (dy / dist) * force;
      } else if (!mouse.down && dist < NEBULA.mouseRadius && dist > 0
        && p.tier !== NEBULA_TIERS.length - 1) {
        // The furthest-out-of-focus tier ignores the cursor, as in the sketch:
        // background haze reacting to the pointer breaks the depth read.
        const force = ((NEBULA.mouseRadius - dist) / NEBULA.mouseRadius)
          * NEBULA.repelForce / Math.max(0.1, scale);
        p.vx += (dx / dist) * force;
        p.vy += (dy / dist) * force;
      }
    }

    // Off the card: fade rather than clip, so the edge is not a visible boundary.
    if (p.px < -margin || p.px > width + margin
      || p.py < -margin || p.py > height + margin) {
      p.age = Math.max(p.age, p.lifespan - p.fadeOut);
    }

    p.radius = p.baseRadius * scale;
    const depthDiff = Math.abs(p.z - NEBULA.focalDepth) - NEBULA.focusRange / 2;
    p.tier = depthDiff <= 0
      ? 0
      : Math.min(NEBULA_TIERS.length - 1,
        NEBULA_DEPTH_STEP > 0 ? Math.floor(depthDiff / NEBULA_DEPTH_STEP) : NEBULA_TIERS.length - 1);
  }
}

function nebulaPaint(state) {
  const ctx = state.ctx;
  const { width, height } = state;

  // Trail. destination-out decays the alpha of what is already on the canvas and
  // leaves it transparent — see the deviation note above.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(0, 0, 0, ${NEBULA.trailFade})`;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = 'source-over';
  for (const p of state.data.particles) {
    if (p.opacity <= 0.01 || p.radius <= 0.1) continue;
    const r = p.radius * NEBULA_TIERS[p.tier].spread;
    if (p.px < -r || p.px > width + r || p.py < -r || p.py > height + r) continue;
    ctx.globalAlpha = p.opacity;
    ctx.drawImage(state.assets[p.color][p.tier], p.px - r, p.py - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
}

const NEBULA_SPEC = {
  pointer: true,
  buildAssets: (palette) => palette.map((rgb) =>
    NEBULA_TIERS.map((tier) => clockCanvasGlowSprite(rgb, tier.stops, NEBULA.spritePx))),
  layout: nebulaLayout,
  step: nebulaStep,
  paint: nebulaPaint
};

/** Which canvas runtime a variant needs, or null for the CSS-only ones. */
const CLOCK_CANVAS_SPECS = { wave: WAVE_SPEC, particles: NEBULA_SPEC };

function buildClockBackgroundMarkup(variant) {
  switch (variant) {
    case 'wave':
    case 'particles':
      // The two canvas variants. See the block comment above the shared runtime
      // (startClockCanvas) for why they are canvases and what that costs; the
      // glow behind the nebula is a plain CSS element, as it does not move with
      // anything in the simulation.
      return (variant === 'particles' ? '<i class="jbe-bg-glow"></i>' : '')
        + '<canvas class="jbe-bg-canvas"></canvas>';

    case 'mesh':
      return buildClockBgMesh();

    case 'godray':
      return buildClockBgGodRay();

    default:
      return '';
  }
}

/**
 * Idempotent: called from applyClockSettingsToContainer() on every
 * applyEnhancements() pass, so the steady state must be a single attribute read.
 * The markup is rebuilt only when the chosen variant actually changes.
 */
function ensureClockBackground(container, requestedVariant) {
  if (!container) return;
  const variant = normalizeClockBackground(requestedVariant);
  const existing = container.querySelector(':scope > .jbe-clock-bg');

  const spec = CLOCK_CANVAS_SPECS[variant] || null;

  if (variant === 'none') {
    if (existing) existing.remove();
    stopClockCanvas();
    container.removeAttribute('data-clock-bg');
    return;
  }

  container.dataset.clockBg = variant;
  if (existing && existing.dataset.variant === variant) {
    // The layer survived, but the clock around it may not have: a rebuild leaves a
    // detached canvas whose loop has already stopped itself, and startClockCanvas
    // is a no-op when it is still the live one.
    if (spec) startClockCanvas(existing.querySelector('.jbe-bg-canvas'), container, spec);
    return;
  }

  const layer = existing || document.createElement('div');
  layer.className = 'jbe-clock-bg';
  layer.dataset.variant = variant;
  // Decorative only: it must never reach the accessibility tree or take a click
  // (the card's whole surface is above it, PUSH button included).
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = buildClockBackgroundMarkup(variant);
  if (!existing) container.prepend(layer);

  if (spec) {
    startClockCanvas(layer.querySelector('.jbe-bg-canvas'), container, spec);
  } else {
    stopClockCanvas();
  }
}

function applyClockSettingsToContainer(container, settings) {
  const clockSize = settings.clockSize || 'medium';
  const showProgressBar = settings.showProgressBar !== false;

  // Every setting is expressed as one attribute on the container and resolved by
  // CSS (see the [data-clock-size] rules in styles.css). This function
  // runs on every applyEnhancements() pass — roughly once a second — so it must
  // not walk the digits: it used to write 8 inline styles per digit per pass, all
  // of which the stylesheet could do for free. Writing an unchanged dataset value
  // is a no-op in the DOM, so the steady-state path now costs nothing.
  container.dataset.clockSize = clockSize;

  const prog = container.querySelector('.work-progress-container');
  if (prog) prog.classList.toggle('hidden', !showProgressBar);

  ensureClockBackground(container, settings.clockBackground);
  updateFlipClockColors(container);
}

// Apply saved clock settings (size, progress bar visibility). Seconds are always
// shown: the toggle was removed from the popup, so there is no `false` state left.
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
      showProgressBar: settings.showProgressBar ?? stored.showProgressBar,
      clockBackground: settings.clockBackground ?? stored.clockBackground ?? DEFAULT_CLOCK_BACKGROUND
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
      // The status pill in the clock is a text mirror of #working_status (see
      // punchCard.js), so it has to be re-read here rather than only once a second
      // from applyEnhancements().
      if (typeof syncPunchStatusBadge === 'function') syncPunchStatusBadge();
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
