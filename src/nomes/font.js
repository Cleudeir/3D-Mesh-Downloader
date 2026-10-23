/**
 * Leitor de fontes TrueType (.ttf) e montagem do texto em contornos 2D.
 *
 * O gerador de nomes roda dentro da extensao (sem rede e sem bibliotecas), por
 * isso o leitor e proprio: cmap -> indice do glifo, loca/glyf -> contornos e
 * hmtx -> avanco. As curvas quadraticas sao achatadas em poligonos, que depois
 * viram a distancia assinada usada pela geometria.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NomesFont = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tolerancia de achatamento das curvas, em ems. 1/1000 de em vira ~0.008 mm
  // num texto de 8 mm - bem abaixo do passo da malha.
  var FLATTEN_EM = 1 / 1000;

  function fail(message) {
    throw new Error(message);
  }

  function Font(data) {
    var view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    var tag = view.getUint32(0);
    // 0x00010000 = TrueType, 'true' = Apple, 'OTTO' = CFF (sem glyf)
    if (tag !== 0x00010000 && tag !== 0x74727565) {
      if (tag === 0x4f54544f) fail('fonte CFF (.otf) nao suportada - use um .ttf');
      if (tag === 0x74746366) fail('colecao de fontes (.ttc) nao suportada - use um .ttf');
      fail('arquivo nao parece uma fonte TrueType');
    }

    var numTables = view.getUint16(4);
    var tables = {};
    for (var i = 0; i < numTables; i++) {
      var p = 12 + i * 16;
      var name = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
      tables[name] = { offset: view.getUint32(p + 8), length: view.getUint32(p + 12) };
    }
    ['head', 'maxp', 'cmap', 'hhea', 'hmtx', 'loca', 'glyf'].forEach(function (required) {
      if (!tables[required]) fail('fonte sem a tabela "' + required + '"');
    });

    this.data = data;
    this.view = view;
    this.tables = tables;
    this.unitsPerEm = view.getUint16(tables.head.offset + 18) || 1000;
    this.glyphCount = view.getUint16(tables.maxp.offset + 4);
    this.hMetricCount = view.getUint16(tables.hhea.offset + 34);
    this.locaFormat = view.getInt16(tables.head.offset + 50);
    this.glyphCache = {};
    this.lookup = this.buildCmap();
  }

  Font.prototype.buildCmap = function () {
    var view = this.view;
    var cmap = this.tables.cmap.offset;
    var count = view.getUint16(cmap + 2);
    var best = null;
    var bestScore = -1;

    for (var i = 0; i < count; i++) {
      var p = cmap + 4 + i * 8;
      var platform = view.getUint16(p);
      var encoding = view.getUint16(p + 2);
      var offset = cmap + view.getUint32(p + 4);
      var format = view.getUint16(offset);
      // (3,10) Unicode completo > (3,1) BMP > (0,x) simbolico
      var score = 0;
      if (format === 12) score = 3;
      else if (format === 4) score = 2;
      else if (format === 6) score = 1;
      else if (format === 0) score = 1;
      else continue;
      if (platform === 3 && encoding === 10) score += 4;
      else if (platform === 3 && encoding === 1) score += 3;
      else if (platform === 0) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }

    if (best == null) fail('fonte sem tabela cmap utilizavel');
    var format = view.getUint16(best);

    if (format === 12) {
      var groups = view.getUint32(best + 12);
      var base = best + 16;
      return function (cp) {
        var lo = 0;
        var hi = groups - 1;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          var start = view.getUint32(base + mid * 12);
          var end = view.getUint32(base + mid * 12 + 4);
          if (cp < start) hi = mid - 1;
          else if (cp > end) lo = mid + 1;
          else return view.getUint32(base + mid * 12 + 8) + (cp - start);
        }
        return 0;
      };
    }

    if (format === 4) {
      var segX2 = view.getUint16(best + 6);
      var segCount = segX2 / 2;
      var endOff = best + 14;
      var startOff = endOff + segX2 + 2;
      var deltaOff = startOff + segX2;
      var rangeOff = deltaOff + segX2;
      return function (cp) {
        if (cp > 0xffff) return 0;
        for (var i = 0; i < segCount; i++) {
          var end = view.getUint16(endOff + i * 2);
          if (cp > end) continue;
          var start = view.getUint16(startOff + i * 2);
          if (cp < start) return 0;
          var delta = view.getInt16(deltaOff + i * 2);
          var range = view.getUint16(rangeOff + i * 2);
          if (!range) return (cp + delta) & 0xffff;
          var addr = rangeOff + i * 2 + range + (cp - start) * 2;
          if (addr + 1 >= view.byteLength) return 0;
          var glyph = view.getUint16(addr);
          if (!glyph) return 0;
          return (glyph + delta) & 0xffff;
        }
        return 0;
      };
    }

    if (format === 6) {
      var first = view.getUint16(best + 6);
      var total = view.getUint16(best + 8);
      var array = best + 10;
      return function (cp) {
        var index = cp - first;
        if (index < 0 || index >= total) return 0;
        return view.getUint16(array + index * 2);
      };
    }

    if (format === 0) {
      return function (cp) {
        if (cp < 0 || cp > 255) return 0;
        return view.getUint8(best + 6 + cp);
      };
    }

    fail('formato de cmap ' + format + ' nao suportado');
  };

  Font.prototype.advance = function (gid) {
    var view = this.view;
    var hmtx = this.tables.hmtx.offset;
    var index = gid < this.hMetricCount ? gid : this.hMetricCount - 1;
    if (index < 0) return 0;
    return view.getUint16(hmtx + index * 4);
  };

  /** Offsets do glifo na tabela loca. */
  Font.prototype.glyphRange = function (gid) {
    if (gid < 0 || gid >= this.glyphCount) return null;
    var loca = this.tables.loca.offset;
    if (this.locaFormat === 0) {
      return [
        this.view.getUint16(loca + gid * 2) * 2,
        this.view.getUint16(loca + (gid + 1) * 2) * 2
      ];
    }
    return [
      this.view.getUint32(loca + gid * 4),
      this.view.getUint32(loca + (gid + 1) * 4)
    ];
  };

  /**
   * Contornos do glifo em unidades da fonte, y para cima.
   * Cada contorno e uma lista de pares [x, y].
   */
  Font.prototype.glyphContours = function (gid, depth) {
    if (this.glyphCache[gid]) return this.glyphCache[gid];
    depth = depth || 0;
    var contours = this.readGlyph(gid, depth);
    this.glyphCache[gid] = contours;
    return contours;
  };

  Font.prototype.readGlyph = function (gid, depth) {
    if (depth > 5) return [];
    var view = this.view;
    var data = this.data;
    var range = this.glyphRange(gid);
    if (!range || range[1] <= range[0]) return [];

    var glyf = this.tables.glyf.offset;
    var p = glyf + range[0];
    var contourCount = view.getInt16(p);
    p += 2;

    if (contourCount < 0) {
      p += 8; // bbox do glifo composto
      return this.readComposite(p, depth);
    }

    // glifo simples: bbox (4 x int16) + endPtsOfContours
    p += 8;
    var ends = [];
    var i;
    for (i = 0; i < contourCount; i++) {
      ends.push(view.getUint16(p));
      p += 2;
    }
    var instructions = view.getUint16(p);
    p += 2 + instructions;

    var pointCount = contourCount ? ends[contourCount - 1] + 1 : 0;
    var flags = new Uint8Array(pointCount);
    var xs = new Float64Array(pointCount);
    var ys = new Float64Array(pointCount);
    var onCurve = new Uint8Array(pointCount);

    // flags com compactacao por repeticao: um byte + contador cobre N pontos
    i = 0;
    while (i < pointCount) {
      var flag = view.getUint8(p++);
      var repeat = (flag & 8) ? view.getUint8(p++) + 1 : 1;
      for (var r = 0; r < repeat && i < pointCount; r++) {
        flags[i] = flag;
        onCurve[i] = flag & 1;
        i++;
      }
    }

    var x = 0;
    for (i = 0; i < pointCount; i++) {
      flag = flags[i];
      if (flag & 2) {
        var dx = view.getUint8(p++);
        x += (flag & 16) ? dx : -dx;
      } else if (!(flag & 16)) {
        x += view.getInt16(p);
        p += 2;
      }
      xs[i] = x;
    }

    var y = 0;
    for (i = 0; i < pointCount; i++) {
      flag = flags[i];
      if (flag & 4) {
        var dy = view.getUint8(p++);
        y += (flag & 32) ? dy : -dy;
      } else if (!(flag & 32)) {
        y += view.getInt16(p);
        p += 2;
      }
      ys[i] = y;
    }

    var tolerance = FLATTEN_EM * this.unitsPerEm;
    var result = [];
    var start = 0;
    for (i = 0; i < contourCount; i++) {
      var end = ends[i];
      var ring = [];
      for (var j = start; j <= end; j++) {
        ring.push({ x: xs[j], y: ys[j], on: !!onCurve[j] });
      }
      if (ring.length) result.push(flattenContour(ring, tolerance));
      start = end + 1;
    }
    return result;
  };

  Font.prototype.readComposite = function (p, depth) {
    var view = this.view;
    var contours = [];
    var more = true;
    var steps = 0;

    while (more && steps++ < 32) {
      var flags = view.getUint16(p);
      var gid = view.getUint16(p + 2);
      p += 4;

      var dx = 0;
      var dy = 0;
      if (flags & 1) {
        dx = view.getInt16(p);
        dy = view.getInt16(p + 2);
        p += 4;
      } else {
        dx = view.getInt8(p);
        dy = view.getInt8(p + 1);
        p += 2;
      }

      var a = 1;
      var b = 0;
      var c = 0;
      var d = 1;
      if (flags & 8) {
        a = d = view.getInt16(p) / 16384;
        p += 2;
      } else if (flags & 64) {
        a = view.getInt16(p) / 16384;
        d = view.getInt16(p + 2) / 16384;
        p += 4;
      } else if (flags & 128) {
        a = view.getInt16(p) / 16384;
        b = view.getInt16(p + 2) / 16384;
        c = view.getInt16(p + 4) / 16384;
        d = view.getInt16(p + 6) / 16384;
        p += 8;
      }

      // ARGS_ARE_XY_VALUES ausente = casamento de pontos (raro): sem deslocamento
      if (!(flags & 2)) {
        dx = 0;
        dy = 0;
      }

      var glyph = this.glyphContours(gid, depth + 1);
      for (var i = 0; i < glyph.length; i++) {
        var ring = glyph[i];
        var moved = new Array(ring.length);
        for (var k = 0; k < ring.length; k++) {
          moved[k] = [
            a * ring[k][0] + c * ring[k][1] + dx,
            b * ring[k][0] + d * ring[k][1] + dy
          ];
        }
        contours.push(moved);
      }

      more = !!(flags & 32);
    }
    return contours;
  };

  /**
   * Achata um contorno TrueType (on/off curve) numa polilinha.
   * Regra padrao: pontos fora da curva viram controles de quadraticas e o
   * ponto medio entre dois controles consecutivos entra como ponto da curva.
   */
  function flattenContour(ring, tolerance) {
    var points = ring.slice();
    var out = [];
    var count = points.length;
    var startIndex = 0;

    if (!points[0].on) {
      if (points[count - 1].on) {
        startIndex = count - 1;
      } else {
        // primeiro ponto implicito: media entre o ultimo e o primeiro
        var first = { x: (points[0].x + points[count - 1].x) / 2, y: (points[0].y + points[count - 1].y) / 2, on: true };
        points.unshift(first);
        count++;
      }
    }

    var current = points[startIndex];
    out.push([current.x, current.y]);
    var i = 0;
    var index = (startIndex + 1) % count;

    while (i < count) {
      var point = points[index];
      if (point.on) {
        out.push([point.x, point.y]);
        index = (index + 1) % count;
        i++;
        current = point;
        continue;
      }

      var nextIndex = (index + 1) % count;
      var next = points[nextIndex];
      if (next.on) {
        flattenQuad(out, current, point, next, tolerance);
        current = next;
        index = (nextIndex + 1) % count;
        i += 2;
      } else {
        var mid = { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2, on: true };
        flattenQuad(out, current, point, mid, tolerance);
        current = mid;
        index = nextIndex;
        i++;
      }
    }

    // remove o ponto final duplicado do fechamento
    var last = out[out.length - 1];
    if (last && Math.abs(last[0] - out[0][0]) < 1e-9 && Math.abs(last[1] - out[0][1]) < 1e-9) {
      out.pop();
    }
    return out;
  }

  function flattenQuad(out, p0, control, p1, tolerance) {
    var dx = p0.x - 2 * control.x + p1.x;
    var dy = p0.y - 2 * control.y + p1.y;
    var curvature = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.ceil(Math.sqrt(curvature / (4 * Math.max(tolerance, 1e-6))));
    if (!isFinite(steps) || steps < 1) steps = 1;
    if (steps > 24) steps = 24;
    for (var i = 1; i < steps; i++) {
      var t = i / steps;
      var mt = 1 - t;
      out.push([
        mt * mt * p0.x + 2 * mt * t * control.x + t * t * p1.x,
        mt * mt * p0.y + 2 * mt * t * control.y + t * t * p1.y
      ]);
    }
    out.push([p1.x, p1.y]);
  }

  /**
   * Texto em milimetros, y para cima, centralizado na origem.
   *
   * Retorna { contours, width, height, minX, maxX, minY, maxY }.
   */
  Font.prototype.layout = function (text, size) {
    var scale = size / this.unitsPerEm;
    var contours = [];
    var penX = 0;
    var chars = Array.from ? Array.from(String(text)) : String(text).split('');

    for (var i = 0; i < chars.length; i++) {
      var cp = chars[i].codePointAt(0);
      var gid = this.lookup(cp);
      var glyph = this.glyphContours(gid);
      for (var c = 0; c < glyph.length; c++) {
        var ring = glyph[c];
        var moved = new Array(ring.length);
        for (var k = 0; k < ring.length; k++) {
          moved[k] = {
            x: (penX + ring[k][0]) * scale,
            y: ring[k][1] * scale
          };
        }
        if (moved.length > 2) contours.push(moved);
      }
      penX += this.advance(gid);
    }

    var minX = Infinity;
    var maxX = -Infinity;
    var minY = Infinity;
    var maxY = -Infinity;
    contours.forEach(function (ring) {
      ring.forEach(function (point) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      });
    });
    if (!contours.length) {
      return { contours: [], width: 0, height: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
    }

    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    contours.forEach(function (ring) {
      ring.forEach(function (point) {
        point.x -= cx;
        point.y -= cy;
      });
    });

    return {
      contours: contours,
      width: maxX - minX,
      height: maxY - minY,
      minX: minX - cx,
      maxX: maxX - cx,
      minY: minY - cy,
      maxY: maxY - cy
    };
  };

  return {
    parse: function (buffer) {
      var data = buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
      return new Font(data);
    },
    flattenContour: flattenContour
  };
});
