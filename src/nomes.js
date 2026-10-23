/**
 * Gerador de nomes - interface.
 *
 * Monta o texto com a fonte embutida, gera as duas pecas (base com furo
 * conico e topo vazado) e mostra a previa 3D. A exportacao STL acontece aqui
 * mesmo, sem depender da pagina aberta.
 */
(function () {
  'use strict';

  var els = {
    names: document.getElementById('names'),
    namesHint: document.getElementById('namesHint'),
    mode: document.getElementById('mode'),
    pieces: document.getElementById('pieces'),
    columns: document.getElementById('columns'),
    spacingX: document.getElementById('spacingX'),
    spacingY: document.getElementById('spacingY'),
    distanceSeparate: document.getElementById('distanceSeparate'),
    distanceBoth: document.getElementById('distanceBoth'),
    fontSelect: document.getElementById('fontSelect'),
    fontFile: document.getElementById('fontFile'),
    fontSize: document.getElementById('fontSize'),
    border: document.getElementById('border'),
    holeIn: document.getElementById('holeIn'),
    holeOut: document.getElementById('holeOut'),
    holeStyle: document.getElementById('holeStyle'),
    plug: document.getElementById('plug'),
    minWall: document.getElementById('minWall'),
    topThickness: document.getElementById('topThickness'),
    quality: document.getElementById('quality'),
    baseColor: document.getElementById('baseColor'),
    topColor: document.getElementById('topColor'),
    exportStl: document.getElementById('exportStl'),
    exportScad: document.getElementById('exportScad'),
    oneFilePerName: document.getElementById('oneFilePerName'),
    loading: document.getElementById('loading'),
    stats: document.getElementById('stats'),
    status: document.getElementById('status'),
    legendBase: document.getElementById('legendBase'),
    legendTop: document.getElementById('legendTop')
  };

  // v2: muda o furo padrao (tunel) e o tamanho minimo do texto (12 mm);
  // a chave nova descarta formularios salvos com os padroes antigos
  var STORAGE_KEY = 'nomesForm3';
  var DEBOUNCE_MS = 260;
  var MAX_NAMES = 120;

  var renderer = null;
  var font = null;
  var fontName = 'Chewy';
  var cache = new Map();
  var scene = null;
  var pieces = [];
  var timer = null;
  var generation = 0;
  var lastDuration = 0;

  // ---------------------------------------------------------------------------
  // estado do formulario
  // ---------------------------------------------------------------------------

  var FIELDS = ['names', 'mode', 'pieces', 'columns', 'spacingX', 'spacingY',
    'distanceSeparate', 'distanceBoth', 'fontSize', 'border', 'holeIn', 'holeOut', 'holeStyle', 'plug',
    'minWall', 'topThickness', 'quality', 'baseColor', 'topColor'];

  function saveForm() {
    var data = {};
    FIELDS.forEach(function (id) { data[id] = els[id].value; });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* sem storage */ }
  }

  function restoreForm() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    FIELDS.forEach(function (id) {
      if (data[id] !== undefined && data[id] !== null) els[id].value = data[id];
    });
  }

  function numberValue(el, fallback, min, max) {
    var value = Number(el.value);
    if (!isFinite(value)) value = fallback;
    if (min !== undefined && value < min) value = min;
    if (max !== undefined && value > max) value = max;
    return value;
  }

  function readParams() {
    return NomesParts.params({
      fontSize: numberValue(els.fontSize, 15, 12, 200),
      border: numberValue(els.border, 2, 0, 40),
      holeIn: numberValue(els.holeIn, 4.5, 0.5, 60),
      holeOut: numberValue(els.holeOut, 3.5, 0.5, 60),
      holeStyle: els.holeStyle.value,
      plug: numberValue(els.plug, 2, 0, 20),
      minWall: numberValue(els.minWall, 1.6, 0.2, 20),
      topThickness: numberValue(els.topThickness, 1.5, 0.3, 20),
      columns: Math.round(numberValue(els.columns, 4, 1, 40)),
      spacingX: numberValue(els.spacingX, 220, 5, 10000),
      spacingY: numberValue(els.spacingY, 160, 5, 10000),
      distanceSeparate: numberValue(els.distanceSeparate, 40, 0, 10000),
      distanceBoth: numberValue(els.distanceBoth, 45, 0, 10000),
      mode: els.mode.value,
      parts: els.pieces.value,
      quality: numberValue(els.quality, 0.15, 0.05, 1)
    });
  }

  function parseNames() {
    var raw = els.names.value || '';
    var list = raw.split(/[\n,;]+/).map(function (item) {
      return item.replace(/\s+/g, ' ').trim();
    }).filter(function (item) {
      return item.length > 0;
    });
    return list;
  }

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------

  function showStatus(message, type) {
    els.status.textContent = message;
    els.status.className = 'status show ' + (type || 'info');
  }

  function hideStatus() {
    els.status.className = 'status';
  }

  /** Todas as medidas na mesma unidade (cm quando a maior passa de 100 mm). */
  function fmtDims(size) {
    var useCm = Math.max(size[0], size[1], size[2]) >= 100;
    return size.map(function (value) {
      return useCm ? (value / 10).toFixed(1) + ' cm' : value.toFixed(1) + ' mm';
    }).join(' × ');
  }

  function fmtInt(n) {
    return Number(n).toLocaleString('pt-BR');
  }

  // ---------------------------------------------------------------------------
  // geracao
  // ---------------------------------------------------------------------------

  function pieceKey(name, params) {
    return [name, params.fontSize, params.border, params.holeIn, params.holeOut, params.holeStyle, params.plug,
      params.minWall, params.topThickness, params.quality].join('|');
  }

  function buildPieces(names, params) {
    var out = [];
    var next = new Map();
    var failures = 0;
    var noTunnel = 0;

    names.forEach(function (name) {
      if (!name) { out.push(null); return; }
      var key = pieceKey(name, params);
      var cached = cache.get(key);
      if (cached) {
        out.push(cached);
        next.set(key, cached);
        return;
      }
      var layout = font.layout(name, params.fontSize);
      var piece = NomesParts.buildPiece(layout, params);
      // triangulacao que nao fechou = malha aberta: melhor avisar do que exportar
      if (!piece || piece.failures) {
        failures++;
        out.push(null);
        return;
      }
      if (!piece.hasTunnel) noTunnel++;
      next.set(key, piece);
      out.push(piece);
    });

    cache = next;
    return { pieces: out, failures: failures, noTunnel: noTunnel };
  }

  function regenerate() {
    if (!font) return;
    var names = parseNames();
    var params = readParams();
    var runId = ++generation;

    els.namesHint.textContent = names.length
      ? names.length + (names.length === 1 ? ' nome' : ' nomes')
        + (names.length > MAX_NAMES ? ' - use até ' + MAX_NAMES : '')
      : 'Um nome por linha (também aceita vírgula).';

    if (!names.length) {
      scene = { base: [], top: [] };
      pieces = [];
      renderer.setScene(scene, colors());
      updateStats(names, params, 0);
      els.loading.hidden = true;
      hideStatus();
      return;
    }

    if (names.length > MAX_NAMES) {
      showStatus('Muitos nomes de uma vez (' + names.length + '). Gere no máximo ' + MAX_NAMES + '.', 'err');
      return;
    }

    // o aviso de "gerando" so aparece se a conta demorar o suficiente para
    // incomodar - em listas curtas a previa atualiza sem piscar
    var showLoading = lastDuration > 140;
    if (showLoading) {
      els.loading.hidden = false;
      els.loading.innerHTML = 'Gerando <span class="spin"></span>';
    }

    setTimeout(function () {
      if (runId !== generation) return;
      var started = Date.now();
      var built;
      try {
        built = buildPieces(names, params);
      } catch (error) {
        els.loading.hidden = true;
        showStatus('Falha ao gerar: ' + (error && error.message ? error.message : error), 'err');
        return;
      }
      if (runId !== generation) return;

      pieces = built.pieces;
      scene = NomesParts.buildLayout(pieces, params);
      var triangles = (scene.base.length + scene.top.length) / 9;
      var ms = Date.now() - started;
      lastDuration = ms;

      renderer.setScene(scene, colors());
      updateStats(names, params, triangles, ms);
      els.loading.hidden = true;

      if (built.failures) {
        showStatus(built.failures + (built.failures === 1 ? ' nome' : ' nomes') +
          ' não puderam ser gerados (texto vazio ou sem contorno).', 'err');
      } else if (built.noTunnel) {
        showStatus('A peça saiu sem o furo cônico em ' + built.noTunnel +
          (built.noTunnel === 1 ? ' nome' : ' nomes') + '. Aumente a borda ou reduza o raio do furo.', 'err');
      } else {
        hideStatus();
      }
    }, 16);
  }

  function colors() {
    return {
      baseColor: hexToRgb(els.baseColor.value),
      topColor: hexToRgb(els.topColor.value)
    };
  }

  function hexToRgb(hex) {
    var value = String(hex || '').replace('#', '');
    if (value.length === 3) {
      value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    }
    var number = parseInt(value, 16);
    if (!isFinite(number)) return [255, 255, 255];
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }

  function updateStats(names, params, triangles, ms) {
    var valid = pieces.filter(Boolean).length;
    var perName = params.mode === 'ambos' ? 4 : 2;
    if (params.parts !== 'ambos') perName = perName / 2;
    var count = valid * perName;

    var bounds = NomesParts.bounds(scene.base.concat(scene.top));
    var bits = [];
    bits.push('<span><b>' + names.length + '</b> nome' + (names.length === 1 ? '' : 's') + '</span>');
    bits.push('<span><b>' + count + '</b> peça' + (count === 1 ? '' : 's') + '</span>');
    if (triangles) bits.push('<span><b>' + fmtInt(triangles) + '</b> triângulos</span>');
    if (bounds.size[0] > 0) {
      bits.push('<span>mesa: <b>' + fmtDims(bounds.size) + '</b></span>');
    }
    if (ms) bits.push('<span>' + ms + ' ms</span>');
    els.stats.innerHTML = bits.join('');
  }

  function scheduleRegenerate() {
    saveForm();
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      regenerate();
    }, DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // exportacao
  // ---------------------------------------------------------------------------

  function download(buffer, filename, mime) {
    var blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function baseFileName() {
    var names = parseNames();
    if (names.length === 1) {
      return names[0].toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'chaveiro';
    }
    return 'nomes-' + names.length;
  }

  function exportStl() {
    if (!font) return;
    if (!scene || (!scene.base.length && !scene.top.length)) {
      showStatus('Escreva pelo menos um nome para gerar o STL.', 'err');
      return;
    }

    var params = readParams();
    var names = parseNames();

    try {
      if (els.oneFilePerName.checked && names.length > 1) {
        if (names.length > 20) {
          showStatus('Com "um STL por nome" o limite é 20 arquivos. Reduza a lista ou desmarque a opção.', 'err');
          return;
        }
        names.forEach(function (name, index) {
          var piece = pieces[index];
          if (!piece) return;
          var solo = NomesParts.buildLayout([piece], params);
          var buffer = NomesParts.stlBinary([solo.base, solo.top]);
          setTimeout(function () {
            download(buffer, safeName(name) + '.stl', 'model/stl');
          }, index * 350);
        });
        showStatus(names.length + ' arquivos STL sendo baixados. Se o Chrome perguntar, clique em Permitir.', 'ok');
        return;
      }

      var buffer = NomesParts.stlBinary([scene.base, scene.top]);
      download(buffer, baseFileName() + '.stl', 'model/stl');
      var triangles = Math.round((buffer.byteLength - 84) / 50);
      showStatus('STL gerado: ' + (buffer.byteLength / 1024).toFixed(0) + ' KB · ' +
        fmtInt(triangles) + ' triângulos.', 'ok');
    } catch (error) {
      showStatus('Falha ao exportar: ' + (error && error.message ? error.message : error), 'err');
    }
  }

  function safeName(name) {
    return String(name).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'chaveiro';
  }

  function exportScad() {
    var names = parseNames();
    if (!names.length) {
      showStatus('Escreva pelo menos um nome para gerar o .scad.', 'err');
      return;
    }
    var params = readParams();
    // largura real de cada nome: o .scad fica igual a previa
    var widths = names.map(function (name) {
      return font.layout(name, params.fontSize).width;
    });
    var text = NomesParts.scadText(names, params, fontName, widths);
    download(text, baseFileName() + '.scad', 'text/plain');
    showStatus('Arquivo .scad gerado. Abra no OpenSCAD (F6) para renderizar.', 'ok');
  }

  // ---------------------------------------------------------------------------
  // fonte
  // ---------------------------------------------------------------------------

  function useFont(parsed, name) {
    font = parsed;
    fontName = name;
    cache = new Map();
    if (els.loading) els.loading.hidden = true;
    consumePendingNames();
    regenerate();
  }

  /** Lista enviada pelo popup ("Abrir com esta lista"). */
  function consumePendingNames() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get('nomesPending', function (items) {
        var pending = items && items.nomesPending;
        if (!pending) return;
        try { chrome.storage.local.remove('nomesPending'); } catch (e) { /* sem storage */ }
        els.names.value = pending;
        regenerate();
      });
    } catch (e) {
      /* fora da extensao: ignora */
    }
  }

  function loadBundledFont() {
    fetch('fonts/Chewy-Regular.ttf')
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        useFont(NomesFont.parse(new Uint8Array(buffer)), 'Chewy');
      })
      .catch(function (error) {
        els.loading.textContent = 'Não foi possível carregar a fonte embutida.';
        showStatus('Falha ao carregar a fonte embutida: ' + (error && error.message ? error.message : error), 'err');
      });
  }

  function loadCustomFont(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = NomesFont.parse(new Uint8Array(reader.result));
        useFont(parsed, file.name.replace(/\.ttf$/i, ''));
        showStatus('Fonte "' + file.name + '" carregada (' + parsed.glyphCount + ' glifos).', 'ok');
      } catch (error) {
        showStatus('Não foi possível ler essa fonte: ' + (error && error.message ? error.message : error), 'err');
        els.fontSelect.value = 'chewy';
      }
    };
    reader.onerror = function () {
      showStatus('Falha ao ler o arquivo da fonte.', 'err');
    };
    reader.readAsArrayBuffer(file);
  }

  // ---------------------------------------------------------------------------
  // eventos
  // ---------------------------------------------------------------------------

  FIELDS.forEach(function (id) {
    els[id].addEventListener('input', scheduleRegenerate);
    els[id].addEventListener('change', scheduleRegenerate);
  });

  els.baseColor.addEventListener('input', function () {
    els.legendBase.style.background = els.baseColor.value;
    renderer.setScene(scene || { base: [], top: [] }, colors());
  });
  els.topColor.addEventListener('input', function () {
    els.legendTop.style.background = els.topColor.value;
    renderer.setScene(scene || { base: [], top: [] }, colors());
  });

  els.fontSelect.addEventListener('change', function () {
    if (els.fontSelect.value === 'custom') {
      els.fontFile.click();
    } else {
      loadBundledFont();
      els.fontSelect.value = 'chewy';
    }
  });

  els.fontFile.addEventListener('change', function () {
    loadCustomFont(els.fontFile.files && els.fontFile.files[0]);
  });

  els.exportStl.addEventListener('click', exportStl);
  els.exportScad.addEventListener('click', exportScad);

  document.querySelectorAll('.views button').forEach(function (button) {
    button.addEventListener('click', function () {
      renderer.setView(button.dataset.view);
    });
  });

  document.getElementById('openScadHelp').addEventListener('click', function (event) {
    event.preventDefault();
    showStatus('O .scad reproduz o desenho no OpenSCAD. A prévia e o STL daqui usam a largura real ' +
      'do texto (o .scad usa a estimativa por caractere), então as pontas do furo ficam sempre no material.', 'info');
  });

  // ---------------------------------------------------------------------------
  // inicio
  // ---------------------------------------------------------------------------

  restoreForm();
  els.legendBase.style.background = els.baseColor.value;
  els.legendTop.style.background = els.topColor.value;

  if (!els.names.value.trim()) {
    els.names.value = 'GABRIEL\nPEDRO H.\nBERNARDO\nENZO\nISAAC\nLIZ\nANA CLARA\nALEXSANDRA';
  }

  renderer = NomesRender.create(document.getElementById('preview'));
  loadBundledFont();

  window.addEventListener('beforeunload', function () {
    if (timer) clearTimeout(timer);
  });
})();
