// Efha - MAIN World Injection Script
// Intercepts Instagram's fetch/XHR to capture the x-ig-set-www-claim header
// and stores it in sessionStorage for the content script to use.

(function () {
  'use strict';

  // --- Intercept fetch() ---
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then(response => {
      try {
        const claim = response.headers.get('x-ig-set-www-claim');
        if (claim && claim !== '0' && claim.length > 2) {
          sessionStorage.setItem('www-claim-v2', claim);
          // Also notify content script via DOM event
          document.dispatchEvent(new CustomEvent('efha-www-claim', { detail: claim }));
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
    this._efhaUrl = url;
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
      } catch (e) { /* silently ignore */ }
    });
    return XHRSend.apply(this, args);
  };

  console.log('[Efha] MAIN world interceptor active — www-claim capture enabled.');
})();
