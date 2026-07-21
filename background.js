// Background Service Worker for Efha

const downloadFilenameMap = new Map();
const downloadIdFilenameMap = new Map();
let unfollowQueue = [];
let isUnfollowing = false;
let csrfTokenVal = '';

// Intercept filename determination to override remote Content-Disposition headers.
// This is a safety net: the primary mechanism now passes `filename` directly to
// chrome.downloads.download(). This listener catches edge cases where Chrome may
// ignore the filename option (e.g., for CDN URLs with Content-Disposition headers).
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // First try download-ID based lookup (most reliable)
  if (downloadIdFilenameMap.has(item.id)) {
    const suggestedName = downloadIdFilenameMap.get(item.id);
    suggest({ filename: suggestedName, conflictAction: 'uniquify' });
    downloadIdFilenameMap.delete(item.id);
    downloadFilenameMap.delete(item.url); // cleanup URL-based map too
  } else if (downloadFilenameMap.has(item.url)) {
    // Fallback to URL-based lookup
    const suggestedName = downloadFilenameMap.get(item.url);
    suggest({ filename: suggestedName, conflictAction: 'uniquify' });
    downloadFilenameMap.delete(item.url);
  } else {
    suggest();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DOWNLOAD') {
    console.log('Initiating download for:', message.url);
    chrome.storage.local.get({ download_subfolder: '' }, (data) => {
      let filename = message.filename;
      if (data.download_subfolder) {
        const cleanSubfolder = data.download_subfolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (cleanSubfolder) {
          filename = `${cleanSubfolder}/${filename}`;
        }
      }
      // Store in URL-based map as fallback
      downloadFilenameMap.set(message.url, filename);
      // Pass filename directly in download options (primary mechanism)
      chrome.downloads.download({
        url: message.url,
        filename: filename,
        conflictAction: 'uniquify',
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('Download failed:', chrome.runtime.lastError.message);
          downloadFilenameMap.delete(message.url);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          // Also store by download ID for the onDeterminingFilename safety net
          downloadIdFilenameMap.set(downloadId, filename);
          sendResponse({ success: true, downloadId: downloadId });
        }
      });
    });
    return true;
  }

  if (message.action === 'FETCH_BLOB') {
    fetch(message.url)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.blob();
      })
      .then(blob => {
        sendResponse({ success: true, blob: blob });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'FETCH_BASE64') {
    fetch(message.url)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ success: true, base64: reader.result });
        reader.readAsDataURL(blob);
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'FETCH_IMAGE_BASE64') {
    fetch(message.url)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return response.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ success: true, base64: reader.result });
        reader.readAsDataURL(blob);
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (message.action === 'START_UNFOLLOW_BATCH') {
    if (isUnfollowing) {
      sendResponse({ success: false, error: 'Unfollow batch is already running.' });
      return;
    }
    unfollowQueue = message.userIds;
    csrfTokenVal = message.csrftoken;
    isUnfollowing = true;
    
    // Start background processor
    processUnfollowQueue();
    sendResponse({ success: true, total: unfollowQueue.length });
    return;
  }

  if (message.action === 'GET_UNFOLLOW_STATUS') {
    sendResponse({ active: isUnfollowing, remaining: unfollowQueue.length });
    return;
  }

  if (message.action === 'STOP_UNFOLLOW_BATCH') {
    isUnfollowing = false;
    unfollowQueue = [];
    sendResponse({ success: true });
    return;
  }
});

async function processUnfollowQueue() {
  console.log('Starting batch unfollow processing. Queue size:', unfollowQueue.length);
  
  while (unfollowQueue.length > 0 && isUnfollowing) {
    const userId = unfollowQueue[0];
    
    try {
      const url = `https://www.instagram.com/api/v1/friendships/destroy/${userId}/`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrftoken': csrfTokenVal || '',
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest'
        },
        credentials: 'include'
      });

      if (response.status === 429) {
        console.error('Rate limited by Instagram. Stopping batch.');
        broadcastProgress({ action: 'UNFOLLOW_ERROR', error: 'Rate limited by Instagram. Batch stopped for safety.' });
        break;
      }

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const json = await response.json();
      if (json.status === 'ok') {
        unfollowQueue.shift(); // Remove from queue on success
        broadcastProgress({
          action: 'UNFOLLOW_PROGRESS',
          success: true,
          userId: userId,
          remaining: unfollowQueue.length
        });
      } else {
        throw new Error(json.message || 'API error');
      }

    } catch (e) {
      console.error(`Unfollow failed for ${userId}:`, e);
      unfollowQueue.shift(); // skip failed to avoid block lock
      broadcastProgress({
        action: 'UNFOLLOW_PROGRESS',
        success: false,
        userId: userId,
        error: e.message,
        remaining: unfollowQueue.length
      });
    }

    if (unfollowQueue.length > 0 && isUnfollowing) {
      // Enforce randomized safety delay between 10 and 18 seconds
      const delay = Math.floor(Math.random() * (18000 - 10000 + 1) + 10000);
      console.log(`Waiting ${delay / 1000} seconds before next unfollow...`);
      
      broadcastProgress({ action: 'UNFOLLOW_DELAY', delayMs: delay });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  console.log('Batch unfollow processor finished.');
  isUnfollowing = false;
  broadcastProgress({ action: 'UNFOLLOW_FINISHED' });
}

function broadcastProgress(data) {
  chrome.runtime.sendMessage(data).catch(() => {
    // Ignore error when popup window is closed
  });
}


