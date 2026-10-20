/**
 * 3D Mesh Downloader - content.js
 *
 * Isolated-world bridge between the popup (extension context) and the page
 * context (injected.js). It never touches page data itself.
 */
(function () {
  'use strict';

  // --- page -> popup -------------------------------------------------------
  window.addEventListener('message', function (event) {
    // Only trust messages coming from this very frame.
    if (event.source !== window) return;

    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'MDL_INFO') {
      chrome.runtime.sendMessage({ type: 'MDL_INFO', info: data.info, version: data.version });
    } else if (data.type === 'MDL_RESULT') {
      chrome.runtime.sendMessage({ type: 'MDL_RESULT', result: data.result });
    }
  });

  // --- popup -> page -------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (!request || typeof request !== 'object') return false;

    if (request.type === 'MDL_GET_INFO') {
      window.postMessage({ type: 'MDL_GET_INFO' }, '*');
      sendResponse({ status: 'requested' });
      return true;
    }

    if (request.type === 'MDL_DOWNLOAD') {
      window.postMessage({ type: 'MDL_DOWNLOAD', options: request.options || {} }, '*');
      sendResponse({ status: 'downloading' });
      return true;
    }

    return false;
  });
})();
