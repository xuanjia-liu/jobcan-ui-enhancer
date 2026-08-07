document.addEventListener('DOMContentLoaded', function() {
  const darkModeToggle = document.getElementById('darkMode');
  const showProgressBarToggle = document.getElementById('showProgressBar');
  const clockSizeRadios = document.querySelectorAll('input[name="clockSize"]');
  const clockBackgroundSelect = document.getElementById('clockBackground');

  // Mirrors CLOCK_BACKGROUNDS / DEFAULT_CLOCK_BACKGROUND in scripts/clock.js.
  const CLOCK_BACKGROUND_LABELS = {
    none: 'なし',
    wave: 'ウェーブメッシュ',
    particles: 'パーティクル',
    mesh: 'メッシュグラデーション',
    godray: 'ゴッドレイ'
  };
  // Same aliases as CLOCK_BACKGROUND_ALIASES in scripts/clock.js: both slots were
  // stored under an older id before they were rebuilt. The removed 'pulse' and
  // 'orbit' get none on purpose — the labels lookup below drops them to the default.
  const CLOCK_BACKGROUND_ALIASES = { aurora: 'godray', blob: 'mesh' };
  const DEFAULT_CLOCK_BACKGROUND = 'mesh';
  
  // Login form elements
  const employeeLoginBtn = document.getElementById('employeeLoginBtn');
  const loginSettingsBtn = document.querySelector('.login-settings-icon-btn');
  const loginForm = document.getElementById('loginForm');
  const loginEmail = document.getElementById('loginEmail');

  function isLoginFormOpen() {
    return loginForm.classList.contains('is-open');
  }

  function openLoginForm() {
    loginForm.classList.add('is-open');
    loginForm.removeAttribute('inert');
  }

  function closeLoginForm() {
    loginForm.classList.remove('is-open');
    loginForm.setAttribute('inert', '');
  }
  const loginPassword = document.getElementById('loginPassword');
  const rememberLogin = document.getElementById('rememberLogin');
  const securityNote = document.getElementById('securityNote');
  
  // Dropdown elements
  const dropdownContainers = document.querySelectorAll('.dropdown-container');

  // Show the real extension version (single source of truth: the manifest).
  const appVersionEl = document.getElementById('appVersion');
  if (appVersionEl) appVersionEl.textContent = chrome.runtime.getManifest().version;
  
  // Load saved settings
  chrome.storage.sync.get(
    ['darkMode', 'clockSize', 'showProgressBar', 'clockBackground'],
    function(result) {
      if (result.darkMode !== undefined) {
        darkModeToggle.checked = result.darkMode;
        // Apply dark mode to popup if enabled
        if (result.darkMode) {
          document.body.classList.add('dark-mode');
        } else {
          document.body.classList.remove('dark-mode');
        }
      }
      
      // Set clock size radio buttons
      if (result.clockSize) {
        document.querySelector(`input[name="clockSize"][value="${result.clockSize}"]`).checked = true;
      }
      
      // Set progress bar toggle
      if (result.showProgressBar !== undefined) {
        showProgressBarToggle.checked = result.showProgressBar;
      } else {
        // Default to enabled
        showProgressBarToggle.checked = true;
      }

      // Set the clock background. An unrecognised stored value (e.g. a variant
      // removed in a later build) falls back to the default rather than leaving
      // the select showing something the content script will not honour.
      if (clockBackgroundSelect) {
        const stored = CLOCK_BACKGROUND_ALIASES[result.clockBackground] || result.clockBackground;
        clockBackgroundSelect.value = CLOCK_BACKGROUND_LABELS[stored]
          ? stored
          : DEFAULT_CLOCK_BACKGROUND;
      }
    }
  );
  
  // Security migration: older builds saved credentials to chrome.storage.sync
  // (cloud-replicated through the user's Google account). Move any synced copy to
  // local and delete the synced one. Credentials now live only in storage.local.
  chrome.storage.sync.get(['rememberedLogin'], function(syncResult) {
    if (syncResult.rememberedLogin) {
      chrome.storage.local.set({ rememberedLogin: syncResult.rememberedLogin });
      chrome.storage.sync.remove(['rememberedLogin']);
    }
  });

  // Load saved login if "remember me" was checked. Stored in storage.LOCAL
  // (device-only): storage.sync would replicate the saved password to every
  // signed-in device.
  chrome.storage.local.get(['rememberedLogin'], function(result) {
    if (result.rememberedLogin) {
      loginEmail.value = result.rememberedLogin.email || '';
      // If we have saved password, populate it
      if (result.rememberedLogin.password) {
        loginPassword.value = result.rememberedLogin.password;
      }
      if (result.rememberedLogin.rememberChecked) {
        rememberLogin.checked = true;
        // Show security note if remember is checked
        securityNote.style.display = 'block';
      }
    }
  });
  
  darkModeToggle.addEventListener('change', function() {
    const isEnabled = this.checked;
    chrome.storage.sync.set({darkMode: isEnabled});
    
    // Apply dark mode to popup
    if (isEnabled) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
    
    showToast(isEnabled ? 'ダークモードをオンにしました' : 'ダークモードをオフにしました');
    
    // Send message to content script
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'toggleDarkMode',
          enabled: isEnabled
        });
      }
    });
  });
  
  // Handle clock size changes
  clockSizeRadios.forEach(radio => {
    radio.addEventListener('change', function() {
      if (this.checked) {
        chrome.storage.sync.set({clockSize: this.value});
        const clockSizeLabels = { small: '小', medium: '中', large: '大', xlarge: '特大', xxlarge: '最大' };
        showToast(`時計のサイズを「${clockSizeLabels[this.value] || this.value}」に変更しました`);
        
        // Send message to content script
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'updateClockSettings',
              clockSize: radio.value
            });
          }
        });
      }
    });
  });
  
  // Handle clock background changes
  if (clockBackgroundSelect) {
    clockBackgroundSelect.addEventListener('change', function() {
      const value = this.value;
      chrome.storage.sync.set({clockBackground: value});
      const label = CLOCK_BACKGROUND_LABELS[value] || value;
      showToast(value === 'none'
        ? '時計の背景アニメーションをオフにしました'
        : `時計の背景を「${label}」に変更しました`);

      // Send message to content script
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'updateClockSettings',
            clockBackground: value
          });
        }
      });
    });
  }

  // Handle show progress bar toggle
  showProgressBarToggle.addEventListener('change', function() {
    const isEnabled = this.checked;
    chrome.storage.sync.set({showProgressBar: isEnabled});
    showToast(isEnabled ? '勤務進捗バーを表示にしました' : '勤務進捗バーを非表示にしました');
    
    // Send message to content script
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'updateClockSettings',
          showProgressBar: isEnabled
        });
      }
    });
  });
  
  // Handle dropdown toggles with animation
  dropdownContainers.forEach(container => {
    const btn = container.querySelector('.quick-access-btn');
    const menuElement = container.querySelector('.sub-menu');

    if (btn && menuElement) {
      const menuItems = () => Array.from(menuElement.querySelectorAll('.sub-menu-item'));

      const closeMenu = () => {
        menuElement.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
      };
      const openMenu = () => {
        document.querySelectorAll('.sub-menu').forEach(menu => { menu.style.display = 'none'; });
        menuElement.style.display = 'block';
        btn.setAttribute('aria-expanded', 'true');
      };

      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (menuElement.style.display === 'block') closeMenu(); else openMenu();
      });

      // Keyboard: ArrowDown opens + focuses first item; Escape closes.
      btn.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          openMenu();
          const items = menuItems();
          if (items.length) items[0].focus();
        } else if (e.key === 'Escape') {
          closeMenu();
        }
      });

      // Roving focus inside the menu with arrows; Escape returns to the button.
      menuElement.addEventListener('keydown', function(e) {
        const items = menuItems();
        if (!items.length) return;
        const current = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          items[(current + 1) % items.length].focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          items[(current - 1 + items.length) % items.length].focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
          btn.focus();
        }
      });
    }
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', function(e) {
    // Only close if the click is not on a dropdown toggle or within a submenu
    if (!e.target.closest('.dropdown-container')) {
      document.querySelectorAll('.sub-menu').forEach(menu => {
        menu.style.display = 'none';
      });
      document.querySelectorAll('.quick-access-btn[aria-expanded="true"]').forEach(b => {
        b.setAttribute('aria-expanded', 'false');
      });
    }
  });
  
  // Handle quick access link clicks
  document.querySelectorAll('.sub-menu-item').forEach(link => {
    link.addEventListener('click', function(e) {
      if (this.href) {
        e.preventDefault();
        chrome.tabs.create({ url: this.href });
        showToast(`「${this.textContent.trim()}」を開いています…`);
      }
    });
  });
  
  // Handle direct links (not in dropdowns)
  document.querySelectorAll('.quick-access-btn:not(.dropdown-container > .quick-access-btn)').forEach(link => {
    link.addEventListener('click', function(e) {
      if (this.href) {
        e.preventDefault();
        chrome.tabs.create({ url: this.href });
        showToast(`「${this.textContent.trim()}」を開いています…`);
      }
    });
  });
  
  // Make the main button perform login; header settings button toggles the form
  employeeLoginBtn.addEventListener('click', function(e) {
    // If form is visible, use the entered credentials
    if (isLoginFormOpen()) {
      const email = loginEmail.value.trim();
      const password = loginPassword.value;
      
      if (!email || !password) {
        showToast('メールアドレス（またはID）とパスワードを入力してください', 2000);
        return;
      }
      
      // Persist or clear stored credentials based on Remember checkbox
      if (rememberLogin.checked) {
        chrome.storage.local.set({
          rememberedLogin: {
            email: email,
            password: password,
            rememberChecked: true
          }
        });
        showToast('⚠️ パスワードはこの端末内にのみ保存されます。個人用端末でのみご利用ください。', 5000);
      } else {
        chrome.storage.local.remove(['rememberedLogin']);
        chrome.storage.sync.remove(['rememberedLogin']);
      }
      
      // Hide the form as we proceed with login
      closeLoginForm();
      
      // Show loading state on the button
      const originalText = employeeLoginBtn.querySelector('span').textContent;
      employeeLoginBtn.querySelector('span').textContent = 'ログイン中…';
      employeeLoginBtn.disabled = true;
      
      // Perform login
      performJobcanLogin(email, password, function() {
        // Reset button text after login attempt
        employeeLoginBtn.querySelector('span').textContent = originalText;
        employeeLoginBtn.disabled = false;
      });
    } 
    // If form is hidden, check if we have saved credentials
    else {
      const savedEmail = loginEmail.value;
      const savedPassword = loginPassword.value;
      
      // If we have both saved, login directly
      if (savedEmail && savedPassword) {
        // Show loading state on the button
        const originalText = employeeLoginBtn.querySelector('span').textContent;
        employeeLoginBtn.querySelector('span').textContent = 'ログイン中…';
        employeeLoginBtn.disabled = true;
        
        // Perform login with saved credentials
        performJobcanLogin(savedEmail, savedPassword, function() {
          // Reset button text after login attempt
          employeeLoginBtn.querySelector('span').textContent = originalText;
          employeeLoginBtn.disabled = false;
        });
      } 
      // Otherwise show the form
      else {
        openLoginForm();
        loginEmail.focus();
      }
    }
  });
  
  // Header settings control toggles the login form
  if (loginSettingsBtn) {
    loginSettingsBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      
      if (!isLoginFormOpen()) {
        openLoginForm();
        if (loginEmail.value) {
          loginPassword.focus();
        } else {
          loginEmail.focus();
        }
      } else {
        closeLoginForm();
      }
    });
  }
  
  // Also allow pressing Enter in the password field to login
  loginPassword.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      employeeLoginBtn.click();
    }
  });
  
  const togglePasswordBtn = document.getElementById('togglePasswordVisibility');
  if (togglePasswordBtn) {
    // Inline SVGs (no Material Icons web font): eye = reveal, eye-off = hide.
    const EYE_SVG = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    const EYE_OFF_SVG = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
    const togglePasswordSvg = togglePasswordBtn.querySelector('svg');
    togglePasswordBtn.addEventListener('click', function() {
      const isVisible = loginPassword.type === 'text';
      loginPassword.type = isVisible ? 'password' : 'text';
      if (togglePasswordSvg) {
        togglePasswordSvg.innerHTML = isVisible ? EYE_SVG : EYE_OFF_SVG;
      }
      togglePasswordBtn.setAttribute('aria-label', isVisible ? 'パスワードを表示' : 'パスワードを隠す');
      togglePasswordBtn.setAttribute('aria-pressed', isVisible ? 'false' : 'true');
      togglePasswordBtn.title = isVisible ? 'パスワードを表示' : 'パスワードを隠す';
    });
  }
  
  // Toggle security note when remember checkbox is changed; clear persisted credentials when unchecked
  rememberLogin.addEventListener('change', function() {
    securityNote.style.display = this.checked ? 'block' : 'none';
    if (!this.checked) {
      chrome.storage.local.remove(['rememberedLogin']);
      chrome.storage.sync.remove(['rememberedLogin']);
    }
  });
  
  // Function to perform Jobcan login
  function performJobcanLogin(email, password, callback) {
    // Delegate login to background service worker so it works even when the new tab is active
    showToast('ログイン中…', 2000);
    chrome.runtime.sendMessage(
      { action: 'performJobcanLogin', email, password },
      function(response) {
        if (response && response.success) {
          showToast('ログインに成功しました', 2000);
        } else {
          showToast('ログインに失敗しました。IDとパスワードをご確認ください。', 3000);
        }
        if (callback) callback();
      }
    );
  }
  
  // Function to show toast notification
  function showToast(message, duration = 3000) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      document.body.appendChild(toast);
    }
    
    toast.textContent = message;
    toast.className = 'show';
    
    // Clear any existing timeout
    if (toast.timeoutId) {
      clearTimeout(toast.timeoutId);
    }
    
    // Set new timeout
    toast.timeoutId = setTimeout(function() {
      toast.className = toast.className.replace("show", "");
    }, duration);
  }
});
