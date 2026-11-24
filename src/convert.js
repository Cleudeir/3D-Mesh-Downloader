/**
 * Conversor local -> 3MF com cores.
 *
 * Le glTF/GLB, OBJ (+MTL) e STL do disco, mostra a previa 3D e grava um .3mf
 * com uma cor por peca em <basematerials>. Tudo no navegador: nenhum arquivo
 * sai da maquina.
 */
(function () {
  'use strict';

  var els = {
    drop: document.getElementById('drop'),
    pick: document.getElementById('pick'),
    file: document.getElementById('file'),
    fileInfo: document.getElementById('fileInfo'),
    fileName: document.getElementById('fileName'),
    fileMeta: document.getElementById('fileMeta'),
    warnings: document.getElementById('warnings'),
    status: document.getElementById('status'),
    partsPanel: document.getElementById('partsPanel'),
    partsCount: document.getElementById('partsCount'),
    parts: document.getElementById('parts'),
    exportPanel: document.getElementById('exportPanel'),
    scale: document.getElementById('scale'),
    targetHeight: document.getElementById('targetHeight'),
    yUp: document.getElementById('yUp'),
    export: document.getElementById('export'),
    resetFile: document.getElementById('resetFile'),
    preview: document.getElementById('preview'),
    empty: document.getElementById('empty'),
    statTris: document.getElementById('statTris'),
    statParts: document.getElementById('statParts'),
    statSize: document.getElementById('statSize')
  };

  var state = {
    raw: null,
    rawBounds: null,
    parts: [],
    colors: [],
    renderer: null,
    busy: false
  };

  // ---------------------------------------------------------------------------
  // utilidades
  // ---------------------------------------------------------------------------

  function setStatus(kind, text) {
    els.status.className = 'status show ' + kind;
    els.status.textContent = text;
  }

  function clearStatus() {
    els.status.className = 'status';
    els.status.textContent = '';
  }

  function fmtInt(value) {
    return (Number(value) || 0).toLocaleString('pt-BR');
  }

  function fmtMm(value) {
    var n = Number(value) || 0;
    if (Math.abs(n) >= 100) return n.toFixed(0);
    if (Math.abs(n) >= 10) return n.toFixed(1);
    return n.toFixed(2);
  }

  function toHex(color) {
    function channel(value) {
      var n = Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
      return (n < 16 ? '0' : '') + n.toString(16);
    }
    var c = color || [205, 205, 210];
    return '#' + channel(c[0]) + channel(c[1]) + channel(c[2]);
  }

  function fromHex(text) {
    var clean = String(text || '').replace('#', '');
    return [
      parseInt(clean.slice(0, 2), 16) || 0,
      parseInt(clean.slice(2, 4), 16) || 0,
      parseInt(clean.slice(4, 6), 16) || 0
    ];
  }

  function download(name, bytes) {
    var blob = new Blob([bytes], { type: 'model/3mf' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // ---------------------------------------------------------------------------
  // arquivos
  // ---------------------------------------------------------------------------

  function readOne(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve({ name: file.name, buffer: reader.result });
      };
      reader.onerror = function () {
        reject(new Error('nao consegui ler ' + file.name));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (state.busy) return;

    state.busy = true;
    setStatus('info', 'lendo ' + (files.length > 1 ? files.length + ' arquivos' : files[0].name) + '...');

    Promise.all(files.map(readOne))
      .then(function (loaded) {
        var hasZip = loaded.some(function (file) { return /\.zip$/i.test(file.name); });
        if (hasZip) setStatus('info', 'abrindo o ZIP e procurando o modelo...');
        return ConvertLoad.parseInputs(loaded);
      })
      .then(function (result) {
        loadResult(result);
        setStatus('ok', 'pronto: ' + fmtInt(totalFaces()) + ' triangulos em ' + result.parts.length + ' peca(s).');
      })
      .catch(function (error) {
        setStatus('err', error && error.message ? error.message : 'falha ao abrir o arquivo.');
      })
      .then(function () { state.busy = false; });
  }

  function totalFaces() {
    return state.parts.reduce(function (sum, part) { return sum + (part.faces || 0); }, 0);
  }

  function loadResult(result) {
    state.raw = result;
    state.rawBounds = ConvertLoad.bounds(result.parts);
    state.colors = result.parts.map(function (part) {
      return (part.color || [205, 205, 210]).slice();
    });

    els.scale.value = result.unitScale;
    els.targetHeight.value = 0;
    els.yUp.checked = !!result.yUp;

    els.fileInfo.hidden = false;
    els.fileName.textContent = result.name + ' (' + (result.container === 'zip' ? 'ZIP' : String(result.kind).toUpperCase()) + ')';
    els.fileMeta.textContent = fmtInt(result.parts.length) + ' pecas - ' +
      fmtInt(result.parts.reduce(function (sum, part) { return sum + part.faces; }, 0)) + ' triangulos';

    els.warnings.textContent = (result.warnings || []).join(' · ');
    els.warnings.hidden = !(result.warnings && result.warnings.length);

    apply();
  }

  function apply() {
    if (!state.raw) return;

    var scale = Number(els.scale.value);
    if (!isFinite(scale) || scale <= 0) scale = 1;

    var target = Number(els.targetHeight.value);
    var effective = scale;
    var useTarget = isFinite(target) && target > 0;
    if (useTarget && state.rawBounds) {
      var size = state.rawBounds.size;
      var max = Math.max(size[0], size[1], size[2]);
      if (max > 0) effective = target / max;
    }

    // com altura alvo preenchida, "mm por unidade" nao vale nada
    els.scale.disabled = useTarget;
    els.scale.title = useTarget ? 'ignorada enquanto a altura alvo estiver preenchida' : '';

    state.parts = ConvertLoad.transform(state.raw.parts, {
      scale: effective,
      yUp: els.yUp.checked
    });

    state.parts.forEach(function (part, index) {
      part.color = state.colors[index] || part.color;
    });

    els.partsPanel.hidden = false;
    els.exportPanel.hidden = false;
    els.empty.hidden = true;

    renderList();
    updateStats();

    if (state.renderer) state.renderer.setParts(state.parts);
  }

  function renderList() {
    els.parts.textContent = '';
    els.partsCount.textContent = state.parts.length + ' peca(s)';

    state.parts.forEach(function (part, index) {
      var row = document.createElement('label');
      row.className = 'part';

      var input = document.createElement('input');
      input.type = 'color';
      input.value = toHex(state.colors[index]);
      input.title = 'cor da peca no 3MF';
      input.addEventListener('input', function () {
        state.colors[index] = fromHex(input.value);
        state.parts[index].color = state.colors[index];
        if (state.renderer) state.renderer.setColor(index, state.colors[index]);
      });

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = part.name || ('peca ' + (index + 1));
      name.title = name.textContent;

      var tris = document.createElement('span');
      tris.className = 'tris';
      tris.textContent = fmtInt(part.faces);

      row.appendChild(input);
      row.appendChild(name);
      row.appendChild(tris);
      els.parts.appendChild(row);
    });
  }

  function updateStats() {
    var bounds = ConvertLoad.bounds(state.parts);
    els.statTris.textContent = fmtInt(totalFaces());
    els.statParts.textContent = fmtInt(state.parts.length);
    els.statSize.textContent = fmtMm(bounds.size[0]) + ' x ' + fmtMm(bounds.size[1]) +
      ' x ' + fmtMm(bounds.size[2]) + ' mm';
  }

  // ---------------------------------------------------------------------------
  // exportacao
  // ---------------------------------------------------------------------------

  function exportFile() {
    if (!state.raw || !state.parts.length || state.busy) return;

    var faces = totalFaces();
    var bar = faces > 1500000
      ? 'modelo grande: gerando o XML e juntando vertices, pode demorar...'
      : 'gerando o .3mf...';

    state.busy = true;
    els.export.disabled = true;
    els.export.innerHTML = '<span class="spin"></span> gerando...';
    setStatus('info', bar);

    // deixa o navegador pintar o "gerando" antes do trabalho pesado
    setTimeout(function () {
      try {
        var bytes = Convert3mf.build(state.parts);
        var name = (state.raw.name || 'modelo') + '.3mf';
        download(name, bytes);
        setStatus('ok', name + ' pronto - ' + (bytes.length / (1024 * 1024)).toFixed(2) + ' MB.');
      } catch (error) {
        setStatus('err', error && error.message ? error.message : 'falha ao gerar o 3MF.');
      }
      state.busy = false;
      els.export.disabled = false;
      els.export.textContent = 'Baixar .3mf';
    }, 40);
  }

  function resetAll() {
    state.raw = null;
    state.rawBounds = null;
    state.parts = [];
    state.colors = [];

    els.file.value = '';
    els.fileInfo.hidden = true;
    els.partsPanel.hidden = true;
    els.exportPanel.hidden = true;
    els.parts.textContent = '';
    els.warnings.textContent = '';
    els.warnings.hidden = true;
    els.empty.hidden = false;
    els.statTris.textContent = '-';
    els.statParts.textContent = '-';
    els.statSize.textContent = '-';

    if (state.renderer) state.renderer.setParts([]);
    clearStatus();
  }

  // ---------------------------------------------------------------------------
  // entrada
  // ---------------------------------------------------------------------------

  try {
    state.renderer = ConvertRender.create(els.preview);
  } catch (error) {
    state.renderer = null;
    setStatus('err', 'previa 3D indisponivel: ' + (error.message || error) + '. O .3mf continua funcionando.');
  }
  if (!state.renderer) {
    setStatus('err', 'previa 3D indisponivel (WebGL2). O .3mf continua funcionando.');
  }

  els.pick.addEventListener('click', function () { els.file.click(); });
  els.drop.addEventListener('click', function () { els.file.click(); });
  els.file.addEventListener('change', function () {
    handleFiles(els.file.files);
    els.file.value = '';
  });

  els.export.addEventListener('click', exportFile);
  els.resetFile.addEventListener('click', resetAll);

  els.scale.addEventListener('change', apply);
  els.targetHeight.addEventListener('change', apply);
  els.yUp.addEventListener('change', apply);

  document.querySelectorAll('.views button').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!state.renderer) return;
      state.renderer.setView(button.dataset.view);
    });
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    els.drop.addEventListener(type, function (event) {
      event.preventDefault();
      els.drop.classList.add('over');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    els.drop.addEventListener(type, function () { els.drop.classList.remove('over'); });
  });

  window.addEventListener('dragover', function (event) { event.preventDefault(); });
  window.addEventListener('drop', function (event) {
    event.preventDefault();
    els.drop.classList.remove('over');
    handleFiles(event.dataTransfer && event.dataTransfer.files);
  });
})();
