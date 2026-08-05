// scripts/ui.js

/* exported setupCleanupObserver, initDarkMode,
   setupHeaderVisibility, enhanceManagerNameDisplay,
   enhanceUserDisplay, setupMenuOrderDropdown, fixSettingsIcon,
   foldSignInRightContainer, removeLogoBorder, autoCollapseExternalPanelMisc */

// Observer to cleanup intervals/observers when elements are removed
function setupCleanupObserver() {
  if (window.__jbe_cleanupObserverInited) return;
  window.__jbe_cleanupObserverInited = true;

  // Create a MutationObserver to watch for removed nodes
  const cleanupObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      if (mutation.removedNodes.length > 0) {
        mutation.removedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const clockContainers = node.querySelectorAll ? node.querySelectorAll('.flip-clock-container') : [];
          clockContainers.forEach(container => {
            cleanupClockContainer(container);
          });
          if (node.classList && node.classList.contains('flip-clock-container')) {
            cleanupClockContainer(node);
          }
        });
      }
    });
  });
  cleanupObserver.observe(document.body, { childList: true, subtree: true });
  // Tracked (not `watch:`-prefixed) so it survives SPA navigation: this observer
  // is what tears down clock timers, and it is created exactly once.
  if (typeof window.__jbe_registerManagedObserver === 'function') {
    window.__jbe_registerManagedObserver('core:clockCleanup', cleanupObserver);
  }
}

