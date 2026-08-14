// background.js

// Hard ceiling on a login attempt. Without it a rejected password left the
// tabs.onUpdated listener attached forever and never called sendResponse, so the
// popup's button stayed disabled on 「ログイン中…」 with no way back.
const LOGIN_TIMEOUT_MS = 25000;

// Entry point for a login attempt.
//
// The employee app (ssl.jobcan.jp) is a separate application from the identity
// provider (id.jobcan.jp) and is only reachable through an OAuth handshake.
// Measured redirect chain from this URL while signed out:
//
//   ssl.jobcan.jp/jbcoauth/login
//     → id.jobcan.jp/oauth/authorize/?...&redirect_uri=ssl.jobcan.jp/jbcoauth/callback
//     → id.jobcan.jp/users/sign_in        ← inject credentials here
//     → (Jobcan resumes the pending authorize request itself)
//     → ssl.jobcan.jp/jbcoauth/callback?code=… → ssl.jobcan.jp/employee
//
// While already signed in the same URL runs the whole chain unattended and lands
// on /employee with no form and no typing.
//
// This used to start at id.jobcan.jp/users/sign_in instead. That URL has no
// pending OAuth request attached to it, so Jobcan has nowhere to send you
// afterwards and parks you on its own id.jobcan.jp/account/profile portal page —
// the employee app is never entered. /account/profile was never a required step;
// it was the symptom of entering through the wrong door. Handled below anyway,
// since Jobcan can still land there on its own.
const LOGIN_ENTRY_URL = 'https://ssl.jobcan.jp/jbcoauth/login';

// The content script that fills the form is injected at document_idle, which can
// land after tabs.onUpdated has already reported 'complete' on a slow load.
const MAX_INJECT_ATTEMPTS = 3;
const INJECT_RETRY_DELAY_MS = 400;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'performJobcanLogin') {
    startJobcanLogin(message, sendResponse);
    return true; // Keep the message channel open for the async response
  }

  if (message.action === 'ensureHtml2Canvas') {
    injectHtml2Canvas(sender, sendResponse);
    return true;
  }

  return false;
});

// Drive a login in a background tab: start the OAuth handshake, fill in the
// sign-in form if Jobcan asks for one, and reveal the tab once it reaches the
// employee app.
//
// Nothing here assumes the user is signed out. An unexpired id.jobcan.jp session
// simply means the sign-in page never appears and the credentials are never used.
//
// Every exit path — success, rejected credentials, injection failure, the user
// closing the tab, or the timeout — funnels through finish(), which is the only
// place the listeners are removed and the only place sendResponse is called.
// (Previously only the two success paths cleaned up.)
function startJobcanLogin({ email, password }, sendResponse) {
  chrome.tabs.create({ url: LOGIN_ENTRY_URL, active: false }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      sendResponse({ success: false });
      return;
    }

    const loginTabId = tab.id;
    let settled = false;
    let injectAttempts = 0;
    let credentialsSubmitted = false;
    let restartedHandshake = false;
    let timeoutId = null;

    const finish = (success, { reveal = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (reveal) {
        // The tab may already be gone; swallow the resulting lastError.
        chrome.tabs.update(loginTabId, { active: true }, () => void chrome.runtime.lastError);
      }
      sendResponse({ success });
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === loginTabId) finish(false);
    };

    const injectCredentials = () => {
      injectAttempts += 1;
      chrome.tabs.sendMessage(loginTabId, { action: 'injectLoginCredentials', email, password }, (response) => {
        if (settled) return;
        if (chrome.runtime.lastError || !response || !response.success) {
          if (injectAttempts < MAX_INJECT_ATTEMPTS) {
            setTimeout(() => {
              if (!settled) injectCredentials();
            }, INJECT_RETRY_DELAY_MS);
            return;
          }
          finish(false, { reveal: true });
          return;
        }
        // Submitted. Jobcan owns the navigation from here: it resumes the
        // authorize request that LOGIN_ENTRY_URL left pending in the session.
        // Do not race it with a tabs.update — the previous version fired one on
        // a fixed 800ms timer, which also wiped Jobcan's 「認証に失敗」 message
        // off the page whenever the password was wrong.
        credentialsSubmitted = true;
      });
    };

    const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== loginTabId) return;

      // `status: 'complete'` updates carry no `url`, so fall back to the tab's.
      const currentUrl = changeInfo.url || (updatedTab && updatedTab.url) || '';

      // Success: the OAuth callback has handed us over to the employee app.
      // Taken on the first `loading` event so the popup's toast resolves without
      // waiting for the page to finish rendering.
      if (currentUrl.startsWith('https://ssl.jobcan.jp/employee')) {
        finish(true, { reveal: true });
        return;
      }

      // Everything below is a decision about where we have *landed*. The 302s
      // inside the handshake only ever produce `loading` events, so gating on
      // 'complete' keeps us from mistaking a hop we are passing through for a
      // destination.
      if (changeInfo.status !== 'complete') return;

      if (currentUrl.startsWith('https://id.jobcan.jp/users/sign_in')) {
        if (credentialsSubmitted) {
          // We already submitted and Jobcan served the sign-in page again, so the
          // credentials were rejected. Surface the tab (it carries Jobcan's own
          // error message) instead of leaving the popup spinning.
          finish(false, { reveal: true });
          return;
        }
        // A 'complete' while an attempt is already in flight belongs to the retry
        // timer, not to a new attempt — do not double-submit the form.
        if (injectAttempts === 0) injectCredentials();
        return;
      }

      // Signed in, but parked on the identity provider instead of the employee
      // app — /account/profile is the one Jobcan uses. Restart the handshake,
      // once, so this cannot ping-pong. /oauth/ is excluded: reaching 'complete'
      // there means a consent screen is genuinely on display and re-entering
      // would only redraw it, so let the timeout reveal the tab for the user.
      if (currentUrl.startsWith('https://id.jobcan.jp/') && !currentUrl.includes('/oauth/')) {
        if (!restartedHandshake) {
          restartedHandshake = true;
          chrome.tabs.update(loginTabId, { url: LOGIN_ENTRY_URL }, () => void chrome.runtime.lastError);
        }
      }
    };

    timeoutId = setTimeout(() => finish(false, { reveal: true }), LOGIN_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// html2canvas is ~220KB and is only needed for the screenshot / 工数レポート
// features, so it is no longer a static content script (that cost every Jobcan
// page load). It is injected on first use instead.
//
// This has to go through chrome.scripting rather than a <script> tag: a tag would
// evaluate in the page's MAIN world, while screenshot.js runs in the ISOLATED
// world and needs `html2canvas` as its own global. executeScript defaults to
// ISOLATED, which puts it in the same world as the rest of the content scripts.
function injectHtml2Canvas(sender, sendResponse) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') {
    sendResponse({ success: false });
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId, frameIds: [sender.frameId || 0] },
    files: ['html2canvas.min.js']
  }, () => {
    sendResponse({ success: !chrome.runtime.lastError });
  });
}
