/**
 * 3D Mesh Downloader - content.js
 *
 * Isolated-world bridge between the popup (extension context) and the page
 * context (injected.js). It never touches page data itself.
 *
 * It also understands a deep link so the export can be triggered from
 * outside the extension UI:
 *
 *   #3dmesh=info                 -> dumps the captured models to the console
 *   #3dmesh=export               -> exports everything
 *   #3dmesh=export&text=dog      -> only models whose name contains "dog"
 *   #3dmesh=export&min=1&max=50  -> only models between 1 KB and 50 KB
 *   #3dmesh=export&combine=0     -> one .obj per model instead of a single file
 *
 * The hash is consumed once, so a reload does not re-export.
 */
(function () {
  'use strict';

  var VERSION = '2.0.0';

  // --- page -> popup -------------------------------------------------------
  var infoWaiters = [];

  window.addEventListener('message', function (event) {
    // Only trust messages coming from this very frame.
    if (event.source !== window) return;

    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'MDL_INFO') {
      chrome.runtime.sendMessage({ type: 'MDL_INFO', info: data.info, version: data.version });
      var waiter = infoWaiters.shift();
      if (waiter) waiter(data.info);
    } else if (data.type === 'MDL_RESULT') {
      chrome.runtime.sendMessage({ type: 'MDL_RESULT', result: data.result });
    }
  });

  /** Asks the page for the captured models and waits for the answer. */
  function requestInfo(timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var waiter = function (info) {
        done = true;
        resolve(info);
      };
      infoWaiters.push(waiter);
      window.postMessage({ type: 'MDL_GET_INFO' }, '*');
      setTimeout(function () {
        if (done) return;
        var i = infoWaiters.indexOf(waiter);
        if (i !== -1) infoWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs || 5000);
    });
  }

  // --- popup -> page -------------------------------------------------------
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (!request || typeof request !== 'object') return false;

    if (request.type === 'MDL_GET_INFO') {
      window.postMessage({
        type: 'MDL_GET_INFO',
        exclude: request.exclude || [],
        excludeSize: request.excludeSize || null,
        format: request.format || 'obj'
      }, '*');
      sendResponse({ status: 'requested' });
      return true;
    }

    if (request.type === 'MDL_DOWNLOAD') {
      window.postMessage({ type: 'MDL_DOWNLOAD', options: request.options || {} }, '*');
      sendResponse({ status: 'downloading' });
      return true;
    }

    // O service worker usa isto para localizar a aba alvo de um deep link.
    if (request.type === 'MDL_WHERE') {
      sendResponse({ url: location.href });
      return true;
    }

    return false;
  });

  // --- deep link -----------------------------------------------------------
  function deepLinkOptions(params) {
    var options = {
      applyTransforms: true,
      normals: 'auto',
      uvs: 'on',
      expandInstances: true,
      materials: 'on',
      combine: params.get('combine') !== '0',
      format: params.get('format') || 'obj',
      filter: {
        text: params.get('text') || '',
        minKB: null,
        maxKB: null,
        include: null,
        exclude: params.getAll('exclude').filter(Boolean),
        excludeSize: null
      }
    };
    if (params.get('min')) options.filter.minKB = Number(params.get('min'));
    if (params.get('max')) options.filter.maxKB = Number(params.get('max'));
    if (params.get('text')) options.filter.text = params.get('text');
    if (params.get('sizekb')) {
      options.filter.excludeSize = {
        enabled: true,
        mode: params.get('sizemode') === 'below' ? 'below' : 'above',
        kb: Number(params.get('sizekb'))
      };
    }
    return options;
  }

  function checkDeepLink() {
    var hash = (location.hash || '').replace(/^#/, '');
    if (!hash || hash.indexOf('3dmesh=') === -1) return;

    var params;
    try {
      params = new URLSearchParams(hash);
    } catch (e) {
      return;
    }

    var action = params.get('3dmesh');
    if (action !== 'export' && action !== 'info') return;

    // consume the hash so a reload does not repeat the action
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      /* ignore */
    }

    if (action === 'info') {
      window.postMessage({ type: 'MDL_GET_INFO' }, '*');
      return;
    }

    var options = deepLinkOptions(params);
    var waitSeconds = Number(params.get('wait') || 30);
    console.debug('[3D Mesh Downloader] deep link -> export', options.filter);

    // Heavy pages create the scene (and load the model) after 'load', so we
    // wait until the page actually has meshes before exporting.
    (async function () {
      var deadline = Date.now() + waitSeconds * 1000;
      var info = await requestInfo(5000);
      while ((!info || !info.count) && Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 1500); });
        info = await requestInfo(5000);
      }
      console.debug('[3D Mesh Downloader] deep link: ' +
        (info && info.count ? info.count + ' malha(s) encontrada(s)' : 'nenhuma malha encontrada') +
        ' - exportando');
      window.postMessage({ type: 'MDL_DOWNLOAD', options: options }, '*');
    })();
  }

  window.addEventListener('hashchange', checkDeepLink);
  window.addEventListener('load', checkDeepLink);

  console.debug('[3D Mesh Downloader] content script v' + VERSION);
})();
