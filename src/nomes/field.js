/**
 * Geometria 2D do gerador de nomes: campo de distancia assinada, extracao de
 * contorno (marching squares), simplificacao e triangulacao com furos.
 *
 * O desenho do chaveiro e uma extrusao 2D, entao tudo passa por aqui: o texto
 * e a ponte viram uma distancia assinada, o offset da borda e uma isolinha e o
 * resultado (poligonos fechados) vira tampa + parede no modulo parts.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NomesField = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  // ---------------------------------------------------------------------------
  // utilidades de poligono
  // ---------------------------------------------------------------------------

  function area(points) {
    var sum = 0;
    for (var i = 0, n = points.length; i < n; i++) {
      var a = points[i];
      var b = points[(i + 1) % n];
      sum += a.x * b.y - b.x * a.y;
    }
    return sum / 2;
  }

  function pointInPolygon(px, py, points) {
    var inside = false;
    for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
      var a = points[i];
      var b = points[j];
      if ((a.y > py) !== (b.y > py)) {
        var x = a.x + (py - a.y) / (b.y - a.y) * (b.x - a.x);
        if (x > px) inside = !inside;
      }
    }
    return inside;
  }

  function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
  }

  // ---------------------------------------------------------------------------
  // campo de distancia assinada
  // ---------------------------------------------------------------------------

  /**
   * Distancia assinada (negativa dentro) nas interseccoes da grade.
   *
   * contours: lista de poligonos fechados (regra de preenchimento: winding).
   * options: { h, maxDist }
   */
  function build(contours, options) {
    var h = options.h || 0.15;
    var maxDist = options.maxDist || 3;

    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var segments = [];

    contours.forEach(function (ring) {
      if (!ring || ring.length < 3) return;
      for (var i = 0, n = ring.length; i < n; i++) {
        var a = ring[i];
        var b = ring[(i + 1) % n];
        segments.push(a.x, a.y, b.x, b.y);
        if (a.x < minX) minX = a.x;
        if (a.x > maxX) maxX = a.x;
        if (a.y < minY) minY = a.y;
        if (a.y > maxY) maxY = a.y;
      }
    });

    // pontos extras (a ponte, por exemplo) tambem precisam caber na grade
    (options.extraPoints || []).forEach(function (point) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    });

    if (!segments.length) {
      return { x0: 0, y0: 0, h: h, nx: 0, ny: 0, values: new Float32Array(1), empty: true };
    }

    var pad = maxDist + 2 * h;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    var nx = Math.max(1, Math.ceil((maxX - minX) / h));
    var ny = Math.max(1, Math.ceil((maxY - minY) / h));
    var x0 = minX;
    var y0 = minY;

    var stride = nx + 1;
    var values = new Float32Array(stride * (ny + 1));
    var inside = computeInside(contours, x0, y0, h, nx, ny);
    var distance = computeDistance(segments, x0, y0, h, nx, ny, maxDist);

    for (var j = 0; j <= ny; j++) {
      for (var i = 0; i <= nx; i++) {
        var index = j * stride + i;
        var d = distance[index];
        if (inside[index]) d = -d;
        // zero exato confunde o marching squares: empurra para dentro
        if (d === 0) d = -EPS;
        values[index] = d;
      }
    }

    return { x0: x0, y0: y0, h: h, nx: nx, ny: ny, values: values, stride: stride };
  }

  /** Preenchimento (winding != 0) nas interseccoes da grade. */
  function computeInside(contours, x0, y0, h, nx, ny) {
    var stride = nx + 1;
    var inside = new Uint8Array(stride * (ny + 1));
    var edges = [];
    contours.forEach(function (ring) {
      if (!ring || ring.length < 3) return;
      for (var i = 0, n = ring.length; i < n; i++) {
        edges.push([ring[i], ring[(i + 1) % n]]);
      }
    });

    var crossings = [];
    for (var j = 0; j <= ny; j++) {
      var y = y0 + j * h;
      crossings.length = 0;
      for (var e = 0; e < edges.length; e++) {
        var a = edges[e][0];
        var b = edges[e][1];
        var aUp = a.y > y;
        var bUp = b.y > y;
        if (aUp === bUp) continue;
        var t = (y - a.y) / (b.y - a.y);
        crossings.push({ x: a.x + t * (b.x - a.x), dir: b.y > a.y ? 1 : -1 });
      }
      if (!crossings.length) continue;
      crossings.sort(function (p, q) { return p.x - q.x; });

      var winding = 0;
      for (var c = 0; c < crossings.length - 1; c++) {
        winding += crossings[c].dir;
        if (!winding) continue;
        var from = Math.max(0, Math.ceil((crossings[c].x - x0) / h - 0.5));
        var to = Math.min(nx, Math.floor((crossings[c + 1].x - x0) / h + 0.5));
        for (var i = from; i <= to; i++) inside[j * stride + i] = 1;
      }
    }
    return inside;
  }

  /** Distancia (sem sinal) ate o segmento mais proximo, limitada a maxDist. */
  function computeDistance(segments, x0, y0, h, nx, ny, maxDist) {
    var stride = nx + 1;
    var total = stride * (ny + 1);
    var result = new Float32Array(total);
    var count = segments.length / 4;

    // grade esparsa de segmentos
    var cell = Math.max(maxDist / 2, 0.75);
    var gx = Math.max(1, Math.ceil((nx * h) / cell));
    var gy = Math.max(1, Math.ceil((ny * h) / cell));
    var buckets = new Array(gx * gy);
    for (var s = 0; s < count; s++) {
      var ax = segments[s * 4];
      var ay = segments[s * 4 + 1];
      var bx = segments[s * 4 + 2];
      var by = segments[s * 4 + 3];
      var cx0 = clamp(Math.floor((Math.min(ax, bx) - x0) / cell), 0, gx - 1);
      var cx1 = clamp(Math.floor((Math.max(ax, bx) - x0) / cell), 0, gx - 1);
      var cy0 = clamp(Math.floor((Math.min(ay, by) - y0) / cell), 0, gy - 1);
      var cy1 = clamp(Math.floor((Math.max(ay, by) - y0) / cell), 0, gy - 1);
      for (var yy = cy0; yy <= cy1; yy++) {
        for (var xx = cx0; xx <= cx1; xx++) {
          var key = yy * gx + xx;
          if (!buckets[key]) buckets[key] = [];
          buckets[key].push(s);
        }
      }
    }

    var maxRing = Math.ceil(maxDist / cell) + 1;
    var limit2 = maxDist * maxDist;

    for (var j = 0; j <= ny; j++) {
      var py = y0 + j * h;
      var gyi = clamp(Math.floor((py - y0) / cell), 0, gy - 1);
      for (var i = 0; i <= nx; i++) {
        var px = x0 + i * h;
        var gxi = clamp(Math.floor((px - x0) / cell), 0, gx - 1);
        var best = limit2;
        var found = false;

        for (var ring = 0; ring <= maxRing; ring++) {
          var yMin = gyi - ring;
          var yMax = gyi + ring;
          var xMin = gxi - ring;
          var xMax = gxi + ring;
          for (var by2 = yMin; by2 <= yMax; by2++) {
            if (by2 < 0 || by2 >= gy) continue;
            for (var bx2 = xMin; bx2 <= xMax; bx2++) {
              if (bx2 < 0 || bx2 >= gx) continue;
              // so a borda do anel ja foi visitada antes
              if (ring > 0 && bx2 !== xMin && bx2 !== xMax && by2 !== yMin && by2 !== yMax) continue;
              var bucket = buckets[by2 * gx + bx2];
              if (!bucket) continue;
              for (var b = 0; b < bucket.length; b++) {
                var index = bucket[b] * 4;
                var d2 = segmentDistance2(px, py,
                  segments[index], segments[index + 1],
                  segments[index + 2], segments[index + 3]);
                if (d2 < best) {
                  best = d2;
                  found = true;
                }
              }
            }
          }
          // tudo fora do bloco (2*ring+1) esta a pelo menos ring*cell
          if (found && best <= ring * cell * ring * cell) break;
        }

        result[j * stride + i] = found ? Math.sqrt(best) : maxDist;
      }
    }
    return result;
  }

  function segmentDistance2(px, py, ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) {
      var ex = px - ax;
      var ey = py - ay;
      return ex * ex + ey * ey;
    }
    var t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    var qx = ax + t * dx - px;
    var qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }

  // ---------------------------------------------------------------------------
  // isolinha (marching squares)
  // ---------------------------------------------------------------------------

  /**
   * Extrai as isolinhas de nivel `level` (padrao 0) do campo.
   * Devolve uma lista de poligonos fechados, sem orientacao definida.
   */
  function contour(field, level) {
    level = level || 0;
    var nx = field.nx;
    var ny = field.ny;
    var stride = field.stride || (nx + 1);
    var values = field.values;
    var h = field.h;
    var x0 = field.x0;
    var y0 = field.y0;
    if (!nx || !ny) return [];

    var hPoints = new Map(); // arestas horizontais: (i,j)-(i+1,j)
    var vPoints = new Map(); // arestas verticais: (i,j)-(i,j+1)
    var segments = [];

    function insideAt(i, j) {
      return values[j * stride + i] < level;
    }

    function horizontal(i, j) {
      var key = j * (nx + 1) + i;
      var cached = hPoints.get(key);
      if (cached) return cached;
      var va = values[j * stride + i];
      var vb = values[j * stride + i + 1];
      var t = (level - va) / (vb - va);
      var point = { x: x0 + (i + t) * h, y: y0 + j * h };
      hPoints.set(key, point);
      return point;
    }

    function vertical(i, j) {
      var key = j * nx + i;
      var cached = vPoints.get(key);
      if (cached) return cached;
      var va = values[j * stride + i];
      var vb = values[(j + 1) * stride + i];
      var t = (level - va) / (vb - va);
      var point = { x: x0 + i * h, y: y0 + (j + t) * h };
      vPoints.set(key, point);
      return point;
    }

    var CORNER_EDGES = [[3, 0], [0, 1], [1, 2], [2, 3]];

    function pointOnEdge(edge, i, j) {
      if (edge === 0) return horizontal(i, j);
      if (edge === 1) return vertical(i + 1, j);
      if (edge === 2) return horizontal(i, j + 1);
      return vertical(i, j);
    }

    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var c00 = insideAt(i, j);
        var c10 = insideAt(i + 1, j);
        var c11 = insideAt(i + 1, j + 1);
        var c01 = insideAt(i, j + 1);

        var crossings = [];
        if (c00 !== c10) crossings.push(0);
        if (c10 !== c11) crossings.push(1);
        if (c01 !== c11) crossings.push(2);
        if (c00 !== c01) crossings.push(3);

        var pairs;
        if (crossings.length === 2) {
          pairs = [[crossings[0], crossings[1]]];
        } else if (crossings.length === 4) {
          // sela: decide pelo centro da celula e fecha em volta dos cantos
          var center = (values[j * stride + i] + values[j * stride + i + 1] +
            values[(j + 1) * stride + i] + values[(j + 1) * stride + i + 1]) / 4;
          var centerInside = center < level;
          var corners = [c00, c10, c11, c01];
          pairs = [];
          for (var corner = 0; corner < 4; corner++) {
            if (corners[corner] !== centerInside) {
              pairs.push(CORNER_EDGES[corner]);
            }
          }
        } else {
          pairs = [];
        }

        for (var k = 0; k < pairs.length; k++) {
          var a = pointOnEdge(pairs[k][0], i, j);
          var b = pointOnEdge(pairs[k][1], i, j);
          segments.push({ a: a, b: b });
        }
      }
    }

    return linkSegments(segments);
  }

  function linkSegments(segments) {
    if (!segments.length) return [];

    var adjacency = new Map();
    segments.forEach(function (segment, index) {
      [segment.a, segment.b].forEach(function (point) {
        var list = adjacency.get(point);
        if (!list) adjacency.set(point, list = []);
        list.push(index);
      });
    });

    var used = new Uint8Array(segments.length);
    var rings = [];

    for (var start = 0; start < segments.length; start++) {
      if (used[start]) continue;
      var ring = [];
      var segment = segments[start];
      var point = segment.a;
      used[start] = 1;
      ring.push(point);
      point = segment.b;

      var guard = segments.length * 2 + 4;
      while (guard-- > 0) {
        ring.push(point);
        var list = adjacency.get(point) || [];
        var next = -1;
        for (var i = 0; i < list.length; i++) {
          if (!used[list[i]]) { next = list[i]; break; }
        }
        if (next === -1) break;
        used[next] = 1;
        point = segments[next].a === point ? segments[next].b : segments[next].a;
        if (point === ring[0]) break;
      }

      if (ring.length > 3) {
        if (ring[0] === ring[ring.length - 1]) ring.pop();
        rings.push(ring);
      }
    }
    return rings;
  }

  // ---------------------------------------------------------------------------
  // simplificacao (Douglas-Peucker sobre anel fechado)
  // ---------------------------------------------------------------------------

  function simplify(ring, tolerance) {
    if (!ring || ring.length < 4) return ring || [];
    tolerance = tolerance || 0.01;

    // comeca no ponto mais distante do primeiro: evita cortar o anel no meio
    var farthest = 0;
    var bestDist = -1;
    for (var i = 1; i < ring.length; i++) {
      var dx = ring[i].x - ring[0].x;
      var dy = ring[i].y - ring[0].y;
      var d = dx * dx + dy * dy;
      if (d > bestDist) { bestDist = d; farthest = i; }
    }

    var first = ring.slice(0, farthest + 1);
    var second = ring.slice(farthest).concat([ring[0]]);
    var result = simplifyOpen(first, tolerance);
    var tail = simplifyOpen(second, tolerance);
    result.pop();
    tail.pop();
    return result.concat(tail);
  }

  function simplifyOpen(points, tolerance) {
    if (points.length < 3) return points.slice();
    var keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    var stack = [[0, points.length - 1]];
    var tol2 = tolerance * tolerance;

    while (stack.length) {
      var range = stack.pop();
      var a = range[0];
      var b = range[1];
      var best = -1;
      var index = -1;
      for (var i = a + 1; i < b; i++) {
        var d = lineDistance2(points[i], points[a], points[b]);
        if (d > best) { best = d; index = i; }
      }
      if (best > tol2 && index > 0) {
        keep[index] = 1;
        stack.push([a, index], [index, b]);
      }
    }

    var out = [];
    for (var k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  function lineDistance2(point, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) {
      var ex = point.x - a.x;
      var ey = point.y - a.y;
      return ex * ex + ey * ey;
    }
    var cross = (point.x - a.x) * dy - (point.y - a.y) * dx;
    return (cross * cross) / len2;
  }

  // ---------------------------------------------------------------------------
  // triangulacao (ear clipping com furos)
  // ---------------------------------------------------------------------------

  /**
   * Triangula um poligono com furos.
   * outer: anel externo (sentido horario ou anti-horario, e normalizado aqui)
   * holes: lista de aneis internos
   * Devolve { points, triangles } no sentido anti-horario (normal +Z).
   */
  function triangulate(outer, holes) {
    var ring = ensureWinding(outer, true);
    var pending = (holes || [])
      .filter(function (hole) { return hole && hole.length >= 3; })
      .map(function (hole) { return ensureWinding(hole, false); });

    // furos da direita para a esquerda: a fenda sai para o lado livre
    pending.sort(function (a, b) { return maxX(b) - maxX(a); });

    while (pending.length) {
      var hole = pending.shift();
      ring = spliceHole(ring, hole, pending);
    }

    return earClip(ring);
  }

  function maxX(ring) {
    var m = -Infinity;
    for (var i = 0; i < ring.length; i++) if (ring[i].x > m) m = ring[i].x;
    return m;
  }

  function ensureWinding(ring, counterClockwise) {
    var ccw = area(ring) > 0;
    if (ccw === counterClockwise) return ring.map(function (p) { return { x: p.x, y: p.y }; });
    return ring.slice().reverse().map(function (p) { return { x: p.x, y: p.y }; });
  }

  /** Liga um furo ao anel externo com uma "fenda" (keyhole). */
  function spliceHole(ring, hole, pending) {
    var holeIndex = 0;
    for (var i = 1; i < hole.length; i++) {
      if (hole[i].x > hole[holeIndex].x ||
        (hole[i].x === hole[holeIndex].x && hole[i].y > hole[holeIndex].y)) {
        holeIndex = i;
      }
    }
    var anchor = hole[holeIndex];

    // caminho rapido: primeiro alvo visivel pelo raio para +x
    var bestX = Infinity;
    var bestEdge = -1;
    for (var e = 0; e < ring.length; e++) {
      var a = ring[e];
      var b = ring[(e + 1) % ring.length];
      if ((a.y > anchor.y) === (b.y > anchor.y)) continue;
      var t = (anchor.y - a.y) / (b.y - a.y);
      var x = a.x + t * (b.x - a.x);
      if (x < anchor.x - 1e-9) continue;
      if (x < bestX) { bestX = x; bestEdge = e; }
    }

    var candidates = [];
    if (bestEdge !== -1) {
      var edgeA = ring[bestEdge];
      var edgeB = ring[(bestEdge + 1) % ring.length];
      candidates.push(edgeA.x >= edgeB.x ? bestEdge : (bestEdge + 1) % ring.length);
      candidates.push(edgeA.x >= edgeB.x ? (bestEdge + 1) % ring.length : bestEdge);
    }

    // plano B: vertices do anel por distancia
    var byDistance = ring.map(function (point, index) {
      var dx = point.x - anchor.x;
      var dy = point.y - anchor.y;
      return { index: index, d: dx * dx + dy * dy };
    }).sort(function (p, q) { return p.d - q.d; });

    for (var c = 0; c < byDistance.length && c < 32; c++) candidates.push(byDistance[c].index);

    var target = -1;
    // prefere vertices que ainda nao sao ponta de fenda (aparecem uma vez so)
    var passes = [true, false];
    for (var pass = 0; pass < passes.length && target < 0; pass++) {
      var uniqueOnly = passes[pass];
      for (var k = 0; k < candidates.length; k++) {
        var index = candidates[k];
        if (index < 0 || index >= ring.length) continue;
        if (uniqueOnly && countPoint(ring, ring[index]) > 1) continue;
        if (segmentClear(anchor, ring[index], ring, pending)) {
          target = index;
          break;
        }
      }
      if (target < 0) {
        for (var m = 0; m < byDistance.length; m++) {
          var candidate = byDistance[m].index;
          if (uniqueOnly && countPoint(ring, ring[candidate]) > 1) continue;
          if (segmentClear(anchor, ring[candidate], ring, pending)) {
            target = candidate;
            break;
          }
        }
      }
    }

    if (target < 0) {
      // nada visivel (poligono degenerado): aceita o primeiro candidato
      target = candidates.length ? candidates[0] : 0;
    }

    var out = [];
    for (var s = 0; s <= target; s++) out.push(ring[s]);
    out.push({ x: ring[target].x, y: ring[target].y });
    for (var h = 0; h < hole.length; h++) {
      out.push(hole[(holeIndex + h) % hole.length]);
    }
    out.push({ x: anchor.x, y: anchor.y });
    for (var n = target; n < ring.length; n++) out.push(ring[n]);
    return out;
  }

  /** A fenda nao pode cruzar nenhuma aresta nem passar por dentro de um furo. */
  function segmentClear(anchor, target, ring, pending) {
    if (!target) return false;
    for (var i = 0; i < ring.length; i++) {
      if (properIntersect(anchor, target, ring[i], ring[(i + 1) % ring.length])) return false;
    }
    for (var p = 0; p < (pending || []).length; p++) {
      var hole = pending[p];
      for (var j = 0; j < hole.length; j++) {
        if (properIntersect(anchor, target, hole[j], hole[(j + 1) % hole.length])) return false;
      }
    }

    var mx = (anchor.x + target.x) / 2;
    var my = (anchor.y + target.y) / 2;
    if (!pointInPolygon(mx, my, ring)) return false;
    for (var q = 0; q < (pending || []).length; q++) {
      if (pointInPolygon(mx, my, pending[q])) return false;
    }
    return true;
  }

  function properIntersect(a, b, c, d) {
    var o1 = orient(a, b, c);
    var o2 = orient(a, b, d);
    var o3 = orient(c, d, a);
    var o4 = orient(c, d, b);
    return ((o1 > 1e-9 && o2 < -1e-9) || (o1 < -1e-9 && o2 > 1e-9)) &&
      ((o3 > 1e-9 && o4 < -1e-9) || (o3 < -1e-9 && o4 > 1e-9));
  }

  /** Quantas vezes o ponto aparece no anel (pontas de fenda aparecem 2x). */
  function countPoint(ring, point) {
    var count = 0;
    for (var i = 0; i < ring.length; i++) {
      if (Math.abs(ring[i].x - point.x) < 1e-9 && Math.abs(ring[i].y - point.y) < 1e-9) count++;
    }
    return count;
  }

  function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointInTriangle(point, a, b, c) {
    var d1 = sign(point, a, b);
    var d2 = sign(point, b, c);
    var d3 = sign(point, c, a);
    var hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
    var hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
    return !(hasNeg && hasPos);
  }

  function sign(point, a, b) {
    return (point.x - b.x) * (a.y - b.y) - (a.x - b.x) * (point.y - b.y);
  }

  function earClip(points) {
    var n = points.length;
    var triangles = [];
    if (n < 3) return { points: points, triangles: triangles };

    var ring = points.slice();
    var guard = 0;
    var maxGuard = n * n + 100;
    var eps = 1e-9;

    function samePoint(a, b) {
      return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
    }

    function cross(a, b, c) {
      return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }

    function isReflex(index) {
      var a = ring[(index + ring.length - 1) % ring.length];
      var b = ring[index];
      var c = ring[(index + 1) % ring.length];
      return cross(a, b, c) <= 0;
    }

    while (ring.length > 3 && guard++ < maxGuard) {
      var clipped = false;
      for (var i = 0; i < ring.length; i++) {
        var prev = ring[(i + ring.length - 1) % ring.length];
        var current = ring[i];
        var next = ring[(i + 1) % ring.length];
        var turn = cross(prev, current, next);

        if (Math.abs(turn) < eps) {
          // vertice colinear: some com ele (nao gera triangulo degenerado)
          ring.splice(i, 1);
          clipped = true;
          break;
        }
        if (turn < 0) continue; // reflexo

        var blocked = false;
        for (var k = 0; k < ring.length; k++) {
          var q = ring[k];
          if (samePoint(q, prev) || samePoint(q, current) || samePoint(q, next)) continue;
          if (!isReflex(k)) continue;
          // so um vertice reflexo estritamente dentro quebra a orelha
          if (cross(prev, current, q) > eps && cross(current, next, q) > eps && cross(next, prev, q) > eps) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        triangles.push([prev, current, next]);
        ring.splice(i, 1);
        clipped = true;
        break;
      }

      if (!clipped) {
        // malha de seguranca: remove o vertice mais proximo de ser colinear
        var worst = 0;
        var worstCross = Infinity;
        for (var w = 0; w < ring.length; w++) {
          var p0 = ring[(w + ring.length - 1) % ring.length];
          var p1 = ring[w];
          var p2 = ring[(w + 1) % ring.length];
          var c = cross(p0, p1, p2);
          if (c < worstCross) { worstCross = c; worst = w; }
        }
        ring.splice(worst, 1);
      }
    }

    if (ring.length === 3) triangles.push([ring[0], ring[1], ring[2]]);
    return { points: points, triangles: triangles };
  }

  function triangleArea(a, b, c) {
    return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  }

  /** Area total coberta pela triangulacao (para validar a malha). */
  function triangulationArea(triangles) {
    var sum = 0;
    for (var i = 0; i < triangles.length; i++) {
      sum += triangleArea(triangles[i][0], triangles[i][1], triangles[i][2]);
    }
    return sum;
  }

  /** Distancia assinada a um poligono convexo (negativa dentro). */
  function sdfConvex(points, px, py) {
    var inside = true;
    var best = Infinity;
    for (var i = 0; i < points.length; i++) {
      var a = points[i];
      var b = points[(i + 1) % points.length];
      var d2 = segmentDistance2(px, py, a.x, a.y, b.x, b.y);
      if (d2 < best) best = d2;
      var cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if (cross < 0) inside = false;
    }
    var d = Math.sqrt(best);
    return inside ? -d : d;
  }

  /**
   * Agrupa aneis em poligonos com furos (por profundidade de contencao).
   * Devolve [{ outer, holes }] com externos em CCW e furos em CW.
   */
  function groupRings(rings) {
    var items = rings.map(function (ring) {
      return {
        ring: ring,
        abs: Math.abs(area(ring)),
        depth: 0,
        parent: -1
      };
    });

    for (var i = 0; i < items.length; i++) {
      var probe = items[i].ring[0];
      var bestParent = -1;
      var bestArea = Infinity;
      for (var j = 0; j < items.length; j++) {
        if (i === j) continue;
        if (!pointInPolygon(probe.x, probe.y, items[j].ring)) continue;
        items[i].depth++;
        if (items[j].abs < bestArea) {
          bestArea = items[j].abs;
          bestParent = j;
        }
      }
      items[i].parent = bestParent;
    }

    var polygons = [];
    var index = {};
    items.forEach(function (item, i) {
      if (item.depth % 2 !== 0) return;
      index[i] = polygons.length;
      polygons.push({ outer: ensureWinding(item.ring, true), holes: [] });
    });

    items.forEach(function (item, i) {
      if (item.depth % 2 === 0) return;
      if (item.parent !== -1 && index[item.parent] !== undefined) {
        polygons[index[item.parent]].holes.push(ensureWinding(item.ring, false));
      }
    });

    return polygons.filter(function (polygon) {
      return Math.abs(area(polygon.outer)) > 1e-4 || polygon.holes.length;
    });
  }

  return {
    build: build,
    contour: contour,
    simplify: simplify,
    groupRings: groupRings,
    triangulate: triangulate,
    triangulationArea: triangulationArea,
    area: area,
    pointInPolygon: pointInPolygon,
    sdfConvex: sdfConvex,
    segmentDistance2: segmentDistance2
  };
});
