/**
 * Runner de scripts de geometria.
 *
 * Não é carregado como arquivo: o sandbox concatena este texto com field.js,
 * font.js e kernel.js dentro de um blob worker. Assim o eval do script do
 * agente fica isolado do DOM, da página e da chave da API.
 */
'use strict';

(function () {
  var Field = self.NomesField;
  var Font = self.NomesFont;
  var Kernel = self.IaKernel;

  if (!Field || !Font || !Kernel) {
    self.postMessage({
      type: 'fatal',
      error: 'bibliotecas de geometria não carregaram no worker'
    });
    return;
  }

  Kernel.configure({ Field: Field, Font: Font });

  var font = null;
  var fontError = null;
  var queue = [];
  var processing = false;

  function makeLogger() {
    var lines = [];
    var size = 0;
    function add(level, args) {
      if (size > 3500) return;
      var text = Array.prototype.slice.call(args).map(function (value) {
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (e) { return String(value); }
      }).join(' ');
      if (text.length > 600) text = text.slice(0, 600) + '…';
      size += text.length;
      lines.push(level + ': ' + text);
    }
    return {
      api: {
        log: function () { add('log', arguments); },
        info: function () { add('info', arguments); },
        warn: function () { add('warn', arguments); },
        error: function () { add('error', arguments); }
      },
      text: function () { return lines.join('\n'); }
    };
  }

  function round(value, digits) {
    var f = Math.pow(10, digits || 0);
    return Math.round(value * f) / f;
  }

  function statsOf(model) {
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    var volume = 0;
    var area = 0;
    var triangles = 0;
    var boundaryEdges = 0;
    var nonManifoldEdges = 0;

    var parts = model.parts.map(function (part) {
      var m = Kernel.measure(part.positions);
      volume += m.volume;
      area += m.area;
      triangles += m.triangles;
      boundaryEdges += m.boundaryEdges;
      nonManifoldEdges += m.nonManifoldEdges;
      for (var i = 0; i < part.positions.length; i += 3) {
        for (var k = 0; k < 3; k++) {
          var value = part.positions[i + k];
          if (value < min[k]) min[k] = value;
          if (value > max[k]) max[k] = value;
        }
      }
      return {
        name: part.name,
        color: part.color,
        triangles: m.triangles,
        volume: round(m.volume, 1),
        size: m.size.map(function (v) { return round(v, 2); }),
        boundaryEdges: m.boundaryEdges,
        nonManifoldEdges: m.nonManifoldEdges
      };
    });

    if (!isFinite(min[0])) {
      min = [0, 0, 0];
      max = [0, 0, 0];
    }

    return {
      parts: parts,
      triangles: triangles,
      volume: round(volume, 1),
      area: round(area, 1),
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map(function (v) { return round(v, 2); }),
      min: min.map(function (v) { return round(v, 2); }),
      max: max.map(function (v) { return round(v, 2); }),
      boundaryEdges: boundaryEdges,
      nonManifoldEdges: nonManifoldEdges
    };
  }

  function processNext() {
    if (processing || !queue.length) return;
    processing = true;
    var job = queue.shift();
    var logger = makeLogger();
    var started = Date.now();
    var result;

    try {
      var fn = new Function(
        'K', 'console', 'fetch', 'importScripts', 'self', 'postMessage', 'close',
        'globalThis', 'window', 'document', 'chrome', 'localStorage', 'XMLHttpRequest',
        'WebSocket', 'indexedDB', 'navigator', 'location',
        '"use strict";\n' + String(job.code || '')
      );

      result = fn(
        Kernel.api(), logger.api,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined
      );
    } catch (error) {
      finish(job.id, {
        ok: false,
        error: error && error.message ? error.message : String(error),
        stack: error && error.stack ? String(error.stack).split('\n').slice(0, 4).join('\n') : '',
        logs: logger.text()
      });
      return;
    }

    var model;
    try {
      model = Kernel.normalizeParts(result);
    } catch (error) {
      finish(job.id, {
        ok: false,
        error: error && error.message ? error.message : String(error),
        logs: logger.text()
      });
      return;
    }

    // Técnica genérica de junção: separa cada parte em cascas (pernas, asas,
    // olhos), encontra o contato real de cada casca com as outras partes e
    // funde os pinos na própria parte menor — na cor dela.
    // Se o script já tem uma parte "juntas" (sistema manual), ela manda.
    var hasManualJoints = model.parts.some(function (part) {
      return /^juntas/.test(String(part.name || '').toLowerCase());
    });
    var autoJoints = { positions: [], pins: [], joints: [], loose: [] };
    if (!hasManualJoints) {
      try {
        autoJoints = Kernel.connectParts(model.parts, { overlap: 2 });
      } catch (error) {
        logger.api.warn('juntas automáticas falharam: ' + (error && error.message ? error.message : error));
      }
    } else {
      logger.api.info('juntas manuais encontradas; juntas automáticas desligadas neste objeto');
    }

    (autoJoints.pins || []).forEach(function (pin) {
      var target = model.parts[pin.targetPart];
      if (!target) return;
      var old = target.positions;
      var add = pin.positions instanceof Float32Array ? pin.positions : new Float32Array(pin.positions);
      var merged = new Float32Array(old.length + add.length);
      merged.set(old, 0);
      merged.set(add, old.length);
      target.positions = merged;
    });

    var stats;
    try {
      stats = statsOf(model);
      stats.joints = autoJoints.joints;
      stats.loose = autoJoints.loose;
    } catch (error) {
      finish(job.id, {
        ok: false,
        error: 'não foi possível medir a malha: ' + (error && error.message ? error.message : error),
        logs: logger.text()
      });
      return;
    }

    var transfer = model.parts.map(function (part) { return part.positions.buffer; });
    finish(job.id, {
      ok: true,
      model: model,
      stats: stats,
      logs: logger.text(),
      ms: Date.now() - started
    }, transfer);
  }

  function finish(id, payload, transfer) {
    processing = false;
    payload.type = 'result';
    payload.id = id;
    self.postMessage(payload, transfer || []);
    setTimeout(processNext, 0);
  }

  self.onmessage = function (event) {
    var data = event.data || {};

    if (data.type === 'init') {
      try {
        font = Font.parse(new Uint8Array(data.font));
        Kernel.configure({ font: font });
        self.postMessage({ type: 'ready', glyphs: font.glyphCount });
      } catch (error) {
        fontError = error && error.message ? error.message : String(error);
        self.postMessage({ type: 'ready', warning: 'fonte não carregou: ' + fontError });
      }
      return;
    }

    if (data.type === 'run') {
      queue.push({ id: data.id, code: data.code });
      processNext();
    }
  };

  self.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    self.postMessage({
      type: 'fatal',
      error: 'promessa rejeitada no script: ' + (reason && reason.message ? reason.message : String(reason))
    });
  });
})();
