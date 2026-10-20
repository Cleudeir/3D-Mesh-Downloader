/**
 * 3D Mesh Downloader - popup.js
 *
 * Talks to the active tab through the content script, lists the models found
 * and lets the user filter them by name text and by estimated size before
 * exporting.
 */
(function () {
  'use strict';

  var els = {
    version: document.getElementById('version'),
    count: document.getElementById('meshCount'),
    label: document.getElementById('meshLabel'),
    pill: document.getElementById('selectionPill'),
    list: document.getElementById('modelList'),
    status: document.getElementById('status'),
    download: document.getElementById('downloadBtn'),
    refresh: document.getElementById('refreshBtn'),
    filterText: document.getElementById('filterText'),
    filterMinKB: document.getElementById('filterMinKB'),
    filterMaxKB: document.getElementById('filterMaxKB'),
    selectAll: document.getElementById('selectAll'),
    selectNone: document.getElementById('selectNone'),
    selectVisible: document.getElementById('selectVisible'),
    optTransforms: document.getElementById('optTransforms'),
    optNormals: document.getElementById('optNormals'),
    optUvs: document.getElementById('optUvs'),
    optInstances: document.getElementById('optInstances'),
    optMaterials: document.getElementById('optMaterials'),
    optCombine: document.getElementById('optCombine')
  };

  var models = [];            // descriptors coming from the page
  var selection = new Set();  // ids the user wants to export
  var pollTimer = null;
  var lastSignature = '';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function showStatus(message, type) {
    els.status.textContent = message;
    els.status.className = 'status show ' + (type || 'ok');
  }

  function hideStatus() {
    els.status.className = 'status';
  }

  function fmtSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fmtCount(n) {
    return n.toLocaleString('pt-BR');
  }

  /** The filter currently typed by the user. */
  function currentFilter() {
    return {
      text: els.filterText.value.trim(),
      minKB: els.filterMinKB.value === '' ? null : Number(els.filterMinKB.value),
      maxKB: els.filterMaxKB.value === '' ? null : Number(els.filterMaxKB.value)
    };
  }

  /** Same rules as injected.js -> matchesFilter(). */
  function matchesFilter(model, filter) {
    if (!filter) return true;

    if (filter.text) {
      var needle = filter.text.toLowerCase();
      var haystack = (model.name + ' ' + (model.scene || '') + ' ' + (model.materials || []).join(' ')).toLowerCase();
      if (haystack.indexOf(needle) === -1) return false;
    }

    if (filter.minKB !== null && filter.minKB !== undefined && filter.minKB !== '') {
      if (model.sizeBytes < Number(filter.minKB) * 1024) return false;
    }
    if (filter.maxKB !== null && filter.maxKB !== undefined && filter.maxKB !== '') {
      if (model.sizeBytes > Number(filter.maxKB) * 1024) return false;
    }

    return true;
  }

  function visibleModels() {
    var filter = currentFilter();
    return models.filter(function (m) { return matchesFilter(m, filter); });
  }

  function selectedVisibleModels() {
    return visibleModels().filter(function (m) { return selection.has(m.id); });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderInfo(info) {
    if (!info) return;

    var previous = models;
    models = info.models || [];

    // keep the current selection for models that still exist; new ones start
    // selected so a fresh page just exports everything.
    var known = new Set(previous.map(function (m) { return m.id; }));
    var stillThere = new Set();
    models.forEach(function (m) {
      if (known.has(m.id)) stillThere.add(m.id);
    });
    selection.forEach(function (id) {
      if (!stillThere.has(id)) selection.delete(id);
    });
    models.forEach(function (m) {
      if (!known.has(m.id)) selection.add(m.id);
    });

    els.count.textContent = info.count || 0;
    els.label.textContent = info.count === 1 ? 'malha encontrada' : 'malhas encontradas';

    renderList();
    updateSelectionPill();
  }

  function renderList() {
    var visible = visibleModels();
    var scroll = els.list.scrollTop;

    els.list.textContent = '';

    if (!models.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'nenhuma malha encontrada';
      els.list.appendChild(empty);
      return;
    }

    if (!visible.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      none.textContent = 'nenhum modelo corresponde ao filtro';
      els.list.appendChild(none);
      return;
    }

    visible.forEach(function (model) {
      var label = document.createElement('label');
      label.title = model.name + ' - cena: ' + (model.scene || '?');

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selection.has(model.id);
      box.addEventListener('change', function () {
        if (box.checked) selection.add(model.id);
        else selection.delete(model.id);
        updateSelectionPill();
      });

      var name = document.createElement('span');
      name.className = 'mname';
      name.textContent = model.name;

      var meta = document.createElement('span');
      meta.className = 'mmeta';
      var bits = [fmtCount(model.vertexCount) + 'v', fmtCount(model.faceCount) + 'f'];
      if (model.instances > 1) bits.push('x' + model.instances);
      bits.push('~' + fmtSize(model.sizeBytes));
      meta.textContent = bits.join(' · ');

      label.appendChild(box);
      label.appendChild(name);
      label.appendChild(meta);
      els.list.appendChild(label);
    });

    els.list.scrollTop = scroll;
  }

  function updateSelectionPill() {
    var selected = selectedVisibleModels();
    var total = selected.reduce(function (acc, m) { return acc + m.sizeBytes; }, 0);
    els.pill.textContent = selected.length + '/' + models.length + ' · ~' + fmtSize(total);
    els.download.disabled = selected.length === 0;
    els.download.textContent = selected.length === 1 ? 'Baixar 1 malha' : 'Baixar ' + selected.length + ' malhas';
  }

  // ---------------------------------------------------------------------------
  // Tab communication
  // ---------------------------------------------------------------------------

  /**
   * Which tab the popup acts on.
   *
   * By default it is the active tab of the current window, but the popup can
   * be deep-linked to a specific tab:
   *   popup.html?tabId=123
   *   popup.html?url=https://example.com/path
   * This is what makes it possible to drive the popup from an automation tool
   * (the popup is then open in a tab of its own).
   */
  function resolveTargetTabId(callback) {
    var params = new URLSearchParams(location.search);
    var wantedId = params.get('tabId');
    var wantedUrl = params.get('url');

    if (wantedId) {
      callback(Number(wantedId));
      return;
    }

    if (wantedUrl) {
      chrome.tabs.query({}, function (tabs) {
        var match = (tabs || []).filter(function (tab) {
          return tab.url && tab.url.indexOf(wantedUrl) === 0;
        })[0];
        callback(match ? match.id : null);
      });
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs.length || tabs[0].id == null) {
        callback(null);
        return;
      }
      callback(tabs[0].id);
    });
  }

  function activeTabId(callback) {
    resolveTargetTabId(callback);
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
    var filter = currentFilter();
    return {
      applyTransforms: els.optTransforms.checked,
      normals: els.optNormals.checked ? 'auto' : 'none',
      uvs: els.optUvs.checked ? 'on' : 'none',
      expandInstances: els.optInstances.checked,
      materials: els.optMaterials.checked ? 'on' : 'none',
      combine: els.optCombine.checked,
      filter: {
        text: filter.text,
        minKB: filter.minKB,
        maxKB: filter.maxKB,
        include: selectedVisibleModels().map(function (m) { return m.id; })
      }
    };
  }

  function download() {
    var selected = selectedVisibleModels();
    if (!selected.length) {
      showStatus('Nenhuma malha selecionada.', 'err');
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
    updateSelectionPill();
  }

  // ---------------------------------------------------------------------------
  // Messages coming from the content script
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (request) {
    if (!request || typeof request !== 'object') return;

    if (request.type === 'MDL_INFO') {
      if (request.version) els.version.textContent = 'v' + request.version;
      var signature = (request.info.models || []).map(function (m) { return m.id; }).join(',');
      renderInfo(request.info);
      if (signature !== lastSignature) {
        lastSignature = signature;
        hideStatus();
      }
    } else if (request.type === 'MDL_RESULT') {
      var result = request.result || {};
      resetButton();
      if (result.ok) {
        showStatus(filesSummary(result), 'ok');
      } else {
        showStatus(result.message || 'Falha na exportacao.', 'err');
      }
    }
  });

  function filesSummary(result) {
    var stats = result.stats || {};
    var parts = [];
    if (result.files && result.files.length) parts.push(result.files.join(', '));
    if (stats.faces) {
      parts.push(fmtCount(stats.faces) + ' faces · ' + fmtCount(stats.vertices) + ' vertices · ' +
        fmtCount(stats.meshes) + ' objetos');
    }
    if (result.bytes) parts.push(fmtSize(result.bytes));
    return parts.join(' — ');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  els.download.addEventListener('click', download);

  els.refresh.addEventListener('click', function () {
    els.refresh.textContent = 'Atualizando...';
    requestInfo();
    setTimeout(function () { els.refresh.textContent = 'Atualizar contagem'; }, 700);
  });

  function onFilterChange() {
    renderList();
    updateSelectionPill();
  }

  els.filterText.addEventListener('input', onFilterChange);
  els.filterMinKB.addEventListener('input', onFilterChange);
  els.filterMaxKB.addEventListener('input', onFilterChange);

  els.selectAll.addEventListener('click', function () {
    visibleModels().forEach(function (m) { selection.add(m.id); });
    renderList();
    updateSelectionPill();
  });

  els.selectNone.addEventListener('click', function () {
    visibleModels().forEach(function (m) { selection.delete(m.id); });
    renderList();
    updateSelectionPill();
  });

  els.selectVisible.addEventListener('click', function () {
    selection.clear();
    visibleModels().forEach(function (m) { selection.add(m.id); });
    renderList();
    updateSelectionPill();
  });

  // Poll while the popup stays open so the count follows the page.
  pollTimer = setInterval(requestInfo, 2000);

  window.addEventListener('unload', function () {
    if (pollTimer) clearInterval(pollTimer);
  });

  requestInfo();
})();