// Apply dark mode to the page
function applyDarkMode(enabled) {
  if (enabled) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

// Initialize dark mode based on saved settings
function initDarkMode() {
  chrome.storage.sync.get(['darkMode'], function(result) {
    if (result.darkMode !== undefined) {
      applyDarkMode(result.darkMode);
    }
  });
}

// Listen for messages from popup.js.
//
// Only these two actions exist. There were also `testParticleEffects` and
// `getDebugInfo` handlers here, but nothing ever sent those messages — the popup
// has no debug UI — so they were unreachable, and their reflection over
// window.createParticleEffect / window.addPushButtonParticleEffects was the sole
// reason those functions were exposed on window at all.
chrome.runtime.onMessage.addListener(function(message) {
  if (message.action === 'toggleDarkMode') {
    applyDarkMode(message.enabled);
  } else if (message.action === 'updateClockSettings') {
    // Handle clock settings (already implemented)
    if (typeof updateClockSettings === 'function') {
      updateClockSettings(message);
    }
  }
});

// cleanupClockContainer lives in scripts/clock.js, which owns the intervals and
// the ResizeObserver it tears down. This file used to declare a second, narrower
// copy (progress interval only); because clock.js loads after ui.js its version
// won at runtime and this one was dead — but either file changing load order
// would have silently swapped which cleanup ran.

// fixDuplicateSidemenus() and enhanceSidemenuBehavior() used to live here. Both
// were removed after measuring what they matched on the live pages
// (/employee/man-hour-manage/achievement-list and /employee/attendance):
//
//   * fixDuplicateSidemenus() was a no-op. Jobcan renders exactly ONE
//     `#sidemenu, .sidemenu` per page, so the de-dup loop never entered its
//     `length > 1` branch, and `[data-toggle="sidemenu"], .menu-toggle,
//     .sidebar-toggle` matched 0 elements, so the clone-and-rebind block never
//     ran either. It re-queried all of that on every applyEnhancements() pass.
//   * enhanceSidemenuBehavior() actively broke the menu: it hid
//     `[onclick*="closeSidemenu"]`, which is Jobcan's ONLY collapse control
//     (#sidemenu > button.jbc-sidemenu-btn). Once opened, the menu could not be
//     closed — and the collapsed state is the one where .jbc-container drops its
//     1140px cap, so it also cost ~670px of content width. The `mouseenter`
//     handler that was meant to replace it only ever wrote
//     `dataset.mouseInside`, which nothing read; the close-on-mouse-out it
//     promised was never implemented. Setting `onclick="openSidemenu()"` on
//     #sidemenu-closed was dead too — Jobcan already ships that attribute.
//
// The matching CSS (the hide rule for the closer, `.side-closed ~ .contentsArea`,
// and the duplicate-sidemenu blocks) went with them. Menu open/close is Jobcan's
// own openSidemenu()/closeSidemenu(); the extension only skins it now.

// Make header always visible and style navigation
function setupHeaderVisibility() {
  if (window.__jbe_headerVisibilityInited) return;
  window.__jbe_headerVisibilityInited = true;

  const header = document.querySelector('.jbcid-header');
  if (!header) return;
  const existingTrigger = document.querySelector('.jbcid-header-trigger');
  if (existingTrigger && existingTrigger.parentNode) existingTrigger.parentNode.removeChild(existingTrigger);
  header.classList.add('visible');
  header.classList.add('jbe-header-enhanced');
  const navbarMenu = header.querySelector('.jbcid-navbar-menu.jbcid-navbar-left');
  if (navbarMenu) {
    navbarMenu.classList.add('jbe-navbar-menu-enhanced');
    const navItems = navbarMenu.querySelectorAll('ul.nav li a');
    navItems.forEach(item => {
      item.classList.add('jbe-navbar-item');
      item.classList.toggle('jbe-navbar-item-active', item.classList.contains('active'));
    });
    const navContainer = navbarMenu.querySelector('ul.nav');
    if (navContainer) {
      navContainer.classList.add('jbe-navbar-list');
    }
  }
  header.onmouseenter = null;
  header.onmouseleave = null;
  const contentsArea = document.querySelector('.contentsArea');
  if (contentsArea) contentsArea.classList.add('jbe-header-spaced');
  const mainContent = document.querySelector('#main-content');
  if (mainContent) mainContent.classList.add('jbe-header-spaced');
}

// Enhance the manager name dropdown and add settings icon
function enhanceManagerNameDisplay() {
  const managerNameEl = document.querySelector('#manager-name'); if (!managerNameEl) return;
  if (managerNameEl.dataset.enhanced === 'true') return;
  managerNameEl.dataset.enhanced = 'true';
  const staffSettingsLink = managerNameEl.querySelector('.dropdown-item[href="/employee/edit-info/"]');
  if (!staffSettingsLink) return;
  const settingsButton = document.createElement('a');
  settingsButton.href = '/employee/edit-info/';
  settingsButton.className = 'staff-settings-btn';
  settingsButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">` +
    `<path fill="currentColor" d="M19.14 12.94c.04 -.3 .06 -.61 .06 -.94 0 -.32 -.02 -.64 -.07 -.94l2.03 -1.58c.18 -.14 .23 -.41 .12 -.61l-1.92 -3.32c-.12 -.22 -.37 -.29 -.59 -.22l-2.39 .96c-.5 -.38 -1.03 -.7 -1.62 -.94l-.36 -2.54c-.04 -.24 -.24 -.41 -.47 -.41h-3.84c-.24 0 -.43 .17 -.47 .41l-.36 2.54c-.59 .24 -1.13 .57 -1.62 .94l-2.39 -.96c-.22 -.08 -.47 0 -.59 .22L2.74 8.87c-.12 .21 -.08 .47 .12 .61l2.03 1.58c-.05 .3 -.09 .63 -.09 .94s.02 .64 .07 .94l-2.03 1.58c-.18 .14 -.23 .41 -.12 .61l1.92 3.32c.12 .22 .37 .29 .59 .22l2.39 -.96c.5 .38 1.03 .7 1.62 .94l.36 2.54c.05 .24 .24 .41 .48 .41h3.84c.24 0 .44 -.17 .47 -.41l.36 -2.54c.59 -.24 1.13 -.56 1.62 -.94l2.39 .96c.22 .08 .47 0 .59 -.22l1.92 -3.32c.12 -.22 .07 -.47 -.12 -.61l-2.01 -1.58zM12 15.6c-1.98 0 -3.6 -1.62 -3.6 -3.6s1.62 -3.6 3.6 -3.6 3.6 1.62 3.6 3.6 -1.62 3.6 -3.6 3.6z"/></svg>`;
  settingsButton.title = '設定';
  managerNameEl.appendChild(settingsButton);
  const dropdownToggle = managerNameEl.querySelector('.dropdown-toggle');
  const dropdownMenu = managerNameEl.querySelector('.dropdown-menu');
  if (dropdownToggle && dropdownMenu) {
    dropdownMenu.classList.add('jbe-manager-dropdown-menu');
    const items = dropdownMenu.querySelectorAll('.dropdown-item');
    items.forEach(item => item.classList.add('jbe-manager-dropdown-item'));
    dropdownToggle.addEventListener('click', function(e) {
      e.preventDefault(); e.stopPropagation();
      if (managerNameEl.classList.contains('show')) {
        managerNameEl.classList.remove('show');
      } else { managerNameEl.classList.add('show'); }
    });
    if (!window.__jbe_managerDropdownDocClickBound) {
      // Bind the outside-click-to-close listener once, globally. Re-query
      // #manager-name on each click so it keeps working if Jobcan re-renders the
      // node — binding per element would leak a document listener on every re-render.
      window.__jbe_managerDropdownDocClickBound = true;
      document.addEventListener('click', function(e) {
        const el = document.querySelector('#manager-name');
        if (el && !el.contains(e.target) && el.classList.contains('show')) {
          el.classList.remove('show');
        }
      });
    }
  }
}

// Make user name and staff code display horizontally in dropdown toggle
function enhanceUserDisplay() {
  const userToggleElements = document.querySelectorAll('a.dropdown-toggle[id="rollover-menu-link"]');
  userToggleElements.forEach(toggle => {
    if (toggle.dataset.enhanced === 'true') return;
    toggle.dataset.enhanced = 'true';
    toggle.classList.add('jbe-rollover-toggle');
    const content = toggle.innerHTML;
    if (content.includes('<br>') && content.includes('スタッフコード')) {
      const parts = content.split('<br>');
      const name = parts[0].trim();
      const staffCodeDiv = parts[1].trim();
      const wrapper = document.createElement('div');
      wrapper.className = 'jbe-rollover-user-wrapper';
      const nameElement = document.createElement('span'); nameElement.innerHTML = name;
      const tempDiv = document.createElement('div'); tempDiv.innerHTML = staffCodeDiv;
      const codeEl = document.createElement('span'); codeEl.className = 'jbe-rollover-user-code'; codeEl.innerHTML = tempDiv.firstChild.innerHTML;
      wrapper.appendChild(nameElement); wrapper.appendChild(codeEl);
      toggle.innerHTML = ''; toggle.appendChild(wrapper);
    }
  });
}

// Fix the menu_order dropdown functionality
function setupMenuOrderDropdown() {
  if (window.__jbe_menuOrderDropdownInited) return;
  window.__jbe_menuOrderDropdownInited = true;

  const menuTrigger = document.getElementById('menu_order_img');
  const menuDropdown = document.getElementById('menu_order');
  if (!menuTrigger || !menuDropdown) return;
  if (menuTrigger.dataset.enhanced === 'true') return;
  menuTrigger.dataset.enhanced = 'true';

  // Show the dropdown by default
  menuDropdown.classList.add('show');
  menuTrigger.setAttribute('aria-expanded', 'true');

  menuTrigger.addEventListener('click', function(e) {
    e.preventDefault(); e.stopPropagation();
    menuDropdown.classList.toggle('show');
    if (menuDropdown.classList.contains('show')) menuTrigger.setAttribute('aria-expanded', 'true');
    else menuTrigger.setAttribute('aria-expanded', 'false');
  });
  // No outside-click handler on purpose: this dropdown is meant to stay open.
  // (There used to be a document-level listener here whose entire body was
  // commented out — a live listener on every click that did nothing.)
}

// Fix settings icon appearance
function fixSettingsIcon() {
  if (window.__jbe_fixSettingsIconInited) return;
  window.__jbe_fixSettingsIconInited = true;

  const fixSettingsButtons = () => {
    const settingsButtons = document.querySelectorAll('.staff-settings-btn');
    settingsButtons.forEach(button => {
      if (button.hasAttribute('data-enhanced')) return;
      button.setAttribute('data-enhanced', 'true');
      const originalTitle = button.getAttribute('title') || '設定';
      if (!button.textContent.trim()) button.textContent = originalTitle;
    });
  };
  fixSettingsButtons();
  if (!window.__jbe_fixSettingsIconObserver) {
    const observer = new MutationObserver((mutations) => {
    let shouldFix = false;
    mutations.forEach(mutation => {
      if (mutation.type === 'childList' && mutation.addedNodes.length) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1 && (node.classList?.contains('staff-settings-btn') || node.querySelector?.('.staff-settings-btn'))) {
            shouldFix = true;
          }
        });
      }
    });
    if (shouldFix) fixSettingsButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__jbe_fixSettingsIconObserver = observer;
    if (typeof window.__jbe_registerManagedObserver === 'function') {
      window.__jbe_registerManagedObserver('core:settingsIcon', observer);
    }
  }
  // (Removed a redundant 4s setInterval that re-ran fixSettingsButtons — the
  // MutationObserver above already re-applies when .staff-settings-btn appears.)
}

