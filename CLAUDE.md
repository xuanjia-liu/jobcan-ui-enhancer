# CLAUDE.md

Chrome extension (Manifest V3) that restyles and extends Jobcan's employee pages.
No bundler, no build step, no tests — `scripts/*.js` run in the browser as-is.

See [README.md](README.md) for the file-by-file map. This file covers the things
that will bite you when changing code.

## Commands

```bash
npm run lint       # must stay at 0 problems
npm run lint:fix
```

There is no test suite and no build. To verify a change you must reload the
extension at `chrome://extensions/` (the ⟳ button) and reload the Jobcan page —
this applies to CSS too. `chrome://` pages cannot be automated, so ask the user
to reload; you cannot do it yourself.

## Architecture constraints

**Content scripts share one global scope.** The manifest concatenates
`scripts/*.js`; a `function foo()` in one file is called by bare name from
another. Two files declaring the same name is a silent, load-order-dependent
bug — it has happened twice in this repo (`showNotification`,
`cleanupClockContainer`). Before adding a top-level function, grep for the name.

**Manifest order is the dependency order.** `utils.js` first, `main.js` near the
end. If A calls B at load time, B's file must come first in `manifest.json`.

**`scripts/manHourEditSearch.js` runs in the MAIN world.** It needs the page's own
jQuery and jQuery-UI autocomplete instances. It therefore *cannot* see
`window.__jbe_*` or any other isolated-world global, and vice versa. Everything
else runs in the ISOLATED world.

**Never replace the man-hour project/task inputs.** Selections made outside
Jobcan's native autocomplete bypass its internal model, get rejected as 未入力,
and will not save. A custom side-panel picker was tried and reverted. Only widen
the native widget's `_search`.

Inspected on the live page, which is why programmatic fill is still unsolved:
the row has **no hidden inputs** (just checkbox + 2 text `.unit` + `.note` +
`.manhour`), `autocomplete('instance').options.select` is **null**, and Jobcan
tracks edits through its own `setupTrackingEvents`/`TRACK_SELECTORS` listening for
`change` and `autocompletechange`. So the chosen unit id lives only in opaque JS
state. The widget is also created **lazily on first real interaction** — it does
not exist on focus, and synthetic events do not create it. Any "copy a previous
day" feature must therefore drive the real widget, and must not be shipped without
a save-test on a throwaway day.

**Jobcan already ships an unsaved-changes guard** on the edit page
(`hasChanges` + `beforeunload`, verified firing). Do not add a second one.

**`applyEnhancements()` in `main.js` re-runs constantly** — a debounced body-wide
MutationObserver calls it roughly once a second while the DOM churns, plus on
every SPA `locationchange`. Anything it calls must be idempotent and guarded by a
`data-*` attribute or a `window.__jbe_*Inited` flag. Unguarded DOM writes here
feed the same observer and cost real CPU.

**Use the resource registry**, never bare `setInterval` / `new MutationObserver`:

```js
window.__jbe_startManagedInterval(key, cb, delayMs, { maxRuns })
window.__jbe_registerManagedObserver(key, observer, onCleanup)
```

Keys prefixed `watch:` are torn down on SPA navigation — pass `onCleanup` to reset
whatever init flag guards their setup, or they will never come back. Keys prefixed
`core:` persist.

**Re-registering a key disconnects the entry it replaces**, so anything registered
under a fixed key more than once must make `disconnect()` teardown *only its own*
resource. A `{ disconnect: stopFoo }` shim that stops "the current one" will tear down
the run it was just registered for — the second registration kills itself, and only
the first ever works (`attachClockBgPointer` in `clock.js` hit exactly this).

**`html2canvas` is not loaded on page load.** It is injected on first use via
`chrome.scripting.executeScript` from `background.js` (which is why the `scripting`
permission is needed). A `<script>` tag would land in the MAIN world and be
invisible to `screenshot.js` — go through `ensureHtml2Canvas()`.

