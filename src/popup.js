/**
 * 3D Mesh Downloader - popup.js
 *
 * Talks to the active tab through the content script and reflects the state
 * of the captured three.js scenes.
 */
(function () {
  'use strict';

  var els = {
    version: document.getElementById('version'),
    count: document.getElementById('meshCount'),
    label: document.getElementById('meshLabel'),
    scenes: document.getElementById('sceneList'),
    status: document.getElementById('status'),
    download: document.getElementById('downloadBtn'),
    refresh: document.getElementById('refreshBtn'),
    optTransforms: document.getElementById('optTransforms'),
    optNormals: document.getElementById('optNormals'),
    optUvs: document.getElementById('optUvs'),
    optInstances: document.getElementById('optInstances'),
    optMaterials: document.getElementById('optMaterials'),
    optCombine: document.getElementById('optCombine')
  };

  var currentCount = 0;
  var pollTimer = null;

  function showStatus(message, type) {
    els.status.textContent = message;
    els.status.className = 'status show ' + (type || 'ok');
  }

  function hideStatus() {
    els.status.className = 'status';
  }

  function renderInfo(info) {
    if (!info) return;
    currentCount = info.count || 0;
    els.count.textContent = currentCount;
    els.label.textContent = currentCount === 1 ? 'malha encontrada' : 'malhas encontradas';
    els.download.disabled = currentCount === 0;

    els.scenes.textContent = '';
    (info.scenes || []).forEach(function (scene) {
      var row = document.createElement('div');
      var name = document.createElement('span');
      name.textContent = scene.name;
      name.title = (scene.meshNames || []).join(', ');
      var count = document.createElement('span');
      count.textContent = scene.meshes + ' malha(s)';
      row.appendChild(name);
      row.appendChild(count);
      els.scenes.appendChild(row);
    });
  }

  function activeTabId(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs.length || tabs[0].id == null) {
        callback(null);
        return;
      }
      callback(tabs[0].id);
    });
  }

  function requestInfo() {
    activeTabId(function (tabId) {
      if (tabId == null) {
        showStatus('Nao foi possivel acessar a aba ativa.', 'err');
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: 'MDL_GET_INFO' }, function () {
        if (chrome.runtime.lastError) {
          els.count.textContent = '-';
          els.download.disabled = true;
          showStatus('Recarregue a pagina para ativar a extensao nesta aba.', 'err');
        }
      });
    });
  }

  function currentOptions() {
    return {
      applyTransforms: els.optTransforms.checked,
      normals: els.optNormals.checked ? 'auto' : 'none',
      uvs: els.optUvs.checked ? 'on' : 'none',
      expandInstances: els.optInstances.checked,
      materials: els.optMaterials.checked ? 'on' : 'none',
      combine: els.optCombine.checked
    };
  }

  function download() {
    if (currentCount === 0) {
      showStatus('Nenhuma malha encontrada.', 'err');
      return;
    }
    hideStatus();
    els.download.disabled = true;
    els.download.innerHTML = 'Gerando<span class="spin"></span>';

    activeTabId(function (tabId) {
      if (tabId == null) {
        resetButton();
        showStatus('Nao foi possivel acessar a aba ativa.', 'err');
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: 'MDL_DOWNLOAD', options: currentOptions() }, function () {
        if (chrome.runtime.lastError) {
          resetButton();
          showStatus('Recarregue a pagina e tente de novo.', 'err');
        }
      });
    });
  }

  function resetButton() {
    els.download.disabled = currentCount === 0;
    els.download.textContent = 'Baixar malhas';
  }

  // --- messages coming from the content script ------------------------------
  chrome.runtime.onMessage.addListener(function (request) {
    if (!request || typeof request !== 'object') return;

    if (request.type === 'MDL_INFO') {
      if (request.version) els.version.textContent = 'v' + request.version;
      renderInfo(request.info);
      hideStatus();
    } else if (request.type === 'MDL_RESULT') {
      var result = request.result || {};
      resetButton();
      if (result.ok) {
        var stats = result.stats || {};
        var detail = filesSummary(result.files, stats);
        showStatus(detail, 'ok');
      } else {
        showStatus(result.message || 'Falha na exportacao.', 'err');
      }
    }
  });

  function filesSummary(files, stats) {
    if (!files || !files.length) return 'Exportado.';
    var text = files.join(', ');
    if (stats && stats.faces) {
      text += ' - ' + stats.faces + ' faces, ' + stats.vertices + ' vertices';
    }
    return text;
  }

  els.download.addEventListener('click', download);

  els.refresh.addEventListener('click', function () {
    els.refresh.textContent = 'Atualizando...';
    requestInfo();
    setTimeout(function () { els.refresh.textContent = 'Atualizar contagem'; }, 700);
  });

  // Poll while the popup stays open so the count follows the page.
  pollTimer = setInterval(requestInfo, 2000);

  window.addEventListener('unload', function () {
    if (pollTimer) clearInterval(pollTimer);
  });

  requestInfo();
})();
