# Injected UI Light/Dark Audit

Static audit of the injected Jobcan UI only. Scope excludes the extension popup and any live-page/browser validation.

Skills used:
- `audit` for structure, severity, and prioritization
- `frontend-design` for theming quality, anti-patterns, and design-system consistency

## Anti-Patterns Verdict

Verdict: `Fail, but not beyond recovery.`

The injected UI does not read as fully AI-generated, because several newer report/table surfaces are thoughtfully tokenized and the theme toggle wiring is coherent. The main design-quality tell is inconsistency: older and newer subsystems mix semantic tokens, hard-coded literals, and inline JS styling. That creates a product that feels partially systemized rather than intentionally designed across both themes.

Specific tells:
- Theme decisions are split across tokens, component-specific dark-mode selectors, and inline JS `style` assignments.
- Several newer UI blocks still use literal light-theme gradients, border colors, and text colors.
- Typography is inconsistent with the token system and falls back to generic default stacks in core page styles.
- Some interactions remove the browser outline without consistently replacing it with a robust theme-aware focus treatment.

## Executive Summary

- Total issues found: `12`
- Severity breakdown: `0 Critical`, `4 High`, `5 Medium`, `3 Low`
- Overall quality score: `6/10`
- Most critical next steps:
  1. Tokenize JS-built surfaces so dark mode is not bypassed by inline styles.
  2. Remove hard-coded light-theme colors from exported/reporting surfaces.
  3. Consolidate dark-mode ownership so component styling lives in one theme system instead of scattered overrides.

Scenarios checked in this audit:
- Light mode with no `body.dark-mode`
- Dark mode with `body.dark-mode`
- Theme propagation via `chrome.storage.sync.darkMode` and runtime message handling
- Dynamically generated UI after initialization
- Generated SVG/export surfaces that can ignore the active theme

## Detailed Findings

### High-Severity Issues

#### 1. Exported chart SVGs ignore the active theme entirely
- Location: `scripts/tableFilter.js:1743-1770`
- Severity: `High`
- Category: `Theming`
- Description: The generated SVG export uses fixed fills and strokes like `#ffffff`, `#0f172a`, `#334155`, `#3c73f5`, and `#94a3b8` instead of semantic tokens or theme-derived values.
- Impact: Dark-mode users get an exported artifact that visually reverts to a light theme, breaking brand consistency and making the report feel detached from the UI they configured.
- Standard: Theming consistency / dark-mode parity
- Recommendation: Generate exports from a theme palette object or CSS custom property snapshot so exports inherit the active theme intentionally.
- Suggested command: `/normalize`

#### 2. The external panel is built with inline styles that override dark mode
- Location: `scripts/ui.js:559-568`, `scripts/ui.js:580-600`, `css/variables.css:419-430`
- Severity: `High`
- Category: `Theming`
- Description: The `external-panel-misc` enhancement sets `backgroundColor = 'white'`, applies fixed gray backgrounds in `cssText`, and swaps hover colors via JS. Those inline styles outrank the dark-mode rules defined in `css/variables.css`.
- Impact: This panel can remain visually light inside dark mode, creating one of the most obvious theme breaks in the injected UI.
- Standard: Theming consistency / state synchronization
- Recommendation: Move panel and toggle styling into CSS classes driven by tokens, and keep JS responsible only for state classes.
- Suggested command: `/normalize`

#### 3. Older overlay surfaces still rely on light-theme literals and partial dark-mode patching
- Location: `css/styles.css:3078-3253`, `css/variables.css:443-519`
- Severity: `High`
- Category: `Theming`
- Description: The work-time overlay uses fixed values such as `#f8f9fa`, `#e9ecef`, `#495057`, `#212529`, and `var(--color-white)`. Dark mode adds selective overrides later, but the base component is not authored in tokens from the start.
- Impact: The overlay is harder to maintain and more likely to regress because dark mode depends on a patch layer rather than a single source of truth.
- Standard: Design-system consistency
- Recommendation: Refactor the overlay to use semantic tokens at the base layer, then reserve dark mode for token swaps rather than component-specific rescue rules.
- Suggested command: `/normalize`

