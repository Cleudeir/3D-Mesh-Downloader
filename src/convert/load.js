/**
 * Leitura dos arquivos 3D para o conversor 3MF.
 *
 * Aceita glTF/GLB (inclusive .bin ao lado do .gltf), OBJ (+ .mtl) e STL
 * binario/ASCII. Nao usa three.js nem nenhuma dependencia: le o JSON/XML cru,
 * resolve os accessors e devolve uma lista de pecas com posicoes em triangulos
 * e a cor de cada material.
 *
 * O que o formato nao guarda (textura -> cor) vira um aviso: 3MF core nao
 * carrega textura, entao a cor de cada peca vem do material ou do COLOR_0.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../split/3mf.js'));
  else root.ConvertLoad = factory(root.Split3mf);
})(typeof self !== 'undefined' ? self : this, function (zip) {
  'use strict';

  var COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  var COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  var NORMALIZE_MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295 };

  var PALETTE = [
    [91, 108, 255], [255, 138, 101], [76, 175, 80], [255, 213, 79],
    [171, 71, 188], [38, 198, 218], [239, 83, 80], [141, 110, 99],
    [126, 87, 194], [0, 150, 136], [255, 167, 38], [84, 110, 122]
  ];

  // ---------------------------------------------------------------------------
  // bytes e texto
  // ---------------------------------------------------------------------------

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    return new Uint8Array(0);
  }

  function decodeText(bytes) {
    return new TextDecoder('utf-8').decode(toBytes(bytes));
  }

  function base64ToBytes(text) {
    var binary;
    if (typeof atob === 'function') {
      binary = atob(text);
    } else {
      binary = Buffer.from(text, 'base64').toString('binary');
    }
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
    return out;
  }

  function baseName(fileName) {
    var name = String(fileName || 'modelo').split(/[\\/]/).pop();
    return name.replace(/\.[^.]+$/, '');
  }

  // ---------------------------------------------------------------------------
  // cores
  // ---------------------------------------------------------------------------

  function clamp255(value) {
    var n = Math.round(value);
    return n < 0 ? 0 : (n > 255 ? 255 : n);
  }

  function linearToSrgb(value) {
    var c = Math.min(1, Math.max(0, Number(value) || 0));
    var s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return clamp255(s * 255);
  }

  function srgbFromLinear(rgb) {
    return [linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])];
  }

  function hashColor(name) {
    var hash = 0;
    var text = String(name || '');
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }

  // ---------------------------------------------------------------------------
  // matrizes (coluna-maior, como no glTF)
  // ---------------------------------------------------------------------------

  function identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function multiply(a, b) {
    var out = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function nodeMatrix(node) {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
    var t = node.translation || [0, 0, 0];
    var q = node.rotation || [0, 0, 0, 1];
    var s = node.scale || [1, 1, 1];
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var sx = s[0], sy = s[1], sz = s[2];
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      t[0], t[1], t[2], 1
    ];
  }

  // ---------------------------------------------------------------------------
  // glTF / GLB
  // ---------------------------------------------------------------------------

  function parseGlb(bytes) {
    var data = toBytes(bytes);
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < 12 || view.getUint32(0, true) !== 0x46546c67) {
      throw new Error('GLB invalido: assinatura glTF ausente');
    }
    var length = Math.min(data.byteLength, view.getUint32(8, true));
    var offset = 12;
    var json = null;
    var bin = null;

    while (offset + 8 <= length) {
      var size = view.getUint32(offset, true);
      var type = view.getUint32(offset + 4, true);
      var start = offset + 8;
      if (start + size > data.byteLength) break;
      var chunk = data.subarray(start, start + size);
      if (type === 0x4e4f534a) json = JSON.parse(decodeText(chunk));
      else if (type === 0x004e4942) bin = chunk;
      offset = start + size;
      offset += (4 - (size % 4)) % 4;
    }

    if (!json) throw new Error('GLB sem bloco JSON');
    return { json: json, bin: bin };
  }

  function resolveBuffers(json, bin, extras, warnings) {
    var list = json.buffers || [];
    return list.map(function (buffer) {
      if (!buffer || !buffer.uri) return bin;
      var uri = buffer.uri;
      if (uri.indexOf('data:') === 0) {
        var comma = uri.indexOf(',');
        if (comma === -1) return null;
        try {
          return base64ToBytes(uri.slice(comma + 1));
        } catch (e) {
          warnings.push('buffer embutido invalido');
          return null;
        }
      }
      var name = decodeURIComponent(uri.split('/').pop()).toLowerCase();
      var found = extras.get(name) || extras.get(name.toLowerCase());
      if (found) return toBytes(found);
      warnings.push('buffer externo nao encontrado: ' + uri + ' (solte o .bin junto)');
      return null;
    });
  }

  function readAccessor(json, buffers, index, warnings) {
    var accessor = json.accessors && json.accessors[index];
    if (!accessor) return null;
    var itemSize = COMPONENTS[accessor.type] || 1;
    var out = new Float32Array(accessor.count * itemSize);
    if (accessor.bufferView == null) {
      return { data: out, count: accessor.count, itemSize: itemSize };
    }

    var view = json.bufferViews[accessor.bufferView];
    var bytes = view ? buffers[view.buffer] : null;
    if (!bytes) return null;

    var componentSize = COMPONENT_SIZE[accessor.componentType] || 4;
    var elementSize = itemSize * componentSize;
    var stride = view.byteStride || elementSize;
    var start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    var data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var normalize = !!accessor.normalized;
    var max = NORMALIZE_MAX[accessor.componentType] || 1;

    for (var i = 0; i < accessor.count; i++) {
      var base = start + i * stride;
      for (var c = 0; c < itemSize; c++) {
        var at = base + c * componentSize;
        var value;
        switch (accessor.componentType) {
          case 5120: value = data.getInt8(at); break;
          case 5121: value = data.getUint8(at); break;
          case 5122: value = data.getInt16(at, true); break;
          case 5123: value = data.getUint16(at, true); break;
          case 5125: value = data.getUint32(at, true); break;
          default: value = data.getFloat32(at, true);
        }
        if (normalize) value = value < 0 ? Math.max(value / max, -1) : value / max;
        out[i * itemSize + c] = value;
      }
    }

    return { data: out, count: accessor.count, itemSize: itemSize };
  }

  function averageVertexColor(json, buffers, attributes, warnings) {
    if (attributes.COLOR_0 == null) return null;
    var accessor = readAccessor(json, buffers, attributes.COLOR_0, warnings);
    if (!accessor || !accessor.count) return null;
    var sum = [0, 0, 0];
    var n = accessor.itemSize;
    for (var i = 0; i < accessor.count; i++) {
      for (var k = 0; k < 3; k++) sum[k] += accessor.data[i * n + k];
    }
    return [sum[0] / accessor.count, sum[1] / accessor.count, sum[2] / accessor.count];
  }

  function materialColor(json, index, vertexColor) {
    var material = index != null && json.materials ? json.materials[index] : null;
    var linear = null;

    if (material) {
      var pbr = material.pbrMetallicRoughness || {};
      if (Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length >= 3) {
        linear = pbr.baseColorFactor;
      } else if (material.extensions && material.extensions.KHR_materials_pbrSpecularGlossiness &&
        Array.isArray(material.extensions.KHR_materials_pbrSpecularGlossiness.diffuseFactor)) {
        linear = material.extensions.KHR_materials_pbrSpecularGlossiness.diffuseFactor;
      } else if (pbr.baseColorTexture) {
        return { color: vertexColor ? srgbFromLinear(vertexColor) : [205, 205, 210], textured: true };
      }
    }

    if (!linear && vertexColor) return { color: srgbFromLinear(vertexColor), textured: false };
    if (!material) return { color: [205, 205, 210], textured: false };
    if (!linear) linear = [1, 1, 1, 1]; // sem fator = branco (padrao do glTF)
    return { color: srgbFromLinear(linear), textured: false };
  }

  function parseGltf(fileName, json, bin, extras, warnings) {
    var buffers = resolveBuffers(json, bin, extras, warnings);
    var nodes = json.nodes || [];
    var scenes = json.scenes || [];
    var scene = scenes[json.scene || 0] || scenes[0];
    var children = {};
    nodes.forEach(function (node) {
      (node.children || []).forEach(function (child) { children[child] = true; });
    });

    var roots = [];
    if (scene && Array.isArray(scene.nodes) && scene.nodes.length) roots = scene.nodes.slice();
    else {
      nodes.forEach(function (node, index) { if (!children[index]) roots.push(index); });
    }

    var parts = [];
    var textured = false;

    function addPrimitive(node, world, mesh, primitive, ordinal) {
      if (primitive.mode != null && primitive.mode !== 4) {
        warnings.push('primitiva ignorada: modo ' + primitive.mode + ' (so triangulos)');
        return;
      }
      var extensions = primitive.extensions || {};
      if (extensions.KHR_draco_mesh_compression || extensions.EXT_meshopt_compression) {
        warnings.push('malha comprimida (Draco/meshopt) nao suportada');
        return;
      }

      var attributes = primitive.attributes || {};
      if (attributes.POSITION == null) return;

      var position = readAccessor(json, buffers, attributes.POSITION, warnings);
      if (!position || !position.count) return;
      var indexData = primitive.indices != null ? readAccessor(json, buffers, primitive.indices, warnings) : null;

      var indices = indexData ? indexData.data : null;
      var triangles = indices ? Math.floor(indices.length / 3) : Math.floor(position.count / 3);
      if (triangles <= 0) return;

      var source = position.data;
      var positions = new Float32Array(triangles * 9);
      for (var t = 0; t < triangles; t++) {
        for (var k = 0; k < 3; k++) {
          var vertex = indices ? indices[t * 3 + k] : t * 3 + k;
          if (vertex >= position.count) continue;
          var x = source[vertex * 3];
          var y = source[vertex * 3 + 1];
          var z = source[vertex * 3 + 2];
          var out = (t * 3 + k) * 3;
          positions[out] = world[0] * x + world[4] * y + world[8] * z + world[12];
          positions[out + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
          positions[out + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
        }
      }

      var material = primitive.material != null && json.materials ? json.materials[primitive.material] : null;
      var vertexColor = averageVertexColor(json, buffers, attributes, warnings);
      var info = materialColor(json, primitive.material, vertexColor);
      if (info.textured) {
        textured = true;
        warnings.push('textura ignorada: a peca usa a cor media do material');
      }

      var label = node.name || mesh.name || ('malha ' + (ordinal + 1));
      if (material && material.name && material.name !== label) label += ' - ' + material.name;

      parts.push({
        name: label,
        positions: positions,
        faces: triangles,
        color: info.color
      });
    }

    function walk(index, parent, depth) {
      if (depth > 64) return;
      var node = nodes[index];
      if (!node) return;
      var world = multiply(parent, nodeMatrix(node));
      if (node.mesh != null && json.meshes && json.meshes[node.mesh]) {
        var mesh = json.meshes[node.mesh];
        (mesh.primitives || []).forEach(function (primitive, ordinal) {
          addPrimitive(node, world, mesh, primitive, ordinal);
        });
      }
      (node.children || []).forEach(function (child) { walk(child, world, depth + 1); });
    }

    roots.forEach(function (index) { walk(index, identity(), 0); });

    if (!parts.length) {
      throw new Error('nenhuma malha de triangulos encontrada no glTF' +
        (warnings.length ? ': ' + warnings[0] : ''));
    }

    return {
      kind: /\.glb$/i.test(fileName) ? 'glb' : 'gltf',
      name: baseName(fileName),
      parts: parts,
      warnings: warnings,
      unitScale: 1000, // glTF usa metros
      yUp: true,
      textured: textured
    };
  }

  // ---------------------------------------------------------------------------
  // OBJ + MTL
  // ---------------------------------------------------------------------------

  function parseMtl(text) {
    var colors = {};
    var current = null;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var clean = line.trim();
      if (!clean || clean.charAt(0) === '#') return;
      var parts = clean.split(/\s+/);
      var head = parts[0].toLowerCase();
      if (head === 'newmtl') {
        current = parts.slice(1).join(' ') || 'material';
        colors[current] = null;
      } else if (head === 'kd' && current) {
        var r = parseFloat(parts[1]);
        var g = parseFloat(parts[2]);
        var b = parseFloat(parts[3]);
        if (isFinite(r) && isFinite(g) && isFinite(b)) {
          colors[current] = [clamp255(r * 255), clamp255(g * 255), clamp255(b * 255)];
        }
      }
    });
    return colors;
  }

  function parseObj(fileName, text, mtlText, warnings) {
    var lines = String(text || '').split(/\r?\n/);
    var vertices = [];
    var groups = new Map();
    var order = [];
    var current = null;
    var mtl = mtlText ? parseMtl(mtlText) : {};

    function group(name) {
      var key = name || '';
      var found = groups.get(key);
      if (!found) {
        var color = mtl[key] || (key ? hashColor(key) : [205, 205, 210]);
        found = { name: key || baseName(fileName), color: color, positions: [] };
        groups.set(key, found);
        order.push(found);
      }
      return found;
    }

    function vertexIndex(token) {
      var raw = parseInt(String(token).split('/')[0], 10);
      if (!isFinite(raw) || raw === 0) return -1;
      return raw < 0 ? vertices.length / 3 + raw : raw - 1;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var head = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' ')).toLowerCase();

      if (head === 'v') {
        var coords = line.slice(1).trim().split(/\s+/);
        var x = parseFloat(coords[0]);
        var y = parseFloat(coords[1]);
        var z = parseFloat(coords[2]);
        vertices.push(isFinite(x) ? x : 0, isFinite(y) ? y : 0, isFinite(z) ? z : 0);
      } else if (head === 'usemtl') {
        current = group(line.slice(6).trim());
      } else if (head === 'f') {
        var refs = line.slice(1).trim().split(/\s+/);
        if (refs.length < 3) continue;
        var target = current || group('');
        var first = vertexIndex(refs[0]);
        for (var k = 1; k + 1 < refs.length; k++) {
          var b = vertexIndex(refs[k]);
          var c = vertexIndex(refs[k + 1]);
          if (first < 0 || b < 0 || c < 0) continue;
          if (first * 3 + 2 >= vertices.length || b * 3 + 2 >= vertices.length || c * 3 + 2 >= vertices.length) continue;
          target.positions.push(
            vertices[first * 3], vertices[first * 3 + 1], vertices[first * 3 + 2],
            vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2],
            vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]
          );
        }
      }
    }

    var parts = order.map(function (item) {
      return {
        name: item.name,
        positions: new Float32Array(item.positions),
        faces: item.positions.length / 9,
        color: item.color
      };
    }).filter(function (part) { return part.faces > 0; });

    if (!parts.length) throw new Error('OBJ sem faces de triangulos');

    return {
      kind: 'obj',
      name: baseName(fileName),
      parts: parts,
      warnings: warnings,
      unitScale: 1,
      yUp: true,
      textured: false
    };
  }

  // ---------------------------------------------------------------------------
  // STL
  // ---------------------------------------------------------------------------

  function looksAscii(bytes) {
    var data = toBytes(bytes);
    var head = decodeText(data.subarray(0, Math.min(200, data.length))).trim().toLowerCase();
    return head.indexOf('solid') === 0 && head.indexOf('facet') !== -1;
  }

  function parseStl(fileName, bytes, warnings) {
    var data = toBytes(bytes);
    var positions = null;
    var ascii = looksAscii(data);

    if (data.byteLength >= 84) {
      var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      var count = view.getUint32(80, true);
      var exact = count > 0 && 84 + count * 50 === data.byteLength;
      var fits = count > 0 && 84 + count * 50 <= data.byteLength;
      if (exact || (fits && !ascii)) {
        positions = new Float32Array(count * 9);
        for (var i = 0; i < count; i++) {
          var at = 84 + i * 50 + 12;
          for (var k = 0; k < 9; k++) {
            positions[i * 9 + k] = view.getFloat32(at + k * 4, true);
          }
        }
      }
    }

    if (!positions) {
      if (!ascii) {
        throw new Error('STL invalido: nem binario (tamanho nao bate) nem ASCII');
      }
      var text = decodeText(data);
      var values = [];
      var regex = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
      var match;
      while ((match = regex.exec(text))) {
        values.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
      }
      var triangles = Math.floor(values.length / 9);
      positions = new Float32Array(triangles * 9);
      for (var v = 0; v < triangles * 9; v++) positions[v] = values[v] || 0;
      if (!triangles) throw new Error('STL ASCII sem triangulos');
    }

    return {
      kind: 'stl',
      name: baseName(fileName),
      parts: [{
        name: baseName(fileName),
        positions: positions,
        faces: positions.length / 9,
        color: [205, 205, 210]
      }],
      warnings: warnings,
      unitScale: 1,
      yUp: false,
      textured: false
    };
  }

  // ---------------------------------------------------------------------------
  // entrada
  // ---------------------------------------------------------------------------

  function extensionOf(name) {
    var match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
  }

  function pickMain(files) {
    var priority = ['glb', 'gltf', 'obj', 'stl'];
    for (var p = 0; p < priority.length; p++) {
      var candidates = files.filter(function (file) {
        return extensionOf(file.name) === priority[p];
      });
      if (!candidates.length) continue;
      // dentro de um ZIP com glTF, prefere o scene.*
      var scene = candidates.filter(function (file) {
        return /^scene\./i.test(String(file.name || ''));
      })[0];
      return scene || candidates[0];
    }
    return null;
  }

  function extrasMap(files, main) {
    var map = new Map();
    files.forEach(function (file) {
      if (file === main) return;
      var name = String(file.name || '').split(/[\\/]/).pop().toLowerCase();
      map.set(name, file.buffer);
      map.set(name.toLowerCase(), file.buffer);
    });
    return map;
  }

  /**
   * files: [{ name, buffer }] - buffer pode ser ArrayBuffer ou Uint8Array.
   */
  function parseFiles(files, options) {
    var list = (files || []).filter(function (file) { return file && file.buffer; });
    if (!list.length) throw new Error('nenhum arquivo recebido');

    var main = pickMain(list);
    if (!main) {
      throw new Error('formato nao suportado: use .glb, .gltf, .obj, .stl ou um .zip com glTF');
    }

    var warnings = [];
    var kind = extensionOf(main.name);
    var extras = extrasMap(list, main);
    var result;

    if (kind === 'glb') {
      var glb = parseGlb(main.buffer);
      result = parseGltf(main.name, glb.json, glb.bin, extras, warnings);
    } else if (kind === 'gltf') {
      var json;
      try {
        json = JSON.parse(decodeText(main.buffer));
      } catch (e) {
        throw new Error('glTF invalido: JSON nao pode ser lido');
      }
      result = parseGltf(main.name, json, null, extras, warnings);
    } else if (kind === 'obj') {
      var mtlFile = null;
      list.forEach(function (file) {
        if (extensionOf(file.name) === 'mtl' && !mtlFile) mtlFile = file;
      });
      var mtlText = mtlFile ? decodeText(mtlFile.buffer) : '';
      if (!mtlFile) warnings.push('sem .mtl: cada material ganhou uma cor da paleta');
      result = parseObj(main.name, decodeText(main.buffer), mtlText, warnings);
    } else {
      result = parseStl(main.name, main.buffer, warnings);
    }

    if (list.length > 1 && !(options && options.quietExtras)) {
      var others = list.length - 1;
      warnings.push(others + ' arquivo(s) extra(s) lido(s) como apoio (.bin/.mtl)');
    }

    // avisos repetidos (uma primitiva por material, por exemplo) aparecem uma vez so
    var seen = {};
    result.warnings = warnings.filter(function (warning) {
      if (seen[warning]) return false;
      seen[warning] = true;
      return true;
    });

    return result;
  }

  /**
   * Um ZIP com glTF traz scene.gltf + scene.bin + texturas. Abre o pacote e
   * devolve so as pecas que o leitor usa (o resto - texturas - fica de fora).
   */
  function expandArchives(files) {
    var list = (files || []).filter(function (file) { return file && file.buffer; });
    var out = [];

    function step(index) {
      if (index >= list.length) return Promise.resolve(out);
      var file = list[index];
      if (extensionOf(file.name) !== 'zip') {
        out.push(file);
        return step(index + 1);
      }

      var buffer = arrayBufferOf(file.buffer);
      var entries;
      try {
        entries = zip.readZipEntries(buffer);
      } catch (error) {
        return Promise.reject(new Error('ZIP invalido: ' + error.message));
      }

      var names = Object.keys(entries).filter(function (name) {
        return name.slice(-1) !== '/' && /\.(glb|gltf|bin|mtl|obj|stl)$/i.test(name);
      });
      if (!names.length) {
        return Promise.reject(new Error('o ZIP nao tem .glb, .gltf, .obj nem .stl'));
      }

      return names.reduce(function (chain, name) {
        return chain.then(function () {
          return zip.readEntry(buffer, entries[name]).then(function (data) {
            out.push({ name: name.split('/').pop(), buffer: data });
          });
        });
      }, Promise.resolve()).then(function () {
        return step(index + 1);
      });
    }

    return step(0);
  }

  function arrayBufferOf(input) {
    if (input instanceof ArrayBuffer) return input;
    var bytes = toBytes(input);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  /** Igual a parseFiles, mas abre .zip com glTF antes. */
  function parseInputs(files) {
    var list = (files || []).filter(function (file) { return file && file.buffer; });
    var container = list.filter(function (file) {
      return extensionOf(file.name) === 'zip';
    })[0];

    return expandArchives(list).then(function (expanded) {
      var result = parseFiles(expanded, { quietExtras: !!container });
      if (container) {
        result.name = baseName(container.name);
        result.container = 'zip';
      }
      return result;
    });
  }

  /**
   * Aplica escala (mm por unidade) e o eixo para cima. Devolve pecas novas -
   * as originais ficam intactas para trocar a opcao sem reler o arquivo.
   */
  function transform(parts, options) {
    var scale = Number(options && options.scale);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    var yUp = !!(options && options.yUp);

    return (parts || []).map(function (part) {
      var source = part.positions;
      var out = new Float32Array(source.length);
      for (var i = 0; i < source.length; i += 3) {
        var x = source[i] * scale;
        var y = source[i + 1] * scale;
        var z = source[i + 2] * scale;
        if (yUp) {
          // Y para cima -> Z para cima (rotacao -90 graus em X)
          out[i] = x;
          out[i + 1] = -z;
          out[i + 2] = y;
        } else {
          out[i] = x;
          out[i + 1] = y;
          out[i + 2] = z;
        }
      }
      return {
        name: part.name,
        color: part.color,
        faces: part.faces,
        positions: out
      };
    });
  }

  function bounds(parts) {
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    (parts || []).forEach(function (part) {
      var positions = part.positions;
      for (var i = 0; i < positions.length; i += 3) {
        for (var k = 0; k < 3; k++) {
          var value = positions[i + k];
          if (value < min[k]) min[k] = value;
          if (value > max[k]) max[k] = value;
        }
      }
    });
    if (!isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    return {
      min: min,
      max: max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    };
  }

  return {
    parseFiles: parseFiles,
    parseInputs: parseInputs,
    expandArchives: expandArchives,
    transform: transform,
    bounds: bounds,
    parseMtl: parseMtl,
    parseGlb: parseGlb,
    palette: PALETTE
  };
});