## Lint model

`eslint.config.js` models the shared-global architecture explicitly. Cross-file
functions must be registered in **two** places:

1. `/* exported name */` at the top of the declaring file
2. `crossFileGlobals` in `eslint.config.js`

Miss #1 and lint calls it unused; miss #2 and lint calls the caller undefined.
Either way you find out. Keep lint at zero — the config only earns its keep if
real dead code stands out.

## CSS

Load order: `variables.css` → `base.css` → `styles.css` → `responsive.css` →
`manHourRebuild.css`. Everything is scoped under `html.jobcan-enhanced`,
`.jbe-*`, or `.dark-mode`.

**Do not bulk-remove `!important`.** Jobcan's own stylesheets carry ~1,300
`!important` declarations, overwhelmingly Bootstrap 4 utility classes
(`.d-flex`, `.text-center`, `.bg-white`, `.m-*`, `.p-*`) on exactly the properties
this extension needs to override: `display`, `color`, `background-color`, margin,
padding, flex alignment. Specificity never beats `!important`, so raising
specificity does not let you drop it. Measured: ~89% of the `!important` in `css/`
is load-bearing. Only SVG `fill`/`stroke`, `z-index`, `opacity`, `font-size` and a
few one-offs are genuinely removable, and each needs checking on the live page.

**The clock card's ambient background is one `z-index: -1` layer.**
`ensureClockBackground()` (clock.js) prepends a single `.jbe-clock-bg` to
`.flip-clock-container`; the six variants are all CSS keyed on `[data-variant]`.
Two couplings to know about:

* it colours itself from `--jbe-bg-tint` / `--jbe-bg-strength`, which CSS derives
  from the container's `[data-clock-color-class]` — the attribute
  `updateFlipClockColors()` writes from `#working_status`. Never hardcode a state
  colour in a variant.
* `z-index: -1` only paints above the card background because the card is a
  stacking context. Do not add `overflow: hidden` to the container to clip it —
  that clips the 打刻詳細設定 popover; the layer clips itself.

`screenshot.js` hides the layer in html2canvas's clone (`color-mix()` and
`mask-image` are past what it parses reliably). A new variant needs nothing there.

Dark mode is driven by `body.dark-mode`. Jobcan's Bootstrap/jQuery-UI widgets
(e.g. the autocomplete dropdown's `bg-white`) need `!important` overrides and must
be verified on the real page.

## Jobcan API

Jobcan rebuilt the man-hour pages around June 2026: the editor is a standalone
page, the list renders via a Web Worker, and both are backed by a REST API under
`/employee/man-hour-manage-api`. `scripts/manHourApi.js` documents and wraps the
endpoints. Times in API responses are in **seconds**.

**`get-achievements-kinds-in-period` answers for a *defined period*, not "any data
in range".** A month with no man-hour period yet returns `[]` — measured: 2026-08
returned `[]` while 2026-07 and 2026-06 each returned the 2 kinds, and a
multi-month window also returned `[]`. Anything that resolves kind ids must fall
back to earlier months (`manHourEditSearch.js` walks back up to 3). Kind ids are
stable dimension definitions, so a previous month's id works fine for a
current-month date.

**Attendance/punch data has no JSON API** — `/employee/attendance/progress` needs a
ProcessId and `/employee/attendance/download` returns HTML. But it does not need
one: everything is server-rendered, so `dataExtraction.js` uses `fetch` +
`DOMParser` (see `fetchJobcanDocument`). Do **not** reintroduce the hidden iframes
this replaced — measured, fetch is ~770ms for the attendance summary and ~230ms
for 打刻一覧, against an iframe's full page load plus fixed multi-second sleeps.

## Security

Login credentials are stored in `chrome.storage.local` (device-only) in plain
text, and `loginInjector.js` auto-submits them. Do not move this to
`storage.sync` — it was there once and would replicate the password to every
signed-in device. Do not add new credential storage; prefer Chrome's password
manager.