#### 4. Sign-in enhancements contain fixed white surfaces and weak control contrast
- Location: `css/styles.css:73-117`
- Severity: `High`
- Category: `Theming`
- Description: The sign-in container and toggle button use `var(--color-white)` plus literal `#aaa` and `#ddd`. The toggle text is especially weak against the light control background, and the component does not have explicit dark-mode compensation in this file.
- Impact: On the sign-in surface, dark mode can feel unfinished and the toggle control risks insufficient readability even in light mode.
- Standard: WCAG 1.4.3 Contrast (likely risk), theming consistency
- Recommendation: Replace literal border/text colors with semantic control tokens and give the sign-in controls explicit themed states.
- Suggested command: `/harden`

### Medium-Severity Issues

#### 5. Dark-mode ownership is fragmented across tokens, component overrides, and literals
- Location: `css/variables.css:198-519`, `css/styles.css:652-695`, `css/styles.css:2375-2396`, `css/styles.css:4062-4077`
- Severity: `Medium`
- Category: `Theming`
- Description: Dark mode is partly token-driven and partly maintained through component-specific overrides with literal values. Some newer components are well tokenized, while others define bespoke dark rules directly in `styles.css`.
- Impact: Every new surface raises regression risk because implementers must remember which theming strategy that area uses.
- Standard: Maintainability / theming architecture
- Recommendation: Define a single theme contract with semantic tokens and minimize component-specific dark-mode selectors.
- Suggested command: `/normalize`

#### 6. Work-progress UI mixes tokenized structure with hard-coded palette fragments
- Location: `css/styles.css:2185-2396`, `scripts/clock.js:126-143`, `scripts/clock.js:616-622`
- Severity: `Medium`
- Category: `Theming`
- Description: The progress container, track, markers, tooltip, and punch dots use a mix of theme tokens and literal neutrals. The JS-generated marker styles also include fixed border and shadow values.
- Impact: This area will be difficult to tune holistically for contrast and polish because the theme model is split between CSS and runtime-generated style strings.
- Standard: Theming consistency
- Recommendation: Extract the work-progress palette into semantic tokens and let JS reference CSS classes or token-based custom properties instead of hard-coded border/shadow strings.
- Suggested command: `/normalize`

#### 7. Several focus treatments suppress native outlines without a consistently strong replacement
- Location: `css/styles.css:1066-1071`, `css/styles.css:1672-1677`, `css/styles.css:2021-2027`, `css/styles.css:4308-4316`
- Severity: `Medium`
- Category: `Accessibility`
- Description: Inputs and interactive surfaces frequently remove `outline` and rely on custom box-shadow or background-only focus treatments. Some are acceptable, but they are not consistently theme-aware or equally visible across surfaces.
- Impact: Keyboard users can lose a reliable, predictable focus signal, especially in darker or denser panels.
- Standard: WCAG 2.4.7 Focus Visible
- Recommendation: Standardize a theme-aware focus ring token and reuse it across inputs, custom options, trend cells, and modal controls.
- Suggested command: `/harden`

#### 8. Undefined or mismatched custom properties create silent fallback behavior
- Location: `css/styles.css:3198`, `css/styles.css:3249`, `css/styles.css:4485`, `scripts/formEnhancer.js:577`
- Severity: `Medium`
- Category: `Theming`
- Description: The code references `--color-text-muted`, `--color-black-35`, and `--border-color`, but those tokens are not defined in `css/variables.css`. Some references include fallbacks, others do not.
- Impact: Styles can quietly degrade or disappear depending on the surface. This is especially risky in dark mode because fallback values tend to be light-theme-biased.
- Standard: Design token integrity
- Recommendation: Audit and reconcile the token contract so every referenced custom property is intentionally defined or removed.
- Suggested command: `/normalize`

#### 9. Base typography diverges from the token system and uses generic stacks
- Location: `css/variables.css:132-137`, `css/base.css:14-22`
- Severity: `Medium`
- Category: `Theming`
- Description: The token system defines `--font-family-base` as a Roboto/Noto Sans JP stack, but the base page style replaces it with `'Segoe UI', 'Helvetica Neue', Arial, sans-serif`.
- Impact: Theme cohesion is weaker than it should be, and the UI can feel less intentional across subsystems.
- Standard: Frontend-design typography guidance
- Recommendation: Make the base layer consume the shared font token or redefine the token to match the intended product typography.
- Suggested command: `/polish`

