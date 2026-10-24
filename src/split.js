/**
 * Página do divisor 3MF por paint_color.
 *
 * Lê o arquivo local, delega o parse/exportação para split/3mf.js e usa o
 * renderizador do Estúdio IA para a prévia por grupo de cor.
 */
(function () {
  'use strict';

  var els = {};
  [
    'drop', 'chooseFile', 'fileInput', 'fileInfo', 'fileName', 'fileSize',
    'optionsPanel', 'format', 'applyTransforms',
    'summaryPanel', 'statTriangles', 'statGroups', 'statObjects', 'dims', 'warnings',
    'groupsPanel', 'groups', 'allGroups', 'zip', 'clear', 'colorNote',
    'singleStl',
    'preview', 'empty', 'previewTitle', 'status', 'fit', 'views'
  ].forEach(function (id) { els[id] = document.getElementById(id); });
  els.views = document.querySelector('.views');

  var renderer = null;
  var state = {
    buffer: null,
    fileName: '',
    result: null,
    hidden: {},
    view: 'perspective',
    token: 0,
    parsing: false,
    singleUrl: null
  };

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function formatInt(value) {
    return Number(value || 0).toLocaleString('pt-BR');
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return (value / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB';
    if (value >= 1024) return (value / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' KB';
    return value + ' B';
  }

  function formatSize(size) {
    if (!size) return '—';
    var biggest = Math.max(size[0], size[1], size[2]);
    if (biggest >= 100) {
      return size.map(function (value) { return (value / 10).toFixed(1); }).join(' × ') + ' cm';
    }
    return size.map(function (value) { return value.toFixed(1); }).join(' × ') + ' mm';
  }

  function markView(view) {
    if (!els.views) return;
    els.views.querySelectorAll('button[data-view]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.view === view);
    });
  }

  function baseName() {
    return String(state.fileName || 'modelo').replace(/\.3mf$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
  }

  function saveFile(name, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function mimeFor(format) {
    if (format === 'obj') return 'text/plain';
    if (format === 'ply') return 'text/plain';
    return 'model/stl';
  }

  function updatePreview() {
    if (!state.result) {
      renderer.setModel([]);
      els.empty.hidden = false;
      return;
    }
    var parts = state.result.groups.filter(function (group) {
      return !state.hidden[group.id];
    }).map(function (group) {
      return {
        name: group.name,
        color: group.color,
        positions: group.positions
      };
    });
    renderer.setModel(parts);
    renderer.setView(state.view);
    els.empty.hidden = parts.length > 0;
    els.previewTitle.textContent = 'Prévia 3D · ' + parts.length + ' de ' + state.result.groups.length + ' grupo(s)';
  }

  function renderWarnings(warnings) {
    els.warnings.textContent = '';
    (warnings || []).slice(0, 4).forEach(function (warning) {
      var item = document.createElement('span');
      item.textContent = warning;
      els.warnings.appendChild(item);
    });
  }

  function renderGroups() {
    els.groups.textContent = '';
    if (!state.result) return;
    var format = els.format.value.toUpperCase();
    state.result.groups.forEach(function (group) {
      var row = document.createElement('div');
      row.className = 'group' + (state.hidden[group.id] ? ' hidden' : '');
      row.dataset.id = group.id;

      var swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = group.color || '#5b6cff';
      swatch.title = group.color || '';

      var info = document.createElement('div');
      info.className = 'ginfo';
      var name = document.createElement('b');
      name.textContent = group.name;
      var meta = document.createElement('span');
      meta.textContent = formatInt(group.triangles) + ' triângulos · ' + formatSize(group.size);
      info.appendChild(name);
      info.appendChild(meta);

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mini';
      toggle.dataset.toggle = group.id;
      toggle.textContent = state.hidden[group.id] ? 'Mostrar' : 'Ocultar';
      toggle.title = state.hidden[group.id] ? 'Mostrar na prévia' : 'Ocultar da prévia';

      var download = document.createElement('button');
      download.type = 'button';
      download.className = 'mini';
      download.dataset.download = group.id;
      download.textContent = format;
      download.title = 'Baixar ' + group.name + ' em ' + format;

      row.appendChild(swatch);
      row.appendChild(info);
      row.appendChild(toggle);
      row.appendChild(download);
      els.groups.appendChild(row);
    });
  }

  function revokeSingleLink() {
    if (state.singleUrl) {
      URL.revokeObjectURL(state.singleUrl);
      state.singleUrl = null;
    }
    if (els.singleStl) {
      els.singleStl.removeAttribute('href');
      els.singleStl.removeAttribute('download');
      els.singleStl.setAttribute('aria-disabled', 'true');
      els.singleStl.title = '';
    }
  }

  function prepareSingleLink(result) {
    revokeSingleLink();
    if (!result || !result.groups.length) return;
    var output = Split3mf.exportSingleStl(result.groups, state.fileName);
    var blob = new Blob([output.data], { type: 'model/stl' });
    state.singleUrl = URL.createObjectURL(blob);
    els.singleStl.href = state.singleUrl;
    els.singleStl.download = output.name;
    els.singleStl.setAttribute('aria-disabled', 'false');
    els.singleStl.title = 'Baixar ' + output.name + ' · ' + result.groups.length + ' solid(s)';
  }

  function renderResult(result) {
    state.result = result;
    state.hidden = {};
    prepareSingleLink(result);
    els.optionsPanel.hidden = false;
    els.summaryPanel.hidden = false;
    els.groupsPanel.hidden = false;
    els.fileInfo.hidden = false;
    els.statTriangles.textContent = formatInt(result.triangles);
    els.statGroups.textContent = String(result.groups.length);
    els.statObjects.textContent = String(result.objects);
    els.dims.textContent = 'Dimensões: ' + formatSize(result.size) + ' · unidade do 3MF: ' + (result.unit || 'millimeter');
    renderWarnings(result.warnings);
    renderGroups();
    els.colorNote.textContent = result.colors.length
      ? 'Cores dos filamentos do projeto: ' + result.colors.join(', ') + '. A prévia usa essa ordem.'
      : 'O projeto não informou filamentos; as cores da prévia são estimadas.';
    els.previewTitle.textContent = 'Prévia 3D';
    updatePreview();
    var kind = result.warnings.length ? 'warn' : 'ok';
    setStatus(result.groups.length + ' grupo(s) · ' + formatInt(result.triangles) + ' triângulos · pronto', kind);
  }

  async function parseBuffer() {
    if (!state.buffer) return;
    var token = ++state.token;
    state.parsing = true;
    setStatus('lendo ZIP e separando os paint_colors...', '');
    try {
      var result = await Split3mf.parse(state.buffer, {
        applyTransforms: els.applyTransforms.checked
      });
      if (token !== state.token) return;
      state.parsing = false;
      renderResult(result);
    } catch (error) {
      if (token !== state.token) return;
      state.parsing = false;
      state.result = null;
      revokeSingleLink();
      renderer.setModel([]);
      els.empty.hidden = false;
      els.optionsPanel.hidden = true;
      els.summaryPanel.hidden = true;
      els.groupsPanel.hidden = true;
      setStatus('não foi possível ler o 3MF: ' + (error && error.message ? error.message : error), 'err');
    }
  }

  async function loadFile(file) {
    if (!file) return;
    if (file.size > 250 * 1024 * 1024) {
      setStatus('o arquivo passa de 250 MB; use um 3MF menor', 'err');
      return;
    }
    state.token += 1;
    state.buffer = null;
    state.result = null;
    state.hidden = {};
    revokeSingleLink();
    state.fileName = file.name || 'modelo.3mf';
    els.fileName.textContent = state.fileName;
    els.fileSize.textContent = formatBytes(file.size);
    els.fileInfo.hidden = false;
    els.optionsPanel.hidden = false;
    els.summaryPanel.hidden = true;
    els.groupsPanel.hidden = true;
    els.groups.textContent = '';
    renderer.setModel([]);
    els.empty.hidden = false;
    setStatus('lendo ' + state.fileName + '...', '');
    try {
      var buffer = await file.arrayBuffer();
      state.buffer = buffer;
      await parseBuffer();
    } catch (error) {
      setStatus('não foi possível ler o arquivo: ' + (error && error.message ? error.message : error), 'err');
    }
  }

  function clearAll() {
    state.token += 1;
    state.buffer = null;
    state.fileName = '';
    state.result = null;
    state.hidden = {};
    state.parsing = false;
    revokeSingleLink();
    els.fileInput.value = '';
    els.fileInfo.hidden = true;
    els.optionsPanel.hidden = true;
    els.summaryPanel.hidden = true;
    els.groupsPanel.hidden = true;
    els.groups.textContent = '';
    els.warnings.textContent = '';
    els.empty.hidden = false;
    els.previewTitle.textContent = 'Prévia 3D';
    renderer.setModel([]);
    setStatus('Escolha um .3mf para começar.', '');
  }

  function downloadGroup(group) {
    if (!group) return;
    var format = els.format.value;
    var output = Split3mf.exportGroup(group, format, state.fileName);
    saveFile(output.name, output.data, mimeFor(format));
    setStatus('baixando ' + output.name, 'ok');
  }

  function downloadZip() {
    if (!state.result) return;
    var format = els.format.value;
    var files = state.result.groups.map(function (group) {
      return Split3mf.exportGroup(group, format, state.fileName);
    });
    if (!files.length) {
      setStatus('não há grupos para baixar', 'err');
      return;
    }
    var zip = Split3mf.zipFiles(files);
    saveFile(baseName() + '_paint_colors.zip', zip, 'application/zip');
    setStatus('baixando ' + files.length + ' arquivo(s) em ZIP', 'ok');
  }

  function downloadSingleStl() {
    if (!state.result || !state.singleUrl) return;
    setStatus('baixando ' + els.singleStl.download + ' · ' + state.result.groups.length + ' solid(s)', 'ok');
  }

  function bind() {
    els.chooseFile.addEventListener('click', function (event) {
      event.stopPropagation();
      els.fileInput.click();
    });
    els.drop.addEventListener('click', function (event) {
      if (event.target === els.chooseFile || els.chooseFile.contains(event.target)) return;
      els.fileInput.click();
    });
    els.fileInput.addEventListener('change', function () {
      var file = els.fileInput.files && els.fileInput.files[0];
      loadFile(file);
    });

    ['dragenter', 'dragover'].forEach(function (name) {
      els.drop.addEventListener(name, function (event) {
        event.preventDefault();
        els.drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      els.drop.addEventListener(name, function (event) {
        event.preventDefault();
        els.drop.classList.remove('over');
      });
    });
    els.drop.addEventListener('drop', function (event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) loadFile(files[0]);
    });

    els.format.addEventListener('change', renderGroups);
    els.applyTransforms.addEventListener('change', function () {
      if (state.buffer) parseBuffer();
    });

    els.groups.addEventListener('click', function (event) {
      var toggle = event.target.closest('button[data-toggle]');
      if (toggle) {
        var id = toggle.dataset.toggle;
        state.hidden[id] = !state.hidden[id];
        var row = toggle.closest('.group');
        if (row) row.classList.toggle('hidden', !!state.hidden[id]);
        toggle.textContent = state.hidden[id] ? 'Mostrar' : 'Ocultar';
        updatePreview();
        return;
      }
      var download = event.target.closest('button[data-download]');
      if (download && state.result) {
        var group = state.result.groups.filter(function (item) {
          return item.id === download.dataset.download;
        })[0];
        downloadGroup(group);
      }
    });

    els.allGroups.addEventListener('click', function () {
      state.hidden = {};
      renderGroups();
      updatePreview();
    });
    els.zip.addEventListener('click', downloadZip);
    els.singleStl.addEventListener('click', downloadSingleStl);
    els.clear.addEventListener('click', clearAll);

    els.views.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-view]');
      if (!button) return;
      state.view = button.dataset.view;
      markView(state.view);
      if (state.result) renderer.setView(state.view);
    });
    els.fit.addEventListener('click', function () {
      state.view = 'perspective';
      markView(state.view);
      renderer.resetView();
    });
  }

  function boot() {
    if (!window.IaRender) {
      setStatus('renderizador indisponível; recarregue a página', 'err');
      return;
    }
    if (!window.Split3mf) {
      setStatus('divisor 3MF indisponível; recarregue a página', 'err');
      return;
    }
    renderer = IaRender.create(els.preview, { grid: true });
    renderer.setView('perspective');
    bind();
  }

  boot();
})();
