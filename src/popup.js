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
    patternList: document.getElementById('patternList'),
    excludePreview: document.getElementById('excludePreview'),
    sizeList: document.getElementById('sizeList'),
    addSizeExclude: document.getElementById('addSizeExclude'),
    clearSizeExclude: document.getElementById('clearSizeExclude'),
    excludeSizeMode: document.getElementById('excludeSizeMode'),
    excludeSizeKB: document.getElementById('excludeSizeKB'),
    tabBadgeModels: document.getElementById('tabBadgeModels'),
    tabBadgeExclude: document.getElementById('tabBadgeExclude')
  };

  var ACTIVE_TAB_KEY = 'popupTab';

  var models = [];            // descriptors coming from the page
  var selection = new Set();  // ids the user wants to export
  var excludePatterns = [];   // lista por nome (curingas)
  var sizeExcluded = [];      // lista por tamanho (nomes exatos, materializados)
  var sizeRule = { mode: 'below', kb: 50 }; // criterio usado para montar a lista
  var sizeScanned = false;    // o scan automatico inicial ja rodou
  var pollTimer = null;
  var exportTimer = null;
  var lastSignature = '';
  var lastInfoSignature = null;
  var exporting = false;     // exportacao em andamento: nao deixa o poll atrapalhar
  var infoFailures = 0;      // falhas seguidas ao falar com a pagina

  var STORAGE_KEY = 'excludePatterns';
  var STORAGE_KEY_SIZE_LIST = 'sizeExcluded';
  var STORAGE_KEY_SIZE_RULE = 'sizeRule';
  var STORAGE_KEY_SCANNED = 'sizeScanned';
  var STORAGE_KEY_SETTINGS = 'settings';
  var DEFAULT_SIZE_RULE = { mode: 'below', kb: 50 };
  // STL e o padrao: e o formato que a maioria quer (impressao 3D) e evita o
  // .obj gigante com .mtl ao lado.
  var DEFAULT_SETTINGS = {
    format: 'stl',
    applyTransforms: true,
    normals: true,
    uvs: true,
    instances: true,
    materials: true,
    combine: true
  };

  // ---------------------------------------------------------------------------
  // Lista de exclusao (persistida)
  // ---------------------------------------------------------------------------

  function loadState(callback) {
    // Le as chaves cruas (array), sem objeto de defaults: com objeto,
    // chrome.storage.local.get() faz merge raso do default com o valor salvo e
    // injeta campos que nao estao gravados.
    var keys = [
      STORAGE_KEY, STORAGE_KEY_SIZE_LIST, STORAGE_KEY_SIZE_RULE,
      STORAGE_KEY_SCANNED, STORAGE_KEY_SETTINGS, ACTIVE_TAB_KEY, 'excludeSize'
    ];

    function apply(items) {
      items = items || {};

      var stored = items[STORAGE_KEY];
      excludePatterns = Array.isArray(stored) ? stored.slice() : [];

      var savedList = items[STORAGE_KEY_SIZE_LIST];
      sizeExcluded = Array.isArray(savedList) ? savedList.filter(Boolean).map(String) : [];
      sizeScanned = items[STORAGE_KEY_SCANNED] === true;

      // criterio: chave nova; a antiga (excludeSize) serve de migracao
      var rule = items[STORAGE_KEY_SIZE_RULE] || items.excludeSize;
      sizeRule = { mode: DEFAULT_SIZE_RULE.mode, kb: DEFAULT_SIZE_RULE.kb };
      if (rule && typeof rule === 'object') {
        if (rule.mode === 'above' || rule.mode === 'below') sizeRule.mode = rule.mode;
        if (isFinite(Number(rule.kb)) && Number(rule.kb) >= 0) sizeRule.kb = Number(rule.kb);
      }

      applySettings(items[STORAGE_KEY_SETTINGS]);
      renderSizeRule();
      renderSizeList();
      selectTab(items[ACTIVE_TAB_KEY] || 'modelos');
      callback();
    }

    try {
      chrome.storage.local.get(keys, apply);
    } catch (e) {
      apply({});
    }
  }

  /** Objeto de configuracoes salvo (combine NAO entra: ver applySettings). */
  function readSettingsFromForm() {
    return {
      format: currentFormat(),
      applyTransforms: els.optTransforms.checked,
      normals: els.optNormals.checked,
      uvs: els.optUvs.checked,
      instances: els.optInstances.checked,
      materials: els.optMaterials.checked
    };
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: readSettingsFromForm() });
    } catch (e) {
      /* storage indisponivel */
    }
  }

  /** Restaura formato e opcoes salvas (o que nao vier fica no padrao). */
  function applySettings(settings) {
    var s = settings && typeof settings === 'object' ? settings : {};
    var format = s.format;
    els.format.value = format === 'obj' || format === 'stl-ascii' || format === 'stl'
      ? format
      : DEFAULT_SETTINGS.format;
    els.optTransforms.checked = s.applyTransforms !== false;
    els.optNormals.checked = s.normals !== false;
    els.optUvs.checked = s.uvs !== false;
    els.optInstances.checked = s.instances !== false;
    els.optMaterials.checked = s.materials !== false;
    // "unir tudo" fica sempre ligado ao abrir: com varios arquivos o Chrome
    // bloqueia downloads multiplos e o usuario recebe so o primeiro (era o
    // "veio so 1 esfera"). Se quiser arquivos separados, desmarque na sessao.
    els.optCombine.checked = true;
  }

  function savePatterns() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: excludePatterns });
    } catch (e) {
      /* storage indisponivel: a lista continua valendo na sessao */
    }
  }

  function saveSizeList() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY_SIZE_LIST]: sizeExcluded });
    } catch (e) {
      /* storage indisponivel */
    }
  }

  function saveSizeRule() {
    try {
      var payload = {};
      payload[STORAGE_KEY_SIZE_RULE] = sizeRule;
      payload[STORAGE_KEY_SCANNED] = sizeScanned;
      chrome.storage.local.set(payload);
    } catch (e) {
      /* storage indisponivel */
    }
  }

  /** Espelha o criterio salvo nos campos. */
  function renderSizeRule() {
    if (!els.excludeSizeMode) return;
    els.excludeSizeMode.value = sizeRule.mode;
    els.excludeSizeKB.value = String(sizeRule.kb);
  }

  /** Desenha a lista "por tamanho" (nomes concretos, com × para devolver). */
  function renderSizeList() {
    if (!els.sizeList) return;
    els.sizeList.textContent = '';

    if (!sizeExcluded.length) {
      var none = document.createElement('span');
      none.className = 'no-patterns';
      none.textContent = 'nenhum nome';
      els.sizeList.appendChild(none);
      updateExcludeBadge();
      return;
    }

    sizeExcluded.forEach(function (name) {
      var chip = document.createElement('span');
      chip.className = 'pattern';

      var label = document.createElement('span');
      label.textContent = name;
      label.title = 'excluido por tamanho';

      var x = document.createElement('button');
      x.type = 'button';
      x.textContent = '\u00d7';
      x.title = 'devolver este modelo';
      x.addEventListener('click', function () { removeSizeExcluded(name); });

      chip.appendChild(label);
      chip.appendChild(x);
      els.sizeList.appendChild(chip);
    });

    updateExcludeBadge();
  }

  /** Tira um nome da lista por tamanho (o modelo volta a ser exportavel). */
  function removeSizeExcluded(name) {
    var i = sizeExcluded.indexOf(name);
    if (i === -1) return;
    sizeExcluded.splice(i, 1);
    saveSizeList();
    renderSizeList();
    requestInfo();
  }

  /**
   * Varre os modelos e adiciona os que casam com o criterio de tamanho.
   * Cada nome entra UMA vez e fica: nao existe reavaliacao a cada poll, entao
   * a lista nao fica piscando.
   */
  function scanBySize() {
    var format = currentFormat();
    var limit = sizeRule.kb * 1024;
    var added = 0;

    models.forEach(function (model) {
      var size = sizeForFormat(model, format);
      var hit = sizeRule.mode === 'below' ? size < limit : size > limit;
      if (!hit) return;
      // exportName e unico por malha (X, X_1, X_2...): evita que um modelo
      // grande com nome repetido caia junto com um pequeno homonimo
      var entry = model.exportName || model.name;
      if (sizeExcluded.indexOf(entry) !== -1) return;
      sizeExcluded.push(entry);
      added++;
    });

    if (added) {
      saveSizeList();
      renderSizeList();
      requestInfo();
    }
    return added;
  }

  /** Badge = padroes de nome + nomes da lista de tamanho. */
  function updateExcludeBadge() {
    setBadge(els.tabBadgeExclude, excludePatterns.length + sizeExcluded.length);
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
    updateExcludeBadge();
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

  /** Shows a count on a tab badge, or hides it when the count is zero. */
  function setBadge(el, value) {
    if (!el) return;
    if (value > 0) {
      el.textContent = String(value);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Abas (estilo Chrome)
  //
  // A aba ativa fica gravada no storage, para o popup reabrir onde o usuario
  // parou - igual o Chrome restaura a ultima aba ativa.
  // ---------------------------------------------------------------------------

  var tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = {};
  tabButtons.forEach(function (button) {
    var panel = document.getElementById(button.getAttribute('aria-controls'));
    if (panel) panels[button.dataset.tab] = panel;
  });

  function selectTab(name, moveFocus) {
    if (!panels[name]) name = 'modelos';
    tabButtons.forEach(function (button) {
      var on = button.dataset.tab === name;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
      if (on && moveFocus) button.focus();
    });
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== name;
    });
    try { chrome.storage.local.set({ [ACTIVE_TAB_KEY]: name }); } catch (e) { /* storage indisponivel */ }
  }

  tabButtons.forEach(function (button, index) {
    button.addEventListener('click', function () { selectTab(button.dataset.tab); });
    button.addEventListener('keydown', function (event) {
      var delta = event.key === 'ArrowRight' ? 1 : (event.key === 'ArrowLeft' ? -1 : 0);
      if (delta) {
        event.preventDefault();
        var next = (index + delta + tabButtons.length) % tabButtons.length;
        selectTab(tabButtons[next].dataset.tab, true);
        return;
      }
      if (/^[1-9]$/.test(event.key) && tabButtons[Number(event.key) - 1]) {
        event.preventDefault();
        selectTab(tabButtons[Number(event.key) - 1].dataset.tab, true);
      }
    });
  });

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

    // Primeiro contato com a pagina: monta a lista "por tamanho" uma unica vez.
    // Depois disso ela so muda quando o usuario clica em Adicionar ou remove
    // um nome - e por isso que a lista nao fica piscando.
    if (!sizeScanned && models.length) {
      sizeScanned = true;
      saveSizeRule();
      scanBySize();
    }

    // O popup consulta a pagina a cada 2 s. Reconstruir as listas quando nada
    // mudou zerava o scroll a cada poll (o usuario nao conseguia rolar as
    // excluidas), entao so redesenha quando o conteudo realmente muda.
    var signature = models.map(function (m) {
      return m.id + '|' + m.name + '|' + (m.excluded ? 1 : 0) + '|' + (m.excludedBy || '') +
        '|' + (m.vertexCount || 0) + '|' + (m.faceCount || 0) + '|' + (m.instances || 1);
    }).join(',');

    if (signature !== lastInfoSignature) {
      lastInfoSignature = signature;
      renderList();
      renderExcludePreview();
    }
    updateSelectionPill();
  }

  /** Models currently dropped by the exclusion list (the "Exclusão" tab preview). */
  function renderExcludePreview() {
    if (!els.excludePreview) return;
    var scroll = els.excludePreview.scrollTop;
    var excluded = models.filter(function (m) { return m.excluded; });

    els.excludePreview.textContent = '';
    if (!excluded.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      none.textContent = 'nenhuma - nenhuma malha esta sendo excluida';
      els.excludePreview.appendChild(none);
      els.excludePreview.scrollTop = 0;
      return;
    }

    excluded.forEach(function (model) {
      var row = document.createElement('div');
      row.className = 'hit';

      var name = document.createElement('span');
      name.className = 'mname';
      name.textContent = model.name;
      name.style.textDecoration = 'line-through';
      name.title = 'excluido pelo padrao ' + (model.excludedBy || '?');

      var meta = document.createElement('span');
      meta.className = 'mmeta';
      meta.textContent = (model.excludedBy || '?') + ' · ' + fmtCount(model.faceCount) + 'f';

      row.appendChild(name);
      row.appendChild(meta);
      els.excludePreview.appendChild(row);
    });

    els.excludePreview.scrollTop = scroll;
  }

  function renderList() {
    // Os exportaveis ficam no topo; os excluidos vao para o fim da lista.
    // O sort do JS e estavel, entao a ordem original se mantem dentro de cada grupo.
    var visible = visibleModels().slice().sort(function (a, b) {
      return (a.excluded ? 1 : 0) - (b.excluded ? 1 : 0);
    });
    var scroll = els.list.scrollTop;
    var previousBlock = els.list.querySelector('.excluded-block');
    var blockScroll = previousBlock ? previousBlock.scrollTop : 0;

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

    var excludedCount = visible.filter(function (m) { return m.excluded; }).length;
    var excludedBlock = null;

    visible.forEach(function (model) {
      if (model.excluded && !excludedBlock) {
        var divider = document.createElement('div');
        divider.className = 'list-divider';
        divider.textContent = 'excluídas (' + excludedCount + ')';
        els.list.appendChild(divider);

        // O bloco de excluidas rola sozinho: da para percorrer os nomes sem
        // arrastar a lista de exportaveis junto.
        excludedBlock = document.createElement('div');
        excludedBlock.className = 'excluded-block';
        els.list.appendChild(excludedBlock);
      }

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
      var excludedBySize = model.excludedBy === 'tamanho';
      excl.title = model.excluded
        ? (excludedBySize
            ? 'excluido pela lista de tamanho (clique para devolver)'
            : 'remover da lista de exclusao (' + model.excludedBy + ')')
        : 'nao exportar este modelo';
      excl.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (model.excluded) {
          if (excludedBySize) removeSizeExcluded(model.exportName || model.name);
          else if (model.excludedBy) removePattern(model.excludedBy);
        } else {
          addPattern(model.name);
        }
      });

      label.appendChild(box);
      label.appendChild(name);
      label.appendChild(meta);
      label.appendChild(excl);
      (excludedBlock && model.excluded ? excludedBlock : els.list).appendChild(label);
    });

    if (excludedBlock) excludedBlock.scrollTop = blockScroll;
    els.list.scrollTop = scroll;
  }

  function updateSelectionPill() {
    var selected = selectedVisibleModels();
    var format = currentFormat();
    var total = selected.reduce(function (acc, m) { return acc + sizeForFormat(m, format); }, 0);
    els.pill.textContent = selected.length + '/' + models.length + ' · ~' + fmtSize(total);
    // durante a exportacao o botao fica em "Gerando..." - o poll nao pode desfazer
    if (!exporting) {
      els.download.disabled = selected.length === 0;
      els.download.textContent = selected.length === 1 ? 'Baixar 1 malha' : 'Baixar ' + selected.length + ' malhas';
    }
    setBadge(els.tabBadgeModels, selected.length);
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
    if (exporting) return; // pagina ocupada gerando o arquivo
    activeTabId(function (tabId) {
      if (tabId == null) {
        infoFailures++;
        if (!exporting && infoFailures >= 2) {
          showStatus('Nao foi possivel acessar a aba ativa.', 'err');
        }
        return;
      }
      chrome.tabs.sendMessage(tabId, {
        type: 'MDL_GET_INFO',
        exclude: excludePatterns,
        excludeExact: sizeExcluded,
        format: currentFormat()
      }, function () {
        if (chrome.runtime.lastError) {
          infoFailures++;
          // uma falha isolada e normal enquanto a pagina esta ocupada; so
          // avisa quando o problema persiste
          if (exporting || infoFailures < 2) return;
          els.count.textContent = '-';
          els.download.disabled = true;
          showStatus('Recarregue a pagina para ativar a extensao nesta aba.', 'err');
        } else {
          infoFailures = 0;
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
        exclude: excludePatterns.slice(),
        excludeExact: sizeExcluded.slice()
      }
    };
  }

  function download() {
    var selected = selectedVisibleModels();
    if (!selected.length) {
      showStatus('Nenhuma malha selecionada.', 'err');
      return;
    }
    // Um arquivo por malha = N downloads; o Chrome bloqueia downloads multiplos
    // e o usuario recebe so o primeiro. Melhor avisar do que entregar 1 e calar.
    if (!els.optCombine.checked && selected.length > 1) {
      showStatus('Sao ' + selected.length + ' malhas e "Unir tudo em um unico arquivo" esta ' +
        'desmarcado: o Chrome bloquearia os ' + selected.length + ' downloads e chegaria so o ' +
        'primeiro. Marque a opcao na aba Exportar (ou selecione 1 malha).', 'err');
      return;
    }
    hideStatus();
    exporting = true;
    els.download.disabled = true;
    els.download.innerHTML = 'Gerando<span class="spin"></span>';

    // rede de seguranca: se a pagina nunca responder, o botao nao fica travado
    if (exportTimer) clearTimeout(exportTimer);
    exportTimer = setTimeout(function () {
      if (!exporting) return;
      exporting = false;
      resetButton();
      showStatus('A exportacao demorou demais. Se o arquivo nao apareceu, tente com menos malhas.', 'err');
    }, 180000);

    activeTabId(function (tabId) {
      if (tabId == null) {
        exporting = false;
        resetButton();
        showStatus('Nao foi possivel acessar a aba ativa.', 'err');
        return;
      }
      chrome.tabs.sendMessage(tabId, { type: 'MDL_DOWNLOAD', options: currentOptions() }, function () {
        if (chrome.runtime.lastError) {
          exporting = false;
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
      if (request.version) {
        els.version.textContent = 'v' + request.version;
        var extensionVersion = '';
        try { extensionVersion = chrome.runtime.getManifest().version; } catch (e) { /* sem manifest */ }
        // A pagina guarda a copia do content script injetada quando ela carregou.
        // Se a extensao foi recarregada depois, a pagina continua rodando a
        // versao antiga (e ignora recursos novos, como a regra de tamanho).
        if (extensionVersion && request.version !== extensionVersion) {
          els.version.classList.add('stale');
          els.version.title = 'A pagina esta com a versao ' + request.version +
            ' e a extensao instalada e ' + extensionVersion + '. Recarregue a pagina (F5).';
        } else {
          els.version.classList.remove('stale');
          els.version.title = '';
        }
      }
      var signature = (request.info.models || []).map(function (m) { return m.id; }).join(',');
      renderInfo(request.info);
      if (signature !== lastSignature) {
        lastSignature = signature;
        hideStatus();
      }
    } else if (request.type === 'MDL_RESULT') {
      var result = request.result || {};
      exporting = false;
      if (exportTimer) { clearTimeout(exportTimer); exportTimer = null; }
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
    saveSettings();
    // o tamanho estimado muda com o formato: a regra de tamanho precisa saber
    requestInfo();
  });

  // formato e opcoes ficam salvos: reabrir o popup nao volta tudo ao padrao
  [els.optTransforms, els.optNormals, els.optUvs,
   els.optInstances, els.optMaterials, els.optCombine].forEach(function (box) {
    box.addEventListener('change', function () {
      saveSettings();
      updateSelectionPill();
    });
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

  // --- lista por tamanho ----------------------------------------------------
  function onSizeRuleChange() {
    var kb = Number(els.excludeSizeKB.value);
    if (!isFinite(kb) || kb < 0) kb = 0;
    sizeRule = {
      mode: els.excludeSizeMode.value === 'below' ? 'below' : 'above',
      kb: kb
    };
    saveSizeRule();
  }

  els.excludeSizeMode.addEventListener('change', onSizeRuleChange);
  els.excludeSizeKB.addEventListener('input', onSizeRuleChange);

  els.addSizeExclude.addEventListener('click', function () {
    onSizeRuleChange();
    sizeScanned = true;
    saveSizeRule();
    var added = scanBySize();
    showStatus(added
      ? added + (added === 1 ? ' nome adicionado' : ' nomes adicionados') + ' a lista por tamanho.'
      : 'Nenhum nome novo casou com o criterio.',
      added ? 'ok' : '');
  });

  els.clearSizeExclude.addEventListener('click', function () {
    if (!sizeExcluded.length) return;
    sizeExcluded = [];
    saveSizeList();
    renderSizeList();
    requestInfo();
  });

  // Poll while the popup stays open so the count follows the page.
  pollTimer = setInterval(requestInfo, 2000);

  window.addEventListener('unload', function () {
    if (pollTimer) clearInterval(pollTimer);
    if (exportTimer) clearTimeout(exportTimer);
  });

  loadState(function () {
    applyFormatToOptions();
    renderPatterns();
    requestInfo();
  });
})();
