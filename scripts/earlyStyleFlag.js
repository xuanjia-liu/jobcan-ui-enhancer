// scripts/earlyStyleFlag.js
//
// Runs at document_start, before Jobcan's markup is parsed or painted.
//
// Every rule in css/ is scoped under `html.jobcan-enhanced`, and the CSS files
// themselves are injected at document_start — but the class that arms them was
// only added by applyEnhancements() in main.js, which the manifest runs at
// document_idle (the default). Between first paint and document_idle the page
// therefore rendered in Jobcan's own styling: measured on the top page, the PUSH
// button fell back to Jobcan's `.jbc-btn-secondary` orange (#eb840b) because the
// only thing painting it blue is `.jobcan-enhanced .btn` in styles.css.
//
// Adding the class here closes that window for every rule at once. main.js still
// adds it (applyEnhancements re-runs constantly and must stay self-sufficient on
// SPA navigation); classList.add is idempotent, so the two do not fight.
//
// Deliberately an IIFE with no top-level declarations: content scripts share one
// global scope, and this file has nothing to share.
(function setEarlyStyleFlag() {
  document.documentElement.classList.add('jobcan-enhanced');
})();
