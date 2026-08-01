// background.js

// Hard ceiling on a login attempt. Without it a rejected password left the
// tabs.onUpdated listener attached forever and never called sendResponse, so the
// popup's button stayed disabled on 「ログイン中…」 with no way back.
const LOGIN_TIMEOUT_MS = 25000;

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

// Drive a login in a background tab: open the sign-in page, inject the
// credentials once it loads, then follow the SSO hop to the employee portal.
//
// Every exit path — success, rejected credentials, injection failure, the user
// closing the tab, or the timeout — funnels through finish(), which is the only
// place the listeners are removed and the only place sendResponse is called.
// (Previously only the two success paths cleaned up.)
function startJobcanLogin({ email, password }, sendResponse) {
  chrome.tabs.create({ url: 'https://id.jobcan.jp/users/sign_in', active: false }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      sendResponse({ success: false });
      return;
    }

    const loginTabId = tab.id;
    let settled = false;
    let credentialsInjected = false;
    let attemptedNavigateToEmployee = false;
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

    const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId !== loginTabId) return;

      // `status: 'complete'` updates carry no `url`, so fall back to the tab's.
      const currentUrl = changeInfo.url || (updatedTab && updatedTab.url) || '';

      // Success: reached the employee portal.
      if (currentUrl.includes('https://ssl.jobcan.jp/employee')) {
        handleSuccessfulLogin(loginTabId);
        finish(true);
        return;
      }

      const onSignInPage = currentUrl.includes('https://id.jobcan.jp/users/sign_in');

      if (onSignInPage && changeInfo.status === 'complete') {
        if (credentialsInjected) {
          // We already submitted and Jobcan served the sign-in page again, so the
          // credentials were rejected. Surface the tab (it carries Jobcan's own
          // error message) instead of leaving the popup spinning.
          finish(false, { reveal: true });
          return;
        }

        chrome.tabs.sendMessage(loginTabId, { action: 'injectLoginCredentials', email, password }, (response) => {
          if (chrome.runtime.lastError || !response || !response.success) {
            finish(false, { reveal: true });
            return;
          }
          credentialsInjected = true;
          // Give SSO a moment to set cookies, then navigate if we haven't been
          // redirected yet.
          if (!attemptedNavigateToEmployee) {
            attemptedNavigateToEmployee = true;
            setTimeout(() => {
              if (settled) return;
              chrome.tabs.update(
                loginTabId,
                { url: 'https://ssl.jobcan.jp/jbcoauth/login' },
                () => void chrome.runtime.lastError
              );
            }, 800);
          }
        });
        return;
      }

      // Redirected to another id.jobcan.jp page (account/profile) after login —
      // force the hop to the employee portal.
      if (credentialsInjected && !onSignInPage && currentUrl.startsWith('https://id.jobcan.jp/')) {
        if (!attemptedNavigateToEmployee) {
          attemptedNavigateToEmployee = true;
          chrome.tabs.update(
            loginTabId,
            { url: 'https://ssl.jobcan.jp/jbcoauth/login' },
            () => void chrome.runtime.lastError
          );
        }
      }
    };

    timeoutId = setTimeout(() => finish(false, { reveal: true }), LOGIN_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// Focus the employee dashboard on successful login
function handleSuccessfulLogin(tabId) {
  chrome.tabs.update(tabId, { url: 'https://ssl.jobcan.jp/employee', active: true });
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