// Fold the sign-in right container by default
function foldSignInRightContainer() {
  const container = document.querySelector('.col-sm-6.sign-in-right-container'); if (!container || container.dataset.enhanced) return;
  container.dataset.enhanced = 'true';
  const parentElem = container.parentNode;
  if (parentElem && getComputedStyle(parentElem).position === 'static') parentElem.classList.add('jbe-signin-parent-positioned');
  container.classList.add('jbe-signin-right-container');
  container.classList.add('is-collapsed');
  const signInBg = document.querySelector('.sign-in-bg'); if (signInBg) signInBg.classList.add('jbe-hidden');
  Array.from(container.children).forEach(child => {
    if (child.classList) child.classList.add('jbe-signin-child');
  });
  const toggleButton = document.createElement('button'); toggleButton.className = 'sign-in-toggle-btn jbe-signin-toggle-btn is-collapsed'; toggleButton.textContent = '広告を表示'; toggleButton.type = 'button';
  toggleButton.addEventListener('click', () => {
    const isCollapsed = container.classList.contains('is-collapsed');
    if (!isCollapsed) {
      container.classList.add('is-collapsed');
      toggleButton.textContent = '広告を表示';
      toggleButton.classList.add('is-collapsed');
      toggleButton.classList.remove('is-expanded');
      container.parentNode.insertBefore(toggleButton, container);
    } else {
      container.classList.remove('is-collapsed');
      toggleButton.textContent = '×';
      toggleButton.classList.remove('is-collapsed');
      toggleButton.classList.add('is-expanded');
      container.appendChild(toggleButton);
    }
  });
  container.parentNode.insertBefore(toggleButton, container);
}

