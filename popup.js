// Efha - Popup Script

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const actionBtn = document.getElementById('action-btn');

  // Folder Settings Elements
  const btnSetFolder = document.getElementById('btn-set-folder');
  const folderSettingsPanel = document.getElementById('folder-settings-panel');
  const btnCloseFolderSettings = document.getElementById('btn-close-folder-settings');
  const inputFolderPath = document.getElementById('input-folder-path');
  const btnSaveFolder = document.getElementById('btn-save-folder');
  const folderStatusMessage = document.getElementById('folder-status-message');
  const popupCustomFolderDisplay = document.getElementById('popup-custom-folder-display');
  const popupCustomFolderName = document.getElementById('popup-custom-folder-name');
  const btnClearPopupCustomDir = document.getElementById('btn-clear-popup-custom-dir');
  const btnToggleTheme = document.getElementById('btn-toggle-theme');
  const themeToggleIcon = document.getElementById('theme-toggle-icon');

  // Tabs
  const tabLinks = document.querySelectorAll('.tab-link');
  const tabContents = document.querySelectorAll('.tab-content');

  // Tracker Stats
  const cntFollowers = document.getElementById('cnt-followers');
  const cntFollowing = document.getElementById('cnt-following');
  const cntUnfollowers = document.getElementById('cnt-unfollowers');

  // Tracker Action Buttons
  const btnSyncApi = document.getElementById('btn-sync-api');
  const btnUploadJson = document.getElementById('btn-upload-json');
  const fileInput = document.getElementById('file-input');
  
  // Progress Bar
  const progressContainer = document.getElementById('progress-container');
  const progressStatus = document.getElementById('progress-status');
  const progressPercent = document.getElementById('progress-percent');
  const progressBarFill = document.getElementById('progress-bar-fill');

  // List Views
  const unfollowersListContainer = document.getElementById('unfollowers-list-container');
  const searchInput = document.getElementById('search-input');
  const chkSelectAll = document.getElementById('chk-select-all');
  const chkCountText = document.getElementById('chk-count-text');

  // Unfollow Action Panel
  const unfollowActionPanel = document.getElementById('unfollow-action-panel');
  const unfollowStatus = document.getElementById('unfollow-status');
  const btnBatchUnfollow = document.getElementById('btn-batch-unfollow');

  // Engagement Tab
  const engagementListContainer = document.getElementById('engagement-list-container');

  // State Variables
  let sessionToken = '';
  let sessionUserId = '';
  let unfollowersList = []; // Scanned non-followers list
  let selectedUnfollowIds = new Set();
  let loadedFollowers = [];
  let loadedFollowing = [];

  // Initialize
  initPopup();

  function initPopup() {
    // Check if on Instagram tab
    checkInstagramTab();
    
    // Theme initialization
    initTheme();
    if (btnToggleTheme) {
      btnToggleTheme.addEventListener('click', toggleTheme);
    }
    
    // Tab switching
    tabLinks.forEach(link => {
      link.addEventListener('click', () => {
        const targetTab = link.getAttribute('data-tab');
        
        tabLinks.forEach(l => l.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        
        link.classList.add('active');
        document.getElementById(targetTab).classList.add('active');

        if (targetTab === 'tab-engagement') {
          loadEngagementData();
        }
        if (targetTab === 'tab-recap') {
          loadRecapData();
        }
      });
    });

    // Load saved tracker data from storage
    loadSavedTrackerData();

    // Load story likes engagement data
    loadEngagementData();

    // Query active unfollow status from background worker
    queryUnfollowStatus();

    // Set up button actions
    btnSyncApi.addEventListener('click', startApiSync);
    btnUploadJson.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleJsonUpload);
    searchInput.addEventListener('input', filterUnfollowersList);
    chkSelectAll.addEventListener('change', toggleSelectAll);
    btnBatchUnfollow.addEventListener('click', triggerBatchUnfollow);

    // Set up folder settings
    btnSetFolder.addEventListener('click', toggleFolderSettings);
    btnCloseFolderSettings.addEventListener('click', closeFolderSettings);
    btnSaveFolder.addEventListener('click', saveFolderSettings);
    
    inputFolderPath.addEventListener('input', () => {
      const rawVal = inputFolderPath.value;
      const sanitizedVal = rawVal.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      chrome.storage.local.set({ download_subfolder: sanitizedVal });
    });

    const chkEnableMutual = document.getElementById('chk-enable-mutual-badges');
    if (chkEnableMutual) {
      chkEnableMutual.addEventListener('change', () => {
        chrome.storage.local.set({ enable_mutual_badges: chkEnableMutual.checked });
      });
    }

    if (btnClearPopupCustomDir) {
      btnClearPopupCustomDir.addEventListener('click', () => {
        chrome.storage.local.set({ download_custom_folder_name: '' }, () => {
          if (popupCustomFolderDisplay) popupCustomFolderDisplay.style.display = 'none';
        });
      });
    }

    // Set up download recap button actions in popup
    const popupExportRecapBtn = document.getElementById('popup-recap-export-btn');
    const popupClearRecapBtn = document.getElementById('popup-recap-clear-btn');

    if (popupExportRecapBtn) {
      popupExportRecapBtn.addEventListener('click', () => {
        chrome.storage.local.get({ download_recap: {}, followers_list: [], profile_friendship_cache: {} }, (data) => {
          exportRecapToXLS(data.download_recap, data.followers_list, data.profile_friendship_cache);
        });
      });
    }

    if (popupClearRecapBtn) {
      popupClearRecapBtn.addEventListener('click', () => {
        if (confirm('Apakah Anda yakin ingin menghapus semua rekap data unduhan?')) {
          chrome.storage.local.set({ download_recap: {} });
        }
      });
    }

    // Sync settings changes across panels
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.download_subfolder) {
          inputFolderPath.value = changes.download_subfolder.newValue || '';
        }
        if (changes.download_custom_folder_name) {
          const newName = changes.download_custom_folder_name.newValue;
          if (newName) {
            if (popupCustomFolderName) popupCustomFolderName.innerText = newName;
            if (popupCustomFolderDisplay) popupCustomFolderDisplay.style.display = 'block';
          } else {
            if (popupCustomFolderDisplay) popupCustomFolderDisplay.style.display = 'none';
          }
        }
        if (changes.download_recap) {
          const container = document.getElementById('popup-recap-list-container');
          if (container) {
            renderRecapList(changes.download_recap.newValue, container);
          }
        }
        if (changes.theme) {
          applyTheme(changes.theme.newValue);
        }
        if (changes.enable_mutual_badges) {
          const chkEnableMutual = document.getElementById('chk-enable-mutual-badges');
          if (chkEnableMutual) {
            chkEnableMutual.checked = changes.enable_mutual_badges.newValue;
          }
        }
      }
    });

    loadSavedFolderSettings();
  }

  function toggleFolderSettings() {
    if (folderSettingsPanel.style.display === 'none') {
      loadSavedFolderSettings();
      folderSettingsPanel.style.display = 'block';
    } else {
      closeFolderSettings();
    }
  }

  function closeFolderSettings() {
    folderSettingsPanel.style.display = 'none';
    folderStatusMessage.innerText = '';
  }

  function loadSavedFolderSettings() {
    chrome.storage.local.get({ download_subfolder: '', download_custom_folder_name: '', enable_mutual_badges: true }, (data) => {
      inputFolderPath.value = data.download_subfolder || '';
      if (data.download_custom_folder_name) {
        if (popupCustomFolderName) popupCustomFolderName.innerText = data.download_custom_folder_name;
        if (popupCustomFolderDisplay) popupCustomFolderDisplay.style.display = 'block';
      } else {
        if (popupCustomFolderDisplay) popupCustomFolderDisplay.style.display = 'none';
      }
      const chkEnableMutual = document.getElementById('chk-enable-mutual-badges');
      if (chkEnableMutual) {
        chkEnableMutual.checked = data.enable_mutual_badges;
      }
    });
  }

  function saveFolderSettings() {
    const rawVal = inputFolderPath.value;
    const sanitizedVal = rawVal.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    
    chrome.storage.local.set({ download_subfolder: sanitizedVal }, () => {
      inputFolderPath.value = sanitizedVal;
      folderStatusMessage.innerText = 'Folder berhasil disimpan!';
      folderStatusMessage.style.color = '#2ed573';
      setTimeout(() => {
        folderStatusMessage.innerText = '';
      }, 2500);
    });
  }

  function checkInstagramTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        const activeTab = tabs[0];
        const url = activeTab.url || '';

        if (url.includes('instagram.com')) {
          statusDot.classList.add('active');
          statusText.innerText = 'Connected';
          actionBtn.innerText = 'Close and View Page';
          actionBtn.onclick = () => window.close();
        } else {
          statusDot.classList.remove('active');
          statusText.innerText = 'Disconnected';
          actionBtn.innerText = 'Open Instagram.com';
          actionBtn.onclick = () => {
            chrome.tabs.create({ url: 'https://www.instagram.com/' });
            window.close();
          };
        }
      }
    });
  }

  // Load metrics from local storage
  function loadSavedTrackerData() {
    chrome.storage.local.get(['followers_list', 'following_list', 'unfollowers_list'], (data) => {
      if (data.followers_list) loadedFollowers = data.followers_list;
      if (data.following_list) loadedFollowing = data.following_list;
      
      cntFollowers.innerText = loadedFollowers.length || '-';
      cntFollowing.innerText = loadedFollowing.length || '-';
      
      if (data.unfollowers_list && data.unfollowers_list.length > 0) {
        unfollowersList = data.unfollowers_list;
        cntUnfollowers.innerText = unfollowersList.length;
        renderUnfollowersList(unfollowersList);
      } else {
        cntUnfollowers.innerText = '-';
      }
    });
  }

  // Load story views/likes history and aggregate trends
  function loadEngagementData() {
    chrome.storage.local.get({ viewed_stories_history: [], liked_stories_history: [] }, (data) => {
      let history = data.viewed_stories_history || [];
      if (history.length === 0) {
        history = data.liked_stories_history || [];
      }

      if (history.length === 0) {
        engagementListContainer.innerHTML = `
          <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 12px;">
            Belum ada data story yang dilihat. Silakan mulai melihat story orang lain.
          </div>
        `;
        return;
      }

      // Aggregate counts by username
      const counts = {};
      history.forEach(log => {
        counts[log.username] = (counts[log.username] || 0) + 1;
      });

      // Sort profiles descending
      const sorted = Object.keys(counts).map(username => {
        return { username, count: counts[username] };
      }).sort((a, b) => b.count - a.count);

      // Render top list
      engagementListContainer.innerHTML = '';
      sorted.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'engagement-item';
        row.innerHTML = `
          <div class="engagement-user">#${index + 1} @${item.username}</div>
          <div class="engagement-score">${item.count} Views</div>
        `;
        engagementListContainer.appendChild(row);
      });
    });
  }

  // Retrieve active background unfollow batch states
  function queryUnfollowStatus() {
    chrome.runtime.sendMessage({ action: 'GET_UNFOLLOW_STATUS' }, (response) => {
      if (response && response.active) {
        unfollowActionPanel.style.display = 'block';
        btnBatchUnfollow.disabled = true;
        btnBatchUnfollow.style.opacity = '0.5';
        unfollowStatus.innerText = `Processing batch... ${response.remaining} items remaining in background queue.`;
      }
    });
  }

  // Request active tab for Session variables (CSRF token)
  function requestSessionInfo() {
    return new Promise((resolve) => {
      chrome.tabs.query({ url: '*://*.instagram.com/*' }, (tabs) => {
        if (tabs && tabs.length > 0) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'GET_SESSION_INFO' }, (response) => {
            if (response && (response.csrftoken || response.userId)) {
              sessionToken = response.csrftoken || '';
              sessionUserId = response.userId || '';
              resolve(true);
            } else {
              resolve(false);
            }
          });
        } else {
          resolve(false);
        }
      });
    });
  }



  // Scraper API Scanner
  async function startApiSync() {


    progressContainer.style.display = 'block';
    progressStatus.innerText = 'Connecting to Instagram...';
    progressStatus.style.color = 'var(--text-white)';
    updateProgressBar(5);

    try {
      // 1. Get Session Info
      const hasSession = await requestSessionInfo();
      if (!hasSession) {
        throw new Error('Please open Instagram in your active browser tabs and verify you are logged in.');
      }

      // 2. Fetch logged-in user profile ID
      let myUserId = '';
      let myUsername = '';

      try {
        const userRes = await fetch('https://www.instagram.com/api/v1/web/accounts/current_user/', {
          headers: {
            'x-csrftoken': sessionToken,
            'x-ig-app-id': '936619743392459',
            'x-requested-with': 'XMLHttpRequest'
          }
        });

        if (userRes.status === 401 || userRes.status === 403) {
          throw new Error('Unauthorized. Please log in to Instagram first.');
        }

        const userData = await userRes.json();
        if (userData.user && userData.user.id) {
          myUserId = userData.user.id;
          myUsername = userData.user.username;
          console.log('Logged in user ID resolved via API:', myUserId, '@' + myUsername);
        } else {
          throw new Error('User field missing in response');
        }
      } catch (err) {
        console.warn('current_user API fetch failed, attempting fallback:', err);
        if (sessionUserId) {
          myUserId = sessionUserId;
          myUsername = 'me';
          console.log('Using fallback sessionUserId:', myUserId);
        } else {
          throw new Error('Could not identify current logged in account. API error: ' + err.message);
        }
      }

      if (!myUserId) {
        throw new Error('Could not identify current logged in account.');
      }

      // 3. Fetch Following List
      progressStatus.innerText = 'Fetching following list...';
      updateProgressBar(15);
      const following = await fetchInstagramConnectionList('following', myUserId, (count) => {
        progressStatus.innerText = `Fetching following list (Loaded ${count})...`;
      });
      cntFollowing.innerText = following.length;

      // 4. Fetch Followers List
      progressStatus.innerText = 'Fetching followers list...';
      updateProgressBar(60);
      const followers = await fetchInstagramConnectionList('followers', myUserId, (count) => {
        progressStatus.innerText = `Fetching followers list (Loaded ${count})...`;
      });
      cntFollowers.innerText = followers.length;

      // 5. Compare & Compute Non-followers
      progressStatus.innerText = 'Comparing lists...';
      updateProgressBar(90);
      
      const followersSet = new Set(followers.map(u => u.username));
      unfollowersList = following.filter(u => !followersSet.has(u.username));
      
      cntUnfollowers.innerText = unfollowersList.length;

      // Save to local storage
      chrome.storage.local.set({
        logged_in_username: myUsername,
        followers_list: followers,
        following_list: following,
        unfollowers_list: unfollowersList
      });

      progressStatus.innerText = 'Sync complete!';
      updateProgressBar(100);
      
      setTimeout(() => {
        progressContainer.style.display = 'none';
      }, 1500);

      renderUnfollowersList(unfollowersList);

    } catch (e) {
      console.error('Data sync failed:', e);
      progressStatus.innerText = 'Error: ' + e.message;
      progressStatus.style.color = 'var(--destructive)';
    }
  }

  // Iterate connections page by page with safety delay
  async function fetchInstagramConnectionList(type, userId, onProgress) {
    let list = [];
    let hasNext = true;
    let maxId = '';

    while (hasNext) {
      const url = `https://www.instagram.com/api/v1/friendships/${userId}/${type}/?count=200&max_id=${maxId}`;
      const response = await fetch(url, {
        headers: {
          'x-csrftoken': sessionToken,
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
        // Enforce 1200ms delay per page fetch to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }

    return list;
  }

  function updateProgressBar(percentage) {
    progressPercent.innerText = `${percentage}%`;
    progressBarFill.style.width = `${percentage}%`;
  }

  // Local JSON File upload parser fallback
  function handleJsonUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        const list = parseInstagramJson(json);

        if (list.length === 0) {
          throw new Error('Valid list structure not found in JSON data.');
        }

        // Determine if uploaded file is followers or following list
        const fileName = file.name.toLowerCase();
        if (fileName.includes('followers')) {
          loadedFollowers = list;
          chrome.storage.local.set({ followers_list: loadedFollowers });
          cntFollowers.innerText = loadedFollowers.length;
          alert(`Successfully loaded ${loadedFollowers.length} followers! Now upload following.json to compare.`);
        } else if (fileName.includes('following')) {
          loadedFollowing = list;
          chrome.storage.local.set({ following_list: loadedFollowing });
          cntFollowing.innerText = loadedFollowing.length;
          alert(`Successfully loaded ${loadedFollowing.length} following! Now upload followers.json to compare.`);
        } else {
          // Attempt parsing combined format
          alert('Could not determine list type from file name (ensure file contains "followers" or "following").');
          return;
        }

        // Calculate comparison if both loaded
        if (loadedFollowers.length > 0 && loadedFollowing.length > 0) {
          const followersSet = new Set(loadedFollowers.map(u => u.username));
          unfollowersList = loadedFollowing.filter(u => !followersSet.has(u.username));
          
          cntUnfollowers.innerText = unfollowersList.length;
          chrome.storage.local.set({ unfollowers_list: unfollowersList });
          renderUnfollowersList(unfollowersList);
        }

      } catch (err) {
        console.error('JSON parse error:', err);
        alert('Invalid file format. Please upload a valid followers.json or following.json.');
      }
    };
    reader.readAsText(file);
  }

  function parseInstagramJson(json) {
    let list = [];
    // Format 1: Direct Array
    if (Array.isArray(json)) {
      json.forEach(item => {
        if (item.string_list_data && item.string_list_data[0]) {
          list.push({
            id: item.string_list_data[0].value, // fallback ID to username
            username: item.string_list_data[0].value,
            full_name: item.string_list_data[0].value,
            profile_pic_url: ''
          });
        }
      });
    }
    // Format 2: Object nested array (e.g. relationships_following key)
    else if (typeof json === 'object') {
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
    return list;
  }

  // Render non-followers elements inside list container
  function renderUnfollowersList(users) {
    unfollowersListContainer.innerHTML = '';
    selectedUnfollowIds.clear();
    chkSelectAll.checked = false;
    chkCountText.innerText = '0 Selected';
    unfollowActionPanel.style.display = 'none';

    if (users.length === 0) {
      unfollowersListContainer.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 12px;">
          All users follow you back! Great job.
        </div>
      `;
      return;
    }

    users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'list-item';
      
      const avatarUrl = user.profile_pic_url || 'icons/icon128.png'; // fallback avatar
      
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

      // Profile link click listener to open in background tab (prevents popup from closing)
      row.querySelector('.user-profile').addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({
          url: `https://www.instagram.com/${user.username}/`,
          active: false
        });
      });

      // Checkbox click listener
      row.querySelector('.chk-unfollow-user').addEventListener('change', (e) => {
        const id = e.target.getAttribute('data-id');
        if (e.target.checked) {
          selectedUnfollowIds.add(id);
        } else {
          selectedUnfollowIds.delete(id);
        }
        updateSelectedCounter();
      });

      unfollowersListContainer.appendChild(row);
    });
  }

  function updateSelectedCounter() {
    const size = selectedUnfollowIds.size;
    chkCountText.innerText = `${size} Selected`;
    unfollowActionPanel.style.display = size > 0 ? 'block' : 'none';
  }

  function filterUnfollowersList() {
    const query = searchInput.value.toLowerCase();
    const filtered = unfollowersList.filter(u => 
      u.username.toLowerCase().includes(query) || 
      (u.full_name && u.full_name.toLowerCase().includes(query))
    );
    renderUnfollowersList(filtered);
  }

  function toggleSelectAll() {
    const checked = chkSelectAll.checked;
    const checkboxes = unfointersContainerCheckboxes();
    
    checkboxes.forEach(chk => {
      chk.checked = checked;
      const id = chk.getAttribute('data-id');
      if (checked) {
        selectedUnfollowIds.add(id);
      } else {
        selectedUnfollowIds.delete(id);
      }
    });
    
    updateSelectedCounter();
  }

  function unfointersContainerCheckboxes() {
    return unfickersContainer().querySelectorAll('.chk-unfollow-user');
  }

  function unfickersContainer() {
    return unfollowersListContainer;
  }

  // Launch Automated Unfollow Queue
  async function triggerBatchUnfollow() {
    if (selectedUnfollowIds.size === 0) return;

    btnBatchUnfollow.disabled = true;
    btnBatchUnfollow.style.opacity = '0.5';
    unfollowStatus.innerText = 'Connecting session token...';

    // Refresh Session info
    await requestSessionInfo();

    const userIds = Array.from(selectedUnfollowIds);
    console.log('Initiating background batch unfollow queue:', userIds);

    chrome.runtime.sendMessage({
      action: 'START_UNFOLLOW_BATCH',
      userIds: userIds,
      csrftoken: sessionToken
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

  // Listen for progress updates from background queue worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'UNFOLLOW_PROGRESS') {
      const total = selectedUnfollowIds.size;
      const remaining = message.remaining;
      const done = total - remaining;
      
      unfollowStatus.innerText = `Unfollowing ${done}/${total}... (${remaining} remaining)`;
      
      // Update local scanned unfollow list state to exclude unfollowed items
      if (message.success) {
        unfollowersList = unfollowersList.filter(u => String(u.id) !== String(message.userId));
        chrome.storage.local.set({ unfollowers_list: unfollowersList });
        cntUnfollowers.innerText = unfollowersList.length;
      }
    }

    if (message.action === 'UNFOLLOW_DELAY') {
      const delaySec = Math.round(message.delayMs / 1000);
      unfollowStatus.innerText = `${unfollowStatus.innerText.split(' (Waiting')[0]} (Waiting ${delaySec}s for safety...)`;
    }

    if (message.action === 'UNFOLLOW_FINISHED') {
      btnBatchUnfollow.disabled = false;
      btnBatchUnfollow.style.opacity = '1';
      unfollowStatus.innerText = 'Batch unfollow complete!';
      
      // Reload lists
      renderUnfollowersList(unfollowersList);
      setTimeout(() => {
        unfollowActionPanel.style.display = 'none';
      }, 2500);
    }

    if (message.action === 'UNFOLLOW_ERROR') {
      btnBatchUnfollow.disabled = false;
      btnBatchUnfollow.style.opacity = '1';
      unfollowStatus.innerText = 'Stopped: ' + message.error;
    }
  });

  function loadRecapData() {
    chrome.storage.local.get({ download_recap: {} }, (data) => {
      const container = document.getElementById('popup-recap-list-container');
      renderRecapList(data.download_recap, container);
    });
  }

  function renderRecapList(recapData, containerElement) {
    if (!containerElement) return;
    const entries = Object.entries(recapData || {}).sort((a, b) => b[1] - a[1]);
    
    if (entries.length === 0) {
      containerElement.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--muted-foreground); font-size: 12px;">
          Belum ada data unduhan. Silakan unduh foto/video terlebih dahulu.
        </div>
      `;
      return;
    }

    containerElement.innerHTML = '';
    entries.forEach(([username, count], idx) => {
      const isLast = idx === entries.length - 1;
      const item = document.createElement('div');
      item.className = 'recap-item';
      item.style.cssText = `display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: transparent; ${isLast ? '' : 'border-bottom: 1px solid var(--border);'}`;
      
      item.innerHTML = `
        <span class="recap-username" style="font-weight: 600; color: var(--foreground); font-size: 12px;">@${username}</span>
        <span class="recap-badge" style="background: var(--secondary); color: var(--foreground); font-weight: 600; font-size: 12px; padding: 2px 8px; border-radius: 12px;">${count} File</span>
      `;
      containerElement.appendChild(item);
    });
  }

  function exportRecapToXLS(recapData, followersList, profileFriendshipCache) {
    const entries = Object.entries(recapData || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      alert('Tidak ada data rekap untuk diexport!');
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

  // --- Theme Management ---
  const SUN_ICON = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
  const MOON_ICON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';

  function initTheme() {
    chrome.storage.local.get({ theme: 'light' }, (data) => {
      applyTheme(data.theme);
    });
  }

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.classList.add('dark');
      if (themeToggleIcon) themeToggleIcon.innerHTML = SUN_ICON;
    } else {
      document.body.classList.remove('dark');
      if (themeToggleIcon) themeToggleIcon.innerHTML = MOON_ICON;
    }
  }

  function toggleTheme() {
    const isDark = document.body.classList.contains('dark');
    const newTheme = isDark ? 'light' : 'dark';
    chrome.storage.local.set({ theme: newTheme }, () => {
      applyTheme(newTheme);
    });
  }

});