### Low-Severity Issues

#### 10. Motion choices include layout-affecting transitions in heavily interactive areas
- Location: `css/styles.css:24-36`, `css/styles.css:2307-2312`, `css/styles.css:2327-2332`
- Severity: `Low`
- Category: `Performance`
- Description: The main content area transitions `width` and margins, and the progress markers animate width and height on hover.
- Impact: These choices are unlikely to be catastrophic here, but they increase the risk of jank in dense admin pages and conflict with the frontend-design guidance against layout-property animation.
- Standard: Motion/performance best practice
- Recommendation: Prefer transform/opacity for emphasis states and reserve layout changes for major structural transitions only.
- Suggested command: `/optimize`

#### 11. Dark-mode colors for side-menu states are hard-coded instead of token-derived
- Location: `css/styles.css:652-695`
- Severity: `Low`
- Category: `Theming`
- Description: Side-menu dark-mode states use fixed text and background literals rather than semantic state tokens.
- Impact: The current appearance may be acceptable, but future palette updates will require manual retuning in this component.
- Standard: Design token consistency
- Recommendation: Introduce semantic nav state tokens for default, hover, and active states.
- Suggested command: `/normalize`

#### 12. Decorative and celebratory colors are not theme-aware
- Location: `scripts/clock.js:1153`, `scripts/clock.js:1195`
- Severity: `Low`
- Category: `Theming`
- Description: Confetti colors are fixed to a light-brand palette and do not react to the active theme.
- Impact: This does not block usability, but it weakens visual cohesion in dark mode.
- Standard: Visual consistency
- Recommendation: Map celebration colors through a theme palette so motion accents feel native to both modes.
- Suggested command: `/colorize`

## Patterns & Systemic Issues

- Hard-coded colors still appear in both CSS and JS-built UI, especially older surfaces and runtime-generated elements.
- Dark mode is implemented through three competing mechanisms:
  - semantic tokens in `:root`
  - component overrides nested under `body.dark-mode`
  - inline style assignments from JavaScript
- Older overlay/sign-in surfaces are patched for dark mode after the fact, while newer table/report surfaces are closer to token-first design.
- The token contract is incomplete. Some components rely on undefined variables or literal fallbacks.

## Positive Findings

- Theme propagation itself is sound: `chrome.storage.sync.darkMode` is read on init and reapplied from popup messages in `scripts/ui.js:28-50`.
- The root token model in `css/variables.css:4-253` gives the project a workable foundation for a real light/dark system.
- Several newer report surfaces use `color-mix()` plus semantic colors effectively, especially around tabs, heatmaps, and popovers in `css/styles.css:4048-4525`.
- The project already includes dark-mode overrides for complex legacy surfaces such as modal, calendar, external panel, and overlay areas in `css/variables.css:357-519`, which reduces the amount of work needed to normalize everything.

## Recommendations By Priority

1. Immediate
- Remove inline color/background/border styling from JS-generated panels and overlays.
- Replace fixed export/chart colors with theme-aware palette values.

2. Short-term
- Rewrite overlay and sign-in surfaces to use semantic tokens at the base layer.
- Standardize a single focus-ring treatment for all custom interactive controls.
- Reconcile undefined tokens and remove ad hoc fallbacks.

3. Medium-term
- Consolidate dark-mode logic so tokens own the palette and components consume tokens without bespoke literals.
- Unify typography through the design-token layer.

4. Long-term
- Tune celebration/motion accents for each theme.
- Refine animation choices to avoid layout-affecting transitions in dense UI zones.

## Suggested Commands For Fixes

- Use `/normalize` to centralize theme tokens, remove literal palette leaks, and align legacy surfaces with the design system.
- Use `/harden` to improve focus visibility, contrast resilience, and component-state accessibility.
- Use `/polish` to align typography, minor visual consistency, and surface detail quality.
- Use `/optimize` to reduce layout-affecting transitions and tighten interactive performance.
- Use `/colorize` to make celebratory accents and secondary visual cues theme-aware without over-brightening the UI.