// Remove border from the logo
function removeLogoBorder() {
  const logoSelectors = ['.jbcid-logo', '.jbc-logo', '.logo', 'img.logo', '.jbcid-header img', '.jbcid-navbar-logo', '.brand-logo'];
  logoSelectors.forEach(selector => {
    const logoElements = document.querySelectorAll(selector);
    logoElements.forEach(logo => {
      logo.classList.add('jbe-logo-no-border');
    });
  });
}

// Auto-collapse certain panels on man-hour page
function autoCollapseExternalPanelMisc() {
  if (window.__jbe_autoCollapseExternalPanelInited) return;
  window.__jbe_autoCollapseExternalPanelInited = true;
  // Process existing external-panel-misc elements
  const processExternalPanels = () => {
    const panels = document.querySelectorAll('.external-panel-misc');
    panels.forEach(panel => {
      if (panel && !panel.dataset.enhanced) {
        // Mark as enhanced to prevent duplicate processing
        panel.dataset.enhanced = 'true';
        
        // Store original display so the panel can be restored when expanded
        const originalDisplay = getComputedStyle(panel).display;
        
        // Create wrapper for positioning
        const wrapper = document.createElement('div');
        wrapper.className = 'external-panel-wrapper';
        wrapper.style.position = 'relative';
        
        // Move panel to wrapper and adjust its styling
        if (panel.parentNode) {
          panel.parentNode.insertBefore(wrapper, panel);
          wrapper.appendChild(panel);
          panel.style.zIndex = '1000';
          panel.style.left = '0';
          panel.style.right = 'auto';
          panel.style.top = 'auto';
          panel.style.bottom = '100%';
          
          // Hide initially
          panel.style.display = 'none';
        }
        
        // Create header/toggle element
        const toggleHeader = document.createElement('div');
        toggleHeader.className = 'external-panel-toggle';
        toggleHeader.textContent = '言語設定と他のログイン方法';
        
        // Add click handler to toggle visibility
        toggleHeader.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent click from reaching document
          const isVisible = panel.style.display !== 'none';
          
          if (isVisible) {
            // Collapse panel
            panel.style.display = 'none';
            toggleHeader.classList.remove('active');
          } else {
            // Expand panel
            panel.style.display = originalDisplay;
            toggleHeader.classList.add('active');
            
            // Position adjustment if needed
            const panelRect = panel.getBoundingClientRect();
            
            // Check if panel would go off the top of viewport
            if (panelRect.top < 0) {
              // If it would go off the top, position it below instead
              panel.style.bottom = 'auto';
              panel.style.top = '100%';
              
              // Add a class to handle the arrow direction in CSS
              panel.classList.add('position-below');
            } else {
              panel.style.top = 'auto';
              panel.style.bottom = '100%';
              panel.classList.remove('position-below');
            }
            
            // Check if panel would go off the right edge of viewport
            if (panelRect.right > window.innerWidth) {
              panel.style.left = 'auto';
              panel.style.right = '0';
              
              // Adjust arrow position if it's on the right side
              if (panel.classList.contains('position-below')) {
                panel.style.setProperty('--arrow-position', `calc(100% - 20px)`);
              } else {
                panel.style.setProperty('--arrow-position', `calc(100% - 20px)`);
              }
            } else {
              panel.style.setProperty('--arrow-position', '20px');
            }
          }
        });
        
        // Add toggleHeader to wrapper
        wrapper.insertBefore(toggleHeader, panel);
      }
    });
  };

  // Close-on-outside-click is bound ONCE for all panels. It used to be added
  // per panel, so every processExternalPanels() pass leaked another document
  // listener that closed over that panel forever.
  if (!window.__jbe_externalPanelDocClickBound) {
    window.__jbe_externalPanelDocClickBound = true;
    document.addEventListener('click', (e) => {
      document.querySelectorAll('.external-panel-wrapper').forEach((wrapper) => {
        const panel = wrapper.querySelector('.external-panel-misc');
        const toggleHeader = wrapper.querySelector('.external-panel-toggle');
        if (!panel || !toggleHeader) return;
        if (panel.style.display === 'none') return;
        if (panel.contains(e.target) || e.target === toggleHeader) return;
        panel.style.display = 'none';
        toggleHeader.classList.remove('active');
      });
    });
  }
  
  // Process any existing external-panel-misc elements
  processExternalPanels();
  
  // Set up mutation observer to watch for dynamically added external-panel-misc elements
  const observer = new MutationObserver((mutations) => {
    let panelAdded = false;
    
    mutations.forEach(mutation => {
      if (mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach(node => {
          // Check if the added node is an element
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the node itself is an external-panel-misc
            if (node.classList && node.classList.contains('external-panel-misc')) {
              panelAdded = true;
            }
            
            // Check if it contains any external-panel-misc elements
            const panels = node.querySelectorAll ? 
              node.querySelectorAll('.external-panel-misc') : [];
            
            if (panels.length > 0) {
              panelAdded = true;
            }
          }
        });
      }
    });
    
    // If a panel was added, process all panels again
    if (panelAdded) {
      processExternalPanels();
    }
  });
  
  // Start observing document for added nodes
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  // Sign-in page only, and reached by a full page load rather than SPA
  // navigation — tracked for inventory/dedup, not torn down on `watch:` cleanup.
  if (typeof window.__jbe_registerManagedObserver === 'function') {
    window.__jbe_registerManagedObserver('core:externalPanel', observer);
  }
}
