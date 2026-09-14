// Efha - Content Script

(function () {
  let activePanel = null;
  let pollInterval = null;
  let toastElement = null;
  let lastCheckedUsername = null;
  let isCheckingProfile = false;

  // Mutual follow connection states
  let followersSet = new Set();
  let followingSet = new Set();
  let friendshipCache = {};
  let isFriendshipDataLoaded = false;
  let loggedInUsername = '';
  let enableMutualBadges = true;

  // API usage tracking
  let apiCallTimestamps = [];

  // Story views history tracking
  let lastLoggedStoryId = null;

  // Cached www-claim value (updated by MAIN world inject.js interceptor)
  let cachedWwwClaim = '';

  // Theme Management variables
  let currentTheme = 'light';
  const SUN_ICON = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
  const MOON_ICON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';

  // Icons SVG definitions
  const ICONS = {
    download: `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`,
    copy: `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`,
    success: `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`,
    spinner: `<svg class="spinner" viewBox="0 0 50 50" style="animation: rotate 2s linear infinite; width: 16px; height: 16px;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" style="stroke-dasharray: 1, 150; stroke-dashoffset: 0; animation: dash 1.5s ease-in-out infinite;"></circle></svg><style>@keyframes rotate { 100% { transform: rotate(360deg); } } @keyframes dash { 0% { stroke-dasharray: 1, 150; stroke-dashoffset: 0; } 50% { stroke-dasharray: 90, 150; stroke-dashoffset: -35; } 100% { stroke-dasharray: 90, 150; stroke-dashoffset: -124; } }</style>`
  };

  const IG_SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // --- Custom Directory Storage & Writing (File System Access API) ---
  const DB_NAME = 'EfhaIGFolderDB';
  const STORE_NAME = 'settings';
  const KEY_NAME = 'downloadDirHandle';

  function getDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = (event) => {
        resolve(event.target.result);
      };
      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  async function saveDirHandle(handle) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(handle, KEY_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function getDirHandle() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(KEY_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function clearDirHandle() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(KEY_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function verifyPermission(fileHandle, readWrite) {
    const options = {};
    if (readWrite) {
      options.mode = 'readwrite';
    }
    try {
      if ((await fileHandle.queryPermission(options)) === 'granted') {
        return true;
      }
      if ((await fileHandle.requestPermission(options)) === 'granted') {
        return true;
      }
    } catch (err) {
      console.error('Permission check failed:', err);
    }
    return false;
  }

  function fetchBlobViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'FETCH_BASE64',
        url: url
      }, async (response) => {
        if (response && response.success && response.base64) {
          try {
            const blobRes = await fetch(response.base64);
            const blob = await blobRes.blob();
            resolve(blob);
          } catch (err) {
            reject(new Error('Failed to convert base64 to blob: ' + err.message));
          }
        } else {
          reject(new Error(response ? response.error : 'Unknown background fetch error'));
        }
      });
    });
  }

  async function fetchBlobContent(url) {
    if (url.startsWith('blob:')) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP error fetching local blob: ${res.status}`);
      return await res.blob();
    }
    return await fetchBlobViaBackground(url);
  }

  async function tryCustomDirectoryDownload(url, filename) {
    try {
      const handle = await getDirHandle();
      if (!handle) return false;

      const hasPermission = await verifyPermission(handle, true);
      if (!hasPermission) {
        throw new Error('Permission denied by user');
      }

      let targetDir = handle;
      const subfolderData = await new Promise((resolve) => {
        chrome.storage.local.get({ download_subfolder: '' }, resolve);
      });
      
      if (subfolderData.download_subfolder) {
        const cleanSubfolder = subfolderData.download_subfolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (cleanSubfolder) {
          const parts = cleanSubfolder.split('/');
          for (const part of parts) {
            if (part) {
              targetDir = await targetDir.getDirectoryHandle(part, { create: true });
            }
          }
        }
      }

      const blob = await fetchBlobContent(url);
      if (!blob) {
        throw new Error('Failed to fetch file content');
      }

      const fileHandle = await targetDir.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      return true;
    } catch (err) {
      console.warn('Custom directory download failed, falling back:', err);
      showToast('Kustom folder gagal: ' + err.message + '. Mengunduh ke Downloads default.', 'warning');
      return false;
    }
  }

  function incrementDownloadRecap(username) {
    if (!username) return;
    const key = username.toLowerCase().trim();
    chrome.storage.local.get({ download_recap: {} }, (data) => {
      const recap = data.download_recap || {};
      recap[key] = (recap[key] || 0) + 1;
      chrome.storage.local.set({ download_recap: recap });
    });
  }

  function renderRecapList(recapData, containerElement) {
    if (!containerElement) return;
    const entries = Object.entries(recapData || {}).sort((a, b) => b[1] - a[1]);
    
    if (entries.length === 0) {
      containerElement.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 11px;">
          Belum ada data unduhan. Silakan unduh foto/video terlebih dahulu.
        </div>
      `;
      return;
    }

    containerElement.innerHTML = '';
    entries.forEach(([username, count]) => {
      const item = document.createElement('div');
      item.className = 'recap-item';
      item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--secondary); border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); margin-bottom: 6px;';
      
      item.innerHTML = `
        <span class="recap-username" style="font-weight: 600; color: var(--foreground); font-size: 11px;">@${username}</span>
        <span class="recap-badge" style="background: var(--card); color: var(--foreground); border: 1px solid var(--border); font-weight: 600; font-size: 10px; padding: 2px 8px; border-radius: 12px;">${count} File</span>
      `;
      containerElement.appendChild(item);
    });
  }

  function exportRecapToXLS(recapData, followersList, profileFriendshipCache) {
    const entries = Object.entries(recapData || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      showToast('Tidak ada data rekap untuk diexport!', 'warning');
      return;
    }

    const followersSet = new Set((followersList || []).map(u => u.username.toLowerCase().trim()));
    const cache = profileFriendshipCache || {};

    let tableRows = '';
    entries.forEach(([username, count]) => {
      const lowerUsername = username.toLowerCase().trim();
      const followedBack = (followersSet.has(lowerUsername) || cache[lowerUsername] === true || cache[username] === true) ? 'yes' : 'no';
      const profileUrl = `https://www.instagram.com/${username}/`;
      
      tableRows += `
        <tr>
          <td>${username}</td>
          <td>${count}</td>
          <td><a href="${profileUrl}">${profileUrl}</a></td>
          <td>${followedBack}</td>
        </tr>`;
    });

    const xlsContent = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <!--[if gte mso 9]>
        <xml>
          <x:ExcelWorkbook>
            <x:ExcelWorksheets>
              <x:ExcelWorksheet>
                <x:Name>Rekap Download</x:Name>
                <x:WorksheetOptions>
                  <x:DisplayGridlines/>
                </x:WorksheetOptions>
              </x:ExcelWorksheet>
            </x:ExcelWorksheets>
          </x:ExcelWorkbook>
        </xml>
        <![endif]-->
        <meta http-equiv="content-type" content="text/plain; charset=UTF-8"/>
      </head>
      <body>
        <table>
          <thead>
            <tr>
              <th>username</th>
              <th>jumlah</th>
              <th>link ig username</th>
              <th>followed back/no (yes/no)</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </body>
      </html>`;

    const blob = new Blob([xlsContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    const dateStr = new Date().toLocaleDateString().replace(/\//g, '-');
    link.setAttribute('download', `rekap_download_${dateStr}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function executeDownload(url, filename, callback, username) {
    const handled = await tryCustomDirectoryDownload(url, filename);
    if (handled) {
      if (username) {
        await incrementDownloadRecap(username);
      }
      if (callback) callback({ success: true });
      return;
    }

    chrome.runtime.sendMessage({
      action: 'DOWNLOAD',
      url: url,
      filename: filename
    }, (response) => {
      if (response && response.success) {
        if (username) {
          incrementDownloadRecap(username);
        }
      }
      if (callback) callback(response);
    });
  }

  // --- Download History Helpers to prevent redundant/duplicate downloads ---
  function getMediaDownloadKey(media) {
    if (!media || (!media.id && !media.url)) return null;
    
    let baseId = media.id || 'unknown';
    // If ID is generic (often happens in No API fallback), use filename from URL to make it unique
    if (baseId === 'story' || baseId === 'post' || baseId === 'media') {
      if (media.url) {
        const urlPart = media.url.split('?')[0].split('/').pop();
        baseId = `${baseId}_${urlPart}`;
      }
    }
    
    let key = media.username ? `${media.username}_${baseId}` : baseId;
    
    if (media.slideIndex !== undefined && media.slideIndex !== null) {
      key += `_slide${media.slideIndex}`;
    }
    return key;
  }

  function getDownloadHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ download_history: {} }, (data) => {
        resolve(data.download_history || {});
      });
    });
  }

  async function checkDuplicateDownload(key) {
    if (!key) return false;
    const history = await getDownloadHistory();
    return !!history[key];
  }

  function markMediaAsDownloaded(key) {
    if (!key) return;
    chrome.storage.local.get({ download_history: {} }, (data) => {
      const history = data.download_history || {};
      history[key] = Date.now();
      
      const keys = Object.keys(history);
      if (keys.length > 3000) {
        delete history[keys[0]];
      }
      chrome.storage.local.set({ download_history: history });
    });
  }

  // Run the checker script
  init();

  function init() {
    console.log('Instagram Stories & Media Helper active.');

    // Inject MAIN world script to intercept Instagram's fetch/XHR and capture www-claim
    injectMainWorldScript();
    
    // Load local storage cached follower/following data
    loadFriendshipData();
 
    // Inject the permanent floating dashboard launcher
    injectLauncherButton();
 
    // We check the page URL periodically to handle Instagram's SPA client-side routing
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(() => {
      checkState();
      checkProfilePage();
      processMutualBadges();
      processStoryOverlayDownloader();
      processFeedPostDownloaders();
      updateBulkTabStats();
    }, 400);
 
  }

  // Inject the MAIN world script that intercepts Instagram's API responses
  // to capture the x-ig-set-www-claim header for our content script to use.
  function injectMainWorldScript() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('inject.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);

      // Listen for claim updates from the MAIN world script
      document.addEventListener('efha-www-claim', (e) => {
        if (e.detail && e.detail !== '0' && e.detail.length > 2) {
          cachedWwwClaim = e.detail;
          console.log('[Efha] www-claim captured:', cachedWwwClaim.substring(0, 12) + '...');
        }
      });
    } catch (err) {
      console.warn('[Efha] Failed to inject MAIN world script:', err);
    }
  }
 
  // Inject a permanent launcher button at the bottom right corner of the page
  function injectLauncherButton() {
    if (document.getElementById('efha-launcher-btn')) return;
 
    const launcher = document.createElement('div');
    launcher.id = 'efha-launcher-btn';
    launcher.className = 'efha-launcher';
    launcher.title = 'Open Efha';
    
    launcher.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
      </svg>
    `;
    
    document.body.appendChild(launcher);
    
    launcher.onclick = () => {
      injectDashboardDrawer();
      const drawer = document.getElementById('efha-dashboard-drawer');
      if (drawer) {
        drawer.classList.toggle('open');
      }
    };
  }

  function checkState() {
    const isStory = window.location.href.includes('/stories/');
    const isPost = window.location.pathname.match(/\/(p|tv|reel|reels)\/([A-Za-z0-9_-]+)/);

    if (isStory) {
      const urlMatch = window.location.href.match(/stories\/([^\/]+)\/([^\/]+)?/);
      if (urlMatch) {
        const username = urlMatch[1];
        const storyId = urlMatch[2] || 'first';
        const logKey = `${username}_${storyId}`;
        if (username !== 'highlights' && lastLoggedStoryId !== logKey) {
          lastLoggedStoryId = logKey;
          logStoryViewEvent(username, storyId);
        }
      }
    }

    if (isStory || isPost) {
      if (!activePanel) {
        injectControlPanel();
      }
      updatePanelState();
    } else {
      if (activePanel) {
        removeControlPanel();
      }
    }
  }

  function applyThemeToContent(theme) {
    const isDark = theme === 'dark';
    const targets = [
      document.getElementById('efha-dashboard-drawer'),
      document.getElementById('ig-helper-panel'),
      document.getElementById('ig-helper-modal-overlay'),
      document.getElementById('efha-media-modal-overlay'),
      document.querySelector('.ig-helper-toast'),
      document.getElementById('efha-floating-countdown')
    ];
    
    targets.forEach(el => {
      if (el) {
        if (isDark) {
          el.classList.add('dark');
        } else {
          el.classList.remove('dark');
        }
      }
    });
    
    const drawerThemeIcon = document.getElementById('drawer-theme-toggle-icon');
    if (drawerThemeIcon) {
      drawerThemeIcon.innerHTML = isDark ? SUN_ICON : MOON_ICON;
    }
  }

  // Create and inject the docked control panel (slides out from right)
  function injectControlPanel() {
    if (document.getElementById('ig-helper-panel')) return;
 
    activePanel = document.createElement('div');
    activePanel.id = 'ig-helper-panel';
    activePanel.className = 'ig-helper-panel';
    if (currentTheme === 'dark') {
      activePanel.classList.add('dark');
    }
 
    activePanel.innerHTML = `
      <button id="ig-helper-panel-toggle" class="ig-helper-panel-toggle" title="Sembunyikan / Tampilkan Aksi">
        <svg id="ig-helper-panel-toggle-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
      <div class="ig-helper-panel-dir-container">
        <div class="ig-helper-panel-dir-header">
          <span>Save Folder (Default)</span>
          <button id="ig-helper-btn-save-dir" class="ig-helper-panel-dir-save">Save</button>
        </div>
        <input type="text" id="ig-helper-dir-input" class="ig-helper-panel-dir-input" placeholder="Downloads/" />
        <div id="ig-helper-dir-status" class="ig-helper-panel-dir-status"></div>
 
        <div class="ig-helper-panel-dir-header" style="margin-top: 6px;">
          <span>Custom Folder</span>
          <button id="ig-helper-btn-clear-custom-dir" class="ig-helper-panel-dir-save" style="color: var(--destructive); display: none;">Clear</button>
        </div>
        <button id="ig-helper-btn-pick-dir" class="ig-helper-panel-dir-input" style="text-align: left; cursor: pointer; display: flex; align-items: center; gap: 6px; font-weight: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          <span id="ig-helper-picked-dir-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Pilih Folder...</span>
        </button>
      </div>
      <div id="ig-helper-panel-mutual-status" class="ig-helper-mutual-status" style="display: none;"></div>
      <button id="ig-helper-download" class="ig-helper-btn" title="Download media dengan API (kualitas tertinggi)">
        ${ICONS.download}
        <span>Download (API)</span>
      </button>
      <button id="ig-helper-download-no-api" class="ig-helper-btn" title="Download media tanpa API (bebas Safe Mode/Spam)">
        ${ICONS.download}
        <span>Download (No API)</span>
      </button>
      <button id="ig-helper-copy" class="ig-helper-btn" title="Copy photo in highest resolution">
        ${ICONS.copy}
        <span>Copy Photo</span>
      </button>
      <button id="ig-helper-download-all" class="ig-helper-btn" title="Download all stories for this user" style="display: none;">
        ${ICONS.download}
        <span>Download All</span>
      </button>
      <button id="ig-helper-open-dashboard" class="ig-helper-btn" title="Open Efha Instagram Tools Dashboard">
        <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v-2H7v-2h7V7h2v10h-2z"/></svg>
        <span>Dashboard</span>
      </button>

    `;
 
    document.body.appendChild(activePanel);
 
    // Bind directory settings events
    const dirInput = document.getElementById('ig-helper-dir-input');
    const saveBtn = document.getElementById('ig-helper-btn-save-dir');
    const statusMsg = document.getElementById('ig-helper-dir-status');
    const pickDirBtn = document.getElementById('ig-helper-btn-pick-dir');
    const clearDirBtn = document.getElementById('ig-helper-btn-clear-custom-dir');
    const pickedDirName = document.getElementById('ig-helper-picked-dir-name');
 
    // Load initial settings
    chrome.storage.local.get({ download_subfolder: '', download_custom_folder_name: '' }, (data) => {
      if (dirInput) dirInput.value = data.download_subfolder || '';
      
      if (pickedDirName && clearDirBtn) {
        if (data.download_custom_folder_name) {
          pickedDirName.innerText = data.download_custom_folder_name;
          pickedDirName.title = `Folder: ${data.download_custom_folder_name}`;
          clearDirBtn.style.display = 'block';
        } else {
          pickedDirName.innerText = 'Pilih Folder...';
          pickedDirName.title = '';
          clearDirBtn.style.display = 'none';
        }
      }
    });

    if (dirInput) {
      dirInput.addEventListener('input', () => {
        const rawVal = dirInput.value;
        const sanitizedVal = rawVal.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        chrome.storage.local.set({ download_subfolder: sanitizedVal });
      });
    }
 
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const rawVal = dirInput.value;
        const sanitizedVal = rawVal.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        chrome.storage.local.set({ download_subfolder: sanitizedVal }, () => {
          if (dirInput) dirInput.value = sanitizedVal;
          if (statusMsg) {
            statusMsg.innerText = 'Saved!';
            statusMsg.style.color = '#2ed573';
            setTimeout(() => {
              statusMsg.innerText = '';
            }, 2000);
          }
        });
      });
    }

    // Custom Directory Selector events
    if (pickDirBtn) {
      pickDirBtn.addEventListener('click', async () => {
        try {
          const handle = await window.showDirectoryPicker();
          await saveDirHandle(handle);
          await chrome.storage.local.set({ download_custom_folder_name: handle.name });
          showToast('Folder kustom berhasil diatur!', 'success');
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.error('Error selecting folder:', err);
            showToast('Gagal memilih folder: ' + err.message, 'error');
          }
        }
      });
    }

    if (clearDirBtn) {
      clearDirBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await clearDirHandle();
          await chrome.storage.local.set({ download_custom_folder_name: '' });
          showToast('Folder kustom dinonaktifkan.', 'info');
        } catch (err) {
          console.error('Error clearing folder:', err);
        }
      });
    }

    // Bind event listeners
    document.getElementById('ig-helper-download').addEventListener('click', handleDownload);
    document.getElementById('ig-helper-download-no-api').addEventListener('click', handleDownloadNoApi);
    document.getElementById('ig-helper-copy').addEventListener('click', handleCopy);
    document.getElementById('ig-helper-download-all').addEventListener('click', handleDownloadAllStories);
    document.getElementById('ig-helper-open-dashboard').addEventListener('click', () => {
      injectDashboardDrawer();
      const drawer = document.getElementById('efha-dashboard-drawer');
      if (drawer) {
        drawer.classList.toggle('open');
      }
    });

    // Bind toggle handle event
    const toggleBtn = document.getElementById('ig-helper-panel-toggle');
    const toggleIcon = document.getElementById('ig-helper-panel-toggle-icon');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activePanel) return;
        const isCollapsed = activePanel.classList.toggle('collapsed');
        if (toggleIcon) {
          toggleIcon.innerHTML = isCollapsed
            ? '<polyline points="15 18 9 12 15 6"></polyline>'
            : '<polyline points="9 18 15 12 9 6"></polyline>';
        }
        chrome.storage.local.set({ efha_action_panel_collapsed: isCollapsed });
      });
    }

    // Restore saved collapsed state
    chrome.storage.local.get({ efha_action_panel_collapsed: false }, (res) => {
      if (res.efha_action_panel_collapsed && activePanel) {
        activePanel.classList.add('collapsed');
        if (toggleIcon) {
          toggleIcon.innerHTML = '<polyline points="15 18 9 12 15 6"></polyline>';
        }
      }
    });

    // Update panel countdown state immediately upon injection
    updateSafeModeCountdown();
  }
 
  function removeControlPanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
  }
 
  // Update button enabled/disabled states depending on active media type
  function updatePanelState() {
    const downloadBtn = document.getElementById('ig-helper-download');
    const downloadNoApiBtn = document.getElementById('ig-helper-download-no-api');
    const copyBtn = document.getElementById('ig-helper-copy');
    const downloadAllBtn = document.getElementById('ig-helper-download-all');
    
    if (!downloadBtn || !copyBtn) return;
 
    const isVideo = isCurrentMediaVideo();
    const isStory = window.location.href.includes('/stories/');
 
    downloadBtn.classList.remove('disabled');
    if (downloadNoApiBtn) downloadNoApiBtn.classList.remove('disabled');
 
    if (isVideo) {
      // Media is a video: disable copy button since clipboard only copies photos
      copyBtn.classList.add('disabled');
      copyBtn.querySelector('span').innerText = 'Copy (Video)';
    } else {
      // Media is a photo: copy is enabled
      copyBtn.classList.remove('disabled');
      if (!copyBtn.classList.contains('loading') && !copyBtn.classList.contains('success')) {
        copyBtn.querySelector('span').innerText = 'Copy Photo';
      }
    }
 
    if (downloadAllBtn) {
      downloadAllBtn.style.display = isStory ? 'flex' : 'none';
    }

    // Update panel mutual follow status
    updatePanelMutualStatus();
  }

  // Check if current media is a video using DOM analysis
  function isCurrentMediaVideo() {
    if (window.location.href.includes('/reel/') || window.location.href.includes('/reels/')) {
      return true;
    }
    if (window.location.href.includes('/stories/')) {
      const video = document.querySelector('video');
      if (video) {
        const rect = video.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 100) return true;
      }
      return false;
    }
    const activeArticle = getActiveArticle();
    if (activeArticle && activeArticle !== document) {
      const activeVideo = activeArticle.querySelector('video');
      if (activeVideo) {
        const rect = activeVideo.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 100) return true;
      }
    }
    return false;
  }

  // Parse cookie values
  function getCookieValue(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return '';
  }

  // Convert shortcode to numeric post ID
  function convertToPostId(shortcode) {
    let id = BigInt(0);
    for (let i = 0; i < shortcode.length; i++) {
      let char = shortcode[i];
      const index = IG_SHORTCODE_ALPHABET.indexOf(char);
      if (index === -1) continue;
      id = id * BigInt(64) + BigInt(index);
    }
    return id.toString(10);
  }

  // Check profile page and inject relationship status badge
  async function checkProfilePage() {
    if (!enableMutualBadges) return;
    const usernameMatch = window.location.pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
    const reservedNames = ['p', 'tv', 'reel', 'reels', 'stories', 'direct', 'explore', 'accounts', 'emails', 'developer', 'about', 'press', 'api', 'privacy', 'terms', 'directory', 'topics', 'create', 'notifications', 'messages', 'reel'];
    
    if (usernameMatch && !reservedNames.includes(usernameMatch[1])) {
      const username = usernameMatch[1];
      
      if (lastCheckedUsername === username) {
        // Already checked this profile, ensure badge is still there
        const headerEl = findUsernameHeader(username);
        if (headerEl && !document.getElementById('ig-helper-friendship-badge')) {
          chrome.storage.local.get({ profile_friendship_cache: {} }, (data) => {
            const cache = data.profile_friendship_cache;
            if (cache[username] !== undefined && cache[username] !== 'error') {
              injectBadge(headerEl, cache[username]);
            }
          });
        }
        return;
      }
      
      if (isCheckingProfile) return;
      isCheckingProfile = true;
      lastCheckedUsername = username;
      
      try {
        const headerEl = findUsernameHeader(username);
        if (!headerEl) {
          isCheckingProfile = false;
          lastCheckedUsername = null; // retry in next poll
          return;
        }

        // Check local friendship cache first
        chrome.storage.local.get({ profile_friendship_cache: {} }, async (data) => {
          const cache = data.profile_friendship_cache;
          if (cache[username] !== undefined) {
            if (cache[username] !== 'error') {
              injectBadge(headerEl, cache[username]);
            }
            isCheckingProfile = false;
            return;
          }

          try {
            // Fetch user details and request relationship status
            const profile = await fetchUserProfileInfo(username);
            const friendship = await fetchFriendshipInfo(profile.id);
            const followedBy = friendship.followed_by === true;

            // Write to local cache
            cache[username] = followedBy;
            const keys = Object.keys(cache);
            if (keys.length > 50) delete cache[keys[0]]; // restrict cache size
            chrome.storage.local.set({ profile_friendship_cache: cache });

            injectBadge(headerEl, followedBy);
            isCheckingProfile = false;
          } catch (fetchErr) {
            console.error('Failed to fetch profile details:', fetchErr);
            isCheckingProfile = false;
            
            // Cache the error state to avoid spamming API calls
            cache[username] = 'error';
            const keys = Object.keys(cache);
            if (keys.length > 50) delete cache[keys[0]];
            chrome.storage.local.set({ profile_friendship_cache: cache });
          }
        });

      } catch (e) {
        console.error('Failed to resolve profile friendship:', e);
        isCheckingProfile = false;
      }
    } else {
      lastCheckedUsername = null;
    }
  }

  function findUsernameHeader(username) {
    const h2s = document.querySelectorAll('h2');
    for (const h2 of h2s) {
      if (h2.textContent.trim() === username) {
        return h2;
      }
    }
    return null;
  }

  function injectBadge(headerEl, followedBy) {
    if (document.getElementById('ig-helper-friendship-badge')) return;
    
    const badge = document.createElement('span');
    badge.id = 'ig-helper-friendship-badge';
    badge.style.marginLeft = '12px';
    badge.style.padding = '4px 12px';
    badge.style.borderRadius = '20px';
    badge.style.fontSize = '12px';
    badge.style.fontWeight = 'bold';
    badge.style.display = 'inline-block';
    badge.style.verticalAlign = 'middle';
    badge.style.backdropFilter = 'blur(10px)';
    badge.style.webkitBackdropFilter = 'blur(10px)';
    badge.style.border = '1px solid rgba(255, 255, 255, 0.15)';
    badge.style.whiteSpace = 'nowrap';
    
    if (followedBy) {
      badge.textContent = 'Follows You';
      badge.style.background = 'rgba(34, 197, 94, 0.15)';
      badge.style.color = '#22c55e';
      badge.style.border = '1px solid rgba(34, 197, 94, 0.25)';
    } else {
      badge.textContent = 'Does Not Follow You';
      badge.style.background = 'rgba(239, 68, 68, 0.15)';
      badge.style.color = '#ef4444';
      badge.style.border = '1px solid rgba(239, 68, 68, 0.25)';
    }
    
    headerEl.style.display = 'inline-flex';
    headerEl.style.alignItems = 'center';
    headerEl.appendChild(badge);
  }



  function logStoryViewEvent(username, storyId) {
    chrome.storage.local.get({ viewed_stories_history: [] }, (data) => {
      const history = data.viewed_stories_history;
      history.push({
        username: username,
        storyId: storyId,
        timestamp: Date.now()
      });
      if (history.length > 2000) history.shift();
      chrome.storage.local.set({ viewed_stories_history: history });
      console.log('Story view logged for @' + username + ' (ID: ' + storyId + ')');
    });
  }

  // Robust www-claim retrieval: tries multiple sources since Instagram stores
  // this value inconsistently across sessions and page navigations.
  function getWwwClaim() {
    // 1. Cached from MAIN world inject.js interceptor (most reliable)
    if (cachedWwwClaim && cachedWwwClaim.length > 2) return cachedWwwClaim;

    // 2. sessionStorage (Instagram's primary storage, shared with page)
    try {
      const fromSession = sessionStorage.getItem('www-claim-v2');
      if (fromSession && fromSession !== '0' && fromSession.length > 2) return fromSession;
    } catch (e) { /* ignore */ }

    // 3. localStorage fallback
    try {
      const fromLocal = localStorage.getItem('www-claim-v2');
      if (fromLocal && fromLocal !== '0' && fromLocal.length > 2) return fromLocal;
    } catch (e) { /* ignore */ }

    // 4. Try extracting from cookie
    const fromCookie = getCookieValue('ig_www_claim');
    if (fromCookie && fromCookie.length > 2) return fromCookie;

    // 5. Scan embedded JSON script tags for claim value
    try {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const script of scripts) {
        const text = script.textContent;
        if (text && text.includes('claim')) {
          const claimMatch = text.match(/"claim"\s*:\s*"([^"]+)"/);
          if (claimMatch && claimMatch[1] && claimMatch[1] !== '0') return claimMatch[1];
        }
      }
    } catch (e) { /* ignore */ }

    return '0';
  }

  // Helper: save a new www-claim value from API response headers
  function captureClaimFromResponse(response) {
    try {
      const newClaim = response.headers.get('x-ig-set-www-claim');
      if (newClaim && newClaim !== '0' && newClaim.length > 2) {
        cachedWwwClaim = newClaim;
        try { sessionStorage.setItem('www-claim-v2', newClaim); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  // Web API Calls
  async function fetchUserProfileInfo(username) {
    trackApiCall();
    const claim = getWwwClaim();

    // Attempt 1: Primary web_profile_info endpoint
    try {
      const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
      const response = await fetch(url, {
        headers: {
          'x-csrftoken': getCookieValue('csrftoken') || '',
          'x-ig-app-id': '936619743392459',
          'x-ig-www-claim': claim,
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'include'
      });
      captureClaimFromResponse(response);
      checkResponseStatus(response, 'general');
      if (response.ok) {
        const json = await response.json();
        if (json?.data?.user) return json.data.user;
      }
      console.warn(`web_profile_info returned ${response.status} for ${username}, trying fallbacks...`);
    } catch (err) {
      console.warn('Primary profile fetch error:', err.message);
    }

    // Attempt 2: /?__a=1&__d=dis endpoint (different from attempt 1)
    try {
      const fallbackUrl = `https://www.instagram.com/${username}/?__a=1&__d=dis`;
      const response2 = await fetch(fallbackUrl, {
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'include'
      });
      captureClaimFromResponse(response2);
      if (response2.ok) {
        const json2 = await response2.json();
        // This endpoint returns { graphql: { user: ... } } or { items: [...] }
        const user = json2?.graphql?.user || json2?.data?.user;
        if (user) return user;
      }
    } catch (e) {
      console.warn('Fallback /?__a=1&__d=dis (attempt 2) failed:', e.message);
    }

    // Attempt 3: GraphQL username lookup (try multiple doc_ids since they rotate)
    const gqlDocIds = [
      '7842322082460904',
      '8845758582119845',
      '9496129080480496',
      '17991953975672886'
    ];
    for (const docId of gqlDocIds) {
      try {
        const gqlUrl = 'https://www.instagram.com/graphql/query/';
        const body = new URLSearchParams({
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'PolarisProfilePageContentQuery',
          doc_id: docId,
          variables: JSON.stringify({ username: username, render_surface: 'PROFILE' })
        });
        const gqlResponse = await fetch(gqlUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-csrftoken': getCookieValue('csrftoken') || '',
            'x-ig-app-id': '936619743392459',
            'x-fb-friendly-name': 'PolarisProfilePageContentQuery',
            'x-requested-with': 'XMLHttpRequest'
          },
          body: body.toString(),
          credentials: 'include'
        });
        captureClaimFromResponse(gqlResponse);
        if (gqlResponse.ok) {
          const gqlJson = await gqlResponse.json();
          const user = gqlJson?.data?.user
            || gqlJson?.data?.xdt_api__v1__users__web_profile_info?.data?.user
            || gqlJson?.data?.xdt_api__v1__users__web_profile_info;
          if (user && (user.id || user.pk)) return user;
        }
      } catch (e) {
        console.warn(`GraphQL doc_id ${docId} failed:`, e.message);
      }
    }

    // Attempt 4: Scrape the profile page HTML for embedded user data
    try {
      const pageResp = await fetch(`https://www.instagram.com/${username}/`, {
        credentials: 'include'
      });
      if (pageResp.ok) {
        const html = await pageResp.text();

        // Try window._sharedData (legacy but some regions still use it)
        const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});\s*<\/script>/);
        if (sharedDataMatch) {
          try {
            const sharedData = JSON.parse(sharedDataMatch[1]);
            const profileUser = sharedData?.entry_data?.ProfilePage?.[0]?.graphql?.user;
            if (profileUser) return profileUser;
          } catch (e) { /* parse error, continue */ }
        }

        // Try __additionalDataLoaded
        const additionalDataMatch = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*({.+?})\)\s*;/);
        if (additionalDataMatch) {
          try {
            const addData = JSON.parse(additionalDataMatch[1]);
            const user = addData?.graphql?.user || addData?.user;
            if (user) return user;
          } catch (e) { /* parse error, continue */ }
        }

        // Try extracting user ID from embedded JSON script blocks (modern IG SJS)
        const scriptBlocks = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of scriptBlocks) {
          const jsonContent = block.replace(/<script[^>]*>/, '').replace(/<\/script>/i, '');
          try {
            const parsed = JSON.parse(jsonContent);
            const foundUser = deepFindUser(parsed, username);
            if (foundUser) return foundUser;
          } catch (e) { /* not valid JSON or parse error */ }
        }

        // Final: try to find a user ID pattern in raw HTML
        const userIdMatch = html.match(/"profilePage_(\d+)"/) || html.match(/"user_id"\s*:\s*"(\d+)"/) || html.match(/"pk"\s*:\s*"?(\d+)"?/);
        if (userIdMatch) {
          return { id: userIdMatch[1], pk: userIdMatch[1], username: username };
        }
      }
    } catch (e) {
      console.warn('HTML scrape profile fetch (attempt 4) failed:', e.message);
    }

    throw new Error(`Profile fetch failed: semua metode gagal untuk @${username}`);
  }

  // Deep-search a nested JSON object for a user with a matching username
  function deepFindUser(obj, username, depth = 0) {
    if (depth > 15 || !obj || typeof obj !== 'object') return null;
    // Check if this object looks like a user with an id/pk and matching username
    if (obj.username === username && (obj.id || obj.pk)) return obj;
    // Also check inside common wrapper keys
    if (obj.user && obj.user.username === username && (obj.user.id || obj.user.pk)) return obj.user;
    // Recurse into arrays
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = deepFindUser(item, username, depth + 1);
        if (found) return found;
      }
      return null;
    }
    // Recurse into object values
    for (const key of Object.keys(obj)) {
      const found = deepFindUser(obj[key], username, depth + 1);
      if (found) return found;
    }
    return null;
  }

  async function fetchFriendshipInfo(userId) {
    trackApiCall();
    const url = `https://www.instagram.com/api/v1/friendships/show/${userId}/`;
    const response = await fetch(url, {
      headers: {
        'x-csrftoken': getCookieValue('csrftoken') || '',
        'x-ig-app-id': '936619743392459',
        'x-ig-www-claim': getWwwClaim(),
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'include'
    });
    checkResponseStatus(response, 'relationship');
    if (!response.ok) {
      throw new Error(`Friendship status query failed: ${response.status}`);
    }
    return response.json();
  }

  async function fetchUserStories(userId) {
    trackApiCall();
    const url = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${userId}`;
    const response = await fetch(url, {
      headers: {
        'x-csrftoken': getCookieValue('csrftoken') || '',
        'x-ig-app-id': '936619743392459',
        'x-ig-www-claim': getWwwClaim(),
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'include'
    });
    checkResponseStatus(response, 'download');
    if (!response.ok) {
      throw new Error(`Stories fetch failed: ${response.status}`);
    }
    const json = await response.json();
    return json.reels[userId];
  }

  async function fetchHighlightStories(highlightId) {
    trackApiCall();
    const url = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight:${highlightId}`;
    const response = await fetch(url, {
      headers: {
        'x-csrftoken': getCookieValue('csrftoken') || '',
        'x-ig-app-id': '936619743392459',
        'x-ig-www-claim': getWwwClaim(),
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'include'
    });
    checkResponseStatus(response, 'download');
    if (!response.ok) {
      throw new Error(`Highlight fetch failed: ${response.status}`);
    }
    const json = await response.json();
    return json.reels[`highlight:${highlightId}`];
  }

  async function fetchMediaInfo(postId) {
    trackApiCall();
    const url = `https://www.instagram.com/api/v1/media/${postId}/info/`;
    const response = await fetch(url, {
      headers: {
        'x-csrftoken': getCookieValue('csrftoken') || '',
        'x-ig-app-id': '936619743392459',
        'x-ig-www-claim': getWwwClaim(),
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'include'
    });
    checkResponseStatus(response, 'download');
    if (!response.ok) {
      throw new Error(`Media info fetch failed: ${response.status}`);
    }
    const json = await response.json();
    return json.items[0];
  }

  async function fetchGraphQLPostInfo(shortcode) {
    trackApiCall();
    // Instagram rotates doc_id values every few weeks; try multiple known IDs
    const docIds = [
      '8845758582119845',
      '9496129080480496',
      '7153e22b1f182d95',
      '17991953975672886'
    ];
    const url = 'https://www.instagram.com/graphql/query/';
    
    for (const docId of docIds) {
      try {
        const body = new URLSearchParams({
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
          doc_id: docId,
          variables: JSON.stringify({ shortcode: shortcode })
        });
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-csrftoken': getCookieValue('csrftoken') || '',
            'x-ig-app-id': '936619743392459',
            'x-ig-www-claim': getWwwClaim(),
            'x-requested-with': 'XMLHttpRequest'
          },
          body: body.toString(),
          credentials: 'include'
        });
        checkResponseStatus(response, 'download');
        if (!response.ok) continue;
        
        const json = await response.json();
        const media = json?.data?.xdt_shortcode_media;
        if (media) return media;
        
        console.warn(`GraphQL doc_id ${docId} returned no data, trying next...`);
      } catch (e) {
        console.warn(`GraphQL doc_id ${docId} failed:`, e.message);
      }
    }
    
    // Final fallback: try the legacy oembed endpoint to get basic info
    try {
      const oembedResp = await fetch(`https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, {
        headers: {
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'include'
      });
      if (oembedResp.ok) {
        const oembedJson = await oembedResp.json();
        if (oembedJson?.items?.[0]) return oembedJson.items[0];
        if (oembedJson?.graphql?.shortcode_media) return oembedJson.graphql.shortcode_media;
      }
    } catch (e) {
      console.warn('Legacy endpoint also failed:', e.message);
    }
    
    throw new Error('Semua metode GraphQL gagal. Kemungkinan doc_id perlu diperbarui.');
  }

  // Helper to find the carousel UL container
  function findPostCarouselUl(postElement) {
    if (!postElement) return null;
    
    // If postElement is the document, let's find the first article
    const targetElement = postElement.tagName === 'ARTICLE' ? postElement : postElement.querySelector('article') || postElement;
    
    // Find the actions section inside the target element to exclude comments
    const sections = targetElement.querySelectorAll('section');
    let actionsSection = null;
    for (const sec of sections) {
      if (sec.querySelector('svg')) {
        actionsSection = sec;
        break;
      }
    }
    
    const uls = targetElement.querySelectorAll('ul');
    for (const ul of uls) {
      // Skip comment lists which are inside or after the actionsSection
      if (actionsSection && (actionsSection.contains(ul) || (actionsSection.compareDocumentPosition(ul) & (Node.DOCUMENT_POSITION_FOLLOWING || 4)))) {
        continue;
      }
      
      const lis = ul.querySelectorAll('li');
      if (lis.length > 1) {
        // Must contain media (img or video) in the first slide
        if (lis[0].querySelector('img, video')) {
          return ul;
        }
      }
    }
    
    // Fallback: search for any UL with horizontal scroll profile
    for (const ul of uls) {
      if (ul.scrollWidth > ul.clientWidth && ul.querySelectorAll('li').length > 1) {
        return ul;
      }
    }
    
    return null;
  }

  // Find the active article, prioritizing the modal dialog post if open
  function getActiveArticle() {
    const modalArticle = document.querySelector('div[role="dialog"] article, [role="dialog"] article, div[role="presentation"] article');
    if (modalArticle) return modalArticle;
    
    const singleArticle = document.querySelector('article');
    if (singleArticle) return singleArticle;
    
    return document;
  }

  // Detect active item inside a carousel post
  function getActiveCarouselIndex(postElement) {
    if (!postElement) return 0;
    
    // 1. Try dot indicators first (most reliable as they represent the active React state directly)
    const indicators = postElement.querySelectorAll('.XCodT, ._acnb, [class*="CarouselIndicator"], [class*="sliderBubble"]');
    if (indicators.length > 0) {
      const activeIndicator = postElement.querySelector('.XCodT.active, ._acnb._acnf, [class*="CarouselIndicator"][class*="Active"], [class*="sliderBubbleActive"]');
      if (activeIndicator) {
        const allIndicators = Array.from(indicators);
        const index = allIndicators.indexOf(activeIndicator);
        if (index !== -1) {
          console.log(`[IGTools] Detected active carousel slide index ${index} via dot indicators`);
          return index;
        }
      }
    }

    // 2. Fallback to scroll/bounding rect check
    const scrollContainer = findPostCarouselUl(postElement);
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect();
      const slides = scrollContainer.querySelectorAll('li');
      if (slides.length > 0) {
        let activeIndex = 0;
        let minDiff = Infinity;
        
        slides.forEach((slide, index) => {
          const rect = slide.getBoundingClientRect();
          const diff = Math.abs(rect.left - containerRect.left);
          if (diff < minDiff) {
            minDiff = diff;
            activeIndex = index;
          }
        });
        
        return activeIndex;
      }
      
      // Fallback scroll offset calculation
      const width = scrollContainer.clientWidth;
      const scrollLeft = scrollContainer.scrollLeft;
      if (width > 0) {
        return Math.round(scrollLeft / width);
      }
    }

    return 0;
  }

  // Extract the currently visible image/video src from the post DOM
  function getVisibleMediaSrc(postElement) {
    if (!postElement) return null;
    
    // Strategy 1: Find the media container area (before the action buttons section)
    const sections = postElement.querySelectorAll('section');
    let actionsSection = null;
    for (const sec of sections) {
      if (sec.querySelector('svg')) {
        actionsSection = sec;
        break;
      }
    }
    
    // Collect all img and video elements in the post, but only those above the actions section
    const allMedia = [];
    const imgs = postElement.querySelectorAll('img');
    const videos = postElement.querySelectorAll('video');
    
    for (const img of imgs) {
      // Skip tiny images (profile pics, icons, etc.)
      if (img.naturalWidth > 0 && img.naturalWidth < 100) continue;
      if (img.width < 100 && img.height < 100) continue;
      // Skip if it's inside/after the actions section (comment area)
      if (actionsSection && actionsSection.contains(img)) continue;
      // Skip profile pictures in header
      const header = postElement.querySelector('header');
      if (header && header.contains(img)) continue;
      
      allMedia.push({ type: 'image', src: img.src, el: img });
    }
    
    for (const video of videos) {
      if (actionsSection && actionsSection.contains(video)) continue;
      const header = postElement.querySelector('header');
      if (header && header.contains(video)) continue;
      
      allMedia.push({ type: 'video', src: video.src, poster: video.poster, el: video });
    }
    
    if (allMedia.length === 0) return null;
    
    // If there's only one media element, return it
    if (allMedia.length === 1) return allMedia[0];
    
    // If there are multiple, find the one that's most visible in the viewport
    const containerRect = postElement.getBoundingClientRect();
    let bestMedia = null;
    let bestVisibility = -Infinity;
    
    for (const media of allMedia) {
      const rect = media.el.getBoundingClientRect();
      // Check if this media is within the horizontal bounds of the post
      const overlapLeft = Math.max(containerRect.left, rect.left);
      const overlapRight = Math.min(containerRect.right, rect.right);
      const horizontalOverlap = Math.max(0, overlapRight - overlapLeft);
      
      // A media element is "visible" if it significantly overlaps the container horizontally
      if (horizontalOverlap > bestVisibility) {
        bestVisibility = horizontalOverlap;
        bestMedia = media;
      }
    }
    
    return bestMedia || allMedia[0];
  }

  // Extract a normalized URL identifier from an Instagram CDN URL for comparison
  function extractMediaIdFromUrl(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      // Instagram CDN URLs have the actual image path like /v/t51.xxxxx/xxxxxx_n.jpg
      // The path component is the most stable identifier across different resolution variants
      return parsed.pathname;
    } catch (e) {
      return url;
    }
  }

  // Match the visible media in the DOM against carousel items from the API
  // Returns the matched index, or falls back to getActiveCarouselIndex
  function matchCarouselIndexByVisibleMedia(postElement, carouselItems, fallbackUsed) {
    const visibleMedia = getVisibleMediaSrc(postElement);
    if (!visibleMedia) return getActiveCarouselIndex(postElement);
    
    const visibleSrc = visibleMedia.src || visibleMedia.poster || '';
    if (!visibleSrc) return getActiveCarouselIndex(postElement);
    
    // Extract the pathname from the visible src for comparison
    const visiblePath = extractMediaIdFromUrl(visibleSrc);
    
    for (let i = 0; i < carouselItems.length; i++) {
      const item = carouselItems[i];
      
      if (!fallbackUsed) {
        // REST API format: check image_versions2.candidates and video_versions
        const candidates = [];
        if (item.image_versions2 && item.image_versions2.candidates) {
          candidates.push(...item.image_versions2.candidates.map(c => c.url));
        }
        if (item.video_versions) {
          candidates.push(...item.video_versions.map(v => v.url));
        }
        
        for (const candidateUrl of candidates) {
          const candidatePath = extractMediaIdFromUrl(candidateUrl);
          if (candidatePath && visiblePath && candidatePath === visiblePath) {
            console.log(`[IGTools] Matched visible media to carousel slide ${i} via exact path match`);
            return i;
          }
        }
      } else {
        // GraphQL format: check display_resources, display_url, video_url
        const candidateUrls = [];
        if (item.display_resources) {
          candidateUrls.push(...item.display_resources.map(r => r.src));
        }
        if (item.display_url) candidateUrls.push(item.display_url);
        if (item.video_url) candidateUrls.push(item.video_url);
        
        for (const candidateUrl of candidateUrls) {
          const candidatePath = extractMediaIdFromUrl(candidateUrl);
          if (candidatePath && visiblePath && candidatePath === visiblePath) {
            console.log(`[IGTools] Matched visible media to carousel slide ${i} via GraphQL path match`);
            return i;
          }
        }
      }
    }
    
    // Fuzzy match: try matching by filename segment (last part of the path)
    const visibleFilename = visiblePath ? visiblePath.split('/').pop() : '';
    if (visibleFilename) {
      for (let i = 0; i < carouselItems.length; i++) {
        const item = carouselItems[i];
        const candidateUrls = [];
        
        if (!fallbackUsed) {
          if (item.image_versions2 && item.image_versions2.candidates) {
            candidateUrls.push(...item.image_versions2.candidates.map(c => c.url));
          }
          if (item.video_versions) {
            candidateUrls.push(...item.video_versions.map(v => v.url));
          }
        } else {
          if (item.display_resources) candidateUrls.push(...item.display_resources.map(r => r.src));
          if (item.display_url) candidateUrls.push(item.display_url);
          if (item.video_url) candidateUrls.push(item.video_url);
        }
        
        for (const candidateUrl of candidateUrls) {
          try {
            const candidateFilename = new URL(candidateUrl).pathname.split('/').pop();
            // Match by the base filename (without size variants)
            // e.g., "123456789_n.jpg" appears in multiple resolution variants
            if (candidateFilename && visibleFilename.includes(candidateFilename.split('_').slice(0, -1).join('_'))) {
              console.log(`[IGTools] Matched visible media to carousel slide ${i} via fuzzy filename match`);
              return i;
            }
            if (visibleFilename === candidateFilename) {
              console.log(`[IGTools] Matched visible media to carousel slide ${i} via exact filename match`);
              return i;
            }
          } catch (e) { /* skip */ }
        }
      }
    }
    
    console.warn('[IGTools] Could not match visible media to any carousel slide, falling back to DOM index detection');
    return getActiveCarouselIndex(postElement);
  }

  // Extract highest resolution candidate from candidates array
  function getHighestResolutionUrl(item) {
    if (!item) return null;
    const isVideo = item.media_type === 2 || item.is_video || (item.video_versions && item.video_versions.length > 0);
    
    if (isVideo) {
      const videoVersions = item.video_versions;
      if (videoVersions && videoVersions.length > 0) {
        console.log('Available progressive video versions returned by Instagram API:', videoVersions.map(v => `${v.width}x${v.height} (${v.type || 'standard'})`));
        const sorted = [...videoVersions].sort((a, b) => b.width - a.width);
        return sorted[0].url;
      }
    } else {
      const imageVersions = item.image_versions2;
      if (imageVersions && imageVersions.candidates && imageVersions.candidates.length > 0) {
        console.log('Available image versions returned by Instagram API:', imageVersions.candidates.map(c => `${c.width}x${c.height}`));
        const sorted = [...imageVersions.candidates].sort((a, b) => b.width - a.width);
        return sorted[0].url;
      }
    }
    return null;
  }

  // Extract highest resolution candidate from GraphQL display resources
  function getHighestResolutionUrlFromGraphQL(media) {
    if (!media) return null;
    if (media.is_video) {
      console.log('GraphQL video URL retrieved:', media.video_url);
      return media.video_url;
    } else {
      const resources = media.display_resources;
      if (resources && resources.length > 0) {
        console.log('Available GraphQL display resource sizes:', resources.map(r => `${r.config_width}x${r.config_height}`));
        const sorted = [...resources].sort((a, b) => b.config_width - a.config_width);
        return sorted[0].src;
      }
      return media.display_url;
    }
  }

  // Get post shortcode from links within an article
  function getPostShortcode(article) {
    const links = article.querySelectorAll('a');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href) {
        const match = href.match(/\/(p|tv|reel|reels)\/([A-Za-z0-9_-]+)/);
        if (match) {
          return match[2];
        }
      }
    }
    return null;
  }

  // Resolve media details for a specific article element
  async function resolveMediaForArticle(article) {
    const shortcode = getPostShortcode(article);
    if (!shortcode) throw new Error('Could not find post shortcode');

    const postId = convertToPostId(shortcode);
    let mediaItem = null;
    let fallbackUsed = false;
    
    try {
      mediaItem = await fetchMediaInfo(postId);
    } catch (e) {
      console.warn('API /info/ failed, trying GraphQL fallback:', e);
      mediaItem = await fetchGraphQLPostInfo(shortcode);
      fallbackUsed = true;
    }
    
    if (!mediaItem) throw new Error('Failed to fetch post/reel media details');
    
    let targetItem = mediaItem;
    let slideIndex = null;
    if (!fallbackUsed && mediaItem.carousel_media) {
      const activeIndex = getActiveCarouselIndex(article);
      targetItem = mediaItem.carousel_media[activeIndex] || mediaItem.carousel_media[0];
      slideIndex = activeIndex;
    } else if (fallbackUsed && mediaItem.edge_sidecar_to_children) {
      const edges = mediaItem.edge_sidecar_to_children.edges;
      if (edges && edges.length > 0) {
        const activeIndex = getActiveCarouselIndex(article);
        const edge = edges[activeIndex] || edges[0];
        targetItem = edge.node;
        slideIndex = activeIndex;
      }
    }
    
    let url = null;
    let isVideo = false;
    
    if (fallbackUsed) {
      url = getHighestResolutionUrlFromGraphQL(targetItem);
      isVideo = targetItem.is_video;
    } else {
      url = getHighestResolutionUrl(targetItem);
      isVideo = targetItem.media_type === 2;
    }
    
    if (!url) throw new Error('Could not resolve media URL');
    
    const ownerUsername = mediaItem.user ? mediaItem.user.username : (mediaItem.owner ? mediaItem.owner.username : 'instagram');
    
    // Extract upload timestamp: REST API uses taken_at (unix seconds), GraphQL uses taken_at_timestamp
    const takenAtRaw = fallbackUsed ? (mediaItem.taken_at_timestamp || mediaItem.taken_at) : mediaItem.taken_at;
    const takenAt = takenAtRaw ? new Date(takenAtRaw * 1000) : null;
    
    return {
      type: isVideo ? 'video' : 'image',
      url: url,
      username: ownerUsername,
      id: shortcode,
      takenAt: takenAt,
      slideIndex: slideIndex
    };
  }

  // Handle post download action from specific article button
  async function handlePostDownload(article, btn) {
    if (btn.classList.contains('loading')) return;

    btn.classList.add('loading');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg class="spinner" viewBox="0 0 50 50" style="animation: rotate 2s linear infinite; width: 18px; height: 18px;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" style="stroke-dasharray: 1, 150; stroke-dashoffset: 0; animation: dash 1.5s ease-in-out infinite;"></circle></svg>`;
    showToast('Resolving media quality...', 'info');

    try {
      const media = await resolveMediaForArticle(article);
      
      const downloadKey = getMediaDownloadKey(media);
      if (downloadKey) {
        const isDuplicate = await checkDuplicateDownload(downloadKey);
        if (isDuplicate) {
          const proceed = confirm("File ini sudah pernah diunduh. Apakah Anda ingin mengunduhnya lagi?");
          if (!proceed) {
            btn.classList.remove('loading');
            btn.innerHTML = originalHTML;
            return;
          }
        }
      }

      const takenAt = media.takenAt || new Date();
      const day = String(takenAt.getDate()).padStart(2, '0');
      const month = String(takenAt.getMonth() + 1).padStart(2, '0');
      const year = takenAt.getFullYear();
      const hours = String(takenAt.getHours()).padStart(2, '0');
      const minutes = String(takenAt.getMinutes()).padStart(2, '0');
      const seconds = String(takenAt.getSeconds()).padStart(2, '0');
      const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

      const dateStr = `${day} ${month} ${year}`;
      const timeStr = `${hours} ${minutes} ${seconds} ${milliseconds}`;

      const ext = media.type === 'video' ? 'mp4' : 'jpg';
      const filename = `${media.username}_${dateStr}_${timeStr}.${ext}`;

      showToast('Starting download...', 'info');

      executeDownload(media.url, filename, (response) => {
        btn.classList.remove('loading');
        btn.innerHTML = originalHTML;
        
        if (response && response.success) {
          showToast('Download started!', 'success');
          if (downloadKey) markMediaAsDownloaded(downloadKey);
        } else {
          showToast('Download failed: ' + (response ? response.error : 'Unknown error'), 'error');
        }
      }, media.username);

    } catch (e) {
      console.error('Download failed:', e);
      showToast('Error: ' + e.message, 'error');
      btn.classList.remove('loading');
      btn.innerHTML = originalHTML;
    }
  }

  // Handle post copy photo action from specific article button
  async function handlePostCopy(article, btn) {
    if (btn.classList.contains('loading')) return;

    btn.classList.add('loading');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg class="spinner" viewBox="0 0 50 50" style="animation: rotate 2s linear infinite; width: 18px; height: 18px;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" style="stroke-dasharray: 1, 150; stroke-dashoffset: 0; animation: dash 1.5s ease-in-out infinite;"></circle></svg>`;
    showToast('Resolving media quality...', 'info');

    try {
      const media = await resolveMediaForArticle(article);
      if (media.type !== 'image') {
        throw new Error('Copy is only available for photos.');
      }

      showToast('Fetching image data...', 'info');

      // Bypass CORS by asking the background script to fetch image bytes as base64
      chrome.runtime.sendMessage({
        action: 'FETCH_IMAGE_BASE64',
        url: media.url
      }, (response) => {
        if (response && response.success) {
          copyBase64ImageToClipboard(response.base64, (success, errorMsg) => {
            btn.classList.remove('loading');
            
            if (success) {
              btn.classList.add('success');
              btn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#2ed573" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 24px; height: 24px; display: block;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
              showToast('Copied photo to clipboard!', 'success');

              setTimeout(() => {
                btn.classList.remove('success');
                btn.innerHTML = originalHTML;
              }, 2000);
            } else {
              btn.innerHTML = originalHTML;
              showToast('Failed to copy: ' + errorMsg, 'error');
            }
          });
        } else {
          btn.classList.remove('loading');
          btn.innerHTML = originalHTML;
          showToast('Fetch failed: ' + (response ? response.error : 'Unknown CORS error'), 'error');
        }
      });

    } catch (e) {
      console.error('Copy failed:', e);
      showToast('Error: ' + e.message, 'error');
      btn.classList.remove('loading');
      btn.innerHTML = originalHTML;
    }
  }

  // Handle bulk download for all slides of a single carousel post
  async function handlePostBulkDownload(article, btn) {
    if (btn.classList.contains('loading')) return;

    btn.classList.add('loading');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg class="spinner" viewBox="0 0 50 50" style="animation: rotate 2s linear infinite; width: 18px; height: 18px;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" style="stroke-dasharray: 1, 150; stroke-dashoffset: 0; animation: dash 1.5s ease-in-out infinite;"></circle></svg>`;
    showToast('Resolving carousel media...', 'info');

    try {
      const shortcode = getPostShortcode(article);
      if (!shortcode) throw new Error('Could not find post shortcode');

      const postId = convertToPostId(shortcode);
      let mediaItem = null;
      let fallbackUsed = false;
      
      try {
        mediaItem = await fetchMediaInfo(postId);
      } catch (e) {
        console.warn('API /info/ failed, trying GraphQL fallback:', e);
        mediaItem = await fetchGraphQLPostInfo(shortcode);
        fallbackUsed = true;
      }
      
      if (!mediaItem) throw new Error('Failed to fetch post media details');

      let items = [];
      if (!fallbackUsed && mediaItem.carousel_media) {
        items = mediaItem.carousel_media;
      } else if (fallbackUsed && mediaItem.edge_sidecar_to_children) {
        const edges = mediaItem.edge_sidecar_to_children.edges;
        if (edges && edges.length > 0) {
          items = edges.map(edge => edge.node);
        }
      }

      // If it's not actually a carousel (only 1 item), fallback to single download
      if (items.length === 0) {
        items = [mediaItem];
      }

      // Check for duplicates
      const downloadHistory = await getDownloadHistory();
      let duplicatesCount = 0;
      for (let i = 0; i < items.length; i++) {
        const slideKey = `${shortcode}_slide${i}`;
        if (downloadHistory[slideKey]) {
          duplicatesCount++;
        }
      }

      if (duplicatesCount > 0) {
        const proceed = confirm(`Terdapat ${duplicatesCount} slide yang sudah pernah diunduh. Apakah Anda ingin mengunduhnya kembali?`);
        if (!proceed) {
          btn.classList.remove('loading');
          btn.innerHTML = originalHTML;
          return;
        }
      }

      const ownerUsername = mediaItem.user ? mediaItem.user.username : (mediaItem.owner ? mediaItem.owner.username : 'instagram');
      showToast(`Downloading ${items.length} files...`, 'info');

      let triggerCount = 0;
      for (let i = 0; i < items.length; i++) {
        const targetItem = items[i];
        let url = null;
        let isVideo = false;

        if (fallbackUsed) {
          url = getHighestResolutionUrlFromGraphQL(targetItem);
          isVideo = targetItem.is_video;
        } else {
          url = getHighestResolutionUrl(targetItem);
          isVideo = targetItem.media_type === 2;
        }

        if (!url) continue;

        // Use the parent post upload timestamp; individual carousel items may also have taken_at
        const takenAtRaw = fallbackUsed ? (mediaItem.taken_at_timestamp || mediaItem.taken_at) : mediaItem.taken_at;
        const takenAt = takenAtRaw ? new Date(takenAtRaw * 1000) : new Date();
        const day = String(takenAt.getDate()).padStart(2, '0');
        const month = String(takenAt.getMonth() + 1).padStart(2, '0');
        const year = takenAt.getFullYear();
        const hours = String(takenAt.getHours()).padStart(2, '0');
        const minutes = String(takenAt.getMinutes()).padStart(2, '0');
        const seconds = String(takenAt.getSeconds()).padStart(2, '0');
        const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

        const dateStr = `${day} ${month} ${year}`;
        // We offset milliseconds with index to ensure uniqueness and preserve slide order
        const timeStr = `${hours} ${minutes} ${seconds} ${String(Math.floor(takenAt.getMilliseconds() / 10) + i).padStart(2, '0')}`;

        const ext = isVideo ? 'mp4' : 'jpg';
        const filename = `${ownerUsername}_${dateStr}_${timeStr}_slide${i + 1}.${ext}`;

        const slideKey = `${shortcode}_slide${i}`;
        executeDownload(url, filename, (response) => {
          if (response && response.success) {
            markMediaAsDownloaded(slideKey);
          }
        }, ownerUsername);
        triggerCount++;

        // small delay between slides to prevent browser queue choke
        await new Promise(r => setTimeout(r, 150));
      }

      btn.classList.remove('loading');
      btn.innerHTML = originalHTML;
      showToast(`Successfully downloaded ${triggerCount} items!`, 'success');

    } catch (e) {
      console.error('Carousel download failed:', e);
      showToast('Error: ' + e.message, 'error');
      btn.classList.remove('loading');
      btn.innerHTML = originalHTML;
    }
  }

  // Inject download and copy buttons on Feed posts and Reels
  function processFeedPostDownloaders() {
    const articles = document.querySelectorAll('article');
    for (const article of articles) {
      // Find the actions section inside the article
      const sections = article.querySelectorAll('section');
      let actionsSection = null;
      for (const sec of sections) {
        if (sec.querySelector('svg')) {
          actionsSection = sec;
          break;
        }
      }

      if (!actionsSection) continue;

      // Check if already injected
      if (article.querySelector('.ig-post-dl-btn') || article.querySelector('.ig-post-copy-btn')) continue;

      // Find the group of buttons (Like, Comment, Share)
      const firstDiv = actionsSection.querySelector('div');
      if (!firstDiv || !firstDiv.querySelector('svg')) continue;

      // Check if it is a carousel post in the DOM
      const isCarouselDom = !!findPostCarouselUl(article) || !!article.querySelector('.XCodT, ._acnb._acnf, [class*="CarouselIndicator"], [class*="sliderBubble"], button[aria-label="Next"], [class*="chevron"], [class*="Chevron"]');

      const dlBtn = document.createElement('button');
      dlBtn.className = 'ig-post-dl-btn';
      dlBtn.title = 'Download Media';
      dlBtn.style.cssText = 'background: none; border: none; padding: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: currentColor; transition: opacity 0.2s, transform 0.2s;';
      dlBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 24px; height: 24px; display: block;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

      dlBtn.addEventListener('mouseenter', () => {
        dlBtn.style.opacity = '0.7';
        dlBtn.style.transform = 'scale(1.1)';
      });
      dlBtn.addEventListener('mouseleave', () => {
        dlBtn.style.opacity = '1';
        dlBtn.style.transform = 'scale(1)';
      });
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        handlePostDownload(article, dlBtn);
      });

      const copyBtn = document.createElement('button');
      copyBtn.className = 'ig-post-copy-btn';
      copyBtn.title = 'Copy Photo';
      copyBtn.style.cssText = 'background: none; border: none; padding: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: currentColor; transition: opacity 0.2s, transform 0.2s;';
      copyBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 24px; height: 24px; display: block;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

      copyBtn.addEventListener('mouseenter', () => {
        copyBtn.style.opacity = '0.7';
        copyBtn.style.transform = 'scale(1.1)';
      });
      copyBtn.addEventListener('mouseleave', () => {
        copyBtn.style.opacity = '1';
        copyBtn.style.transform = 'scale(1)';
      });
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        handlePostCopy(article, copyBtn);
      });

      // Insert standard download and copy buttons
      firstDiv.appendChild(dlBtn);
      firstDiv.appendChild(copyBtn);

      // If it is a carousel, inject the "Download All Slides" button too
      if (isCarouselDom) {
        const dlAllBtn = document.createElement('button');
        dlAllBtn.className = 'ig-post-dl-all-btn';
        dlAllBtn.title = 'Download All Slides';
        dlAllBtn.style.cssText = 'background: none; border: none; padding: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: currentColor; transition: opacity 0.2s, transform 0.2s;';
        dlAllBtn.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 24px; height: 24px; display: block;"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline><line x1="12" y1="18" x2="12" y2="3"></line><line x1="3" y1="21" x2="21" y2="21"></line></svg>`;

        dlAllBtn.addEventListener('mouseenter', () => {
          dlAllBtn.style.opacity = '0.7';
          dlAllBtn.style.transform = 'scale(1.1)';
        });
        dlAllBtn.addEventListener('mouseleave', () => {
          dlAllBtn.style.opacity = '1';
          dlAllBtn.style.transform = 'scale(1)';
        });
        dlAllBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          handlePostBulkDownload(article, dlAllBtn);
        });

        firstDiv.appendChild(dlAllBtn);
      }
    }
  }

  // Core media resolver routing
  async function resolveCurrentMedia() {
    const isStory = window.location.href.includes('/stories/');
    const isPost = window.location.pathname.match(/\/(p|tv|reel|reels)\/([A-Za-z0-9_-]+)/);

    if (isStory) {
      const urlMatch = window.location.href.match(/stories\/([^\/]+)\/([^\/]+)?/);
      if (!urlMatch) throw new Error('Could not parse Story URL');
      
      const username = urlMatch[1];
      let storyId = urlMatch[2];
      
      if (username === 'highlights') {
        const highlightId = storyId;
        const searchParams = new URLSearchParams(window.location.search);
        const storyMediaId = searchParams.get('story_media_id');
        
        const reelsData = await fetchHighlightStories(highlightId);
        if (!reelsData || !reelsData.items) throw new Error('Highlight stories not found');
        
        const items = reelsData.items;
        let activeItem = items[0];
        if (storyMediaId) {
          activeItem = items.find(item => item.pk === storyMediaId || item.id.startsWith(storyMediaId)) || items[0];
        }
        
        const url = getHighestResolutionUrl(activeItem);
        if (!url) throw new Error('Could not resolve highlight media URL');
        
        return {
          type: activeItem.media_type === 2 ? 'video' : 'image',
          url: url,
          username: reelsData.user ? reelsData.user.username : 'instagram',
          id: activeItem.pk,
          takenAt: activeItem.taken_at ? new Date(activeItem.taken_at * 1000) : null
        };
      } else {
        const user = await fetchUserProfileInfo(username);
        if (!user) throw new Error('Instagram profile not found');
        
        const reelsData = await fetchUserStories(user.id);
        if (!reelsData || !reelsData.items) throw new Error('User stories not found');
        
        const items = reelsData.items;
        let activeItem = items[0];
        if (storyId) {
          activeItem = items.find(item => item.pk === storyId || item.id.startsWith(storyId)) || items[0];
        }
        
        const url = getHighestResolutionUrl(activeItem);
        if (!url) throw new Error('Could not resolve story media URL');
        
        return {
          type: activeItem.media_type === 2 ? 'video' : 'image',
          url: url,
          username: username,
          id: activeItem.pk,
          takenAt: activeItem.taken_at ? new Date(activeItem.taken_at * 1000) : null
        };
      }
    } else if (isPost) {
      const shortcode = isPost[2];
      const postId = convertToPostId(shortcode);
      
      let mediaItem = null;
      let fallbackUsed = false;
      
      try {
        mediaItem = await fetchMediaInfo(postId);
      } catch (e) {
        console.warn('API /info/ failed, trying GraphQL fallback:', e);
        mediaItem = await fetchGraphQLPostInfo(shortcode);
        fallbackUsed = true;
      }
      
      if (!mediaItem) throw new Error('Failed to fetch post/reel media details');
      
      let targetItem = mediaItem;
      let slideIndex = null;
      const postArticle = getActiveArticle();
      if (!fallbackUsed && mediaItem.carousel_media) {
        const activeIndex = getActiveCarouselIndex(postArticle);
        targetItem = mediaItem.carousel_media[activeIndex] || mediaItem.carousel_media[0];
        slideIndex = activeIndex;
      } else if (fallbackUsed && mediaItem.edge_sidecar_to_children) {
        const edges = mediaItem.edge_sidecar_to_children.edges;
        if (edges && edges.length > 0) {
          const activeIndex = getActiveCarouselIndex(postArticle);
          const edge = edges[activeIndex] || edges[0];
          targetItem = edge.node;
          slideIndex = activeIndex;
        }
      }
      
      let url = null;
      let isVideo = false;
      
      if (fallbackUsed) {
        url = getHighestResolutionUrlFromGraphQL(targetItem);
        isVideo = targetItem.is_video;
      } else {
        url = getHighestResolutionUrl(targetItem);
        isVideo = targetItem.media_type === 2;
      }
      
      if (!url) throw new Error('Could not resolve media URL');
      
      const ownerUsername = mediaItem.user ? mediaItem.user.username : (mediaItem.owner ? mediaItem.owner.username : 'instagram');
      
      // Extract upload timestamp: REST API uses taken_at (unix seconds), GraphQL uses taken_at_timestamp
      const takenAtRaw = fallbackUsed ? (mediaItem.taken_at_timestamp || mediaItem.taken_at) : mediaItem.taken_at;
      const takenAt = takenAtRaw ? new Date(takenAtRaw * 1000) : null;
      
      return {
        type: isVideo ? 'video' : 'image',
        url: url,
        username: ownerUsername,
        id: shortcode,
        takenAt: takenAt,
        slideIndex: slideIndex
      };
    }
    
    throw new Error('Not on a supported Instagram media page');
  }

  // Handle Download action
  async function handleDownload() {
    const downloadBtn = document.getElementById('ig-helper-download');
    if (downloadBtn.classList.contains('loading')) return;

    const originalHTML = downloadBtn.innerHTML;
    downloadBtn.classList.add('loading');
    downloadBtn.innerHTML = `${ICONS.spinner} <span>Resolving...</span>`;
    showToast('Resolving media quality...', 'info');

    try {
      const media = await resolveCurrentMedia();
      
      const downloadKey = getMediaDownloadKey(media);
      if (downloadKey) {
        const isDuplicate = await checkDuplicateDownload(downloadKey);
        if (isDuplicate) {
          const proceed = confirm("File ini sudah pernah diunduh. Apakah Anda ingin mengunduhnya lagi?");
          if (!proceed) {
            downloadBtn.classList.remove('loading');
            downloadBtn.innerHTML = originalHTML;
            return;
          }
        }
      }

      const takenAt = media.takenAt || new Date();
      const day = String(takenAt.getDate()).padStart(2, '0');
      const month = String(takenAt.getMonth() + 1).padStart(2, '0');
      const year = takenAt.getFullYear();
      const hours = String(takenAt.getHours()).padStart(2, '0');
      const minutes = String(takenAt.getMinutes()).padStart(2, '0');
      const seconds = String(takenAt.getSeconds()).padStart(2, '0');
      const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

      const dateStr = `${day} ${month} ${year}`;
      const timeStr = `${hours} ${minutes} ${seconds} ${milliseconds}`;

      const ext = media.type === 'video' ? 'mp4' : 'jpg';
      const filename = `${media.username}_${dateStr}_${timeStr}.${ext}`;

      showToast('Starting download...', 'info');

      executeDownload(media.url, filename, (response) => {
        downloadBtn.classList.remove('loading');
        downloadBtn.innerHTML = originalHTML;
        
        if (response && response.success) {
          showToast('Download started!', 'success');
          if (downloadKey) markMediaAsDownloaded(downloadKey);
        } else {
          showToast('Download failed: ' + (response ? response.error : 'Unknown error'), 'error');
        }
      }, media.username);

    } catch (e) {
      console.error('Download failed:', e);
      showToast('Error: ' + e.message, 'error');
      downloadBtn.classList.remove('loading');
      downloadBtn.innerHTML = originalHTML;
    }
  }

  // Handle Download No API action (direct DOM scrape)
  async function handleDownloadNoApi() {
    const downloadBtn = document.getElementById('ig-helper-download-no-api');
    if (downloadBtn.classList.contains('loading')) return;

    const originalHTML = downloadBtn.innerHTML;
    downloadBtn.classList.add('loading');
    downloadBtn.innerHTML = `${ICONS.spinner} <span>Resolving...</span>`;
    showToast('Mendapatkan media dari layar...', 'info');

    try {
      const media = await resolveCurrentMediaNoApi();
      
      const downloadKey = getMediaDownloadKey(media);
      if (downloadKey) {
        const isDuplicate = await checkDuplicateDownload(downloadKey);
        if (isDuplicate) {
          const proceed = confirm("File ini sudah pernah diunduh. Apakah Anda ingin mengunduhnya lagi?");
          if (!proceed) {
            downloadBtn.classList.remove('loading');
            downloadBtn.innerHTML = originalHTML;
            return;
          }
        }
      }

      const takenAt = media.takenAt || new Date();
      const day = String(takenAt.getDate()).padStart(2, '0');
      const month = String(takenAt.getMonth() + 1).padStart(2, '0');
      const year = takenAt.getFullYear();
      const hours = String(takenAt.getHours()).padStart(2, '0');
      const minutes = String(takenAt.getMinutes()).padStart(2, '0');
      const seconds = String(takenAt.getSeconds()).padStart(2, '0');
      const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

      const dateStr = `${day} ${month} ${year}`;
      const timeStr = `${hours} ${minutes} ${seconds} ${milliseconds}`;

      const ext = media.type === 'video' ? 'mp4' : 'jpg';
      const filename = `${media.username}_${dateStr}_${timeStr}.${ext}`;

      showToast('Starting download (No API)...', 'info');

      executeDownload(media.url, filename, (response) => {
        downloadBtn.classList.remove('loading');
        downloadBtn.innerHTML = originalHTML;
        
        if (response && response.success) {
          showToast('Download (No API) started!', 'success');
          if (downloadKey) markMediaAsDownloaded(downloadKey);
        } else {
          showToast('Download failed: ' + (response ? response.error : 'Unknown error'), 'error');
        }
      }, media.username);

    } catch (e) {
      console.error('Download (No API) failed:', e);
      showToast('Error (No API): ' + e.message, 'error');
      downloadBtn.classList.remove('loading');
      downloadBtn.innerHTML = originalHTML;
    }
  }

  // Resolve media details from browser DOM without calling API
  async function resolveCurrentMediaNoApi() {
    const isStory = window.location.href.includes('/stories/');
    const isPost = window.location.pathname.match(/\/(p|tv|reel|reels)\/([A-Za-z0-9_-]+)/);
    const isVideoExpected = isCurrentMediaVideo();

    let username = getCurrentActiveUsername() || 'instagram';
    let url = null;
    let type = isVideoExpected ? 'video' : 'image';
    let shortcode = 'media';
    let slideIndex = null;
    let container = document.body;

    if (isStory) {
      const activeHeader = findActiveStoryHeader();
      container = activeHeader ? activeHeader.closest('section') || document.body : document.body;
      
      const urlMatch = window.location.href.match(/stories\/([^\/]+)\/([^\/]+)?/);
      if (urlMatch) {
        shortcode = urlMatch[2] || 'story';
      }
    } else {
      if (isPost) {
        container = getActiveArticle();
        shortcode = isPost[2];
      } else {
        const articles = document.querySelectorAll('article');
        for (const art of articles) {
          const rect = art.getBoundingClientRect();
          if (rect.top < window.innerHeight && rect.bottom > 0) {
            container = art;
            break;
          }
        }
        if (container && container !== document.body) {
          shortcode = getPostShortcode(container) || 'post';
        }
      }
    }

    const visible = getVisibleMediaSrc(container);
    if (visible) {
      // Jika aslinya foto, tapi terdeteksi video (misal dari slide lain), paksa ambil foto (poster/src)
      if (!isVideoExpected && visible.type === 'video') {
        url = visible.poster || visible.src;
        type = 'image';
      } else {
        url = visible.src || visible.poster;
        type = visible.type;
      }
      if (!isStory) {
        slideIndex = getActiveCarouselIndex(container);
      }
    }

    // Fallback jika getVisibleMediaSrc gagal menemukan media
    if (!url) {
      if (isVideoExpected) {
        const video = container.querySelector('video');
        if (video) url = video.src;
      }
      if (!url) {
        const imgs = Array.from(container.querySelectorAll('img'));
        let bestImg = null;
        let bestVisibility = -Infinity;
        const containerRect = container.getBoundingClientRect();
        
        for (const img of imgs) {
          const rect = img.getBoundingClientRect();
          if (rect.width < 100 || rect.height < 100) continue;
          
          const header = container.querySelector('header');
          if (header && header.contains(img)) continue;

          const overlapLeft = Math.max(containerRect.left, rect.left);
          const overlapRight = Math.min(containerRect.right, rect.right);
          const horizontalOverlap = Math.max(0, overlapRight - overlapLeft);
          
          if (horizontalOverlap > bestVisibility) {
            bestVisibility = horizontalOverlap;
            bestImg = img;
          }
        }
        
        if (bestImg) {
          url = bestImg.src;
          type = 'image';
        }
      }
    }

    if (!url) throw new Error('Tidak dapat menemukan file media di layar.');
    
    // Cegah download BLOB URL untuk video karena akan menyebabkan Network Error di background script
    if (type === 'video' && url.startsWith('blob:')) {
      throw new Error('Video ini dienkripsi (blob stream) oleh Instagram dan tidak bisa didownload tanpa API. Silakan tunggu Safe Mode selesai.');
    }

    return {
      type: type,
      url: url,
      username: username,
      id: shortcode,
      takenAt: new Date(),
      slideIndex: slideIndex
    };
  }

  // Handle Copy Photo action
  async function handleCopy() {
    const copyBtn = document.getElementById('ig-helper-copy');
    if (copyBtn.classList.contains('loading')) return;

    const originalHTML = copyBtn.innerHTML;
    copyBtn.classList.add('loading');
    copyBtn.innerHTML = `${ICONS.spinner} <span>Resolving...</span>`;
    showToast('Resolving media quality...', 'info');

    try {
      const media = await resolveCurrentMedia();
      if (media.type !== 'image') {
        throw new Error('Copy is only available for photos.');
      }

      copyBtn.innerHTML = `${ICONS.spinner} <span>Copying...</span>`;
      showToast('Fetching image data...', 'info');

      // Bypass CORS by asking the background script to fetch image bytes as base64
      chrome.runtime.sendMessage({
        action: 'FETCH_IMAGE_BASE64',
        url: media.url
      }, (response) => {
        if (response && response.success) {
          copyBase64ImageToClipboard(response.base64, (success, errorMsg) => {
            if (success) {
              copyBtn.classList.remove('loading');
              copyBtn.classList.add('success');
              copyBtn.innerHTML = `${ICONS.success} <span>Copied!</span>`;
              showToast('Copied photo to clipboard!', 'success');

              setTimeout(() => {
                copyBtn.classList.remove('success');
                copyBtn.innerHTML = originalHTML;
              }, 2000);
            } else {
              resetCopyButton(copyBtn, originalHTML);
              showToast('Failed to copy: ' + errorMsg, 'error');
            }
          });
        } else {
          resetCopyButton(copyBtn, originalHTML);
          showToast('Fetch failed: ' + (response ? response.error : 'Unknown CORS error'), 'error');
        }
      });

    } catch (e) {
      console.error('Copy failed:', e);
      showToast('Error: ' + e.message, 'error');
      resetCopyButton(copyBtn, originalHTML);
    }
  }

  function resetCopyButton(btn, originalHTML) {
    btn.classList.remove('loading');
    btn.classList.remove('success');
    btn.innerHTML = originalHTML;
  }

  // Copy base64 image bytes to clipboard
  function copyBase64ImageToClipboard(base64Data, callback) {
    const img = new Image();
    img.src = base64Data;
    
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        canvas.toBlob((blob) => {
          if (!blob) {
            callback(false, 'Canvas toBlob conversion failed');
            return;
          }

          const item = new ClipboardItem({ 'image/png': blob });
          navigator.clipboard.write([item]).then(() => {
            callback(true);
          }).catch(err => {
            console.error('Clipboard write error:', err);
            callback(false, 'Permission denied or browser focus lost');
          });
        }, 'image/png');
      } catch (e) {
        console.error('Canvas processing error:', e);
        callback(false, e.message);
      }
    };

    img.onerror = (err) => {
      console.error('Image element loading error:', err);
      callback(false, 'Failed to load image in content context');
    };
  }

  // Handle Download All Stories action
  async function handleDownloadAllStories() {
    const downloadAllBtn = document.getElementById('ig-helper-download-all');
    if (downloadAllBtn.classList.contains('loading')) return;

    const originalHTML = downloadAllBtn.innerHTML;
    downloadAllBtn.classList.add('loading');
    downloadAllBtn.innerHTML = `${ICONS.spinner} <span>Resolving...</span>`;
    showToast('Resolving stories list...', 'info');

    try {
      const urlMatch = window.location.href.match(/stories\/([^\/]+)\/([^\/]+)?/);
      if (!urlMatch) throw new Error('Could not parse Story URL');
      
      const username = urlMatch[1];
      let storyId = urlMatch[2];
      let items = [];
      let reelsUser = null;

      if (username === 'highlights') {
        const highlightId = storyId;
        const reelsData = await fetchHighlightStories(highlightId);
        if (!reelsData || !reelsData.items) throw new Error('Highlight stories not found');
        items = reelsData.items;
        reelsUser = reelsData.user ? reelsData.user.username : 'instagram';
      } else {
        const user = await fetchUserProfileInfo(username);
        if (!user) throw new Error('Instagram profile not found');
        const reelsData = await fetchUserStories(user.id);
        if (!reelsData || !reelsData.items) throw new Error('User stories not found');
        items = reelsData.items;
        reelsUser = username;
      }

      if (items.length === 0) {
        throw new Error('No active stories found to download.');
      }

      downloadAllBtn.classList.remove('loading');
      downloadAllBtn.innerHTML = originalHTML;

      // Show custom popup modal to choose bulk download method
      showBulkDownloadModal(reelsUser, items.length, async (choice) => {
        if (choice === 'ZIP') {
          await downloadStoriesAsZip(reelsUser, items);
        } else if (choice === 'INDIVIDUAL') {
          showMediaSelectionModal(reelsUser, items, async (selectedItems) => {
            await downloadStoriesIndividually(reelsUser, selectedItems);
          });
        }
      });

    } catch (e) {
      console.error('Bulk download resolve failed:', e);
      showToast('Error: ' + e.message, 'error');
      downloadAllBtn.classList.remove('loading');
      downloadAllBtn.innerHTML = originalHTML;
    }
  }

  // Display options overlay modal
  function showBulkDownloadModal(username, count, onChoice) {
    let overlay = document.getElementById('ig-helper-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ig-helper-modal-overlay';
      overlay.className = 'ig-helper-modal-overlay';
      document.body.appendChild(overlay);
    }
    if (currentTheme === 'dark') {
      overlay.classList.add('dark');
    } else {
      overlay.classList.remove('dark');
    }

    overlay.innerHTML = `
      <div class="ig-helper-modal">
        <div class="ig-helper-modal-title">Download All Stories</div>
        <div class="ig-helper-modal-desc">
          Found <strong>${count}</strong> active stories for <strong>@${username}</strong>.<br>Select your download method:
        </div>
        <div class="ig-helper-modal-options">
          <button id="ig-helper-modal-zip" class="ig-helper-modal-btn ig-helper-modal-btn-zip">
            Download ZIP Archive
          </button>
          <button id="ig-helper-modal-individual" class="ig-helper-modal-btn">
            Individual Files
          </button>
          <button id="ig-helper-modal-cancel" class="ig-helper-modal-btn-cancel">
            Cancel
          </button>
        </div>
      </div>
    `;

    overlay.classList.add('show');

    // Button click handlers
    document.getElementById('ig-helper-modal-zip').onclick = () => {
      overlay.classList.remove('show');
      onChoice('ZIP');
    };
    document.getElementById('ig-helper-modal-individual').onclick = () => {
      overlay.classList.remove('show');
      onChoice('INDIVIDUAL');
    };
    document.getElementById('ig-helper-modal-cancel').onclick = () => {
      overlay.classList.remove('show');
    };
  }

  // Display media selection modal before downloading individual stories
  async function showMediaSelectionModal(username, items, onConfirm) {
    let overlay = document.getElementById('efha-media-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'efha-media-modal-overlay';
      overlay.className = 'efha-media-modal-overlay';
      document.body.appendChild(overlay);
    }

    if (currentTheme === 'dark') {
      overlay.classList.add('dark');
    } else {
      overlay.classList.remove('dark');
    }

    // Check duplicate download history to badge already downloaded items
    const downloadHistory = (typeof getDownloadHistory === 'function') ? await getDownloadHistory() : {};

    // Prepare items data (default all selected)
    const selectedIndices = new Set(items.map((_, idx) => idx));
    let currentFilter = 'all'; // 'all', 'photo', 'video'

    const totalCount = items.length;
    const photoCount = items.filter(it => it.media_type !== 2 && !it.is_video).length;
    const videoCount = items.filter(it => it.media_type === 2 || it.is_video).length;

    function renderModalContent() {
      const selectedCount = selectedIndices.size;
      
      overlay.innerHTML = `
        <div class="efha-media-modal">
          <div class="efha-media-modal-header">
            <div class="efha-media-modal-header-title">
              <h3>Pilih Foto / Media untuk Disimpan</h3>
              <span>@${username} &bull; ${totalCount} media ditemukan</span>
            </div>
            <button id="efha-media-modal-close" class="efha-media-modal-close-btn" title="Tutup">&times;</button>
          </div>

          <div class="efha-media-modal-toolbar">
            <div class="efha-media-modal-toolbar-actions">
              <button id="efha-btn-select-all" class="efha-toolbar-btn">Pilih Semua</button>
              <button id="efha-btn-deselect-all" class="efha-toolbar-btn">Batalkan Semua</button>
              <div class="efha-toolbar-filter-group">
                <button class="efha-filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">Semua (${totalCount})</button>
                <button class="efha-filter-btn ${currentFilter === 'photo' ? 'active' : ''}" data-filter="photo">Foto (${photoCount})</button>
                <button class="efha-filter-btn ${currentFilter === 'video' ? 'active' : ''}" data-filter="video">Video (${videoCount})</button>
              </div>
            </div>
            <div style="font-size: 12px; font-weight: 500; color: var(--foreground);">
              Dipilih: <span id="efha-counter-badge" style="color: #2ed573; font-weight: 700;">${selectedCount}</span> / ${totalCount}
            </div>
          </div>

          <div class="efha-media-grid" id="efha-media-items-grid">
            ${items.map((item, idx) => {
              const isVideo = item.media_type === 2 || item.is_video;
              const isDownloaded = item.pk && downloadHistory[item.pk];
              const isSelected = selectedIndices.has(idx);
              const isHidden = (currentFilter === 'photo' && isVideo) || (currentFilter === 'video' && !isVideo);
              
              // Find thumbnail URL
              let thumbUrl = '';
              if (item.image_versions2 && item.image_versions2.candidates && item.image_versions2.candidates.length > 0) {
                const candidates = item.image_versions2.candidates;
                const sorted = [...candidates].sort((a, b) => a.width - b.width);
                const suitable = sorted.find(c => c.width >= 240) || sorted[sorted.length - 1];
                thumbUrl = suitable.url;
              } else {
                thumbUrl = getHighestResolutionUrl(item) || '';
              }

              // Format date/time
              let timeText = '';
              if (item.taken_at) {
                const date = new Date(item.taken_at * 1000);
                const hours = String(date.getHours()).padStart(2, '0');
                const mins = String(date.getMinutes()).padStart(2, '0');
                timeText = `${hours}:${mins}`;
              }

              return `
                <div class="efha-media-card ${isSelected ? 'selected' : ''}" data-idx="${idx}" style="${isHidden ? 'display: none;' : ''}">
                  <div class="efha-media-card-type-badge">
                    ${isVideo 
                      ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> <span>Video</span>' 
                      : '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg> <span>Foto</span>'
                    }
                  </div>
                  <div class="efha-media-card-check">
                    <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  </div>
                  <img src="${thumbUrl}" alt="Story #${idx + 1}" loading="lazy" />
                  ${isDownloaded ? '<div class="efha-media-card-downloaded-badge">Tersimpan</div>' : ''}
                  <div class="efha-media-card-info">
                    <span style="font-weight: 600;">#${idx + 1}</span>
                    <span>${timeText}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          <div class="efha-media-modal-footer">
            <div class="efha-media-modal-status-text">
              Hanya media yang dicentang yang akan disimpan ke komputer.
            </div>
            <div class="efha-media-modal-footer-actions">
              <button id="efha-media-btn-cancel" class="efha-media-btn-cancel">Batal</button>
              <button id="efha-media-btn-save" class="efha-media-btn-save" ${selectedCount === 0 ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                <span>Simpan (${selectedCount} File)</span>
              </button>
            </div>
          </div>
        </div>
      `;

      attachEventListeners();
    }

    function updateCardState(idx) {
      const card = overlay.querySelector(`.efha-media-card[data-idx="${idx}"]`);
      if (card) {
        if (selectedIndices.has(idx)) {
          card.classList.add('selected');
        } else {
          card.classList.remove('selected');
        }
      }
      updateCounters();
    }

    function updateCounters() {
      const selectedCount = selectedIndices.size;
      const counterBadge = document.getElementById('efha-counter-badge');
      if (counterBadge) counterBadge.innerText = selectedCount;

      const saveBtn = document.getElementById('efha-media-btn-save');
      if (saveBtn) {
        saveBtn.disabled = selectedCount === 0;
        const textSpan = saveBtn.querySelector('span');
        if (textSpan) textSpan.innerText = `Simpan (${selectedCount} File)`;
      }
    }

    function attachEventListeners() {
      // Close button
      const closeBtn = document.getElementById('efha-media-modal-close');
      if (closeBtn) {
        closeBtn.onclick = () => overlay.classList.remove('show');
      }

      // Cancel button
      const cancelBtn = document.getElementById('efha-media-btn-cancel');
      if (cancelBtn) {
        cancelBtn.onclick = () => overlay.classList.remove('show');
      }

      // Close on backdrop click
      overlay.onclick = (e) => {
        if (e.target === overlay) {
          overlay.classList.remove('show');
        }
      };

      // Card click handlers
      const cards = overlay.querySelectorAll('.efha-media-card');
      cards.forEach(card => {
        card.onclick = () => {
          const idx = parseInt(card.getAttribute('data-idx'), 10);
          if (selectedIndices.has(idx)) {
            selectedIndices.delete(idx);
          } else {
            selectedIndices.add(idx);
          }
          updateCardState(idx);
        };
      });

      // Select All
      const selectAllBtn = document.getElementById('efha-btn-select-all');
      if (selectAllBtn) {
        selectAllBtn.onclick = () => {
          items.forEach((item, idx) => {
            const isVideo = item.media_type === 2 || item.is_video;
            const isVisible = !( (currentFilter === 'photo' && isVideo) || (currentFilter === 'video' && !isVideo) );
            if (isVisible) {
              selectedIndices.add(idx);
            }
          });
          items.forEach((_, idx) => updateCardState(idx));
        };
      }

      // Deselect All
      const deselectAllBtn = document.getElementById('efha-btn-deselect-all');
      if (deselectAllBtn) {
        deselectAllBtn.onclick = () => {
          items.forEach((item, idx) => {
            const isVideo = item.media_type === 2 || item.is_video;
            const isVisible = !( (currentFilter === 'photo' && isVideo) || (currentFilter === 'video' && !isVideo) );
            if (isVisible) {
              selectedIndices.delete(idx);
            }
          });
          items.forEach((_, idx) => updateCardState(idx));
        };
      }

      // Filter tabs
      const filterBtns = overlay.querySelectorAll('.efha-filter-btn');
      filterBtns.forEach(btn => {
        btn.onclick = () => {
          currentFilter = btn.getAttribute('data-filter');
          filterBtns.forEach(b => b.classList.toggle('active', b === btn));
          cards.forEach(card => {
            const idx = parseInt(card.getAttribute('data-idx'), 10);
            const item = items[idx];
            const isVideo = item.media_type === 2 || item.is_video;
            const isHidden = (currentFilter === 'photo' && isVideo) || (currentFilter === 'video' && !isVideo);
            card.style.display = isHidden ? 'none' : '';
          });
        };
      });

      // Save button
      const saveBtn = document.getElementById('efha-media-btn-save');
      if (saveBtn) {
        saveBtn.onclick = () => {
          if (selectedIndices.size === 0) return;
          const selectedItems = items.filter((_, idx) => selectedIndices.has(idx));
          overlay.classList.remove('show');
          onConfirm(selectedItems);
        };
      }
    }

    renderModalContent();
    overlay.classList.add('show');
  }

  // Helper to fetch media blob directly or fallback to background base64 fetch
  async function fetchMediaBlob(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      return await res.blob();
    } catch (err) {
      console.warn(`Direct fetch failed, falling back to background worker for ${url}:`, err);
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'FETCH_BASE64',
          url: url
        }, resolve);
      });
      if (response && response.success && response.base64) {
        const res = await fetch(response.base64);
        return await res.blob();
      }
      throw new Error(response ? response.error : 'Unknown error during background fetch');
    }
  }

  // Wrapper with retry logic for fetching media blobs
  async function fetchMediaWithRetry(url, maxRetries = 3, retryDelayMs = 1000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const blob = await fetchMediaBlob(url);
        return blob;
      } catch (err) {
        console.error(`Attempt ${attempt} failed to fetch media for ${url}:`, err);
        if (attempt === maxRetries) throw err;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  // Download stories as a ZIP archive
  async function downloadStoriesAsZip(username, items) {
    // Check duplicates
    const downloadHistory = await getDownloadHistory();
    let duplicatesCount = 0;
    for (let i = 0; i < items.length; i++) {
      if (downloadHistory[items[i].pk]) {
        duplicatesCount++;
      }
    }

    if (duplicatesCount > 0) {
      const proceed = confirm(`Terdapat ${duplicatesCount} story yang sudah pernah diunduh. Apakah Anda ingin mengunduhnya kembali ke ZIP?`);
      if (!proceed) return;
    }

    const downloadAllBtn = document.getElementById('ig-helper-download-all');
    let originalHTML = '';
    if (downloadAllBtn) {
      originalHTML = downloadAllBtn.innerHTML;
      downloadAllBtn.classList.add('loading');
      downloadAllBtn.innerHTML = `${ICONS.spinner} <span>ZIP (0%)</span>`;
    }

    try {
      showToast('Downloading stories data to package ZIP...', 'info');
      const zipFiles = [];
      let successCount = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const url = getHighestResolutionUrl(item);
        if (!url) continue;

        const percent = Math.round((i / items.length) * 100);
        if (downloadAllBtn) {
          downloadAllBtn.innerHTML = `${ICONS.spinner} <span>ZIP (${percent}%)</span>`;
        }
        showToast(`Fetching story ${i + 1}/${items.length} (${percent}%)...`, 'info');

        try {
          const blob = await fetchMediaWithRetry(url);

          if (blob) {
            const takenAt = item.taken_at ? new Date(item.taken_at * 1000) : new Date();
            const day = String(takenAt.getDate()).padStart(2, '0');
            const month = String(takenAt.getMonth() + 1).padStart(2, '0');
            const year = takenAt.getFullYear();
            const hours = String(takenAt.getHours()).padStart(2, '0');
            const minutes = String(takenAt.getMinutes()).padStart(2, '0');
            const seconds = String(takenAt.getSeconds()).padStart(2, '0');
            const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

            const dateStr = `${day} ${month} ${year}`;
            const timeStr = `${hours} ${minutes} ${seconds} ${milliseconds}`;
            const isVideo = item.media_type === 2;
            const ext = isVideo ? 'mp4' : 'jpg';

            const title = `${username}_${dateStr}_${timeStr}.${ext}`;
            
            zipFiles.push({
              title: title,
              data: blob,
              pk: item.pk
            });
            successCount++;
          }
        } catch (err) {
          console.error(`Failed to fetch story item ${i}:`, err);
          showToast(`Gagal mengunduh story ke-${i + 1}, dilewati.`, 'warning');
        }

        // Throttle delay to prevent rate limits and browser queue choke
        await new Promise(r => setTimeout(r, 200));
      }

      if (zipFiles.length === 0) {
        showToast('Failed to fetch any story media.', 'error');
        return;
      }

      if (downloadAllBtn) {
        downloadAllBtn.innerHTML = `${ICONS.spinner} <span>ZIP (95%)</span>`;
      }
      showToast('Packaging ZIP file (95%)...', 'info');

      try {
        const zipBlob = await createZip(zipFiles);
        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        
        const zipFilename = `${username}_stories_${day} ${month} ${year}.zip`;
        const zipUrl = URL.createObjectURL(zipBlob);

        executeDownload(zipUrl, zipFilename, (response) => {
          if (response && response.success) {
            showToast(`ZIP saved with ${successCount} stories!`, 'success');
            zipFiles.forEach(zf => {
              if (zf.pk) markMediaAsDownloaded(zf.pk);
            });
          } else {
            showToast('ZIP download failed.', 'error');
          }
        }, username);
      } catch (e) {
        console.error('ZIP creation failed:', e);
        showToast('ZIP creation failed: ' + e.message, 'error');
      }
    } finally {
      if (downloadAllBtn) {
        downloadAllBtn.classList.remove('loading');
        downloadAllBtn.innerHTML = originalHTML;
      }
    }
  }

  // Download stories individually
  async function downloadStoriesIndividually(username, items) {
    // Check duplicates
    const downloadHistory = await getDownloadHistory();
    let duplicatesCount = 0;
    for (let i = 0; i < items.length; i++) {
      if (downloadHistory[items[i].pk]) {
        duplicatesCount++;
      }
    }

    if (duplicatesCount > 0) {
      const proceed = confirm(`Terdapat ${duplicatesCount} story yang sudah pernah diunduh. Apakah Anda ingin mengunduhnya kembali?`);
      if (!proceed) return;
    }

    showToast(`Downloading ${items.length} stories...`, 'info');
    let triggerCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const url = getHighestResolutionUrl(item);
      if (!url) continue;

      const takenAt = item.taken_at ? new Date(item.taken_at * 1000) : new Date();
      const day = String(takenAt.getDate()).padStart(2, '0');
      const month = String(takenAt.getMonth() + 1).padStart(2, '0');
      const year = takenAt.getFullYear();
      const hours = String(takenAt.getHours()).padStart(2, '0');
      const minutes = String(takenAt.getMinutes()).padStart(2, '0');
      const seconds = String(takenAt.getSeconds()).padStart(2, '0');
      const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

      const dateStr = `${day} ${month} ${year}`;
      const timeStr = `${hours} ${minutes} ${seconds} ${milliseconds}`;
      const isVideo = item.media_type === 2;
      const ext = isVideo ? 'mp4' : 'jpg';

      const filename = `${username}_${dateStr}_${timeStr}.${ext}`;

      // Trigger download
      const storyKey = item.pk;
      executeDownload(url, filename, (response) => {
        if (response && response.success) {
          markMediaAsDownloaded(storyKey);
        }
      }, username);
      triggerCount++;
      
      // Delay slightly to prevent browser queue choke
      await new Promise(r => setTimeout(r, 150));
    }

    showToast(`Started downloading ${triggerCount} stories!`, 'success');
  }

  // Store-only Client ZIP Generator
  function calculateCRC32(data) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function createLocalFileHeader(fileName, fileSize, crc32) {
    const fileNameBytes = new TextEncoder().encode(fileName);
    const header = new Uint8Array(30 + fileNameBytes.length);
    header.set([0x50, 0x4b, 0x03, 0x04], 0);
    header.set([0x14, 0x00], 4);
    header.set([0x00, 0x00], 6);
    header.set([0x00, 0x00], 8);
    header.set([0x00, 0x00, 0x00, 0x00], 10);
    header.set(new Uint8Array(new Uint32Array([crc32]).buffer), 14);
    header.set(new Uint8Array(new Uint32Array([fileSize]).buffer), 18);
    header.set(new Uint8Array(new Uint32Array([fileSize]).buffer), 22);
    header.set(new Uint8Array(new Uint16Array([fileNameBytes.length]).buffer), 26);
    header.set([0x00, 0x00], 28);
    header.set(fileNameBytes, 30);
    return header;
  }

  function createCentralDirectoryHeader(fileName, fileSize, crc32, offset) {
    const fileNameBytes = new TextEncoder().encode(fileName);
    const header = new Uint8Array(46 + fileNameBytes.length);
    header.set([0x50, 0x4b, 0x01, 0x02], 0);
    header.set([0x14, 0x00], 4);
    header.set([0x14, 0x00], 6);
    header.set([0x00, 0x00], 8);
    header.set([0x00, 0x00], 10);
    header.set([0x00, 0x00, 0x00, 0x00], 12);
    header.set(new Uint8Array(new Uint32Array([crc32]).buffer), 16);
    header.set(new Uint8Array(new Uint32Array([fileSize]).buffer), 20);
    header.set(new Uint8Array(new Uint32Array([fileSize]).buffer), 24);
    header.set(new Uint8Array(new Uint16Array([fileNameBytes.length]).buffer), 28);
    header.set([0x00, 0x00], 30);
    header.set([0x00, 0x00], 32);
    header.set([0x00, 0x00], 34);
    header.set([0x00, 0x00], 36);
    header.set([0x00, 0x00, 0x00, 0x00], 38);
    header.set(new Uint8Array(new Uint32Array([offset]).buffer), 42);
    header.set(fileNameBytes, 46);
    return header;
  }

  function createEndOfCentralDirectoryRecord(numFiles, centralDirSize, centralDirOffset) {
    const record = new Uint8Array(22);
    record.set([0x50, 0x4b, 0x05, 0x06], 0);
    record.set([0x00, 0x00], 4);
    record.set([0x00, 0x00], 6);
    record.set(new Uint8Array(new Uint16Array([numFiles]).buffer), 8);
    record.set(new Uint8Array(new Uint16Array([numFiles]).buffer), 10);
    record.set(new Uint8Array(new Uint32Array([centralDirSize]).buffer), 12);
    record.set(new Uint8Array(new Uint32Array([centralDirOffset]).buffer), 16);
    record.set([0x00, 0x00], 20);
    return record;
  }

  async function createZip(files) {
    const chunks = [];
    const centralDirectory = [];
    let offset = 0;
    for (const file of files) {
      const arrayBuffer = await file.data.arrayBuffer();
      const content = new Uint8Array(arrayBuffer);
      const crc32 = calculateCRC32(content);
      const header = createLocalFileHeader(file.title, content.length, crc32);
      chunks.push(header);
      chunks.push(content);
      centralDirectory.push(createCentralDirectoryHeader(file.title, content.length, crc32, offset));
      offset += header.length + content.length;
    }
    const centralDirOffset = offset;
    for (const dir of centralDirectory) {
      chunks.push(dir);
      offset += dir.length;
    }
    const endRecord = createEndOfCentralDirectoryRecord(files.length, offset - centralDirOffset, centralDirOffset);
    chunks.push(endRecord);
    return new Blob(chunks);
  }

  // Toast Notification System
  function showToast(message, type = 'info') {
    if (!toastElement) {
      toastElement = document.createElement('div');
      toastElement.className = 'ig-helper-toast';
      document.body.appendChild(toastElement);
    }
    if (currentTheme === 'dark') {
      toastElement.classList.add('dark');
    } else {
      toastElement.classList.remove('dark');
    }

    let typeIcon = '';
    if (type === 'success') {
      typeIcon = ICONS.success;
      toastElement.style.color = '#2ed573';
    } else if (type === 'error') {
      typeIcon = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
      toastElement.style.color = '#ff4757';
    } else if (type === 'info') {
      typeIcon = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`;
      toastElement.style.color = '#ffffff';
    } else if (type === 'warning') {
      typeIcon = `<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;
      toastElement.style.color = '#ffa502';
    }

    toastElement.innerHTML = `${typeIcon} <span>${message}</span>`;
    toastElement.classList.add('show');

    if (toastElement.timeoutId) clearTimeout(toastElement.timeoutId);
    toastElement.timeoutId = setTimeout(() => {
      toastElement.classList.remove('show');
    }, 2500);
  }

  // Load and cache follower lists from storage for fast mutual checking
  function loadFriendshipData() {
    chrome.storage.local.get(['followers_list', 'following_list', 'profile_friendship_cache', 'logged_in_username', 'theme', 'enable_mutual_badges'], (data) => {
      if (data.theme) {
        currentTheme = data.theme;
        applyThemeToContent(currentTheme);
      }
      if (data.logged_in_username) {
        loggedInUsername = data.logged_in_username.toLowerCase();
      }
      if (data.followers_list) {
        followersSet = new Set(data.followers_list.map(u => u.username.toLowerCase()));
      }
      if (data.following_list) {
        followingSet = new Set(data.following_list.map(u => u.username.toLowerCase()));
      }
      if (data.profile_friendship_cache) {
        friendshipCache = data.profile_friendship_cache;
      }
      if (data.enable_mutual_badges !== undefined) {
        enableMutualBadges = data.enable_mutual_badges;
      }
      isFriendshipDataLoaded = true;
    });

    // Listen for storage changes if data is re-scanned in popup
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.logged_in_username) {
          loggedInUsername = changes.logged_in_username.newValue.toLowerCase();
        }
        if (changes.followers_list) {
          followersSet = new Set(changes.followers_list.newValue.map(u => u.username.toLowerCase()));
        }
        if (changes.following_list) {
          followingSet = new Set(changes.following_list.newValue.map(u => u.username.toLowerCase()));
        }
        if (changes.profile_friendship_cache) {
          friendshipCache = changes.profile_friendship_cache.newValue;
        }

        if (changes.download_subfolder) {
          const inputFolder = document.querySelector('#drawer-input-folder-path');
          if (inputFolder) {
            inputFolder.value = changes.download_subfolder.newValue || '';
          }
          const panelFolder = document.querySelector('#ig-helper-dir-input');
          if (panelFolder) {
            panelFolder.value = changes.download_subfolder.newValue || '';
          }
        }
        if (changes.download_custom_folder_name) {
          const newName = changes.download_custom_folder_name.newValue;
          if (!newName) {
            clearDirHandle();
          }
          const floatDirName = document.getElementById('ig-helper-picked-dir-name');
          const floatClearBtn = document.getElementById('ig-helper-btn-clear-custom-dir');
          if (floatDirName && floatClearBtn) {
            if (newName) {
              floatDirName.innerText = newName;
              floatDirName.title = `Folder: ${newName}`;
              floatClearBtn.style.display = 'block';
            } else {
              floatDirName.innerText = 'Pilih Folder...';
              floatDirName.title = '';
              floatClearBtn.style.display = 'none';
            }
          }
          const drawerDirName = document.getElementById('drawer-picked-dir-name');
          const drawerClearBtn = document.getElementById('drawer-btn-clear-custom-dir');
          if (drawerDirName && drawerClearBtn) {
            if (newName) {
              drawerDirName.innerText = newName;
              drawerDirName.title = `Folder: ${newName}`;
              drawerClearBtn.style.display = 'block';
            } else {
              drawerDirName.innerText = 'Pilih Folder...';
              drawerDirName.title = '';
              drawerClearBtn.style.display = 'none';
            }
          }
        }
        if (changes.download_recap) {
          const container = document.getElementById('drawer-recap-list-container');
          if (container) {
            renderRecapList(changes.download_recap.newValue, container);
          }
        }
        if (changes.theme) {
          currentTheme = changes.theme.newValue;
          applyThemeToContent(currentTheme);
        }
        if (changes.enable_mutual_badges) {
          enableMutualBadges = changes.enable_mutual_badges.newValue;
          const drawerChk = document.getElementById('drawer-chk-enable-mutual-badges');
          if (drawerChk) {
            drawerChk.checked = enableMutualBadges;
          }
          if (!enableMutualBadges) {
            removeMutualBadgesFromPage();
          }
        }
      }
    });
  }



  function trackApiCall() {
    const now = Date.now();
    apiCallTimestamps.push(now);
    // Keep only last 5 minutes
    apiCallTimestamps = apiCallTimestamps.filter(t => now - t < 5 * 60 * 1000);
  }

  function getUsageLevel() {
    const now = Date.now();
    const recentCalls = apiCallTimestamps.filter(t => now - t < 5 * 60 * 1000).length;
    if (recentCalls <= 10) return { level: 'normal', label: 'Normal', color: '#22c55e', icon: '✅' };
    if (recentCalls <= 25) return { level: 'moderate', label: 'Sedang', color: '#f59e0b', icon: '⚡' };
    return { level: 'heavy', label: 'Terlalu Sering', color: '#ef4444', icon: '🔥' };
  }

    function removeMutualBadgesFromPage() {
    const storyBadge = document.getElementById('ig-helper-story-mutual-badge');
    if (storyBadge) storyBadge.remove();
    
    const profileBadge = document.getElementById('ig-helper-friendship-badge');
    if (profileBadge) profileBadge.remove();
    
    const feedBadges = document.querySelectorAll('.ig-helper-feed-mutual-badge');
    feedBadges.forEach(b => b.remove());
    
    const panelMutualStatus = document.getElementById('ig-helper-panel-mutual-status');
    if (panelMutualStatus) panelMutualStatus.style.display = 'none';
  }

  function checkResponseStatus(response, context) {
    if (!response) return;
    const status = response.status !== undefined ? response.status : response;
    if (status === 429) {
      console.warn(`Instagram API rate limit/block detected (status ${status}). Context: ${context || 'general'}`);
    }
  }

  // Check relationship status for a specific user safely
  async function checkMutualStatus(username) {
    const lowerUsername = username.toLowerCase();

    // 1. Don't badge self
    if (loggedInUsername && lowerUsername === loggedInUsername) {
      return null;
    }

    // 2. If friendship list is fully synced/loaded, check directly (instant, no rate-limiting)
    if (isFriendshipDataLoaded && followersSet.size > 0) {
      return followersSet.has(lowerUsername);
    }

    // 3. Fallback to profile friendship cache
    if (friendshipCache[username] !== undefined) {
      if (friendshipCache[username] === 'error') {
        return null;
      }
      return friendshipCache[username];
    }

    // 4. API fetch fallback (only when synced data is not available, rate limited)
    if (!checkMutualStatus.apiCallsThisMinute) {
      checkMutualStatus.apiCallsThisMinute = 0;
      checkMutualStatus.resetTime = Date.now() + 60000;
    }
    if (Date.now() > checkMutualStatus.resetTime) {
      checkMutualStatus.apiCallsThisMinute = 0;
      checkMutualStatus.resetTime = Date.now() + 60000;
    }
    if (checkMutualStatus.apiCallsThisMinute >= 5) {
      console.warn('API lookup rate limit reached for mutual check on feed. Skipping to prevent 429.');
      return null;
    }

    try {
      checkMutualStatus.apiCallsThisMinute++;
      const profile = await fetchUserProfileInfo(username);
      const friendship = await fetchFriendshipInfo(profile.id);
      const followedBy = friendship.followed_by === true;

      // Update local cache
      friendshipCache[username] = followedBy;
      chrome.storage.local.get({ profile_friendship_cache: {} }, (data) => {
        const cache = data.profile_friendship_cache;
        cache[username] = followedBy;
        chrome.storage.local.set({ profile_friendship_cache: cache });
      });

      return followedBy;
    } catch (e) {
      console.error(`Failed to fetch friendship status for ${username}:`, e);
      
      // Cache the error state to avoid spamming API calls
      friendshipCache[username] = 'error';
      chrome.storage.local.get({ profile_friendship_cache: {} }, (data) => {
        const cache = data.profile_friendship_cache;
        cache[username] = 'error';
        chrome.storage.local.set({ profile_friendship_cache: cache });
      });

      return null;
    }
  }

  // Find active story header (supports normal stories and highlights)
  function findActiveStoryHeader() {
    const isStory = window.location.href.includes('/stories/');
    if (!isStory) return null;

    const urlMatch = window.location.href.match(/stories\/([^\/]+)\/([^\/]+)?/);
    if (!urlMatch) return null;

    const username = urlMatch[1];
    if (username && username !== 'highlights') {
      const headerLink = document.querySelector(`header a[href="/${username}/"]`);
      if (headerLink) return headerLink.closest('header');
    } else {
      const headers = document.querySelectorAll('header');
      for (const h of headers) {
        const rect = h.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const profileLink = h.querySelector('a[href^="/"]');
          if (profileLink) {
            const href = profileLink.getAttribute('href');
            const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
            if (match) {
              const reservedNames = ['p', 'tv', 'reel', 'reels', 'stories', 'direct', 'explore', 'accounts', 'emails', 'developer', 'about', 'press', 'api', 'privacy', 'terms', 'directory', 'topics', 'create', 'notifications', 'messages'];
              if (!reservedNames.includes(match[1])) {
                return h;
              }
            }
          }
        }
      }
    }
    return null;
  }

  // Inject story overlay download button
  function processStoryOverlayDownloader() {
    const header = findActiveStoryHeader();
    if (!header) return;

    if (header.querySelector('.ig-story-dl-btn')) {
      return;
    }

    const dlBtn = document.createElement('button');
    dlBtn.className = 'ig-story-dl-btn';
    dlBtn.title = 'Download story';
    dlBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;

    dlBtn.onclick = (e) => {
      e.stopPropagation();
      handleStoryOverlayDownload(dlBtn);
    };

    const buttons = Array.from(header.querySelectorAll('button, [role="button"]'));
    if (buttons.length > 0) {
      const lastBtn = buttons[buttons.length - 1];
      lastBtn.parentNode.insertBefore(dlBtn, lastBtn);
    } else {
      header.appendChild(dlBtn);
    }
  }

  // Handle overlay download
  async function handleStoryOverlayDownload(btn) {
    if (btn.classList.contains('loading')) return;

    btn.classList.add('loading');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<svg class="spinner" viewBox="0 0 50 50" style="animation: rotate 2s linear infinite; width: 18px; height: 18px;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" style="stroke-dasharray: 1, 150; stroke-dashoffset: 0; animation: dash 1.5s ease-in-out infinite;"></circle></svg>`;
    showToast('Resolving media quality...', 'info');

    try {
      const media = await resolveCurrentMedia();
      
      const downloadKey = getMediaDownloadKey(media);
      if (downloadKey) {
        const isDuplicate = await checkDuplicateDownload(downloadKey);
        if (isDuplicate) {
          const proceed = confirm("File ini sudah pernah diunduh. Apakah Anda ingin mengunduhnya lagi?");
          if (!proceed) {
            btn.classList.remove('loading');
            btn.innerHTML = originalHTML;
            return;
          }
        }
      }

      const takenAt = media.takenAt || new Date();
      const day = String(takenAt.getDate()).padStart(2, '0');
      const month = String(takenAt.getMonth() + 1).padStart(2, '0');
      const year = takenAt.getFullYear();
      const hours = String(takenAt.getHours()).padStart(2, '0');
      const minutes = String(takenAt.getMinutes()).padStart(2, '0');
      const seconds = String(takenAt.getSeconds()).padStart(2, '0');
      const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

      const dateStr = `${day} ${month} ${year}`;
      const timeStr = `${hours} ${minutes} ${seconds} ${milliseconds}`;

      const ext = media.type === 'video' ? 'mp4' : 'jpg';
      const filename = `${media.username}_${dateStr}_${timeStr}.${ext}`;

      showToast('Starting download...', 'info');

      executeDownload(media.url, filename, (response) => {
        btn.classList.remove('loading');
        btn.innerHTML = originalHTML;
        
        if (response && response.success) {
          showToast('Download started!', 'success');
          if (downloadKey) markMediaAsDownloaded(downloadKey);
        } else {
          showToast('Download failed: ' + (response ? response.error : 'Unknown error'), 'error');
        }
      }, media.username);

    } catch (e) {
      console.error('Download failed:', e);
      showToast('Error: ' + e.message, 'error');
      btn.classList.remove('loading');
      btn.innerHTML = originalHTML;
    }
  }

  // Inject mutual badges in Feed posts and Stories
  async function processMutualBadges() {
    if (!enableMutualBadges) return;
    // 1. Process Stories
    if (window.location.href.includes('/stories/')) {
      const urlMatch = window.location.href.match(/stories\/([^\/]+)\/([^\/]+)?/);
      if (urlMatch) {
        const username = urlMatch[1];
        if (username && username !== 'highlights') {
          // Find story header link for this username
          const storyHeaderLink = document.querySelector(`header a[href="/${username}/"]`);
          if (storyHeaderLink) {
            const existingBadge = document.getElementById('ig-helper-story-mutual-badge');
            if (existingBadge) {
              const badgeUsername = existingBadge.getAttribute('data-user');
              if (badgeUsername !== username) {
                existingBadge.remove();
              }
            }

            if (!document.getElementById('ig-helper-story-mutual-badge')) {
              const isMutual = await checkMutualStatus(username);
              injectStoryMutualBadge(storyHeaderLink, username, isMutual);
            }
          }
        }
      }
    }

    // 2. Process Feed Posts
    const articles = document.querySelectorAll('article');
    for (const article of articles) {
      // Find the username link in the post header
      const header = article.querySelector('header') || article;
      const usernameLinks = header.querySelectorAll('a[href^="/"]');
      let usernameLink = null;
      let username = '';

      for (const link of usernameLinks) {
        const href = link.getAttribute('href');
        const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
        if (match) {
          const u = match[1];
          const reservedNames = ['p', 'tv', 'reel', 'reels', 'stories', 'direct', 'explore', 'accounts', 'emails', 'developer', 'about', 'press', 'api', 'privacy', 'terms', 'directory', 'topics', 'create', 'notifications', 'messages'];
          if (!reservedNames.includes(u)) {
            usernameLink = link;
            username = u;
            break;
          }
        }
      }

      if (usernameLink && username) {
        const parent = usernameLink.parentNode;
        if (!parent.querySelector('.ig-helper-feed-mutual-badge')) {
          // Add a placeholder/processing span to prevent double-firing
          const placeholder = document.createElement('span');
          placeholder.className = 'ig-helper-feed-mutual-badge processing';
          placeholder.style.display = 'none'; // hidden while loading
          parent.insertBefore(placeholder, usernameLink.nextSibling);

          const isMutual = await checkMutualStatus(username);
          if (isMutual !== null) {
            updateFeedMutualBadge(placeholder, isMutual);
          } else {
            // Keep placeholder but style it as failed/hidden to prevent subsequent checks
            placeholder.className = 'ig-helper-feed-mutual-badge failed';
            placeholder.style.display = 'none';
          }
        }
      }
    }
  }

  // Inject a visual glassmorphism badge inside the active Story view header
  function injectStoryMutualBadge(anchorEl, username, followedBy) {
    if (document.getElementById('ig-helper-story-mutual-badge')) return;

    const badge = document.createElement('span');
    badge.id = 'ig-helper-story-mutual-badge';
    badge.setAttribute('data-user', username);
    badge.style.marginLeft = '8px';
    badge.style.padding = '2px 8px';
    badge.style.borderRadius = '12px';
    badge.style.fontSize = '10px';
    badge.style.fontWeight = 'bold';
    badge.style.display = 'inline-block';
    badge.style.verticalAlign = 'middle';
    badge.style.backdropFilter = 'blur(10px)';
    badge.style.webkitBackdropFilter = 'blur(10px)';
    badge.style.whiteSpace = 'nowrap';
    badge.style.fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

    if (followedBy === null) {
      badge.style.display = 'none';
      badge.classList.add('failed');
    } else if (followedBy) {
      badge.textContent = 'Follows You';
      badge.style.background = 'rgba(34, 197, 94, 0.15)';
      badge.style.color = '#22c55e';
      badge.style.border = '1px solid rgba(34, 197, 94, 0.25)';
    } else {
      badge.textContent = 'Does Not Follow You';
      badge.style.background = 'rgba(239, 68, 68, 0.15)';
      badge.style.color = '#ef4444';
      badge.style.border = '1px solid rgba(239, 68, 68, 0.25)';
    }

    anchorEl.parentNode.insertBefore(badge, anchorEl.nextSibling);
  }

  // Update/format the mutual status badge on timeline feed posts
  function updateFeedMutualBadge(badge, followedBy) {
    badge.classList.remove('processing');
    badge.style.marginLeft = '8px';
    badge.style.padding = '2px 8px';
    badge.style.borderRadius = '12px';
    badge.style.fontSize = '10px';
    badge.style.fontWeight = 'bold';
    badge.style.display = 'inline-block';
    badge.style.verticalAlign = 'middle';
    badge.style.whiteSpace = 'nowrap';
    badge.style.fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

    if (followedBy) {
      badge.textContent = 'Follows You';
      badge.style.background = 'rgba(34, 197, 94, 0.15)';
      badge.style.color = '#22c55e';
      badge.style.border = '1px solid rgba(34, 197, 94, 0.2)';
    } else {
      badge.textContent = 'Does Not Follow You';
      badge.style.background = 'rgba(239, 68, 68, 0.1)';
      badge.style.color = '#ef4444';
      badge.style.border = '1px solid rgba(239, 68, 68, 0.15)';
    }
  }

  // Get active username from viewport or url
  function getCurrentActiveUsername() {
    // 1. Check Stories
    if (window.location.href.includes('/stories/')) {
      const urlMatch = window.location.href.match(/stories\/([^\/]+)\/([^\/]+)?/);
      if (urlMatch && urlMatch[1] !== 'highlights') {
        return urlMatch[1];
      }
    }
    // 2. Check Profile page
    const usernameMatch = window.location.pathname.match(/^\/([A-Za-z0-9._]+)\/?$/);
    const reservedNames = ['p', 'tv', 'reel', 'reels', 'stories', 'direct', 'explore', 'accounts', 'emails', 'developer', 'about', 'press', 'api', 'privacy', 'terms', 'directory', 'topics', 'create', 'notifications', 'messages', 'highlights'];
    if (usernameMatch && !reservedNames.includes(usernameMatch[1])) {
      return usernameMatch[1];
    }
    // 3. Check Feed/Reel Post
    const articles = document.querySelectorAll('article');
    for (const article of articles) {
      const rect = article.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) {
        const usernameLinks = article.querySelectorAll('a[href^="/"]');
        for (const link of usernameLinks) {
          const href = link.getAttribute('href');
          const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
          if (match && !reservedNames.includes(match[1])) {
            return match[1];
          }
        }
      }
    }
    return null;
  }

  // Update floating panel status text
  async function updatePanelMutualStatus() {
    if (!enableMutualBadges) {
      const statusEl = document.getElementById('ig-helper-panel-mutual-status');
      if (statusEl) statusEl.style.display = 'none';
      return;
    }
    const statusEl = document.getElementById('ig-helper-panel-mutual-status');
    if (!statusEl) return;

    const username = getCurrentActiveUsername();
    if (!username) {
      statusEl.style.display = 'none';
      return;
    }

    if (statusEl.getAttribute('data-active-user') === username) {
      return;
    }
    statusEl.setAttribute('data-active-user', username);

    statusEl.style.display = 'none';

    const isMutual = await checkMutualStatus(username);
    if (isMutual !== null) {
      statusEl.className = 'ig-helper-mutual-status ' + (isMutual ? 'mutual-yes' : 'mutual-no');
      statusEl.textContent = isMutual ? 'Follows You' : 'Not Follow Back';
      statusEl.style.display = 'block';
    } else {
      // Keep data-active-user attribute but hide elements to prevent immediate retries
      statusEl.style.display = 'none';
    }
  }

  // Update bulk download tab post counts and buttons states
  function updateBulkTabStats() {
    const bulkTab = document.getElementById('drawer-tab-bulk');
    if (!bulkTab) return;
    
    // Check if the tab is currently active
    if (bulkTab.style.display === 'none' || !bulkTab.classList.contains('active')) return;

    const countText = document.getElementById('drawer-bulk-status-text');
    const infoText = document.getElementById('drawer-bulk-info-text');
    if (!countText || !infoText) return;

    const count = document.querySelectorAll('article').length;
    
    const zipBtn = document.getElementById('drawer-btn-bulk-zip');
    const indBtn = document.getElementById('drawer-btn-bulk-ind');

    if (count === 0) {
      countText.innerText = 'Tidak Ada Postingan';
      infoText.innerText = 'Buka Feed atau Halaman Profil dan gulir ke bawah.';
      if (zipBtn) {
        zipBtn.disabled = true;
        zipBtn.style.opacity = '0.5';
      }
      if (indBtn) {
        indBtn.disabled = true;
        indBtn.style.opacity = '0.5';
      }
    } else {
      countText.innerText = `Ditemukan ${count} Postingan`;
      infoText.innerText = 'Postingan siap untuk diunduh secara massal.';
      if (zipBtn) {
        zipBtn.disabled = false;
        zipBtn.style.opacity = '1';
      }
      if (indBtn) {
        indBtn.disabled = false;
        indBtn.style.opacity = '1';
      }
    }
  }

  // Trigger bulk post/reels downloading
  async function triggerBulkPostDownload(method) {
    const articles = Array.from(document.querySelectorAll('article'));
    if (articles.length === 0) return;

    const zipBtn = document.getElementById('drawer-btn-bulk-zip');
    const indBtn = document.getElementById('drawer-btn-bulk-ind');
    const statusText = document.getElementById('drawer-bulk-status-text');
    const infoText = document.getElementById('drawer-bulk-info-text');

    const originalZipText = zipBtn ? zipBtn.innerText : '';
    const originalIndText = indBtn ? indBtn.innerText : '';

    if (zipBtn) {
      zipBtn.disabled = true;
      zipBtn.style.opacity = '0.5';
    }
    if (indBtn) {
      indBtn.disabled = true;
      indBtn.style.opacity = '0.5';
    }

    try {
      if (statusText) statusText.innerText = 'Memeriksa duplikasi...';
      
      // Resolve all articles and check duplicates first
      const downloadHistory = await getDownloadHistory();
      let duplicatesCount = 0;
      const resolvedItems = [];

      for (let i = 0; i < articles.length; i++) {
        if (infoText) infoText.innerText = `Memeriksa postingan ${i + 1}/${articles.length}...`;
        const article = articles[i];
        try {
          const media = await resolveMediaForArticle(article);
          const downloadKey = getMediaDownloadKey(media);
          if (downloadKey && downloadHistory[downloadKey]) {
            duplicatesCount++;
          }
          resolvedItems.push({ media, downloadKey });
        } catch (err) {
          console.error(`Gagal memeriksa postingan ke-${i}:`, err);
        }
      }

      if (duplicatesCount > 0) {
        const proceed = confirm(`Terdapat ${duplicatesCount} postingan yang sudah pernah diunduh. Apakah Anda ingin mengunduhnya kembali?`);
        if (!proceed) {
          return;
        }
      }

      let successCount = 0;
      const downloadedUrls = new Set();
      const zipFiles = [];
      const targetUsername = getCurrentActiveUsername() || 'instagram';

      if (statusText) statusText.innerText = 'Memproses...';
      
      for (let i = 0; i < resolvedItems.length; i++) {
        const percent = Math.round((i / resolvedItems.length) * 100);
        if (infoText) infoText.innerText = `Mengunduh postingan ${i + 1}/${resolvedItems.length} (${percent}%)...`;
        if (zipBtn && method === 'ZIP') zipBtn.innerText = `Unduh (${percent}%)`;
        if (indBtn && method === 'INDIVIDUAL') indBtn.innerText = `Unduh (${percent}%)`;

        const { media, downloadKey } = resolvedItems[i];
        if (downloadedUrls.has(media.url)) continue; // skip duplicates
        downloadedUrls.add(media.url);

        try {
          const takenAt = media.takenAt || new Date();
          const day = String(takenAt.getDate()).padStart(2, '0');
          const month = String(takenAt.getMonth() + 1).padStart(2, '0');
          const year = takenAt.getFullYear();
          const hours = String(takenAt.getHours()).padStart(2, '0');
          const minutes = String(takenAt.getMinutes()).padStart(2, '0');
          const seconds = String(takenAt.getSeconds()).padStart(2, '0');
          const milliseconds = String(Math.floor(takenAt.getMilliseconds() / 10)).padStart(2, '0');

          const dateStr = `${day} ${month} ${year}`;
          const timeStr = `${hours} ${minutes} ${seconds} ${milliseconds}`;
          const ext = media.type === 'video' ? 'mp4' : 'jpg';
          const filename = `${media.username}_${dateStr}_${timeStr}.${ext}`;

          if (method === 'ZIP') {
            try {
              const blob = await fetchMediaWithRetry(media.url);
              if (blob) {
                zipFiles.push({
                  title: filename,
                  data: blob,
                  key: downloadKey
                });
                successCount++;
              }
            } catch (err) {
              console.error(`Gagal mengunduh media postingan ke-${i}:`, err);
              showToast(`Gagal mengunduh postingan ke-${i + 1}, dilewati.`, 'warning');
            }
            await new Promise(r => setTimeout(r, 200)); // prevent browser queue choke
          } else {
            executeDownload(media.url, filename, (response) => {
              if (response && response.success) {
                if (downloadKey) markMediaAsDownloaded(downloadKey);
              }
            }, media.username);
            successCount++;
            await new Promise(r => setTimeout(r, 200)); // prevent browser download choke
          }
        } catch (err) {
          console.error(`Gagal memproses postingan ke-${i}:`, err);
        }
      }

      if (method === 'ZIP' && zipFiles.length > 0) {
        if (zipBtn) zipBtn.innerText = 'Membuat ZIP (95%)';
        if (infoText) infoText.innerText = 'Membuat file ZIP (95%)...';
        try {
          const zipBlob = await createZip(zipFiles);
          const now = new Date();
          const day = String(now.getDate()).padStart(2, '0');
          const month = String(now.getMonth() + 1).padStart(2, '0');
          const year = now.getFullYear();
          const zipFilename = `${targetUsername}_posts_${day} ${month} ${year}.zip`;
          const zipUrl = URL.createObjectURL(zipBlob);

          executeDownload(zipUrl, zipFilename, (res) => {
            if (res && res.success) {
              showToast(`ZIP saved with ${successCount} files!`, 'success');
              zipFiles.forEach(zf => {
                if (zf.key) markMediaAsDownloaded(zf.key);
              });
            } else {
              showToast('ZIP download failed.', 'error');
            }
          }, targetUsername);
        } catch (zipErr) {
          console.error('ZIP creation failed:', zipErr);
          showToast('Gagal membuat ZIP: ' + zipErr.message, 'error');
        }
      } else if (method === 'INDIVIDUAL') {
        showToast(`Mengunduh ${successCount} postingan secara terpisah!`, 'success');
      }
    } finally {
      if (zipBtn) {
        zipBtn.disabled = false;
        zipBtn.style.opacity = '1';
        zipBtn.innerText = originalZipText;
      }
      if (indBtn) {
        indBtn.disabled = false;
        indBtn.style.opacity = '1';
        indBtn.innerText = originalIndText;
      }
      updateBulkTabStats();
    }
  }

  // Drawer Overlay variables and controller logic
  let drawerElement = null;
  let drawerFollowers = [];
  let drawerFollowing = [];
  let drawerUnfollowers = [];
  let drawerSelectedIds = new Set();
  let isDrawerSyncing = false;

  function injectDashboardDrawer() {
    if (document.getElementById('efha-dashboard-drawer')) return;

    drawerElement = document.createElement('div');
    drawerElement.id = 'efha-dashboard-drawer';
    if (currentTheme === 'dark') {
      drawerElement.classList.add('dark');
    }
    
    drawerElement.innerHTML = `
      <div class="drawer-container">
        <div class="header">
          <div class="brand">
            <h1>Efha</h1>
          </div>
          <div class="header-actions" style="display: flex; align-items: center; gap: 8px;">
            <button id="drawer-btn-toggle-theme" class="header-icon-btn" title="Ganti Tema (Light/Dark)">
              <svg id="drawer-theme-toggle-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>
            </button>
            <button id="drawer-btn-set-folder" class="header-icon-btn" title="Set Folder Penyimpanan">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
            </button>
            <button id="efha-drawer-close-btn" class="efha-drawer-close" title="Close Dashboard">&times;</button>
          </div>
        </div>

        <!-- Folder Settings Panel -->
        <div id="drawer-folder-settings-panel" class="folder-settings-panel" style="display: none;">
          <div class="panel-header">
            <span>Folder Tujuan Download</span>
            <button id="drawer-btn-close-folder-settings" class="close-btn">&times;</button>
          </div>
          <div class="panel-body">
            <p class="helper-text" style="margin-bottom: 6px;">Pilih folder penyimpanan kustom di komputer Anda (bisa di mana saja dan langsung download tanpa tanya lokasi):</p>
            <div style="display: flex; gap: 8px; margin-bottom: 12px; align-items: center;">
              <button id="drawer-btn-pick-dir" class="btn-primary" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12px; height: 36px; padding: 0 12px; font-weight: 600; cursor: pointer;">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                <span id="drawer-picked-dir-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px;">Pilih Folder...</span>
              </button>
              <button id="drawer-btn-clear-custom-dir" class="btn-secondary" style="display: none; background: var(--destructive); color: white; height: 36px; padding: 0 12px; border: none; font-weight: 600; cursor: pointer;">Hapus</button>
            </div>
            <p class="helper-text" style="border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px;">Atau simpan ke subfolder (di dalam folder Downloads bawaan Chrome):</p>
            <div class="input-group">
              <input type="text" id="drawer-input-folder-path" placeholder="Contoh: Efha_Instagram" />
              <button id="drawer-btn-save-folder" class="btn-save">Simpan</button>
            </div>
            <div id="drawer-folder-status-message" class="status-message"></div>
            
            <div style="border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px;">
              <p class="helper-text" style="font-weight: bold; color: var(--foreground); margin-bottom: 6px;">Keamanan Akun (Anti-Block):</p>
              <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer; color: var(--foreground);">
                <input type="checkbox" id="drawer-chk-enable-mutual-badges" style="cursor: pointer;" />
                <span>Aktifkan Badge Hubungan Mutual</span>
              </label>
              <p class="helper-text" style="margin-top: 4px; font-size: 9.5px; color: var(--muted-foreground); line-height: 1.3;">
                Nonaktifkan ini jika Anda sering terblokir sementara oleh Instagram untuk membatasi request API latar belakang.
              </p>
            </div>
          </div>
        </div>



        <!-- Tabs Nav Bar -->
        <div class="tabs-nav">
          <button class="tab-link active" data-tab="drawer-tab-tracker">Tracker</button>
          <button class="tab-link" data-tab="drawer-tab-engagement">Engagement</button>
          <button class="tab-link" data-tab="drawer-tab-recap">Rekap</button>
          <button class="tab-link" data-tab="drawer-tab-bulk">Bulk DL</button>
        </div>

        <!-- TAB 1: FOLLOW BACK TRACKER -->
        <div id="drawer-tab-tracker" class="tab-content active">
          <!-- Control buttons row -->
          <div class="sync-actions">
            <button id="drawer-btn-sync-api" class="btn-primary">Pindai Data Follower</button>
            <button id="drawer-btn-upload-json" class="btn-secondary">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
              </svg>
              Upload JSON
            </button>
            <input type="file" id="drawer-file-input" accept=".json" style="display: none;">
          </div>

          <!-- Syncing progress bar -->
          <div id="drawer-progress-container" class="progress-container">
            <div class="progress-header">
              <span id="drawer-progress-status">Menghubungi API...</span>
              <span id="drawer-progress-percent">0%</span>
            </div>
            <div class="progress-bar-bg">
              <div id="drawer-progress-bar-fill" class="progress-bar-fill"></div>
            </div>
          </div>

          <!-- Scanned stats cards -->
          <div class="stats-row">
            <div class="stat-card">
              <div id="drawer-cnt-followers" class="stat-val">-</div>
              <div class="stat-lbl">Followers</div>
            </div>
            <div class="stat-card">
              <div id="drawer-cnt-following" class="stat-val">-</div>
              <div class="stat-lbl">Following</div>
            </div>
            <div class="stat-card">
              <div id="drawer-cnt-unfollowers" class="stat-val red">-</div>
              <div class="stat-lbl">Non-Followback</div>
            </div>
          </div>

          <!-- Non-followers list content -->
          <div class="tracker-list-section">
            <div class="search-row">
              <input type="text" id="drawer-search-input" class="search-input" placeholder="Cari non-follower...">
            </div>
            
            <div class="bulk-action-bar">
              <label class="select-all-lbl">
                <input type="checkbox" id="drawer-chk-select-all">
                <span>Select All</span>
              </label>
              <span id="drawer-chk-count-text">0 Terpilih</span>
            </div>

            <div class="list-wrapper">
              <div id="drawer-unfollowers-list-container">
                <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 12px;">
                  Silakan lakukan pemindaian data follower Anda terlebih dahulu.
                </div>
              </div>
            </div>
          </div>

          <!-- Unfollow buttons actions -->
          <div id="drawer-unfollow-action-panel" class="unfollow-action-panel">
            <div id="drawer-unfollow-status" class="unfollow-status-text"></div>
            <button id="drawer-btn-batch-unfollow" class="btn-danger">Unfollow Masal Terpilih</button>
          </div>
        </div>

        <!-- TAB 2: ENGAGEMENT -->
        <div id="drawer-tab-engagement" class="tab-content">
          <div class="section-title">Tren Story Paling Sering Dilihat</div>
          <div style="font-size: 12px; color: var(--muted-foreground); margin-bottom: 12px; line-height: 1.4;">
            Berdasarkan histori story milik teman yang paling sering Anda tonton:
          </div>
          
          <div class="engagement-list">
            <div id="drawer-engagement-list-container">
              <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 12px;">
                Belum ada data story yang dilihat. Silakan mulai melihat story orang lain.
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 3: REKAP DOWNLOAD -->
        <div id="drawer-tab-recap" class="tab-content">
          <div class="sync-actions" style="margin-bottom: 12px; display: flex; gap: 8px;">
            <button id="drawer-recap-export-btn" class="btn-primary" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="fill: currentColor; flex-shrink: 0;"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>
              Export Excel
            </button>
            <button id="drawer-recap-clear-btn" class="btn-danger" style="flex: 1; cursor: pointer;">
              Hapus Rekap
            </button>
          </div>
          
          <div style="font-size: 12px; color: var(--muted-foreground); margin-bottom: 12px; line-height: 1.4;">
            Rekap jumlah file media yang berhasil Anda unduh per pengguna:
          </div>

          <div class="list-wrapper">
            <div id="drawer-recap-list-container">
              <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 12px;">
                Belum ada data unduhan. Silakan unduh foto/video terlebih dahulu.
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 4: BULK DOWNLOAD -->
        <div id="drawer-tab-bulk" class="tab-content">
          <div class="section-title">Bulk Download Posts & Reels</div>
          <div style="background: var(--secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; margin-bottom: 16px; text-align: center;">
            <div id="drawer-bulk-status-icon" style="font-size: 24px; margin-bottom: 8px;">📦</div>
            <div id="drawer-bulk-status-text" style="font-size: 13px; font-weight: 600; color: var(--foreground); margin-bottom: 4px;">Pindai Halaman...</div>
            <div id="drawer-bulk-info-text" style="font-size: 11px; color: var(--muted-foreground); margin-bottom: 12px;">Menghitung jumlah postingan di layar...</div>
            
            <div style="display: flex; gap: 8px; justify-content: center;">
              <button id="drawer-btn-bulk-zip" class="btn-primary" style="flex: 1; height: 36px; padding: 0 12px; font-size: 11px; cursor: pointer;">Simpan sebagai ZIP</button>
              <button id="drawer-btn-bulk-ind" class="btn-secondary" style="flex: 1; height: 36px; padding: 0 12px; font-size: 11px; cursor: pointer;">Simpan Terpisah</button>
            </div>
          </div>
          <p class="helper-text" style="line-height: 1.4; color: var(--muted-foreground); font-size: 11.5px; margin: 0;">
            <strong>Catatan:</strong> Fitur ini akan mengunduh semua foto/video dari postingan feed atau reels yang sedang tampil di layar Anda saat ini. Gulir halaman ke bawah untuk memuat lebih banyak postingan, lalu klik salah satu tombol di atas.
          </p>
        </div>
      </div>
    `;

    document.body.appendChild(drawerElement);
    
    const drawerThemeIcon = drawerElement.querySelector('#drawer-theme-toggle-icon');
    if (drawerThemeIcon) {
      drawerThemeIcon.innerHTML = currentTheme === 'dark' ? SUN_ICON : MOON_ICON;
    }
    
    bindDrawerListeners();
    loadDrawerDataFromStorage();

    // Load api_block_context from storage and start countdown
    chrome.storage.local.get({ api_block_context: 'general' }, (data) => {
      lastApiBlockContext = data.api_block_context || 'general';
      updateSafeModeCountdown();
    });

    // Trigger open animation
    setTimeout(() => {
      drawerElement.classList.add('open');
    }, 10);
  }

  function bindDrawerListeners() {
    const drawer = drawerElement;
    if (!drawer) return;

    drawer.querySelector('#efha-drawer-close-btn').onclick = () => {
      drawer.classList.remove('open');
    };

    const drawerToggleBtn = drawer.querySelector('#drawer-btn-toggle-theme');
    if (drawerToggleBtn) {
      drawerToggleBtn.onclick = () => {
        const isDark = drawer.classList.contains('dark');
        const newTheme = isDark ? 'light' : 'dark';
        chrome.storage.local.set({ theme: newTheme });
      };
    }

    const tabLinks = drawer.querySelectorAll('.tab-link');
    tabLinks.forEach(link => {
      link.onclick = () => {
        const targetTab = link.getAttribute('data-tab');
        tabLinks.forEach(l => l.classList.remove('active'));
        drawer.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        link.classList.add('active');
        drawer.querySelector('#' + targetTab).classList.add('active');
        
        if (targetTab === 'drawer-tab-engagement') {
          loadDrawerEngagementData();
        }
        if (targetTab === 'drawer-tab-recap') {
          chrome.storage.local.get({ download_recap: {} }, (data) => {
            const container = drawer.querySelector('#drawer-recap-list-container');
            renderRecapList(data.download_recap, container);
          });
        }
        if (targetTab === 'drawer-tab-bulk') {
          updateBulkTabStats();
        }
      };
    });

    const btnBulkZip = drawer.querySelector('#drawer-btn-bulk-zip');
    if (btnBulkZip) {
      btnBulkZip.onclick = () => triggerBulkPostDownload('ZIP');
    }

    const btnBulkInd = drawer.querySelector('#drawer-btn-bulk-ind');
    if (btnBulkInd) {
      btnBulkInd.onclick = () => triggerBulkPostDownload('INDIVIDUAL');
    }

    drawer.querySelector('#drawer-btn-sync-api').onclick = startDrawerApiSync;

    const uploadBtn = drawer.querySelector('#drawer-btn-upload-json');
    const fileInput = drawer.querySelector('#drawer-file-input');
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = handleDrawerJsonUpload;

    drawer.querySelector('#drawer-search-input').oninput = filterDrawerUnfollowersList;
    drawer.querySelector('#drawer-chk-select-all').onchange = toggleDrawerSelectAll;
    drawer.querySelector('#drawer-btn-batch-unfollow').onclick = triggerDrawerBatchUnfollow;

    // Download recap listeners inside drawer
    const exportRecapBtn = drawer.querySelector('#drawer-recap-export-btn');
    const clearRecapBtn = drawer.querySelector('#drawer-recap-clear-btn');

    if (exportRecapBtn) {
      exportRecapBtn.onclick = () => {
        chrome.storage.local.get({ download_recap: {}, followers_list: [], profile_friendship_cache: {} }, (data) => {
          exportRecapToXLS(data.download_recap, data.followers_list, data.profile_friendship_cache);
        });
      };
    }

    if (clearRecapBtn) {
      clearRecapBtn.onclick = () => {
        if (confirm('Apakah Anda yakin ingin menghapus semua rekap data unduhan?')) {
          chrome.storage.local.set({ download_recap: {} }, () => {
            showToast('Rekap unduhan berhasil dihapus.', 'success');
          });
        }
      };
    }

    // Folder settings listeners inside drawer
    const btnSetFolder = drawer.querySelector('#drawer-btn-set-folder');
    const folderPanel = drawer.querySelector('#drawer-folder-settings-panel');
    const btnCloseFolder = drawer.querySelector('#drawer-btn-close-folder-settings');
    const inputFolder = drawer.querySelector('#drawer-input-folder-path');
    const btnSaveFolder = drawer.querySelector('#drawer-btn-save-folder');
    const folderStatus = drawer.querySelector('#drawer-folder-status-message');

    const drawerPickBtn = drawer.querySelector('#drawer-btn-pick-dir');
    const drawerClearBtn = drawer.querySelector('#drawer-btn-clear-custom-dir');
    const drawerDirName = drawer.querySelector('#drawer-picked-dir-name');

    async function updateDrawerCustomDirUI() {
      try {
        const handle = await getDirHandle();
        if (handle) {
          if (drawerDirName) {
            drawerDirName.innerText = handle.name;
            drawerDirName.title = `Folder: ${handle.name}`;
          }
          if (drawerClearBtn) drawerClearBtn.style.display = 'block';
        } else {
          if (drawerDirName) {
            drawerDirName.innerText = 'Pilih Folder...';
            drawerDirName.title = '';
          }
          if (drawerClearBtn) drawerClearBtn.style.display = 'none';
        }
      } catch (err) {
        console.error('Error updating Drawer Custom Dir UI:', err);
      }
    }

    if (dirInput) {
      dirInput.addEventListener('input', () => {
        const rawVal = dirInput.value;
        const sanitizedVal = rawVal.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        chrome.storage.local.set({ download_subfolder: sanitizedVal });
      });
    }

    if (inputFolder) {
      inputFolder.addEventListener('input', () => {
        const rawVal = inputFolder.value;
        const sanitizedVal = rawVal.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        chrome.storage.local.set({ download_subfolder: sanitizedVal });
      });
    }

    if (btnSetFolder) {
      btnSetFolder.onclick = () => {
        if (folderPanel.style.display === 'none') {
          chrome.storage.local.get({ download_subfolder: '', download_custom_folder_name: '' }, (data) => {
            if (inputFolder) inputFolder.value = data.download_subfolder || '';
            if (drawerDirName && drawerClearBtn) {
              if (data.download_custom_folder_name) {
                drawerDirName.innerText = data.download_custom_folder_name;
                drawerDirName.title = `Folder: ${data.download_custom_folder_name}`;
                drawerClearBtn.style.display = 'block';
              } else {
                drawerDirName.innerText = 'Pilih Folder...';
                drawerDirName.title = '';
                drawerClearBtn.style.display = 'none';
              }
            }
          });
          folderPanel.style.display = 'block';
        } else {
          folderPanel.style.display = 'none';
          if (folderStatus) folderStatus.innerText = '';
        }
      };
    }

    if (drawerPickBtn) {
      drawerPickBtn.onclick = async () => {
        try {
          const handle = await window.showDirectoryPicker();
          await saveDirHandle(handle);
          await chrome.storage.local.set({ download_custom_folder_name: handle.name });
          showToast('Folder kustom berhasil diatur!', 'success');
        } catch (err) {
          if (err.name !== 'AbortError') {
            console.error('Error selecting folder in drawer:', err);
            showToast('Gagal memilih folder: ' + err.message, 'error');
          }
        }
      };
    }

    if (drawerClearBtn) {
      drawerClearBtn.onclick = async () => {
        try {
          await clearDirHandle();
          await chrome.storage.local.set({ download_custom_folder_name: '' });
          showToast('Folder kustom dinonaktifkan.', 'info');
        } catch (err) {
          console.error('Error clearing folder in drawer:', err);
        }
      };
    }

    if (btnCloseFolder) {
      btnCloseFolder.onclick = () => {
        folderPanel.style.display = 'none';
        if (folderStatus) folderStatus.innerText = '';
      };
    }

    if (btnSaveFolder) {
      btnSaveFolder.onclick = () => {
        const rawVal = inputFolder.value;
        const sanitizedVal = rawVal.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        
        chrome.storage.local.set({ download_subfolder: sanitizedVal }, () => {
          if (inputFolder) inputFolder.value = sanitizedVal;
          if (folderStatus) {
            folderStatus.innerText = 'Folder berhasil disimpan!';
            folderStatus.style.color = '#2ed573';
            setTimeout(() => {
              folderStatus.innerText = '';
            }, 2500);
          }
        });
      };
    }

    // Mutual Badge Checkbox Listener inside drawer
    const drawerChkEnableMutual = drawer.querySelector('#drawer-chk-enable-mutual-badges');
    if (drawerChkEnableMutual) {
      drawerChkEnableMutual.checked = enableMutualBadges;
      drawerChkEnableMutual.onchange = () => {
        chrome.storage.local.set({ enable_mutual_badges: drawerChkEnableMutual.checked });
      };
    }
  }

  function loadDrawerDataFromStorage() {
    chrome.storage.local.get(['followers_list', 'following_list', 'unfollowers_list', 'download_subfolder', 'download_custom_folder_name', 'enable_mutual_badges'], (data) => {
      if (data.followers_list) drawerFollowers = data.followers_list;
      if (data.following_list) drawerFollowing = data.following_list;
      
      const inputFolder = drawerElement ? drawerElement.querySelector('#drawer-input-folder-path') : null;
      if (inputFolder) {
        inputFolder.value = data.download_subfolder || '';
      }

      const drawerDirName = drawerElement ? drawerElement.querySelector('#drawer-picked-dir-name') : null;
      const drawerClearBtn = drawerElement ? drawerElement.querySelector('#drawer-btn-clear-custom-dir') : null;
      if (drawerDirName && drawerClearBtn) {
        if (data.download_custom_folder_name) {
          drawerDirName.innerText = data.download_custom_folder_name;
          drawerDirName.title = `Folder: ${data.download_custom_folder_name}`;
          drawerClearBtn.style.display = 'block';
        } else {
          drawerDirName.innerText = 'Pilih Folder...';
          drawerDirName.title = '';
          drawerClearBtn.style.display = 'none';
        }
      }
      
      const drawerChkEnableMutual = drawerElement ? drawerElement.querySelector('#drawer-chk-enable-mutual-badges') : null;
      if (drawerChkEnableMutual) {
        drawerChkEnableMutual.checked = data.enable_mutual_badges !== undefined ? data.enable_mutual_badges : true;
      }

      const cntFollowers = drawerElement.querySelector('#drawer-cnt-followers');
      const cntFollowing = drawerElement.querySelector('#drawer-cnt-following');
      if (cntFollowers) cntFollowers.innerText = drawerFollowers.length || '-';
      if (cntFollowing) cntFollowing.innerText = drawerFollowing.length || '-';
      
      const cntUnfollowers = drawerElement.querySelector('#drawer-cnt-unfollowers');
      if (data.unfollowers_list && data.unfollowers_list.length > 0) {
        drawerUnfollowers = data.unfollowers_list;
        if (cntUnfollowers) cntUnfollowers.innerText = drawerUnfollowers.length;
        renderDrawerUnfollowersList(drawerUnfollowers);
      } else {
        if (cntUnfollowers) cntUnfollowers.innerText = '-';
      }
    });
  }

  function loadDrawerEngagementData() {
    chrome.storage.local.get({ viewed_stories_history: [], liked_stories_history: [] }, (data) => {
      let history = data.viewed_stories_history || [];
      if (history.length === 0) {
        history = data.liked_stories_history || [];
      }
      const listContainer = drawerElement.querySelector('#drawer-engagement-list-container');
      if (!listContainer) return;

      if (history.length === 0) {
        listContainer.innerHTML = `
          <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 12px;">
            Belum ada data story yang dilihat. Silakan mulai melihat story orang lain.
          </div>
        `;
        return;
      }

      const counts = {};
      history.forEach(log => {
        counts[log.username] = (counts[log.username] || 0) + 1;
      });

      const sorted = Object.keys(counts).map(username => {
        return { username, count: counts[username] };
      }).sort((a, b) => b.count - a.count);

      listContainer.innerHTML = '';
      sorted.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'engagement-item';
        row.innerHTML = `
          <div class="engagement-user">#${index + 1} @${item.username}</div>
          <div class="engagement-score">${item.count} Views</div>
        `;
        listContainer.appendChild(row);
      });
    });
  }

  function renderDrawerUnfollowersList(users) {
    const listContainer = drawerElement.querySelector('#drawer-unfollowers-list-container');
    const chkSelectAll = drawerElement.querySelector('#drawer-chk-select-all');
    const chkCountText = drawerElement.querySelector('#drawer-chk-count-text');
    const actionPanel = drawerElement.querySelector('#drawer-unfollow-action-panel');
    
    if (!listContainer) return;
    listContainer.innerHTML = '';
    drawerSelectedIds.clear();
    if (chkSelectAll) chkSelectAll.checked = false;
    if (chkCountText) chkCountText.innerText = '0 Terpilih';
    if (actionPanel) actionPanel.style.display = 'none';

    if (users.length === 0) {
      listContainer.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-gray); font-size: 12px;">
          All users follow you back! Great job.
        </div>
      `;
      return;
    }

    users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'list-item';
      
      const avatarUrl = user.profile_pic_url || 'icons/icon128.png';
      
      row.innerHTML = `
        <a href="https://www.instagram.com/${user.username}/" target="_blank" class="user-profile">
          <img src="${avatarUrl}" class="avatar" onerror="this.src='icons/icon128.png'">
          <div class="user-info">
            <span class="username">@${user.username}</span>
            <span class="fullname">${user.full_name || ''}</span>
          </div>
        </a>
        <div class="chk-container">
          <input type="checkbox" class="chk-unfollow-user" data-id="${user.id}">
        </div>
      `;

      row.querySelector('.chk-unfollow-user').addEventListener('change', (e) => {
        const id = e.target.getAttribute('data-id');
        if (e.target.checked) {
          drawerSelectedIds.add(id);
        } else {
          drawerSelectedIds.delete(id);
        }
        updateDrawerSelectedCounter();
      });

      listContainer.appendChild(row);
    });
  }

  function updateDrawerSelectedCounter() {
    const chkCountText = drawerElement.querySelector('#drawer-chk-count-text');
    const actionPanel = drawerElement.querySelector('#drawer-unfollow-action-panel');
    const size = drawerSelectedIds.size;
    if (chkCountText) chkCountText.innerText = `${size} Terpilih`;
    if (actionPanel) actionPanel.style.display = size > 0 ? 'block' : 'none';
  }

  function filterDrawerUnfollowersList() {
    const query = drawerElement.querySelector('#drawer-search-input').value.toLowerCase();
    const filtered = drawerUnfollowers.filter(u => 
      u.username.toLowerCase().includes(query) || 
      (u.full_name && u.full_name.toLowerCase().includes(query))
    );
    renderDrawerUnfollowersList(filtered);
  }

  function toggleDrawerSelectAll() {
    const chkSelectAll = drawerElement.querySelector('#drawer-chk-select-all');
    const checked = chkSelectAll.checked;
    const checkboxes = drawerElement.querySelectorAll('.chk-unfollow-user');
    
    checkboxes.forEach(chk => {
      chk.checked = checked;
      const id = chk.getAttribute('data-id');
      if (checked) {
        drawerSelectedIds.add(id);
      } else {
        drawerSelectedIds.delete(id);
      }
    });
    
    updateDrawerSelectedCounter();
  }

  async function startDrawerApiSync() {
    const progressContainer = drawerElement.querySelector('#drawer-progress-container');
    const progressStatus = drawerElement.querySelector('#drawer-progress-status');
    const progressPercent = drawerElement.querySelector('#drawer-progress-percent');
    const progressBarFill = drawerElement.querySelector('#drawer-progress-bar-fill');
    
    if (isDrawerSyncing) return;
    isDrawerSyncing = true;

    progressContainer.style.display = 'block';
    progressStatus.innerText = 'Connecting to Instagram...';
    progressStatus.style.color = '#ffffff';
    progressPercent.innerText = '5%';
    progressBarFill.style.width = '5%';

    try {
      const myUserId = getCookieValue('ds_user_id');
      const token = getCookieValue('csrftoken');
      
      if (!myUserId) {
        throw new Error('Please verify you are logged in to Instagram.');
      }

      let myUsername = 'me';
      try {
        const userRes = await fetch('https://www.instagram.com/api/v1/web/accounts/current_user/', {
          headers: {
            'x-csrftoken': token,
            'x-ig-app-id': '936619743392459',
            'x-requested-with': 'XMLHttpRequest'
          }
        });
        const userData = await userRes.json();
        if (userData.user && userData.user.username) {
          myUsername = userData.user.username;
        }
      } catch (e) {
        console.warn('Could not load current user profile info, using fallback ID:', e);
      }

      progressStatus.innerText = 'Fetching following list...';
      progressPercent.innerText = '15%';
      progressBarFill.style.width = '15%';
      
      const following = await fetchInstagramConnectionList('following', myUserId, (count) => {
        progressStatus.innerText = `Fetching following list (Loaded ${count})...`;
      });
      const cntFollowing = drawerElement.querySelector('#drawer-cnt-following');
      if (cntFollowing) cntFollowing.innerText = following.length;

      progressStatus.innerText = 'Fetching followers list...';
      progressPercent.innerText = '60%';
      progressBarFill.style.width = '60%';
      
      const followers = await fetchInstagramConnectionList('followers', myUserId, (count) => {
        progressStatus.innerText = `Fetching followers list (Loaded ${count})...`;
      });
      const cntFollowers = drawerElement.querySelector('#drawer-cnt-followers');
      if (cntFollowers) cntFollowers.innerText = followers.length;

      progressStatus.innerText = 'Comparing lists...';
      progressPercent.innerText = '90%';
      progressBarFill.style.width = '90%';
      
      const followersSet = new Set(followers.map(u => u.username));
      drawerUnfollowers = following.filter(u => !followersSet.has(u.username));
      
      const cntUnfollowers = drawerElement.querySelector('#drawer-cnt-unfollowers');
      if (cntUnfollowers) cntUnfollowers.innerText = drawerUnfollowers.length;

      chrome.storage.local.set({
        logged_in_username: myUsername,
        followers_list: followers,
        following_list: following,
        unfollowers_list: drawerUnfollowers
      });

      progressStatus.innerText = 'Sync complete!';
      progressPercent.innerText = '100%';
      progressBarFill.style.width = '100%';
      
      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 1500);

      renderDrawerUnfollowersList(drawerUnfollowers);

    } catch (e) {
      console.error('Drawer sync failed:', e);
      progressStatus.innerText = 'Error: ' + e.message;
      progressStatus.style.color = '#ff4757';
    } finally {
      isDrawerSyncing = false;
    }
  }

  function handleDrawerJsonUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        let list = [];
        
        if (Array.isArray(json)) {
          json.forEach(item => {
            if (item.string_list_data && item.string_list_data[0]) {
              list.push({
                id: item.string_list_data[0].value,
                username: item.string_list_data[0].value,
                full_name: item.string_list_data[0].value,
                profile_pic_url: ''
              });
            }
          });
        } else if (typeof json === 'object') {
          const key = Object.keys(json)[0];
          const arr = json[key];
          if (Array.isArray(arr)) {
            arr.forEach(item => {
              if (item.string_list_data && item.string_list_data[0]) {
                list.push({
                  id: item.string_list_data[0].value,
                  username: item.string_list_data[0].value,
                  full_name: item.string_list_data[0].value,
                  profile_pic_url: ''
                });
              }
            });
          }
        }

        if (list.length === 0) {
          throw new Error('Valid list structure not found in JSON data.');
        }

        const fileName = file.name.toLowerCase();
        if (fileName.includes('followers')) {
          drawerFollowers = list;
          chrome.storage.local.set({ followers_list: drawerFollowers });
          const cntFollowers = drawerElement.querySelector('#drawer-cnt-followers');
          if (cntFollowers) cntFollowers.innerText = drawerFollowers.length;
          alert(`Successfully loaded ${drawerFollowers.length} followers! Now upload following.json to compare.`);
        } else if (fileName.includes('following')) {
          drawerFollowing = list;
          chrome.storage.local.set({ following_list: drawerFollowing });
          const cntFollowing = drawerElement.querySelector('#drawer-cnt-following');
          if (cntFollowing) cntFollowing.innerText = drawerFollowing.length;
          alert(`Successfully loaded ${drawerFollowing.length} following! Now upload followers.json to compare.`);
        } else {
          alert('Could not determine list type from file name (ensure file contains "followers" or "following").');
          return;
        }

        if (drawerFollowers.length > 0 && drawerFollowing.length > 0) {
          const followersSet = new Set(drawerFollowers.map(u => u.username));
          drawerUnfollowers = drawerFollowing.filter(u => !followersSet.has(u.username));
          
          const cntUnfollowers = drawerElement.querySelector('#drawer-cnt-unfollowers');
          if (cntUnfollowers) cntUnfollowers.innerText = drawerUnfollowers.length;
          chrome.storage.local.set({ unfollowers_list: drawerUnfollowers });
          renderDrawerUnfollowersList(drawerUnfollowers);
        }

      } catch (err) {
        console.error('Drawer JSON parse error:', err);
        alert('Invalid file format. Please upload a valid followers.json or following.json.');
      }
    };
    reader.readAsText(file);
  }

  async function triggerDrawerBatchUnfollow() {
    if (drawerSelectedIds.size === 0) return;

    const unfollowStatus = drawerElement.querySelector('#drawer-unfollow-status');
    const btnBatchUnfollow = drawerElement.querySelector('#drawer-btn-batch-unfollow');
    
    if (btnBatchUnfollow.disabled) return;
    
    btnBatchUnfollow.disabled = true;
    btnBatchUnfollow.style.opacity = '0.5';
    unfollowStatus.innerText = 'Connecting session token...';

    const token = getCookieValue('csrftoken');
    const userIds = Array.from(drawerSelectedIds);
    console.log('Initiating background batch unfollow queue from overlay:', userIds);

    chrome.runtime.sendMessage({
      action: 'START_UNFOLLOW_BATCH',
      userIds: userIds,
      csrftoken: token
    }, (response) => {
      if (response && response.success) {
        unfollowStatus.innerText = `Starting batch. Unfollowing 0/${userIds.length}...`;
      } else {
        btnBatchUnfollow.disabled = false;
        btnBatchUnfollow.style.opacity = '1';
        unfollowStatus.innerText = 'Failed: ' + (response ? response.error : 'Session issue');
      }
    });
  }

  function updateDrawerUnfollowProgress(msg) {
    if (!drawerElement) return;
    const unfollowStatus = drawerElement.querySelector('#drawer-unfollow-status');
    const total = drawerSelectedIds.size;
    const remaining = msg.remaining;
    const done = total - remaining;
    
    if (unfollowStatus) {
      unfollowStatus.innerText = `Unfollowing ${done}/${total}... (${remaining} remaining)`;
    }

    if (msg.success) {
      drawerUnfollowers = drawerUnfollowers.filter(u => String(u.id) !== String(msg.userId));
      chrome.storage.local.set({ unfollowers_list: drawerUnfollowers });
      const cntUnfollowers = drawerElement.querySelector('#drawer-cnt-unfollowers');
      if (cntUnfollowers) cntUnfollowers.innerText = drawerUnfollowers.length;
    }
  }

  function updateDrawerUnfollowDelay(msg) {
    if (!drawerElement) return;
    const unfollowStatus = drawerElement.querySelector('#drawer-unfollow-status');
    if (unfollowStatus) {
      const delaySec = Math.round(msg.delayMs / 1000);
      unfollowStatus.innerText = `${unfollowStatus.innerText.split(' (Waiting')[0]} (Waiting ${delaySec}s for safety...)`;
    }
  }

  function updateDrawerUnfollowFinished() {
    if (!drawerElement) return;
    const unfollowStatus = drawerElement.querySelector('#drawer-unfollow-status');
    const btnBatchUnfollow = drawerElement.querySelector('#drawer-btn-batch-unfollow');
    const actionPanel = drawerElement.querySelector('#drawer-unfollow-action-panel');
    
    if (btnBatchUnfollow) {
      btnBatchUnfollow.disabled = false;
      btnBatchUnfollow.style.opacity = '1';
    }
    if (unfollowStatus) {
      unfollowStatus.innerText = 'Batch unfollow complete!';
    }
    
    renderDrawerUnfollowersList(drawerUnfollowers);
    setTimeout(() => {
      if (actionPanel) actionPanel.style.display = 'none';
    }, 2500);
  }

  function updateDrawerUnfollowError(err) {
    if (!drawerElement) return;
    const unfollowStatus = drawerElement.querySelector('#drawer-unfollow-status');
    const btnBatchUnfollow = drawerElement.querySelector('#drawer-btn-batch-unfollow');
    
    if (btnBatchUnfollow) {
      btnBatchUnfollow.disabled = false;
      btnBatchUnfollow.style.opacity = '1';
    }
    if (unfollowStatus) {
      unfollowStatus.innerText = 'Stopped: ' + err;
    }
  }

  // Iterate connections page by page with safety delay
  async function fetchInstagramConnectionList(type, userId, onProgress) {
    let list = [];
    let hasNext = true;
    let maxId = '';
    const token = getCookieValue('csrftoken');

    while (hasNext) {
      const url = `https://www.instagram.com/api/v1/friendships/${userId}/${type}/?count=200&max_id=${maxId}`;
      const response = await fetch(url, {
        headers: {
          'x-csrftoken': token,
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest'
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper HTTP request failed with code: ${response.status}`);
      }

      const data = await response.json();
      if (data.users && data.users.length > 0) {
        data.users.forEach(u => {
          list.push({
            id: u.pk,
            username: u.username,
            full_name: u.full_name,
            profile_pic_url: u.profile_pic_url
          });
        });
      }

      if (onProgress) {
        onProgress(list.length);
      }

      maxId = data.next_max_id || '';
      hasNext = !!maxId;

      if (hasNext) {
        // Enforce 1200ms delay per page to prevent rate limits
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }

    return list;
  }

  // Handle extension messages for session retrieval and unfollower updates
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GET_SESSION_INFO') {
      sendResponse({
        csrftoken: getCookieValue('csrftoken'),
        userId: getCookieValue('ds_user_id')
      });
      return;
    }

    if (message.action === 'UNFOLLOW_PROGRESS') {
      updateDrawerUnfollowProgress(message);
    } else if (message.action === 'UNFOLLOW_DELAY') {
      updateDrawerUnfollowDelay(message);
    } else if (message.action === 'UNFOLLOW_FINISHED') {
      updateDrawerUnfollowFinished();
    } else if (message.action === 'UNFOLLOW_ERROR') {
      updateDrawerUnfollowError(message.error);
    }
  });

})();
