document.addEventListener('DOMContentLoaded', function() {
  const darkModeToggle = document.getElementById('darkMode');
  const showSecondsToggle = document.getElementById('showSeconds');
  const showProgressBarToggle = document.getElementById('showProgressBar');
  const clockSizeRadios = document.querySelectorAll('input[name="clockSize"]');
  
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
  const submitLogin = document.getElementById('submitLogin');
  const cancelLogin = document.getElementById('cancelLogin');
  const loginStatus = document.getElementById('loginStatus');
  const securityNote = document.getElementById('securityNote');
  
  // Dropdown elements
  const dropdownContainers = document.querySelectorAll('.dropdown-container');
  
  // Load saved settings
  chrome.storage.sync.get(
    ['darkMode', 'clockSize', 'showSeconds', 'showProgressBar'], 
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
      
      // Set seconds toggle
      if (result.showSeconds !== undefined) {
        showSecondsToggle.checked = result.showSeconds;
      }
      
      // Set progress bar toggle
      if (result.showProgressBar !== undefined) {
        showProgressBarToggle.checked = result.showProgressBar;
      } else {
        // Default to enabled
        showProgressBarToggle.checked = true;
      }
    }
  );
  
  // Load saved login if "remember me" was checked
  chrome.storage.sync.get(['rememberedLogin'], function(result) {
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
        const clockSizeLabels = { small: '小', medium: '中', large: '大' };
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
  
  // Handle show seconds toggle
  showSecondsToggle.addEventListener('change', function() {
    const isEnabled = this.checked;
    chrome.storage.sync.set({showSeconds: isEnabled});
    showToast(isEnabled ? '秒の表示をオンにしました' : '秒の表示をオフにしました');
    
    // Send message to content script
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'updateClockSettings',
          showSeconds: isEnabled
        });
      }
    });
  });
  
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
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        const isOpen = menuElement.style.display === 'block';

        document.querySelectorAll('.sub-menu').forEach(menu => {
          menu.style.display = 'none';
        });

        if (!isOpen) {
          menuElement.style.display = 'block';
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
        chrome.storage.sync.set({
          rememberedLogin: {
            email: email,
            password: password,
            rememberChecked: true
          }
        });
        showToast('⚠️ パスワードは拡張機能に保存されます。個人用端末でのみご利用ください。', 5000);
      } else {
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
    const togglePasswordIcon = togglePasswordBtn.querySelector('.material-icons');
    togglePasswordBtn.addEventListener('click', function() {
      const isVisible = loginPassword.type === 'text';
      loginPassword.type = isVisible ? 'password' : 'text';
      if (togglePasswordIcon) {
        togglePasswordIcon.textContent = isVisible ? 'visibility' : 'visibility_off';
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
  
  // Script injected into the login page to fill and submit credentials
  function injectLoginScript(email, password) {
    const emailField = document.querySelector('input[type="email"]') ||
                       document.querySelector('input[name="user[email]"]') ||
                       document.querySelector('#user_email');
    const passwordField = document.querySelector('input[type="password"]') ||
                          document.querySelector('input[name="user[password]"]') ||
                          document.querySelector('#user_password');
    const submitBtn = document.querySelector('button[type="submit"]') ||
                      document.querySelector('input[type="submit"]');
    if (emailField && passwordField && submitBtn) {
      emailField.value = email;
      emailField.dispatchEvent(new Event('input', { bubbles: true }));
      passwordField.value = password;
      passwordField.dispatchEvent(new Event('input', { bubbles: true }));
      submitBtn.click();
    }
  }
  
  // Poll the login tab for successful navigation
  function pollLoginStatus(tabId, callback) {
    let attempts = 0;
    const maxAttempts = 20; // allow for 10 seconds at 500ms intervals
    const interval = setInterval(() => {
      chrome.tabs.get(tabId, tab => {
        if (tab.url.includes('/employee')) {
          clearInterval(interval);
          handleSuccessfulLogin(tabId);
          if (callback) callback();
        } else if (attempts++ >= maxAttempts) {
          clearInterval(interval);
          showToast('ログインに失敗しました。IDとパスワードをご確認ください。', 3000);
          chrome.tabs.update(tabId, { active: true });
          if (callback) callback();
        }
      });
    }, 500); // check twice as often
  }
  
  // Handle successful login by redirecting to the dashboard
  function handleSuccessfulLogin(tabId) {
    showToast('ログインに成功しました', 2000);
    chrome.tabs.update(tabId, { url: 'https://ssl.jobcan.jp/employee', active: true });
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
