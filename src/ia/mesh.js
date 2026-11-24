/**
 * LLaMA-Mesh local (text-to-3D) -> malha de referência do Estúdio IA.
 *
 * O modelo roda fora do navegador (llama.cpp / Ollama / LM Studio) e fala
 * OpenAI chat/completions em localhost. Aqui ficam:
 *   - o prompt que pede OBJ puro;
 *   - o parser tolerante de OBJ (vértices duplicados, índices negativos,
 *     polígonos com mais de 3 lados, cercas de markdown);
 *   - o reparo determinístico e a escala para a mesa (mm, Z para cima);
 *   - o cliente HTTP, sem dependência de DOM.
 *
 * O resultado é um RASCUNHO visual: não é fechado/printável por garantia e
 * nunca entra no STL final sozinho.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./kernel.js'));
  } else {
    root.IaMesh = factory(root.IaKernel);
  }
})(typeof self !== 'undefined' ? self : this, function (Kernel) {
  'use strict';

  var DEFAULT_BASE = 'http://127.0.0.1:8080/v1';
  var DEFAULT_MODEL = 'llama-mesh';
  var DEFAULT_TIMEOUT = 600000;
  var DEFAULT_MAX_TOKENS = 8000;
  var MAX_FACES = 4000;

  var COLORS = ['#6f5cff', '#24b3a3', '#e09b2d', '#d7618c', '#4f8ef7', '#8fbf4d'];

  function normalizeBase(baseUrl) {
    var base = String(baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
    return base;
  }

  function buildPrompt(prompt, options) {
    var text = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!text) text = 'a simple printable object';
    var feedback = options && options.feedback ? String(options.feedback).replace(/\s+/g, ' ').trim() : '';
    var base = 'Output ONLY the OBJ data: all "v" lines first, then all "f" lines. ' +
      'Finish the mesh; do not stop in the middle. Use fewer than 800 faces, valid indices, ' +
      'and include all parts of the object. The mesh is a low-poly draft/reference, not the final printable part. ' +
      'No explanations, no markdown, no comments.';
    if (feedback) {
      return 'Correct the previous 3D model of ' + text + ' in OBJ format. ' +
        'Problems to fix: ' + feedback + '. ' +
        'Generate a complete corrected OBJ from scratch. ' + base;
    }
    return 'Create a complete 3D model of ' + text + ' in OBJ format. ' + base;
  }

  /**
   * Recorta só o trecho OBJ da resposta. O LLaMA-Mesh às vezes devolve
   * explicação antes/depois e cercas ```obj```.
   */
  function extractOBJ(text, options) {
    var raw = String(text || '').replace(/\r/g, '');
    raw = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, '').replace(/```/g, '');
    var lines = raw.split('\n');
    var start = -1;
    var end = -1;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (start === -1 && /^v\s+[-+0-9.,]/.test(line)) start = i;
      if (/^f\s+/.test(line)) end = i;
    }
    if (start === -1) return '';
    // Streaming: ainda pode não haver nenhuma face completa.
    if (end === -1 && options && options.partial) end = lines.length - 1;
    if (end === -1 || end < start) return '';
    return lines.slice(start, end + 1).join('\n');
  }

  function num(value) {
    var n = Number(String(value == null ? '' : value).replace(/,/g, ''));
    return isFinite(n) ? n : NaN;
  }

  /** Triangula uma lista de índices (leque a partir do primeiro). */
  function fan(indices, out) {
    for (var i = 1; i + 1 < indices.length; i++) out.push([indices[0], indices[i], indices[i + 1]]);
  }

  function emptyStats() {
    return {
      triangles: 0,
      volume: 0,
      area: 0,
      size: [0, 0, 0],
      min: [0, 0, 0],
      max: [0, 0, 0],
      center: [0, 0, 0],
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      watertight: false
    };
  }

  function uniquePoints(vertices) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < vertices.length; i++) {
      var v = vertices[i];
      var key = v[0].toFixed(5) + ',' + v[1].toFixed(5) + ',' + v[2].toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(round(v[0], 4), round(v[1], 4), round(v[2], 4));
    }
    return out;
  }

  /** Resposta parcial (streaming): ainda sem faces completas. */
  function partialResult(raw, options, warning, points) {
    var colors = Array.isArray(options.colors) && options.colors.length ? options.colors : COLORS;
    var parts = [];
    if (points && points.length) {
      parts.push({
        name: options.name ? String(options.name) : 'rascunho',
        color: colors[0],
        points: points
      });
    }
    return {
      name: options.name ? String(options.name) : 'rascunho',
      prompt: options.prompt ? String(options.prompt) : '',
      obj: raw,
      positions: [],
      parts: parts,
      shells: [],
      stats: emptyStats(),
      warnings: warning ? [warning] : [],
      partial: true
    };
  }

  /**
   * Converte o texto OBJ em triângulos soldados e medidos.
   *
   * options:
   *   name     nome do rascunho
   *   sizeMm   maior dimensão final (padrão 60); 0 desliga o ajuste
   *   up       'y' (padrão, Objaverse/LLaMA-Mesh) ou 'z' (já em Z para cima)
   *   colors   paleta das cascas
   */
  function parseOBJ(text, options) {
    options = options || {};
    var raw = extractOBJ(text, options);
    if (!raw) throw new Error('a resposta não contém um OBJ (linhas "v" e "f")');

    var lines = raw.split('\n');
    var vertices = [];
    var rawFaces = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var parts = line.split(/\s+/);
      var tag = parts[0];
      if (tag === 'v') {
        var x = num(parts[1]);
        var y = num(parts[2]);
        var z = num(parts[3]);
        if (isFinite(x) && isFinite(y) && isFinite(z)) vertices.push([x, y, z]);
      } else if (tag === 'f') {
        var indices = [];
        for (var k = 1; k < parts.length; k++) {
          var token = parts[k].split('/')[0];
          var index = parseInt(token, 10);
          if (!isFinite(index) || index === 0) continue;
          indices.push(index);
        }
        if (indices.length >= 3) rawFaces.push({ indices: indices, count: vertices.length });
      }
    }

    // Y para cima (Objaverse/LLaMA-Mesh) -> Z para cima (estúdio).
    if (options.up !== 'z') {
      for (var vi = 0; vi < vertices.length; vi++) {
        var p = vertices[vi];
        vertices[vi] = [p[0], -p[2], p[1]];
      }
    }

    if (!vertices.length || !rawFaces.length) {
      if (options.partial) {
        return partialResult(raw, options, 'aguardando faces...', uniquePoints(vertices));
      }
      if (!vertices.length) throw new Error('o OBJ não tem vértices');
      throw new Error('o OBJ não tem faces');
    }

    // Solda por coordenada quantizada: o modelo costuma repetir vértices.
    var map = new Map();
    var unique = [];
    var remap = new Array(vertices.length);
    for (var u = 0; u < vertices.length; u++) {
      var v = vertices[u];
      var key = v[0].toFixed(5) + ',' + v[1].toFixed(5) + ',' + v[2].toFixed(5);
      var found = map.get(key);
      if (found === undefined) {
        found = unique.length;
        map.set(key, found);
        unique.push(v);
      }
      remap[u] = found;
    }

    var faces = [];
    for (var f = 0; f < rawFaces.length; f++) {
      var rawFace = rawFaces[f];
      var resolved = [];
      for (var j = 0; j < rawFace.indices.length; j++) {
        var value = rawFace.indices[j];
        var at = value < 0 ? rawFace.count + value : value - 1;
        if (at < 0 || at >= vertices.length) { resolved = null; break; }
        resolved.push(remap[at]);
      }
      if (resolved && resolved.length >= 3) fan(resolved, faces);
      if (faces.length > MAX_FACES) break;
    }

    // Remove triângulos degenerados e duplicados de vértice.
    var tris = [];
    for (var t = 0; t < faces.length; t++) {
      var face = faces[t];
      var a = face[0], b = face[1], c = face[2];
      if (a === b || b === c || c === a) continue;
      var pa = unique[a], pb = unique[b], pc = unique[c];
      var ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
      var vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * nx + ny * ny + nz * nz < 1e-20) continue;
      tris.push([a, b, c]);
    }

    if (!tris.length) {
      if (options.partial) {
        return partialResult(raw, options, 'aguardando faces válidas...', uniquePoints(vertices));
      }
      throw new Error('todas as faces do OBJ são degeneradas');
    }

    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var q = 0; q < unique.length; q++) {
      for (var axis = 0; axis < 3; axis++) {
        if (unique[q][axis] < min[axis]) min[axis] = unique[q][axis];
        if (unique[q][axis] > max[axis]) max[axis] = unique[q][axis];
      }
    }

    // No streaming, mantem as coordenadas originais (o renderer enquadra);
    // a normalizacao para mm acontece uma unica vez no resultado final.
    var normalize = options.normalize !== false;
    var sizeMm = options.sizeMm === 0 ? 0 : Number(options.sizeMm) || 60;
    var extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    var scale = normalize && sizeMm > 0 && extent > 1e-9 ? sizeMm / extent : 1;
    var cx = (min[0] + max[0]) / 2;
    var cy = (min[1] + max[1]) / 2;
    var baseZ = min[2];

    var positions = [];
    for (var ti = 0; ti < tris.length; ti++) {
      var tri = tris[ti];
      for (var n = 0; n < 3; n++) {
        var point = unique[tri[n]];
        positions.push(
          round(normalize ? (point[0] - cx) * scale : point[0], normalize ? 0 : 4),
          round(normalize ? (point[1] - cy) * scale : point[1], normalize ? 0 : 4),
          round(normalize ? (point[2] - baseZ) * scale : point[2], normalize ? 0 : 4)
        );
      }
    }

    var stats = measure(positions);
    var warnings = [];
    if (!options.partial) {
      if (stats.boundaryEdges > 0) warnings.push('malha aberta: ' + stats.boundaryEdges + ' arestas de borda');
      if (stats.nonManifoldEdges > 0) warnings.push(stats.nonManifoldEdges + ' arestas não-manifold');
      if (!(stats.volume > 0)) warnings.push('volume zero (faces podem estar invertidas)');
      if (stats.triangles < 12) warnings.push('poucos triângulos; o rascunho pode ter vindo incompleto');
    }

    var colors = Array.isArray(options.colors) && options.colors.length ? options.colors : COLORS;
    var shells = [];
    var parts = [];
    var shellInfo = [];

    if (options.partial || options.shells === false) {
      parts = [{
        name: options.name ? String(options.name) : 'rascunho',
        color: colors[0],
        positions: positions
      }];
    } else {
      shells = splitShells(positions);
      parts = shells.map(function (shell, index) {
        return {
          name: (options.name ? String(options.name) : 'rascunho') + ' ' + (index + 1),
          color: colors[index % colors.length],
          positions: shell.positions,
          shellIndex: index
        };
      });
      if (!parts.length) {
        parts = [{
          name: options.name ? String(options.name) : 'rascunho',
          color: colors[0],
          positions: positions
        }];
      }
      shellInfo = shells.map(function (shell, index) {
        var s = measure(shell.positions);
        return {
          name: parts[index].name,
          color: parts[index].color,
          triangles: s.triangles,
          volume: round(s.volume, 1),
          size: s.size.map(function (value) { return round(value, 2); }),
          center: s.center.map(function (value) { return round(value, 2); }),
          boundaryEdges: s.boundaryEdges,
          nonManifoldEdges: s.nonManifoldEdges
        };
      });
    }

    return {
      name: options.name ? String(options.name) : 'rascunho',
      prompt: options.prompt ? String(options.prompt) : '',
      obj: raw,
      positions: positions,
      parts: parts,
      shells: shellInfo,
      stats: stats,
      warnings: warnings,
      partial: !!options.partial
    };
  }

  function measure(positions) {
    if (Kernel && typeof Kernel.measure === 'function') return Kernel.measure(positions);
    return fallbackMeasure(positions);
  }

  function splitShells(positions) {
    if (Kernel && typeof Kernel.splitShells === 'function') {
      var shells = Kernel.splitShells(positions);
      if (shells && shells.length) {
        return shells.map(function (shell) {
          return {
            positions: shell.positions,
            triangles: shell.triangles,
            bounds: shell.bounds,
            volume: shell.volume
          };
        });
      }
    }
    return [{ positions: positions, triangles: positions.length / 9 }];
  }

  /** Medida mínima usada só se o kernel não estiver disponível (testes isolados). */
  function fallbackMeasure(positions) {
    var volume = 0;
    var area = 0;
    var triangles = 0;
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < positions.length; i += 9) {
      var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      var cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
      triangles++;
      for (var k = 0; k < 3; k++) {
        var p = positions[i + k * 3];
        var q = positions[i + k * 3 + 1];
        var r = positions[i + k * 3 + 2];
        if (p < min[0]) min[0] = p;
        if (q < min[1]) min[1] = q;
        if (r < min[2]) min[2] = r;
        if (p > max[0]) max[0] = p;
        if (q > max[1]) max[1] = q;
        if (r > max[2]) max[2] = r;
      }
    }
    return {
      triangles: triangles,
      volume: Math.abs(volume),
      area: area,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      min: min,
      max: max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      watertight: false
    };
  }

  function round(value, digits) {
    var f = Math.pow(10, digits || 0);
    return Math.round(value * f) / f;
  }

  function errorMessage(status, text) {
    var snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 180);
    if (status === 401 || status === 403) {
      return 'o servidor local recusou a requisição (HTTP ' + status + '). Confira o modelo/porta.';
    }
    return 'o LLaMA-Mesh local respondeu HTTP ' + status + (snippet ? ': ' + snippet : '');
  }

  function requestBody(options) {
    return {
      model: options.model || DEFAULT_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You generate complete Wavefront OBJ meshes. Always emit all vertices and faces, ' +
            'finish the mesh, and reply with OBJ only. The result is a low-poly draft for reconstruction.'
        },
        { role: 'user', content: buildPrompt(options.prompt, options) }
      ],
      stream: !!options.stream || typeof options.onProgress === 'function',
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.9,
      max_tokens: Math.max(256, Number(options.maxTokens) || DEFAULT_MAX_TOKENS)
    };
  }

  function finalizeText(text, options, started, finishReason) {
    if (!text.trim()) throw new Error('o LLaMA-Mesh respondeu vazio');
    var parsed = parseOBJ(text, {
      name: options.name,
      prompt: options.prompt,
      sizeMm: options.sizeMm,
      up: options.up
    });
    parsed.raw = text;
    parsed.model = options.model || DEFAULT_MODEL;
    parsed.finishReason = finishReason || '';
    if (parsed.finishReason === 'length') {
      parsed.warnings.push('resposta truncada no limite de tokens; a malha pode estar incompleta');
    }
    parsed.ms = Date.now() - started;
    parsed.partial = false;
    return parsed;
  }

  function parseFinal(data, options, started) {
    var choice = data && data.choices && data.choices[0];
    var text = '';
    if (choice) {
      if (choice.message && typeof choice.message.content === 'string') text = choice.message.content;
      else if (typeof choice.text === 'string') text = choice.text;
    }
    return finalizeText(text, options, started, choice && choice.finish_reason ? choice.finish_reason : '');
  }

  /** Lê o SSE do llama-server e devolve a malha parcial a cada ~250 ms. */
  function readStreamResponse(response, options, started) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var text = '';
    var finishReason = '';
    var lastEmit = 0;
    var lastLength = 0;
    var tokenCount = 0;

    function handleLine(line) {
      line = line.trim();
      if (!line || line.indexOf('data:') !== 0) return;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      var event;
      try { event = JSON.parse(payload); } catch (e) { return; }
      var choice = event.choices && event.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      var delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        tokenCount++;
      } else if (choice.message && typeof choice.message.content === 'string') {
        text += choice.message.content;
        tokenCount++;
      }
    }

    function emitProgress(force) {
      if (typeof options.onProgress !== 'function') return;
      var now = Date.now();
      if (!force && now - lastEmit < 250) return;
      if (text.length === lastLength) return;
      lastEmit = now;
      lastLength = text.length;
      var partial;
      try {
        partial = parseOBJ(text, {
          name: options.name,
          prompt: options.prompt,
          sizeMm: options.sizeMm,
          up: options.up,
          partial: true,
          normalize: false
        });
      } catch (e) {
        return;
      }
      partial.model = options.model || DEFAULT_MODEL;
      partial.ms = now - started;
      partial.tokens = tokenCount;
      partial.tps = partial.ms > 0 ? tokenCount / (partial.ms / 1000) : 0;
      try { options.onProgress(partial); } catch (e) { /* a UI nunca quebra a geração */ }
    }

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          if (buffer) handleLine(buffer);
          emitProgress(true);
          var result = finalizeText(text, options, started, finishReason);
          result.tokens = tokenCount;
          result.tps = result.ms > 0 ? tokenCount / (result.ms / 1000) : 0;
          return result;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        lines.forEach(handleLine);
        emitProgress(false);
        return pump();
      });
    }

    return pump();
  }

  /**
   * Chama o llama-server (ou outro servidor OpenAI-compatible local) e devolve
   * o rascunho já parseado. options.fetchImpl permite testar sem rede.
   */
  function generate(options) {
    options = options || {};
    var base = normalizeBase(options.baseUrl);
    var fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) return Promise.reject(new Error('fetch indisponível neste ambiente'));

    var controller = new AbortController();
    var timer = null;
    var timedOut = false;
    var timeout = Math.max(1000, Number(options.timeout) || DEFAULT_TIMEOUT);

    function abort() {
      try { controller.abort(); } catch (e) { /* ignora */ }
    }
    timer = setTimeout(function () {
      timedOut = true;
      abort();
    }, timeout);

    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    var started = Date.now();
    return fetchImpl(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(options)),
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw new Error(errorMessage(response.status, text));
        });
      }
      var contentType = response.headers && response.headers.get
        ? String(response.headers.get('content-type') || '')
        : '';
      var wantsStream = !!options.stream || typeof options.onProgress === 'function';
      if (wantsStream && response.body && typeof response.body.getReader === 'function' &&
        contentType.indexOf('application/json') === -1) {
        return readStreamResponse(response, options, started);
      }
      return response.json().then(function (data) {
        return parseFinal(data, options, started);
      });
    }).catch(function (error) {
      if (timedOut) {
        throw new Error('o LLaMA-Mesh local passou de ' + Math.round(timeout / 1000) +
          ' s sem terminar. Aumente o tempo limite em Ajustes ou use um modelo menor.');
      }
      if (error && error.name === 'AbortError') throw new Error('geração cancelada');
      if (error && /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(String(error.message))) {
        throw new Error('não foi possível falar com o LLaMA-Mesh em ' + base +
          '. O llama-server está rodando nessa porta?');
      }
      throw error;
    }).then(function (result) {
      if (timer) clearTimeout(timer);
      return result;
    }, function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }

  /** Lista os modelos do servidor local (usado pelo botão "Verificar servidor"). */
  function ping(options) {
    options = options || {};
    var base = normalizeBase(options.baseUrl);
    var fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) return Promise.reject(new Error('fetch indisponível neste ambiente'));
    var controller = new AbortController();
    var timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* ignora */ } },
      Math.max(1000, Number(options.timeout) || 5000));
    return fetchImpl(base + '/models', { signal: controller.signal }).then(function (response) {
      if (!response.ok) throw new Error('servidor respondeu HTTP ' + response.status + ' em ' + base);
      return response.json();
    }).then(function (data) {
      var list = Array.isArray(data && data.data) ? data.data : [];
      return {
        base: base,
        models: list.map(function (item) {
          return item && (item.id || item.name) ? String(item.id || item.name) : '';
        }).filter(Boolean)
      };
    }).then(function (result) {
      clearTimeout(timer);
      return result;
    }, function (error) {
      clearTimeout(timer);
      if (error && error.name === 'AbortError') {
        throw new Error('o servidor local não respondeu em ' + base +
          '. Inicie o llama-server e confira a porta.');
      }
      throw error;
    });
  }

  return {
    DEFAULT_BASE: DEFAULT_BASE,
    DEFAULT_MODEL: DEFAULT_MODEL,
    DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
    DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS,
    normalizeBase: normalizeBase,
    buildPrompt: buildPrompt,
    extractOBJ: extractOBJ,
    parseOBJ: parseOBJ,
    generate: generate,
    ping: ping
  };
});
