/**
 * Leitor e divisor de 3MF por paint_color.
 *
 * O 3MF é um ZIP com XML. Modelos do Bambu Studio/Creality guardam a pintura
 * por triângulo em `paint_color`; o divisor junta os triângulos de mesmo valor
 * (0 quando não há pintura), aplica as transformações de componentes/build e
 * exporta STL, OBJ ou PLY. Roda na página normal da extensão: ZIP + XML +
 * geometria, sem Python e sem servidor.
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

  function localName(name) {
    var parts = String(name || '').split(':');
    return parts[parts.length - 1];
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
  // XML (parser mínimo para o modelo 3MF)
  // -------------------------------------------------------------------------

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function parseAttrs(text) {
    var attrs = {};
    var re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var match;
    while ((match = re.exec(text || ''))) {
      attrs[match[1]] = decodeEntities(match[2] !== undefined ? match[2] : match[3]);
    }
    return attrs;
  }

  function parseXml(text) {
    var root = { name: '#document', attrs: {}, children: [] };
    var stack = [root];
    var re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
    var match;
    while ((match = re.exec(text))) {
      if (match[1]) {
        var closing = localName(match[1]);
        for (var i = stack.length - 1; i > 0; i--) {
          if (localName(stack[i].name) === closing) {
            stack.length = i;
            break;
          }
        }
      } else if (match[2]) {
        var node = {
          name: match[2],
          attrs: parseAttrs(match[3] || ''),
          children: []
        };
        stack[stack.length - 1].children.push(node);
        if (!match[4]) stack.push(node);
      }
    }
    return root;
  }

  function child(node, name) {
    if (!node) return null;
    var wanted = localName(name);
    for (var i = 0; i < node.children.length; i++) {
      if (localName(node.children[i].name) === wanted) return node.children[i];
    }
    return null;
  }

  function children(node, name) {
    if (!node) return [];
    var wanted = localName(name);
    return node.children.filter(function (item) {
      return localName(item.name) === wanted;
    });
  }

  function attr(node, name) {
    if (!node) return '';
    if (node.attrs[name] !== undefined) return node.attrs[name];
    var wanted = localName(name);
    var keys = Object.keys(node.attrs);
    for (var i = 0; i < keys.length; i++) {
      if (localName(keys[i]) === wanted) return node.attrs[keys[i]];
    }
    return '';
  }

  // -------------------------------------------------------------------------
  // modelo 3MF
  // -------------------------------------------------------------------------

  function parseModel(text, path) {
    var xml = parseXml(text);
    var model = child(xml, 'model') || xml;
    var resources = child(model, 'resources');
    var objects = {};

    children(resources, 'object').forEach(function (objectNode) {
      var id = attr(objectNode, 'id');
      if (!id) return;
      var meshNode = child(objectNode, 'mesh');
      var mesh = null;
      if (meshNode) {
        var vertexNodes = children(child(meshNode, 'vertices'), 'vertex');
        var vertices = vertexNodes.map(function (vertex) {
          return [
            parseNumber(attr(vertex, 'x')),
            parseNumber(attr(vertex, 'y')),
            parseNumber(attr(vertex, 'z'))
          ];
        });
        var triangleNodes = children(child(meshNode, 'triangles'), 'triangle');
        var triangles = triangleNodes.map(function (triangle) {
          return {
            a: Math.round(parseNumber(attr(triangle, 'v1'), -1)),
            b: Math.round(parseNumber(attr(triangle, 'v2'), -1)),
            c: Math.round(parseNumber(attr(triangle, 'v3'), -1)),
            paint: Math.round(parseNumber(attr(triangle, 'paint_color'), 0))
          };
        }).filter(function (triangle) {
          return triangle.a >= 0 && triangle.b >= 0 && triangle.c >= 0;
        });
        mesh = { vertices: vertices, triangles: triangles };
      }

      var componentNodes = children(child(objectNode, 'components'), 'component');
      var components = componentNodes.map(function (component) {
        return {
          objectid: attr(component, 'objectid'),
          path: attr(component, 'p:path') || attr(component, 'path'),
          transform: parseTransform(attr(component, 'transform'))
        };
      });

      objects[id] = {
        id: id,
        type: attr(objectNode, 'type'),
        mesh: mesh,
        components: components
      };
    });

    var buildNode = child(model, 'build');
    var build = children(buildNode, 'item').map(function (item) {
      return {
        objectid: attr(item, 'objectid'),
        transform: parseTransform(attr(item, 'transform'))
      };
    });

    return {
      path: normalizePath(path),
      unit: attr(model, 'unit') || 'millimeter',
      objects: objects,
      build: build
    };
  }

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

  function applyTransform(m, point) {
    return [
      point[0] * m[0] + point[1] * m[4] + point[2] * m[8] + m[12],
      point[0] * m[1] + point[1] * m[5] + point[2] * m[9] + m[13],
      point[0] * m[2] + point[1] * m[6] + point[2] * m[10] + m[14]
    ];
  }

  // -------------------------------------------------------------------------
  // divisão por paint_color
  // -------------------------------------------------------------------------

  function emptyBounds() {
    return {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity]
    };
  }

  function includePoint(bounds, point) {
    for (var k = 0; k < 3; k++) {
      if (point[k] < bounds.min[k]) bounds.min[k] = point[k];
      if (point[k] > bounds.max[k]) bounds.max[k] = point[k];
    }
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

  function addMesh(mesh, transform, context) {
    if (!mesh || !mesh.vertices.length || !mesh.triangles.length) return;
    var transformed = mesh.vertices.map(function (vertex) {
      return applyTransform(transform, vertex);
    });
    var bounds = context.bounds;
    var triangles = mesh.triangles;

    for (var i = 0; i < triangles.length; i++) {
      var triangle = triangles[i];
      var a = transformed[triangle.a];
      var b = transformed[triangle.b];
      var c = transformed[triangle.c];
      if (!a || !b || !c) continue;

      var id = String(triangle.paint || 0);
      var group = context.groups[id];
      if (!group) {
        group = context.groups[id] = {
          id: id,
          positions: [],
          triangles: 0,
          bounds: emptyBounds()
        };
      }
      group.positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      group.triangles += 1;
      includePoint(group.bounds, a);
      includePoint(group.bounds, b);
      includePoint(group.bounds, c);
      includePoint(bounds, a);
      includePoint(bounds, b);
      includePoint(bounds, c);
      context.triangles += 1;
    }
    context.objects += 1;
  }

  function resolveObject(context, modelPath, objectId, transform, stack) {
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
    if (object.mesh) addMesh(object.mesh, transform, context);

    object.components.forEach(function (component) {
      if (!component.objectid) return;
      var nextPath = component.path ? normalizePath(component.path) : modelPath;
      var nextTransform = context.applyTransforms ? multiply(transform, component.transform) : IDENTITY;
      resolveObject(context, nextPath, component.objectid, nextTransform, stack.concat(marker));
    });
  }

  function readFilamentColors(text) {
    if (!text) return [];
    var json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (json) {
      var list = json.filament_colour || json.default_filament_colour || [];
      return (Array.isArray(list) ? list : []).filter(function (color) {
        return /^#[0-9a-f]{6}$/i.test(String(color || ''));
      });
    }
    var match = text.match(/"filament_colour"\s*:\s*\[([\s\S]*?)\]/);
    if (!match) return [];
    return (match[1].match(/#[0-9a-fA-F]{6}/g) || []);
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

    var models = {};
    await Promise.all(modelKeys.map(async function (key) {
      var text = await readText(buffer, entries[key]);
      models[lowerPath(key)] = parseModel(text, key);
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

    var context = {
      models: models,
      groups: {},
      warnings: [],
      bounds: emptyBounds(),
      triangles: 0,
      objects: 0,
      applyTransforms: options.applyTransforms !== false
    };

    if (main.build.length) {
      main.build.forEach(function (item) {
        var transform = context.applyTransforms ? item.transform : IDENTITY;
        resolveObject(context, mainKey, item.objectid, transform, []);
      });
    } else {
      var objectIds = Object.keys(main.objects);
      objectIds.forEach(function (id) {
        if (main.objects[id].mesh) {
          resolveObject(context, mainKey, id, IDENTITY, []);
        }
      });
      if (!context.objects) {
        Object.keys(models).forEach(function (path) {
          Object.keys(models[path].objects).forEach(function (id) {
            if (models[path].objects[id].mesh) resolveObject(context, path, id, IDENTITY, []);
          });
        });
      }
    }

    var colors = [];
    var settingsEntry = findEntry(entries, 'Metadata/project_settings.config');
    if (settingsEntry) {
      try {
        colors = readFilamentColors(await readText(buffer, settingsEntry));
      } catch (e) {
        context.warnings.push('não foi possível ler as cores do projeto: ' + e.message);
      }
    }

    var ids = Object.keys(context.groups).sort(function (a, b) {
      return Number(a) - Number(b);
    });
    var groups = ids.map(function (id, index) {
      var group = context.groups[id];
      var bounds = finishBounds(group.bounds);
      return {
        id: id,
        name: 'paint_color_' + id,
        color: colors[index] || PALETTE[index % PALETTE.length],
        positions: new Float32Array(group.positions),
        triangles: group.triangles,
        size: bounds.size,
        min: bounds.min,
        max: bounds.max
      };
    });

    if (!groups.length) context.warnings.push('nenhum triângulo com geometria foi encontrado');
    if (groups.length === 1 && groups[0].id === '0') {
      context.warnings.push('este 3MF não tem paint_color; toda a malha ficou no grupo 0');
    }
    if (!colors.length) context.warnings.push('o projeto não informou filamentos; as cores da prévia são estimadas');

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
    var header = 'Split3mf paint_color_' + group.id;
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
   * Um único STL ASCII, com um `solid` por paint_color. É a forma de manter
   * "partes separadas" em STL: o formato binário não tem nomes/objetos.
   */
  function stlAsciiFromGroups(groups) {
    var lines = [];
    (groups || []).forEach(function (group) {
      var positions = group.positions;
      var triangles = Math.floor(positions.length / 9);
      if (!triangles) return;
      var name = String(group.name || ('paint_color_' + group.id)).replace(/\s+/g, '_');
      lines.push('solid ' + name);
      for (var t = 0; t < triangles; t++) {
        var p = t * 9;
        var n = triangleNormal(positions, p);
        lines.push(' facet normal ' + n[0].toFixed(6) + ' ' + n[1].toFixed(6) + ' ' + n[2].toFixed(6));
        lines.push('  outer loop');
        for (var v = 0; v < 3; v++) {
          lines.push('   vertex ' +
            positions[p + v * 3].toFixed(6) + ' ' +
            positions[p + v * 3 + 1].toFixed(6) + ' ' +
            positions[p + v * 3 + 2].toFixed(6));
        }
        lines.push('  endloop');
        lines.push(' endfacet');
      }
      lines.push('endsolid ' + name);
    });
    return lines.join('\n') + '\n';
  }

  function indexedMesh(group) {
    var positions = group.positions;
    var vertices = [];
    var faces = [];
    var lookup = {};
    for (var i = 0; i < positions.length; i += 9) {
      var face = [];
      for (var v = 0; v < 3; v++) {
        var x = positions[i + v * 3];
        var y = positions[i + v * 3 + 1];
        var z = positions[i + v * 3 + 2];
        var key = x.toFixed(6) + '|' + y.toFixed(6) + '|' + z.toFixed(6);
        var index = lookup[key];
        if (index === undefined) {
          index = vertices.length;
          lookup[key] = index;
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
    var lines = ['# Split3mf · paint_color_' + group.id, 'o paint_color_' + group.id];
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
      'comment Split3mf paint_color_' + group.id,
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
    readZipEntries: readZipEntries
  };
});
