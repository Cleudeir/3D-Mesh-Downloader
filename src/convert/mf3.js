/**
 * Escritor 3MF (formato core, sem extensoes).
 *
 * Monta um pacote OPC minimo - [Content_Types].xml, _rels/.rels e
 * 3D/3dmodel.model - com uma cor por peca em <basematerials>. O ZIP usa o
 * writer "store" que ja existe em split/3mf.js (sem compressao, sem deps).
 *
 * Os vertices chegam em milimetros e com Z para cima: a pagina converte o
 * arquivo de entrada antes de chamar build().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../split/3mf.js'));
  else root.Convert3mf = factory(root.Split3mf);
})(typeof self !== 'undefined' ? self : this, function (zip) {
  'use strict';

  var CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';

  var RELS =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';

  var MODEL_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

  // Coordenadas em mm, arredondadas a 1/10000 mm (0,1 micron). O mesmo
  // arredondamento serve de chave na deduplicacao, entao dois vertices que
  // saem iguais no XML tambem contam como um so.
  function quant(value) {
    var rounded = Math.round(value * 10000) / 10000;
    return rounded === 0 ? 0 : rounded;
  }

  function num(value) {
    var rounded = quant(value);
    var text = String(rounded);
    if (text.indexOf('e') !== -1 || text.indexOf('E') !== -1) {
      text = rounded.toFixed(6).replace(/\.?0+$/, '');
    }
    return text;
  }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function channel(value) {
    var n = Math.round(Number(value) || 0);
    if (n < 0) n = 0;
    if (n > 255) n = 255;
    return (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
  }

  function colorHex(color) {
    var c = color || [200, 200, 205];
    return '#' + channel(c[0]) + channel(c[1]) + channel(c[2]) + 'FF';
  }

  function colorKey(color) {
    var c = color || [200, 200, 205];
    return channel(c[0]) + channel(c[1]) + channel(c[2]);
  }

  /** Junta vertices repetidos e devolve { vertices: [...], triangles: [...] }. */
  function dedupe(positions) {
    var seen = new Map();
    var vertices = [];
    var triangles = [];
    var count = positions.length / 3;

    for (var i = 0; i < count; i++) {
      var x = quant(positions[i * 3]);
      var y = quant(positions[i * 3 + 1]);
      var z = quant(positions[i * 3 + 2]);
      var key = x + ',' + y + ',' + z;
      var index = seen.get(key);
      if (index === undefined) {
        index = vertices.length / 3;
        seen.set(key, index);
        vertices.push(x, y, z);
      }
      triangles.push(index);
    }

    return { vertices: vertices, triangles: triangles };
  }

  function writeMesh(xml, part, index, pindex) {
    var geometry = dedupe(part.positions);
    if (!geometry.triangles.length) return null;

    xml.push('<object id="' + (index + 2) + '" type="model" name="' + esc(part.name || ('peca ' + (index + 1))) +
      '" pid="1" pindex="' + pindex + '">');

    xml.push('<mesh><vertices>');
    for (var v = 0; v < geometry.vertices.length; v += 3) {
      xml.push('<vertex x="' + num(geometry.vertices[v]) + '" y="' + num(geometry.vertices[v + 1]) +
        '" z="' + num(geometry.vertices[v + 2]) + '"/>');
    }
    xml.push('</vertices><triangles>');
    for (var t = 0; t < geometry.triangles.length; t += 3) {
      xml.push('<triangle v1="' + geometry.triangles[t] + '" v2="' + geometry.triangles[t + 1] +
        '" v3="' + geometry.triangles[t + 2] + '"/>');
    }
    xml.push('</triangles></mesh></object>');

    return { index: index, objectId: index + 2 };
  }

  /**
   * parts: [{ name, positions: Float32Array (sopa de triangulos), color: [r,g,b] }]
   * Devolve o XML do 3dmodel.model.
   */
  function modelXml(parts) {
    var list = (parts || []).filter(function (part) {
      return part && part.positions && part.positions.length >= 9;
    });
    if (!list.length) throw new Error('nenhuma peca com triangulos para exportar');

    var materials = [];
    var materialIndex = new Map();
    list.forEach(function (part) {
      var key = colorKey(part.color);
      if (!materialIndex.has(key)) {
        materialIndex.set(key, materials.length);
        materials.push({ key: key, color: colorHex(part.color) });
      }
    });

    var xml = [];
    xml.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    xml.push('<model unit="millimeter" xml:lang="pt-BR" xmlns="' + MODEL_NS + '">');
    xml.push('<resources>');

    xml.push('<basematerials id="1">');
    materials.forEach(function (material, i) {
      xml.push('<base name="cor ' + (i + 1) + '" displaycolor="' + material.color + '"/>');
    });
    xml.push('</basematerials>');

    var written = [];
    list.forEach(function (part, i) {
      var pindex = materialIndex.get(colorKey(part.color));
      var mesh = writeMesh(xml, part, i, pindex);
      if (mesh) written.push({ part: part, objectId: mesh.objectId });
    });

    if (!written.length) throw new Error('nenhuma peca com triangulos para exportar');

    xml.push('</resources><build>');
    written.forEach(function (item) {
      xml.push('<item objectid="' + item.objectId + '"/>');
    });
    xml.push('</build></model>');
    return xml.join('');
  }

  /** Devolve o pacote .3mf completo (Uint8Array). */
  function build(parts) {
    var model = modelXml(parts);
    return zip.zipFiles([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: RELS },
      { name: '3D/3dmodel.model', data: model }
    ]);
  }

  return {
    build: build,
    modelXml: modelXml
  };
});
