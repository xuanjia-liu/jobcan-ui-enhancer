// ESLint flat config (ESLint 9+).  Setup:  npm install   then:  npm run lint
//
// This extension loads its scripts as plain globals concatenated by the manifest
// (no modules / no bundler): a function defined in one file is called from another
// through the global scope. That pattern makes `no-undef` and "unused" top-level
// functions produce many false positives, so `no-undef` is OFF and unused *vars*
// are warnings only. The genuinely useful correctness rules from eslint:recommended
// (no-dupe-keys, no-unreachable, no-redeclare, no-cond-assign, …) stay on as errors
// — those are the ones that catch real bugs in this codebase.
//
// To tighten later: enumerate the cross-file globals below and switch `no-undef`
// back on to catch typo'd identifiers.

const js = require('@eslint/js');

module.exports = [
  {
    // Vendored / minified third-party libraries — never lint these.
    ignores: [
      'html2canvas.min.js',
      'confetti.min.js',
      'gif.js',
      'gif.worker.js'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Browser
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'writable',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        Node: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        ClipboardItem: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        getComputedStyle: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        // Extension APIs
        chrome: 'readonly',
        // Vendored libraries (loaded before our scripts via the manifest)
        html2canvas: 'readonly',
        GIF: 'readonly',
        confetti: 'readonly',
        jQuery: 'readonly',
        $: 'readonly'
      }
    },
    rules: {
      // Off / relaxed: the cross-file global-function architecture makes these
      // too noisy to be actionable. NOTE: no-unused-vars still reports top-level
      // entry-point functions (called cross-file from main.js) as "unused" — those
      // are false positives; the actionable signal is unused *local* variables.
      'no-undef': 'off',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // This codebase legitimately uses full-width spaces (U+3000) inside regex
      // literals for Japanese text (e.g. /　+$/ to trim ideographic spaces), which
      // ESLint can't distinguish from an accidental invisible char — so this is a
      // warning, not an error. Still skips comments/strings to cut the noise.
      'no-irregular-whitespace': ['warn', { skipComments: true, skipStrings: true, skipTemplates: true, skipRegExps: true }],
      // Redundant escapes (e.g. \/ inside a char class) are harmless style nits.
      'no-useless-escape': 'warn',
      // Keep the high-value correctness checks as hard errors.
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-func-assign': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'use-isnan': 'error',
      'valid-typeof': 'error'
    }
  }
];
