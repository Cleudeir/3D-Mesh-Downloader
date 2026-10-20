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
    optCombine: document.getElementById('optCombine'),
    format: document.getElementById('format'),
    stlNote: document.getElementById('stlNote'),
    optNormalsRow: document.getElementById('optNormalsRow'),
    optUvsRow: document.getElementById('optUvsRow'),
    optMaterialsRow: document.getElementById('optMaterialsRow'),
    combineLabel: document.getElementById('combineLabel'),
    excludeInput: document.getElementById('excludeInput'),
    addExclude: document.getElementById('addExclude'),
    clearExclude: document.getElementById('clearExclude'),
    patternList: document.getElementById('patternList')
  };

  var models = [];            // descriptors coming from the page
  var selection = new Set();  // ids the user wants to export
  var excludePatterns = [];   // names that must never be captured
  var pollTimer = null;
  var lastSignature = '';

  var STORAGE_KEY = 'excludePatterns';

  // ---------------------------------------------------------------------------
  // Lista de exclusao (persistida)
  // ---------------------------------------------------------------------------

  function loadPatterns(callback) {
    try {
      chrome.storage.local.get({ [STORAGE_KEY]: [] }, function (items) {
        var stored = items && items[STORAGE_KEY];
        excludePatterns = Array.isArray(stored) ? stored.slice() : [];
        callback();
      });
    } catch (e) {
      callback();
    }
  }

  function savePatterns() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: excludePatterns });
    } catch (e) {
      /* storage indisponivel: a lista continua valendo na sessao */
    }
  }

  function addPattern(pattern) {
    var p = String(pattern || '').trim();
    if (!p) return;
    if (excludePatterns.indexOf(p) !== -1) return;
    excludePatterns.push(p);
    savePatterns();
    renderPatterns();
    requestInfo();
  }

  function removePattern(pattern) {
    var i = excludePatterns.indexOf(pattern);
    if (i === -1) return;
    excludePatterns.splice(i, 1);
    savePatterns();
    renderPatterns();
    requestInfo();
  }

  function renderPatterns() {
    els.patternList.textContent = '';
    if (!excludePatterns.length) {
      var none = document.createElement('span');
      none.className = 'no-patterns';
      none.textContent = 'nenhum padrao';
      els.patternList.appendChild(none);
      return;
    }
    excludePatterns.forEach(function (pattern) {
      var chip = document.createElement('span');
      chip.className = 'pattern';

      var label = document.createElement('span');
      label.textContent = pattern;

      var x = document.createElement('button');
      x.type = 'button';
      x.textContent = '\u00d7';
      x.title = 'remover padrao';
      x.addEventListener('click', function () { removePattern(pattern); });

      chip.appendChild(label);
      chip.appendChild(x);
      els.patternList.appendChild(chip);
    });
  }

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

  /** The export format currently selected. */
  function currentFormat() {
    var value = els.format && els.format.value;
    return value === 'stl' || value === 'stl-ascii' ? value : 'obj';
  }

  /** Size a model will take in the current format. */
  function sizeForFormat(model, format) {
    if (model.sizes && model.sizes[format] !== undefined) return model.sizes[format];
    return model.sizeBytes || 0;
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

    var size = sizeForFormat(model, currentFormat());

    if (filter.minKB !== null && filter.minKB !== undefined && filter.minKB !== '') {
      if (size < Number(filter.minKB) * 1024) return false;
    }
    if (filter.maxKB !== null && filter.maxKB !== undefined && filter.maxKB !== '') {
      if (size > Number(filter.maxKB) * 1024) return false;
    }

    return true;
  }

  function visibleModels() {
    var filter = currentFilter();
    return models.filter(function (m) { return matchesFilter(m, filter); });
  }

  function selectedVisibleModels() {
    return visibleModels().filter(function (m) {
      return selection.has(m.id) && !m.excluded;
    });
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
    var excluded = info.excludedCount || 0;
    els.label.textContent = excluded
      ? 'malhas encontradas · ' + excluded + ' excluída(s)'
      : (info.count === 1 ? 'malha encontrada' : 'malhas encontradas');

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
      if (model.excluded) label.classList.add('excluded');

      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !model.excluded && selection.has(model.id);
      box.disabled = !!model.excluded;
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
      bits.push('~' + fmtSize(sizeForFormat(model, currentFormat())));
      meta.textContent = bits.join(' · ');

      // botao de exclusao rapida: alterna o modelo na lista de exclusao
      var excl = document.createElement('button');
      excl.type = 'button';
      excl.className = 'excl';
      excl.textContent = model.excluded ? '\u21ba' : '\u2298';
      excl.title = model.excluded
        ? 'remover da lista de exclusao (' + model.excludedBy + ')'
        : 'nao exportar este modelo';
      excl.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (model.excluded) {
          if (model.excludedBy) removePattern(model.excludedBy);
        } else {
          addPattern(model.name);
        }
      });

      label.appendChild(box);
      label.appendChild(name);
      label.appendChild(meta);
      label.appendChild(excl);
      els.list.appendChild(label);
    });

    els.list.scrollTop = scroll;
  }

  function updateSelectionPill() {
    var selected = selectedVisibleModels();
    var format = currentFormat();
    var total = selected.reduce(function (acc, m) { return acc + sizeForFormat(m, format); }, 0);
    els.pill.textContent = selected.length + '/' + models.length + ' · ~' + fmtSize(total);
    els.download.disabled = selected.length === 0;
    els.download.textContent = selected.length === 1 ? 'Baixar 1 malha' : 'Baixar ' + selected.length + ' malhas';
  }

  /** OBJ-only options do not apply to STL: hide them and explain why. */
  function applyFormatToOptions() {
    var isSTL = currentFormat() !== 'obj';
    els.stlNote.style.display = isSTL ? 'block' : 'none';
    els.optNormalsRow.style.display = isSTL ? 'none' : '';
    els.optUvsRow.style.display = isSTL ? 'none' : '';
    els.optMaterialsRow.style.display = isSTL ? 'none' : '';
    els.combineLabel.firstChild.nodeValue = isSTL
      ? 'Unir tudo em um unico arquivo STL'
      : 'Unir tudo em um unico .obj';
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
      // Sem a permissao "tabs", tab.url chega vazio: quem procura a aba e o
      // service worker, perguntando as content scripts pelo location.href.
      chrome.runtime.sendMessage({ type: 'MDL_FIND_TAB', url: wantedUrl }, function (response) {
        callback(response && response.tabId ? response.tabId : null);
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
      chrome.tabs.sendMessage(tabId, { type: 'MDL_GET_INFO', exclude: excludePatterns }, function () {
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
      format: currentFormat(),
      filter: {
        text: filter.text,
        minKB: filter.minKB,
        maxKB: filter.maxKB,
        include: selectedVisibleModels().map(function (m) { return m.id; }),
        exclude: excludePatterns.slice()
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

  els.format.addEventListener('change', function () {
    applyFormatToOptions();
    renderList();
    updateSelectionPill();
  });

  els.filterText.addEventListener('input', onFilterChange);
  els.filterMinKB.addEventListener('input', onFilterChange);
  els.filterMaxKB.addEventListener('input', onFilterChange);

  els.selectAll.addEventListener('click', function () {
    visibleModels().forEach(function (m) { if (!m.excluded) selection.add(m.id); });
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
    visibleModels().forEach(function (m) { if (!m.excluded) selection.add(m.id); });
    renderList();
    updateSelectionPill();
  });

  // --- lista de exclusao ----------------------------------------------------
  function addFromInput() {
    var value = els.excludeInput.value;
    if (!value.trim()) return;
    addPattern(value);
    els.excludeInput.value = '';
    els.excludeInput.focus();
  }

  els.addExclude.addEventListener('click', addFromInput);
  els.excludeInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addFromInput();
    }
  });
  els.clearExclude.addEventListener('click', function () {
    if (!excludePatterns.length) return;
    excludePatterns = [];
    savePatterns();
    renderPatterns();
    requestInfo();
  });

  // Poll while the popup stays open so the count follows the page.
  pollTimer = setInterval(requestInfo, 2000);

  window.addEventListener('unload', function () {
    if (pollTimer) clearInterval(pollTimer);
  });

  applyFormatToOptions();
  loadPatterns(function () {
    renderPatterns();
    requestInfo();
  });
})();
