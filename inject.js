// Efha - MAIN World Injection Script
// Intercepts Instagram's fetch/XHR to capture x-ig-set-www-claim,
// and intercepted stories / reels / user profile data for instant 0ms resolving.

(function () {
  'use strict';

  function processInterceptedData(url, data) {
    if (!data || typeof data !== 'object') return;
    try {
      // 1. Stories / Reels Feed (e.g. /api/v1/feed/reels_media/)
      if (data.reels && typeof data.reels === 'object') {
        document.dispatchEvent(new CustomEvent('efha-reels-data', { detail: data.reels }));
      }
      
      // 2. User profile info (/api/v1/users/web_profile_info/)
      if (data.data?.user?.username) {
        document.dispatchEvent(new CustomEvent('efha-user-data', { detail: data.data.user }));
      }

      // 3. GraphQL queries with reels or user
      if (data.data?.xdt_api__v1__feed__reels_media?.reels_media) {
        const list = data.data.xdt_api__v1__feed__reels_media.reels_media;
        const reelsObj = {};
        for (const item of list) {
          if (item?.id) reelsObj[item.id] = item;
        }
        document.dispatchEvent(new CustomEvent('efha-reels-data', { detail: reelsObj }));
      }
    } catch (e) {
      /* silently ignore intercept parsing errors */
    }
  }

  // --- Intercept fetch() ---
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    return originalFetch.apply(this, args).then(response => {
      try {
        const claim = response.headers.get('x-ig-set-www-claim');
        if (claim && claim !== '0' && claim.length > 2) {
          sessionStorage.setItem('www-claim-v2', claim);
          document.dispatchEvent(new CustomEvent('efha-www-claim', { detail: claim }));
        }

        if (url.includes('reels_media') || url.includes('web_profile_info') || url.includes('graphql')) {
          response.clone().json().then(data => {
            processInterceptedData(url, data);
          }).catch(() => {});
        }
      } catch (e) { /* silently ignore */ }
      return response;
    }).catch(err => {
      throw err;
    });
  };

  // --- Intercept XMLHttpRequest ---
  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._efhaUrl = url || '';
    return XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const claim = this.getResponseHeader('x-ig-set-www-claim');
        if (claim && claim !== '0' && claim.length > 2) {
          sessionStorage.setItem('www-claim-v2', claim);
          document.dispatchEvent(new CustomEvent('efha-www-claim', { detail: claim }));
        }

        const url = this._efhaUrl || '';
        if (url.includes('reels_media') || url.includes('web_profile_info') || url.includes('graphql')) {
          try {
            const data = JSON.parse(this.responseText);
            processInterceptedData(url, data);
          } catch (e) {}
        }
      } catch (e) { /* silently ignore */ }
    });
    return XHRSend.apply(this, args);
  };

  console.log('[Efha] MAIN world interceptor active — www-claim & live stories interceptor enabled.');
})();
