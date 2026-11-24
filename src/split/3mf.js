/**
 * Leitor e divisor de 3MF por cor.
 *
 * O 3MF é um ZIP com XML. Os modelos do Bambu Studio/Orca/Creality guardam a
 * cor de duas formas:
 *
 *   1. por peça/objeto, em `Metadata/model_settings.config` (chave `extruder`);
 *   2. por triângulo, em `paint_color`, uma árvore de subdivisão em hex.
 *
 * A paleta real (hex) vem de `Metadata/project_settings.config`
 * (`filament_colour`), com `Metadata/plate_N.json` como reserva. O divisor
 * resolve a cor de cada triângulo, junta os triângulos do mesmo filamento,
 * aplica as transformações de componentes/build e exporta STL, OBJ ou PLY.
 * Roda na página normal da extensão: ZIP + XML + geometria, sem Python e sem
 * servidor.
 *
 * O XML é lido por varredura direta das tags (sem montar árvore DOM): modelos
 * de 30 MB com 400 mil triângulos abrem em fração de segundo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Split3mf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var IDENTITY = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
  ];
  var PALETTE = ['#5b6cff', '#ffb020', '#16a34a', '#e2557b', '#8b5cf6',
    '#0ea5e9', '#f97316', '#14b8a6', '#64748b', '#dc2626'];

  // Bloco de posições por grupo: evita crescer um array JS com milhões de
  // números (o que dispara o GC em modelos grandes).
  var CHUNK_FLOATS = 9 * 4096;

  // -------------------------------------------------------------------------
  // utilidades
  // -------------------------------------------------------------------------

  function decodeText(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(0);
  }

  function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function lowerPath(value) {
    return normalizePath(value).toLowerCase();
  }

  function parseNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : (fallback || 0);
  }

  function cleanBaseName(value) {
    return String(value || 'modelo')
      .replace(/\.3mf$/i, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || 'modelo';
  }

  function isSpace(ch) {
    return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
  }

  function decodeEntities(value) {
    if (!value || value.indexOf('&') === -1) return value;
    return String(value)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  /** Valor de um atributo dentro do texto de uma tag, sem montar objeto. */
  function attrText(text, name) {
    var from = 0;
    var needle = name + '=';
    while (from < text.length) {
      var index = text.indexOf(needle, from);
      if (index < 0) return '';
      if (index === 0 || isSpace(text.charAt(index - 1))) {
        var quote = text.charAt(index + needle.length);
        if (quote === '"' || quote === "'") {
          var end = text.indexOf(quote, index + needle.length + 1);
          if (end > index) return decodeEntities(text.slice(index + needle.length + 1, end));
        }
      }
      from = index + needle.length;
    }
    return '';
  }

  /** Conta tags de verdade: `<triangle` não pode casar com `<triangles`. */
  function countTags(text, tag) {
    var count = 0;
    var from = 0;
    while ((from = text.indexOf(tag, from)) !== -1) {
      var next = text.charAt(from + tag.length);
      if (!next || isSpace(next) || next === '>' || next === '/') count++;
      from += tag.length;
    }
    return count;
  }

  /** Metadados `key=value` de um bloco (model_settings.config). */
  function readMetadata(text) {
    var out = {};
    var re = /<metadata\b([^>]*?)\/?>/g;
    var match;
    while ((match = re.exec(text || ''))) {
      var key = attrText(match[1], 'key');
      if (key) out[key] = attrText(match[1], 'value');
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // ZIP (leitura)
  // -------------------------------------------------------------------------

  function readZipEntries(buffer) {
    var view = new DataView(buffer);
    var eocd = -1;
    var min = Math.max(0, view.byteLength - 65557);
    for (var i = view.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('o arquivo não é um ZIP/3MF válido (fim do diretório não encontrado)');

    var count = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    var entries = {};
    var p = cdOffset;

    for (var n = 0; n < count; n++) {
      if (p + 46 > view.byteLength || view.getUint32(p, true) !== 0x02014b50) {
        throw new Error('diretório ZIP inválido');
      }
      var flags = view.getUint16(p + 8, true);
      var method = view.getUint16(p + 10, true);
      var compressed = view.getUint32(p + 20, true);
      var uncompressed = view.getUint32(p + 24, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = decodeText(new Uint8Array(buffer, p + 46, nameLen));

      if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('ZIP64 não é suportado neste divisor');
      }
      if (p + 46 + nameLen + extraLen + commentLen > view.byteLength) {
        throw new Error('entrada ZIP fora dos limites');
      }
      if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error('cabeçalho local ZIP inválido em ' + name);
      }
      var localNameLen = view.getUint16(localOffset + 26, true);
      var localExtraLen = view.getUint16(localOffset + 28, true);
      var start = localOffset + 30 + localNameLen + localExtraLen;
      if (start + compressed > view.byteLength) throw new Error('dados ZIP fora dos limites em ' + name);

      entries[name] = {
        name: name,
        method: method,
        compressed: compressed,
        uncompressed: uncompressed,
        start: start,
        flags: flags
      };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function findEntry(entries, suffix) {
    var wanted = lowerPath(suffix);
    var keys = Object.keys(entries);
    for (var i = 0; i < keys.length; i++) {
      var key = lowerPath(keys[i]);
      if (key === wanted || key.slice(-wanted.length - 1) === '/' + wanted) return entries[keys[i]];
    }
    return null;
  }

  function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('este navegador não tem DecompressionStream para ler ZIP deflate'));
    }
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  async function readEntry(buffer, entry) {
    if (!entry) return null;
    if (entry.data) return entry.data;
    var raw = new Uint8Array(buffer, entry.start, entry.compressed);
    if (entry.method === 0) entry.data = raw.slice();
    else if (entry.method === 8) entry.data = await inflateRaw(raw);
    else throw new Error('método de compressão ZIP ' + entry.method + ' não suportado');
    return entry.data;
  }

  async function readText(buffer, entry) {
    var bytes = await readEntry(buffer, entry);
    return bytes ? decodeText(bytes) : '';
  }

  // -------------------------------------------------------------------------
  // paint_color: árvore de subdivisão do TriangleSelector (Bambu/Orca/Prusa)
  // -------------------------------------------------------------------------

  /**
   * O `paint_color` não é um índice: é a árvore de subdivisão do triângulo
   * serializada em hex, lida da direita para a esquerda. Cada nibble tem
   * 2 bits baixos = lados divididos (0 = folha) e 2 bits altos = estado
   * (filamento) quando é folha. Estado 3 é escape: o próximo nibble continua
   * a contagem.
   *
   * Um triângulo pode ter regiões de cores diferentes; devolvemos a cor
   * dominante (maior peso) para a prévia e para a separação.
   */
  function dominantPaintState(code) {
    if (!code) return 0;
    var pos = code.length - 1;

    function next() {
      if (pos < 0) return 0;
      var value = parseInt(code.charAt(pos--), 16);
      return isFinite(value) ? value : 0;
    }

    var weights = {};

    function visit(weight, depth) {
      var nibble = next();
      var split = nibble & 3;
      if (!split || depth > 16) {
        var state = nibble & 12;
        if (state === 12) {
          var extra = next();
          if (extra < 14) state = extra + 3;
          else if (extra === 14) state = 17 + next() + next() * 16;
          else state = 0;
        } else {
          state = nibble >> 2;
        }
        weights[state] = (weights[state] || 0) + weight;
        return;
      }
      var childWeight = weight / (split + 1);
      for (var i = 0; i <= split; i++) visit(childWeight, depth + 1);
    }

    visit(1, 0);

    var best = 0;
    var bestWeight = -1;
    Object.keys(weights).forEach(function (key) {
      if (weights[key] > bestWeight) {
        bestWeight = weights[key];
        best = Number(key);
      }
    });
    return best;
  }

  function decodePaintState(code, cache) {
    var key = String(code || '');
    if (cache) {
      var cached = cache.get(key);
      if (cached !== undefined) return cached;
    }
    var state = dominantPaintState(key);
    if (cache) cache.set(key, state);
    return state;
  }

  function paintCodeOf(attrs) {
    var code = attributeCode(attrs, 'paint_color');
    if (code) return code;
    // PrusaSlicer usa o mesmo bitstream com outro nome.
    return attributeCode(attrs, 'mmu_segmentation');
  }

  function attributeCode(attrs, name) {
    var index = attrs.indexOf(name + '=');
    if (index < 0) return '';
    index += name.length + 1;
    var quote = attrs.charAt(index);
    if (quote !== '"' && quote !== "'") return '';
    var end = attrs.indexOf(quote, index + 1);
    return end < 0 ? '' : attrs.slice(index + 1, end);
  }

  // -------------------------------------------------------------------------
  // modelo 3MF
  // -------------------------------------------------------------------------

  function parseTransform(value) {
    var values = String(value || '').trim().split(/\s+/).map(Number);
    if (values.length !== 12 || values.some(function (number) { return !isFinite(number); })) {
      return IDENTITY.slice();
    }
    return [
      values[0], values[1], values[2], 0,
      values[3], values[4], values[5], 0,
      values[6], values[7], values[8], 0,
      values[9], values[10], values[11], 1
    ];
  }

  function isIdentity(m) {
    for (var i = 0; i < 16; i++) {
      if (m[i] !== IDENTITY[i]) return false;
    }
    return true;
  }

  function multiply(a, b) {
    var out = new Array(16);
    for (var row = 0; row < 4; row++) {
      for (var col = 0; col < 4; col++) {
        var sum = 0;
        for (var k = 0; k < 4; k++) sum += a[row * 4 + k] * b[k * 4 + col];
        out[row * 4 + col] = sum;
      }
    }
    return out;
  }

  function readVerticesFast(text, out) {
    var re = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g;
    var count = out.length / 3;
    var index = 0;
    var match;
    while (index < count && (match = re.exec(text))) {
      out[index * 3] = +match[1] || 0;
      out[index * 3 + 1] = +match[2] || 0;
      out[index * 3 + 2] = +match[3] || 0;
      index++;
    }
    return index;
  }

  function readVerticesSlow(text, out) {
    var re = /<vertex\b([^>]*?)\/?>/g;
    var count = out.length / 3;
    var index = 0;
    var match;
    while (index < count && (match = re.exec(text))) {
      out[index * 3] = parseNumber(attrText(match[1], 'x'));
      out[index * 3 + 1] = parseNumber(attrText(match[1], 'y'));
      out[index * 3 + 2] = parseNumber(attrText(match[1], 'z'));
      index++;
    }
    return index;
  }

  function readTrianglesFast(text, triangles, paints, cache) {
    var re = /<triangle\s+v1="(-?\d+)"\s+v2="(-?\d+)"\s+v3="(-?\d+)"([^>]*)>/g;
    var count = paints.length;
    var index = 0;
    var painted = 0;
    var match;
    while (index < count && (match = re.exec(text))) {
      triangles[index * 3] = +match[1];
      triangles[index * 3 + 1] = +match[2];
      triangles[index * 3 + 2] = +match[3];
      var code = paintCodeOf(match[4]);
      if (code) {
        paints[index] = decodePaintState(code, cache);
        painted++;
      }
      index++;
    }
    return { count: index, painted: painted };
  }

  function readTrianglesSlow(text, triangles, paints, cache) {
    var re = /<triangle\b([^>]*?)\/?>/g;
    var count = paints.length;
    var index = 0;
    var painted = 0;
    var match;
    while (index < count && (match = re.exec(text))) {
      triangles[index * 3] = parseNumber(attrText(match[1], 'v1'));
      triangles[index * 3 + 1] = parseNumber(attrText(match[1], 'v2'));
      triangles[index * 3 + 2] = parseNumber(attrText(match[1], 'v3'));
      var code = attrText(match[1], 'paint_color') || attrText(match[1], 'mmu_segmentation');
      if (code) {
        paints[index] = decodePaintState(code, cache);
        painted++;
      }
      index++;
    }
    return { count: index, painted: painted };
  }

  function parseMesh(block, cache) {
    var verticesOpen = block.indexOf('<vertices');
    var verticesClose = verticesOpen < 0 ? -1 : block.indexOf('</vertices>', verticesOpen);
    var trianglesOpen = block.indexOf('<triangles');
    var trianglesClose = trianglesOpen < 0 ? -1 : block.indexOf('</triangles>', trianglesOpen);
    if (verticesOpen < 0 || verticesClose < 0 || trianglesOpen < 0 || trianglesClose < 0) return null;

    var vertexText = block.slice(verticesOpen, verticesClose);
    var triangleText = block.slice(trianglesOpen, trianglesClose);

    var vertexCount = countTags(vertexText, '<vertex');
    var vertices = new Float32Array(vertexCount * 3);
    if (readVerticesFast(vertexText, vertices) !== vertexCount) {
      vertices.fill(0);
      readVerticesSlow(vertexText, vertices);
    }

    var triangleCount = countTags(triangleText, '<triangle');
    var triangles = new Uint32Array(triangleCount * 3);
    var paints = new Int32Array(triangleCount);
    var read = readTrianglesFast(triangleText, triangles, paints, cache);
    if (read.count !== triangleCount) {
      triangles.fill(0);
      paints.fill(0);
      read = readTrianglesSlow(triangleText, triangles, paints, cache);
    }

    return {
      vertices: vertices,
      vertexCount: vertexCount,
      triangles: triangles,
      triangleCount: triangleCount,
      paints: paints,
      painted: read.painted
    };
  }

  function parseComponents(block, object) {
    if (block.indexOf('<component') === -1) return;
    var re = /<component\b([^>]*?)\/?>/g;
    var match;
    while ((match = re.exec(block))) {
      var objectid = attrText(match[1], 'objectid');
      if (!objectid) continue;
      object.components.push({
        objectid: objectid,
        path: attrText(match[1], 'p:path') || attrText(match[1], 'path'),
        transform: parseTransform(attrText(match[1], 'transform'))
      });
    }
  }

  function parseModel(text, path, cache) {
    var model = {
      path: normalizePath(path),
      unit: 'millimeter',
      objects: {},
      build: [],
      painted: 0
    };

    var modelTag = /<model\b([^>]*)>/.exec(text);
    if (modelTag) model.unit = attrText(modelTag[1], 'unit') || 'millimeter';

    var objectRe = /<object\b([^>]*?)(\/?)>/g;
    var match;
    while ((match = objectRe.exec(text))) {
      var id = attrText(match[1], 'id');
      if (!id) continue;
      var object = { id: id, type: attrText(match[1], 'type'), mesh: null, components: [] };
      model.objects[id] = object;
      if (match[2] === '/') continue;

      var close = text.indexOf('</object>', objectRe.lastIndex);
      if (close < 0) close = text.length;
      var block = text.slice(objectRe.lastIndex, close);
      objectRe.lastIndex = close + '</object>'.length;

      parseComponents(block, object);
      if (block.indexOf('<mesh') !== -1) {
        object.mesh = parseMesh(block, cache);
        if (object.mesh) model.painted += object.mesh.painted;
      }
    }

    var buildOpen = text.indexOf('<build');
    if (buildOpen !== -1) {
      var buildClose = text.indexOf('</build>', buildOpen);
      var buildBlock = text.slice(buildOpen, buildClose < 0 ? text.length : buildClose);
      var itemRe = /<item\b([^>]*?)\/?>/g;
      while ((match = itemRe.exec(buildBlock))) {
        var objectid = attrText(match[1], 'objectid');
        if (!objectid) continue;
        model.build.push({
          objectid: objectid,
          transform: parseTransform(attrText(match[1], 'transform'))
        });
      }
    }

    return model;
  }

  // -------------------------------------------------------------------------
  // cores do projeto
  // -------------------------------------------------------------------------

  function normalizeHex(value) {
    var text = String(value || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{8}$/i.test(text)) return '#' + text.slice(0, 6).toUpperCase();
    if (/^[0-9a-f]{6}$/i.test(text)) return '#' + text.toUpperCase();
    return '';
  }

  /** Paleta por slot (1-based no uso): mantém o índice de cada filamento. */
  function readFilamentColors(text) {
    var colors = [];
    if (!text) return colors;

    var list = /"filament_colour"\s*:\s*\[([\s\S]*?)\]/.exec(text);
    if (list) {
      (list[1].match(/#?[0-9a-fA-F]{6,8}/g) || []).forEach(function (value) {
        colors.push(normalizeHex(value));
      });
      return colors;
    }

    var ini = /^\s*filament_colour\s*=\s*(.+)$/m.exec(text);
    if (ini) {
      ini[1].split(/[;,\s]+/).forEach(function (value) {
        if (value) colors.push(normalizeHex(value));
      });
    }
    return colors;
  }

  /** Cores da mesa: `filament_ids` são 0-based, como a paleta do projeto. */
  function readPlateColors(text) {
    var json;
    try { json = JSON.parse(text); } catch (e) { return []; }
    var palette = Array.isArray(json.filament_colors) ? json.filament_colors : [];
    var ids = Array.isArray(json.filament_ids) ? json.filament_ids : [];
    var colors = [];
    palette.forEach(function (value, index) {
      var color = normalizeHex(value);
      if (!color) return;
      var slot = index;
      if (ids[index] !== undefined) {
        var parsed = parseNumber(ids[index], index);
        if (parsed >= 0) slot = Math.round(parsed);
      }
      colors[slot] = color;
    });
    return colors;
  }

  // -------------------------------------------------------------------------
  // model_settings.config: extruder por objeto/peça
  // -------------------------------------------------------------------------

  function parseSlot(value) {
    var slot = Math.round(parseNumber(value, 0));
    return slot > 0 ? slot : 0;
  }

  function parseModelSettings(text) {
    var settings = {};
    if (!text) return settings;

    var objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    var match;
    while ((match = objectRe.exec(text))) {
      var id = attrText(match[1], 'id');
      if (!id) continue;
      var body = match[2];
      var partsAt = body.indexOf('<part');
      var head = readMetadata(partsAt === -1 ? body : body.slice(0, partsAt));
      var info = {
        id: id,
        name: head.name || '',
        extruder: parseSlot(head.extruder),
        parts: {}
      };

      if (partsAt !== -1) {
        var partRe = /<part\b([^>]*)>([\s\S]*?)<\/part>/g;
        var partMatch;
        while ((partMatch = partRe.exec(body))) {
          var partId = attrText(partMatch[1], 'id');
          if (!partId) continue;
          var meta = readMetadata(partMatch[2]);
          info.parts[partId] = {
            id: partId,
            name: meta.name || '',
            extruder: parseSlot(meta.extruder)
          };
        }
      }
      settings[id] = info;
    }
    return settings;
  }

  // -------------------------------------------------------------------------
  // divisão por cor
  // -------------------------------------------------------------------------

  function emptyBounds() {
    return {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity]
    };
  }

  function includePoint(bounds, x, y, z) {
    if (x < bounds.min[0]) bounds.min[0] = x;
    if (y < bounds.min[1]) bounds.min[1] = y;
    if (z < bounds.min[2]) bounds.min[2] = z;
    if (x > bounds.max[0]) bounds.max[0] = x;
    if (y > bounds.max[1]) bounds.max[1] = y;
    if (z > bounds.max[2]) bounds.max[2] = z;
  }

  function finishBounds(bounds) {
    if (!isFinite(bounds.min[0])) {
      return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    }
    return {
      min: bounds.min.slice(),
      max: bounds.max.slice(),
      size: [
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2]
      ]
    };
  }

  function createGroup(id) {
    return {
      id: id,
      chunks: [],
      current: new Float32Array(CHUNK_FLOATS),
      offset: 0,
      triangles: 0,
      bounds: emptyBounds()
    };
  }

  function pushTriangle(group, ax, ay, az, bx, by, bz, cx, cy, cz) {
    if (group.offset + 9 > group.current.length) {
      group.chunks.push(group.current);
      group.current = new Float32Array(CHUNK_FLOATS);
      group.offset = 0;
    }
    var out = group.current;
    var at = group.offset;
    out[at] = ax;
    out[at + 1] = ay;
    out[at + 2] = az;
    out[at + 3] = bx;
    out[at + 4] = by;
    out[at + 5] = bz;
    out[at + 6] = cx;
    out[at + 7] = cy;
    out[at + 8] = cz;
    group.offset = at + 9;
    group.triangles += 1;
    includePoint(group.bounds, ax, ay, az);
    includePoint(group.bounds, bx, by, bz);
    includePoint(group.bounds, cx, cy, cz);
  }

  function finishGroup(group) {
    var total = group.chunks.length * CHUNK_FLOATS + group.offset;
    var positions = new Float32Array(total);
    var at = 0;
    for (var i = 0; i < group.chunks.length; i++) {
      positions.set(group.chunks[i], at);
      at += group.chunks[i].length;
    }
    if (group.offset) positions.set(group.current.subarray(0, group.offset), at);
    group.chunks = [];
    group.current = null;
    return positions;
  }

  function addMesh(mesh, transform, context, extruder) {
    if (!mesh || !mesh.vertexCount || !mesh.triangleCount) return;

    var vertices = mesh.vertices;
    if (!isIdentity(transform)) {
      var needed = mesh.vertexCount * 3;
      if (context.scratch.length < needed) context.scratch = new Float32Array(needed);
      var scratch = context.scratch;
      var m = transform;
      for (var v = 0; v < mesh.vertexCount; v++) {
        var offset = v * 3;
        var x = vertices[offset];
        var y = vertices[offset + 1];
        var z = vertices[offset + 2];
        scratch[offset] = x * m[0] + y * m[4] + z * m[8] + m[12];
        scratch[offset + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
        scratch[offset + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
      }
      vertices = scratch;
    }

    var triangles = mesh.triangles;
    var paints = mesh.paints;
    var fallback = extruder > 0 ? extruder : context.defaultSlot;
    var total = vertices.length;
    var bounds = context.bounds;

    for (var t = 0; t < mesh.triangleCount; t++) {
      var slot = paints[t] > 0 ? paints[t] : fallback;
      var key = slot > 0 ? slot : 0;
      var group = context.groups[key] || (context.groups[key] = createGroup(key));

      var a = triangles[t * 3] * 3;
      var b = triangles[t * 3 + 1] * 3;
      var c = triangles[t * 3 + 2] * 3;
      if (a + 2 >= total || b + 2 >= total || c + 2 >= total) continue;

      var ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
      var bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
      var cx = vertices[c], cy = vertices[c + 1], cz = vertices[c + 2];
      pushTriangle(group, ax, ay, az, bx, by, bz, cx, cy, cz);
      includePoint(bounds, ax, ay, az);
      includePoint(bounds, bx, by, bz);
      includePoint(bounds, cx, cy, cz);
      context.triangles += 1;
    }
    context.objects += 1;
  }

  function resolveObject(context, modelPath, objectId, transform, stack, parentSettings, partExtruder) {
    var key = lowerPath(modelPath);
    var model = context.models[key];
    if (!model) {
      context.warnings.push('modelo não encontrado: ' + modelPath);
      return;
    }
    var object = model.objects[String(objectId)];
    if (!object) {
      context.warnings.push('objeto ' + objectId + ' não encontrado em ' + modelPath);
      return;
    }
    var marker = key + '#' + objectId;
    if (stack.indexOf(marker) !== -1) {
      context.warnings.push('referência circular em ' + marker);
      return;
    }

    var settings = context.settings[String(objectId)] || null;
    var extruder = partExtruder || 0;
    if (!extruder && settings) extruder = settings.extruder;
    if (!extruder && parentSettings) extruder = parentSettings.extruder;

    if (object.mesh) addMesh(object.mesh, transform, context, extruder);

    if (!object.components.length) return;
    var scope = settings || parentSettings;
    for (var i = 0; i < object.components.length; i++) {
      var component = object.components[i];
      if (!component.objectid) continue;
      var nextPath = component.path ? normalizePath(component.path) : modelPath;
      // O 3MF transforma com vetor-linha: o componente vale primeiro e depois
      // o que veio de fora (build/pai), então a ordem é componente × acumulado.
      // Inverter isso aplica a translação do componente sem a escala do build,
      // e as peças se afastam do centro ("explode").
      var nextTransform = context.applyTransforms ? multiply(component.transform, transform) : IDENTITY;
      var nextExtruder = 0;
      if (scope && scope.parts) {
        var part = scope.parts[String(component.objectid)];
        if (part) nextExtruder = part.extruder;
      }
      resolveObject(context, nextPath, component.objectid, nextTransform,
        stack.concat(marker), scope, nextExtruder);
    }
  }

  async function parse(input, options) {
    options = options || {};
    var buffer = input instanceof ArrayBuffer
      ? input
      : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    var entries = readZipEntries(buffer);
    var keys = Object.keys(entries);
    var modelKeys = keys.filter(function (key) { return /\.model$/i.test(key); });
    if (!modelKeys.length) throw new Error('nenhum arquivo .model encontrado no 3MF');

    var paintCache = new Map();
    var models = {};
    var paintedTotal = 0;
    await Promise.all(modelKeys.map(async function (key) {
      var text = await readText(buffer, entries[key]);
      var model = parseModel(text, key, paintCache);
      paintedTotal += model.painted;
      models[lowerPath(key)] = model;
    }));

    var mainKey = null;
    for (var i = 0; i < modelKeys.length; i++) {
      if (lowerPath(modelKeys[i]) === '3d/3dmodel.model') { mainKey = modelKeys[i]; break; }
    }
    if (!mainKey) {
      for (var j = 0; j < modelKeys.length; j++) {
        var candidate = models[lowerPath(modelKeys[j])];
        if (candidate && candidate.build.length) { mainKey = modelKeys[j]; break; }
      }
    }
    if (!mainKey) mainKey = modelKeys[0];
    var main = models[lowerPath(mainKey)];

    var settings = {};
    var settingsEntry = findEntry(entries, 'Metadata/model_settings.config');
    if (settingsEntry) {
      try {
        settings = parseModelSettings(await readText(buffer, settingsEntry));
      } catch (e) {
        /* modelo sem configuração de peças: segue pela geometria */
      }
    }

    var colors = [];
    var projectEntry = findEntry(entries, 'Metadata/project_settings.config');
    if (projectEntry) {
      try {
        colors = readFilamentColors(await readText(buffer, projectEntry));
      } catch (e) {
        /* paleta opcional */
      }
    }
    var hasColor = colors.some(Boolean);
    if (!hasColor) {
      for (var plate = 1; plate <= 9; plate++) {
        var plateEntry = findEntry(entries, 'Metadata/plate_' + plate + '.json');
        if (!plateEntry) break;
        var plateColors = readPlateColors(await readText(buffer, plateEntry));
        if (plateColors.some(Boolean)) {
          colors = plateColors;
          hasColor = true;
          break;
        }
      }
    }

    var context = {
      models: models,
      settings: settings,
      groups: {},
      warnings: [],
      bounds: emptyBounds(),
      triangles: 0,
      objects: 0,
      applyTransforms: options.applyTransforms !== false,
      // Triângulo sem pintura herda a peça; sem peça, filamento 1 quando o
      // modelo usa pintura e 0 (grupo único) quando não há cor nenhuma.
      defaultSlot: paintedTotal > 0 ? 1 : 0,
      scratch: new Float32Array(0)
    };

    if (main.build.length) {
      main.build.forEach(function (item) {
        var transform = context.applyTransforms ? item.transform : IDENTITY;
        var itemSettings = context.settings[String(item.objectid)] || null;
        resolveObject(context, mainKey, item.objectid, transform, [], itemSettings, 0);
      });
    } else {
      Object.keys(main.objects).forEach(function (id) {
        if (main.objects[id].mesh) resolveObject(context, mainKey, id, IDENTITY, [], null, 0);
      });
      if (!context.objects) {
        Object.keys(models).forEach(function (path) {
          Object.keys(models[path].objects).forEach(function (id) {
            if (models[path].objects[id].mesh) resolveObject(context, path, id, IDENTITY, [], null, 0);
          });
        });
      }
    }

    var ids = Object.keys(context.groups).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    var groups = ids.map(function (id, index) {
      var group = context.groups[id];
      var slot = Number(id);
      var positions = finishGroup(group);
      var bounds = finishBounds(group.bounds);
      return {
        id: id,
        slot: slot,
        name: slot > 0 ? 'filamento_' + slot : 'paint_color_0',
        color: (slot > 0 ? colors[slot - 1] : '') || PALETTE[index % PALETTE.length],
        positions: positions,
        triangles: group.triangles,
        size: bounds.size,
        min: bounds.min,
        max: bounds.max
      };
    });

    if (!groups.length) context.warnings.push('nenhum triângulo com geometria foi encontrado');
    if (groups.length === 1 && groups[0].id === '0') {
      context.warnings.push('este 3MF não tem paint_color nem filamento por peça; toda a malha ficou no grupo 0');
    }
    if (!hasColor) context.warnings.push('o projeto não informou filamentos; as cores da prévia são estimadas');

    var bounds = finishBounds(context.bounds);
    return {
      groups: groups,
      triangles: context.triangles,
      objects: context.objects,
      vertices: groups.reduce(function (sum, group) { return sum + group.positions.length / 3; }, 0),
      size: bounds.size,
      min: bounds.min,
      max: bounds.max,
      unit: main.unit || 'millimeter',
      colors: colors,
      warnings: context.warnings,
      models: modelKeys
    };
  }

  // -------------------------------------------------------------------------
  // exportação
  // -------------------------------------------------------------------------

  function stlBinary(group) {
    var positions = group.positions;
    var triangles = Math.floor(positions.length / 9);
    var buffer = new ArrayBuffer(84 + triangles * 50);
    var view = new DataView(buffer);
    var header = 'Split3mf ' + (group.name || ('paint_color_' + group.id));
    for (var i = 0; i < Math.min(80, header.length); i++) view.setUint8(i, header.charCodeAt(i));
    view.setUint32(80, triangles, true);

    var offset = 84;
    function normal(ax, ay, az, bx, by, bz, cx, cy, cz) {
      var abx = bx - ax, aby = by - ay, abz = bz - az;
      var acx = cx - ax, acy = cy - ay, acz = cz - az;
      var nx = aby * acz - abz * acy;
      var ny = abz * acx - abx * acz;
      var nz = abx * acy - aby * acx;
      var length = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!length) return [0, 0, 0];
      return [nx / length, ny / length, nz / length];
    }

    for (var t = 0; t < triangles; t++) {
      var p = t * 9;
      var n = normal(
        positions[p], positions[p + 1], positions[p + 2],
        positions[p + 3], positions[p + 4], positions[p + 5],
        positions[p + 6], positions[p + 7], positions[p + 8]
      );
      view.setFloat32(offset, n[0], true);
      view.setFloat32(offset + 4, n[1], true);
      view.setFloat32(offset + 8, n[2], true);
      for (var v = 0; v < 3; v++) {
        view.setFloat32(offset + 12 + v * 12, positions[p + v * 3], true);
        view.setFloat32(offset + 16 + v * 12, positions[p + v * 3 + 1], true);
        view.setFloat32(offset + 20 + v * 12, positions[p + v * 3 + 2], true);
      }
      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
    return new Uint8Array(buffer);
  }

  function triangleNormal(positions, offset) {
    var abx = positions[offset + 3] - positions[offset];
    var aby = positions[offset + 4] - positions[offset + 1];
    var abz = positions[offset + 5] - positions[offset + 2];
    var acx = positions[offset + 6] - positions[offset];
    var acy = positions[offset + 7] - positions[offset + 1];
    var acz = positions[offset + 8] - positions[offset + 2];
    var nx = aby * acz - abz * acy;
    var ny = abz * acx - abx * acz;
    var nz = abx * acy - aby * acx;
    var length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!length) return [0, 0, 0];
    return [nx / length, ny / length, nz / length];
  }

  /**
   * Um único STL ASCII, com um `solid` por grupo. É a forma de manter
   * "partes separadas" em STL: o formato binário não tem nomes/objetos.
   *
   * Devolve uma lista de blocos de string (em vez de um texto único) para o
   * Blob receber pedaços e não estourar a memória em modelos grandes.
   */
  function stlAsciiFromGroups(groups) {
    var chunks = [];
    var lines = [];
    var FLUSH = 2048;

    function flush() {
      if (!lines.length) return;
      chunks.push(lines.join(''));
      lines = [];
    }

    function number(value) {
      return value.toFixed(6);
    }

    (groups || []).forEach(function (group) {
      var positions = group.positions;
      var triangles = Math.floor(positions.length / 9);
      if (!triangles) return;
      var name = String(group.name || ('paint_color_' + group.id)).replace(/\s+/g, '_');
      lines.push('solid ' + name + '\n');
      for (var t = 0; t < triangles; t++) {
        var p = t * 9;
        var n = triangleNormal(positions, p);
        lines.push(' facet normal ' + number(n[0]) + ' ' + number(n[1]) + ' ' + number(n[2]) +
          '\n  outer loop\n' +
          '   vertex ' + number(positions[p]) + ' ' + number(positions[p + 1]) + ' ' + number(positions[p + 2]) + '\n' +
          '   vertex ' + number(positions[p + 3]) + ' ' + number(positions[p + 4]) + ' ' + number(positions[p + 5]) + '\n' +
          '   vertex ' + number(positions[p + 6]) + ' ' + number(positions[p + 7]) + ' ' + number(positions[p + 8]) + '\n' +
          '  endloop\n endfacet\n');
        if (lines.length >= FLUSH) flush();
      }
      lines.push('endsolid ' + name + '\n');
      flush();
    });
    return chunks;
  }

  function indexedMesh(group) {
    var positions = group.positions;
    var vertices = [];
    var faces = [];
    var lookup = new Map();
    for (var i = 0; i < positions.length; i += 9) {
      var face = [];
      for (var v = 0; v < 3; v++) {
        var x = positions[i + v * 3];
        var y = positions[i + v * 3 + 1];
        var z = positions[i + v * 3 + 2];
        var key = x.toFixed(5) + '|' + y.toFixed(5) + '|' + z.toFixed(5);
        var index = lookup.get(key);
        if (index === undefined) {
          index = vertices.length;
          lookup.set(key, index);
          vertices.push([x, y, z]);
        }
        face.push(index);
      }
      faces.push(face);
    }
    return { vertices: vertices, faces: faces };
  }

  function objText(group) {
    var mesh = indexedMesh(group);
    var lines = ['# Split3mf · ' + group.name + ' (' + group.color + ')', 'o ' + group.name];
    mesh.vertices.forEach(function (vertex) {
      lines.push('v ' + vertex[0] + ' ' + vertex[1] + ' ' + vertex[2]);
    });
    mesh.faces.forEach(function (face) {
      lines.push('f ' + (face[0] + 1) + ' ' + (face[1] + 1) + ' ' + (face[2] + 1));
    });
    return lines.join('\n') + '\n';
  }

  function plyText(group) {
    var mesh = indexedMesh(group);
    var lines = [
      'ply',
      'format ascii 1.0',
      'comment Split3mf ' + group.name,
      'element vertex ' + mesh.vertices.length,
      'property float x',
      'property float y',
      'property float z',
      'element face ' + mesh.faces.length,
      'property list uchar int vertex_indices',
      'end_header'
    ];
    mesh.vertices.forEach(function (vertex) {
      lines.push(vertex[0] + ' ' + vertex[1] + ' ' + vertex[2]);
    });
    mesh.faces.forEach(function (face) {
      lines.push('3 ' + face[0] + ' ' + face[1] + ' ' + face[2]);
    });
    return lines.join('\n') + '\n';
  }

  function exportGroup(group, format, baseName) {
    var extension = String(format || 'stl').toLowerCase();
    if (['stl', 'obj', 'ply'].indexOf(extension) === -1) extension = 'stl';
    var name = cleanBaseName(baseName) + '_' + group.name + '.' + extension;
    var data;
    if (extension === 'obj') data = objText(group);
    else if (extension === 'ply') data = plyText(group);
    else data = stlBinary(group);
    return { name: name, data: data, format: extension };
  }

  function exportSingleStl(groups, baseName) {
    return {
      name: cleanBaseName(baseName) + '_partes.stl',
      data: stlAsciiFromGroups(groups),
      format: 'stl'
    };
  }

  // -------------------------------------------------------------------------
  // ZIP de saída (store; sem dependências)
  // -------------------------------------------------------------------------

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    var crc = 0xffffffff;
    for (var i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipFiles(files) {
    var chunks = [];
    var central = [];
    var offset = 0;
    var encoder = new TextEncoder();

    files.forEach(function (file) {
      var name = encoder.encode(file.name);
      var data = toBytes(file.data);
      var crc = crc32(data);
      var local = new Uint8Array(30 + name.length + data.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      chunks.push(local);

      var entry = new Uint8Array(46 + name.length);
      var ev = new DataView(entry.buffer);
      ev.setUint32(0, 0x02014b50, true);
      ev.setUint16(4, 20, true);
      ev.setUint16(6, 20, true);
      ev.setUint16(8, 0, true);
      ev.setUint16(10, 0, true);
      ev.setUint16(12, 0, true);
      ev.setUint16(14, 0x21, true);
      ev.setUint32(16, crc, true);
      ev.setUint32(20, data.length, true);
      ev.setUint32(24, data.length, true);
      ev.setUint16(28, name.length, true);
      ev.setUint16(30, 0, true);
      ev.setUint16(32, 0, true);
      ev.setUint16(34, 0, true);
      ev.setUint16(36, 0, true);
      ev.setUint32(38, 0, true);
      ev.setUint32(42, offset, true);
      entry.set(name, 46);
      central.push(entry);
      offset += local.length;
    });

    var centralSize = central.reduce(function (sum, entry) { return sum + entry.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = chunks.reduce(function (sum, chunk) { return sum + chunk.length; }, 0) +
      centralSize + eocd.length;
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (chunk) { out.set(chunk, at); at += chunk.length; });
    central.forEach(function (chunk) { out.set(chunk, at); at += chunk.length; });
    out.set(eocd, at);
    return out;
  }

  return {
    parse: parse,
    exportGroup: exportGroup,
    exportSingleStl: exportSingleStl,
    stlBinary: stlBinary,
    stlAsciiFromGroups: stlAsciiFromGroups,
    objText: objText,
    plyText: plyText,
    zipFiles: zipFiles,
    readZipEntries: readZipEntries,
    readEntry: readEntry,
    decodePaintState: decodePaintState,
    dominantPaintState: dominantPaintState
  };
});
