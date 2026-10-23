/**
 * Pecas do chaveiro: base (rosa, com o furo conico) e topo (branco, com o nome
 * vazado), a partir do mesmo desenho do nomes.scad.
 *
 * A base e uma extrusao 2D com um tunel conico no meio da espessura, aberto nas
 * duas pontas do nome. O topo e a extrusao do contorno menos o texto.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./field.js'));
  else root.NomesParts = factory(root.NomesField);
})(typeof self !== 'undefined' ? self : this, function (Field) {
  'use strict';

  var TUNNEL_SEGMENTS = 64;

  var DEFAULTS = {
    fontSize: 12,
    border: 2,
    holeIn: 4.5,
    holeOut: 3.5,
    minWall: 1.6,
    topThickness: 1.5,
    holeStyle: 'tab',
    tabLeft: true,
    tabRight: true,
    columns: 4,
    spacingX: 60,
    spacingY: 40,
    distanceSeparate: 40,
    distanceBoth: 45,
    mode: 'juntos',
    quality: 0.15
  };

  function params(overrides) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (key) { out[key] = DEFAULTS[key]; });
    Object.keys(overrides || {}).forEach(function (key) {
      if (overrides[key] !== undefined && overrides[key] !== null) out[key] = overrides[key];
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // malha: lista achatada de triangulos (9 numeros por triangulo)
  // ---------------------------------------------------------------------------

  function tri(out, a, b, c) {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }

  function bounds(positions) {
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < positions.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        var v = positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    return {
      min: min,
      max: max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    };
  }

  // ---------------------------------------------------------------------------
  // perfil 2D
  // ---------------------------------------------------------------------------

  /**
   * Extrai os poligonos (externo + furos) de um campo de distancia.
   * `levels` e a lista de valores por no; o campo so empresta a grade.
   */
  function polygonsOf(field, values) {
    var proxy = {
      x0: field.x0,
      y0: field.y0,
      h: field.h,
      nx: field.nx,
      ny: field.ny,
      stride: field.stride,
      values: values
    };
    var rings = Field.contour(proxy, 0)
      .map(function (ring) { return Field.simplify(ring, Math.max(0.008, field.h / 12)); })
      .filter(function (ring) { return ring.length >= 3 && Math.abs(Field.area(ring)) > 0.004; });
    return Field.groupRings(rings);
  }

  /** Triangula um poligono validando a area (furos podem falhar em casos raros). */
  function triangulateChecked(polygon, extraHoles) {
    var holes = polygon.holes.concat(extraHoles || []);
    var expected = Math.abs(Field.area(polygon.outer)) -
      holes.reduce(function (sum, hole) { return sum + Math.abs(Field.area(hole)); }, 0);
    var result = Field.triangulate(polygon.outer, holes);
    var got = Field.triangulationArea(result.triangles);
    if (!isFinite(got) || Math.abs(expected - got) > Math.max(0.02, expected * 0.001)) {
      // segunda tentativa: ordem inversa dos furos (fendas podem se atrapalhar)
      result = Field.triangulate(polygon.outer, holes.slice().reverse());
      got = Field.triangulationArea(result.triangles);
      if (!isFinite(got) || Math.abs(expected - got) > Math.max(0.02, expected * 0.001)) {
        return { points: [], triangles: [], failed: true, expected: expected, got: got };
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // base: extrusao com tunel conico
  // ---------------------------------------------------------------------------

  function buildBase(polygons, size, params) {
    var H = size.height;
    var positions = [];
    var radiusIn = params.holeIn;
    var radiusOut = params.holeOut;
    var left = null;
    var right = null;
    var failures = 0;

    var minX = Infinity;
    var maxX = -Infinity;
    polygons.forEach(function (polygon) {
      var rings = [polygon.outer].concat(polygon.holes);
      rings.forEach(function (ring) {
        ring.forEach(function (point) {
          if (point.x < minX) minX = point.x;
          if (point.x > maxX) maxX = point.x;
        });
      });
    });
    var tolerance = Math.max(0.05, (size.tolerance || 0.1));
    var onPlane = 1e-6;

    // as pontas saem retas: varios vertices colineares viram so os dois cantos
    polygons.forEach(function (polygon) {
      polygon.outer = straightenRing(straightenRing(polygon.outer, minX, tolerance), maxX, tolerance);
    });

    polygons.forEach(function (polygon) {
      var mesh = triangulateChecked(polygon);
      if (mesh.failed) {
        failures++;
        return;
      }
      // tampa superior (z = H) e inferior (z = 0)
      mesh.triangles.forEach(function (a) {
        tri(positions,
          [a[0].x, a[0].y, H],
          [a[1].x, a[1].y, H],
          [a[2].x, a[2].y, H]);
        tri(positions,
          [a[2].x, a[2].y, 0],
          [a[1].x, a[1].y, 0],
          [a[0].x, a[0].y, 0]);
      });

      [polygon.outer].concat(polygon.holes).forEach(function (ring) {
        for (var i = 0; i < ring.length; i++) {
          var a = ring[i];
          var b = ring[(i + 1) % ring.length];
          if (isEndEdge(a, b, minX, onPlane)) {
            if (!left || Math.abs(a.y - b.y) > Math.abs(left.y0 - left.y1)) {
              left = { x: (a.x + b.x) / 2, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
            }
            continue;
          }
          if (isEndEdge(a, b, maxX, onPlane)) {
            if (!right || Math.abs(a.y - b.y) > Math.abs(right.y0 - right.y1)) {
              right = { x: (a.x + b.x) / 2, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
            }
            continue;
          }
          // parede lateral
          tri(positions, [a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, H]);
          tri(positions, [a.x, a.y, 0], [b.x, b.y, H], [a.x, a.y, H]);
        }
      });
    });

    if (!left || !right) {
      return { positions: positions, hasTunnel: false, failures: failures };
    }

    // raio do cone na posicao real das tampas laterais
    var span = size.length;
    var rOutLeft = radiusAt(left.x, -span / 2, span, radiusIn, radiusOut);
    var rOutRight = radiusAt(right.x, -span / 2, span, radiusIn, radiusOut);
    var centerZ = H / 2;

    var angles = tunnelAngles(left, right, centerZ, H);
    // anel do circulo em sentido horario (furo visto de +X)
    var circleLeft = circleRing(rOutLeft, centerZ, angles).reverse();
    var circleRight = circleRing(rOutRight, centerZ, angles).reverse();

    var endLeft = addEndFace(positions, left, H, circleLeft, -1);
    var endRight = addEndFace(positions, right, H, circleRight, 1);
    addTunnel(positions, left.x, right.x, circleLeft, circleRight);

    return {
      positions: positions,
      hasTunnel: !!endLeft && !!endRight,
      failures: failures,
      radiusIn: rOutLeft,
      radiusOut: rOutRight
    };
  }

  function circleRing(radius, centerZ, angles) {
    var ring = [];
    for (var i = 0; i < angles.length; i++) {
      ring.push({ x: Math.cos(angles[i]) * radius, y: centerZ + Math.sin(angles[i]) * radius });
    }
    return ring;
  }

  /**
   * Angulos do circulo do tunel: passo uniforme + os cantos do retangulo de
   * cada tampa. Assim as tampas e o cone compartilham exatamente os vertices.
   */
  function tunnelAngles(left, right, centerZ, height) {
    var angles = [];
    for (var i = 0; i < TUNNEL_SEGMENTS; i++) angles.push((i / TUNNEL_SEGMENTS) * Math.PI * 2);

    [left, right].forEach(function (end) {
      [[end.y0, 0], [end.y1, 0], [end.y1, height], [end.y0, height]].forEach(function (corner) {
        var angle = Math.atan2(corner[1] - centerZ, corner[0]);
        if (angle < 0) angle += Math.PI * 2;
        angles.push(angle);
      });
    });

    angles.sort(function (a, b) { return a - b; });
    var unique = [];
    angles.forEach(function (angle) {
      if (!unique.length || angle - unique[unique.length - 1] > 1e-9) unique.push(angle);
    });
    return unique;
  }

  /** Todos os pontos dos contornos (para o hull). */
  function collectPoints(contours) {
    var points = [];
    (contours || []).forEach(function (ring) {
      if (!ring) return;
      for (var i = 0; i < ring.length; i++) points.push({ x: ring[i].x, y: ring[i].y });
    });
    return points;
  }

  /** Fecho convexo (Andrew, monotone chain) no sentido anti-horario. */
  function convexHull(points) {
    if (!points || points.length < 3) return (points || []).slice();
    var sorted = points.slice().sort(function (a, b) {
      return a.x - b.x || a.y - b.y;
    });
    var cross = function (o, a, b) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    var lower = [];
    for (var i = 0; i < sorted.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0) lower.pop();
      lower.push(sorted[i]);
    }
    var upper = [];
    for (var j = sorted.length - 1; j >= 0; j--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], sorted[j]) <= 0) upper.pop();
      upper.push(sorted[j]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function radiusAt(x, start, span, r1, r2) {
    var t = (x - start) / span;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return r1 + (r2 - r1) * t;
  }

  function isEndEdge(a, b, plane, tolerance) {
    return Math.abs(a.x - plane) < tolerance && Math.abs(b.x - plane) < tolerance;
  }

  /** Endireita a ponta: vertices colineares viram os dois cantos exatos. */
  function straightenRing(ring, plane, tolerance) {
    var run = [];
    var i;
    for (i = 0; i < ring.length; i++) {
      if (Math.abs(ring[i].x - plane) < tolerance) run.push(i);
    }
    if (!run.length) return ring;

    var lowest = run[0];
    var highest = run[0];
    run.forEach(function (index) {
      if (ring[index].y < ring[lowest].y) lowest = index;
      if (ring[index].y > ring[highest].y) highest = index;
    });

    var drop = {};
    run.forEach(function (index) {
      if (index !== lowest && index !== highest) drop[index] = true;
    });

    return ring
      .filter(function (point, index) { return !drop[index]; })
      .map(function (point) {
        if (Math.abs(point.x - plane) < tolerance) return { x: plane, y: point.y };
        return point;
      });
  }

  /**
   * Tampa lateral da base: retangulo (y, z) menos o circulo do tunel.
   * direction -1 = ponta esquerda (normal -X), +1 = ponta direita (+X).
   * Devolve false quando a triangulacao nao fecha.
   */
  function addEndFace(positions, end, height, circle, direction) {
    var half = Math.max(Math.abs(end.y0), Math.abs(end.y1));
    // usa o vao real da ponta; o circulo fica sempre dentro
    var rect = [
      { x: end.y0, y: 0 },
      { x: end.y1, y: 0 },
      { x: end.y1, y: height },
      { x: end.y0, y: height }
    ];
    if (half <= 0) return false;

    var mesh = Field.triangulate(rect, [circle]);
    mesh.triangles.forEach(function (a) {
      var p0 = [end.x, a[0].x, a[0].y];
      var p1 = [end.x, a[1].x, a[1].y];
      var p2 = [end.x, a[2].x, a[2].y];
      if (direction < 0) tri(positions, p0, p2, p1);
      else tri(positions, p0, p1, p2);
    });
    return true;
  }

  /** Superficie do cone entre as duas tampas (aneis no mesmo angulo). */
  function addTunnel(positions, x0, x1, ringLeft, ringRight) {
    var count = ringLeft.length;
    for (var k = 0; k < count; k++) {
      var next = (k + 1) % count;
      var a = [x0, ringLeft[k].x, ringLeft[k].y];
      var b = [x0, ringLeft[next].x, ringLeft[next].y];
      var c = [x1, ringRight[next].x, ringRight[next].y];
      var d = [x1, ringRight[k].x, ringRight[k].y];
      tri(positions, a, b, c);
      tri(positions, a, c, d);
    }
  }

  // ---------------------------------------------------------------------------
  // topo: extrusao simples
  // ---------------------------------------------------------------------------

  function buildTop(polygons, thickness) {
    var positions = [];
    var failures = 0;
    polygons.forEach(function (polygon) {
      var mesh = triangulateChecked(polygon);
      if (mesh.failed) {
        failures++;
        return;
      }
      mesh.triangles.forEach(function (a) {
        tri(positions,
          [a[0].x, a[0].y, thickness],
          [a[1].x, a[1].y, thickness],
          [a[2].x, a[2].y, thickness]);
        tri(positions,
          [a[2].x, a[2].y, 0],
          [a[1].x, a[1].y, 0],
          [a[0].x, a[0].y, 0]);
      });
      [polygon.outer].concat(polygon.holes).forEach(function (ring) {
        for (var i = 0; i < ring.length; i++) {
          var a = ring[i];
          var b = ring[(i + 1) % ring.length];
          tri(positions, [a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, thickness]);
          tri(positions, [a.x, a.y, 0], [b.x, b.y, thickness], [a.x, a.y, thickness]);
        }
      });
    });
    return { positions: positions, failures: failures };
  }

  // ---------------------------------------------------------------------------
  // modo ponteira: o contorno sao as letras e cada ponta tem uma ponteira
  // redonda com furo (a esquerda no diametro de entrada, a direita no de saida)
  // ---------------------------------------------------------------------------

  var HOLE_SEGMENTS = 64;

  function circleRingAt(cx, cy, radius, segments) {
    var ring = [];
    for (var i = 0; i < segments; i++) {
      var angle = (i / segments) * Math.PI * 2;
      ring.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    }
    return ring;
  }

  /** Tampas do poligono com os furos dos circulos que caem dentro dele. */
  function addCapWithHoles(positions, polygon, z, holes, flip) {
    var mine = holes
      .filter(function (hole) { return Field.pointInPolygon(hole.x, hole.y, polygon.outer); })
      .map(function (hole) { return hole.ring; });
    var mesh = triangulateChecked(polygon, mine);
    if (mesh.failed) return false;
    mesh.triangles.forEach(function (a) {
      if (flip) tri(positions, [a[0].x, a[0].y, z], [a[2].x, a[2].y, z], [a[1].x, a[1].y, z]);
      else tri(positions, [a[0].x, a[0].y, z], [a[1].x, a[1].y, z], [a[2].x, a[2].y, z]);
    });
    return true;
  }

  function addVerticalWalls(positions, polygon, z0, z1) {
    [polygon.outer].concat(polygon.holes).forEach(function (ring) {
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i];
        var b = ring[(i + 1) % ring.length];
        tri(positions, [a.x, a.y, z0], [b.x, b.y, z0], [b.x, b.y, z1]);
        tri(positions, [a.x, a.y, z0], [b.x, b.y, z1], [a.x, a.y, z1]);
      }
    });
  }

  /** Parede do furo vertical: anel em z0 e em z1 (normal para dentro do furo). */
  function addVerticalHole(positions, cx, cy, z0, rBase, z1, rTop, segments) {
    var base = [];
    var top = [];
    for (var i = 0; i < segments; i++) {
      var angle = (i / segments) * Math.PI * 2;
      var cos = Math.cos(angle);
      var sin = Math.sin(angle);
      base.push([cx + cos * rBase, cy + sin * rBase, z0]);
      top.push([cx + cos * rTop, cy + sin * rTop, z1]);
    }
    for (var k = 0; k < segments; k++) {
      var next = (k + 1) % segments;
      tri(positions, top[k], base[next], base[k]);
      tri(positions, top[k], top[next], base[next]);
    }
  }

  function buildTabPiece(layout, p) {
    var h = Math.max(0.06, Number(p.quality) || DEFAULTS.quality);
    var border = Math.max(0, Number(p.border));
    var r1 = Math.max(0.4, Number(p.holeIn));
    var r2 = Math.max(0.4, Number(p.holeOut));
    var wall = Math.max(0, Number(p.minWall));
    var thickness = Math.max(0.2, Number(p.topThickness));
    var height = 2 * Math.max(r1, r2) + 2 * wall;
    var length = layout.width + 2 * border;
    if (layout.width <= 0) return null;

    var bandHalf = Math.max(0.8, Math.min(2.4, layout.height * 0.3));
    var gap = Math.max(0.5, wall * 0.5);
    var tabs = [];
    if (p.tabLeft !== false) {
      tabs.push({ x: -length / 2 - r1 - gap, side: 'left', radius: r1 + wall, hole: r1 });
    }
    if (p.tabRight !== false) {
      tabs.push({ x: length / 2 + r2 + gap, side: 'right', radius: r2 + wall, hole: r2 });
    }

    var bandFrom = -length / 2;
    var bandTo = length / 2;
    tabs.forEach(function (tab) {
      if (tab.side === 'left') bandFrom = tab.x;
      else bandTo = tab.x;
    });

    var extraPoints = [
      { x: -length / 2, y: -bandHalf },
      { x: length / 2, y: bandHalf }
    ];
    tabs.forEach(function (tab) {
      extraPoints.push({ x: tab.x - tab.radius, y: -tab.radius });
      extraPoints.push({ x: tab.x + tab.radius, y: tab.radius });
    });

    var field = Field.build(layout.contours, {
      h: h,
      maxDist: border + 2 * h,
      extraPoints: extraPoints
    });
    if (field.empty) return null;

    var band = [
      { x: bandFrom, y: -bandHalf },
      { x: bandTo, y: -bandHalf },
      { x: bandTo, y: bandHalf },
      { x: bandFrom, y: bandHalf }
    ];

    var values = new Float32Array(field.values.length);
    var topValues = new Float32Array(field.values.length);
    for (var j = 0; j <= field.ny; j++) {
      var y = field.y0 + j * h;
      for (var i = 0; i <= field.nx; i++) {
        var index = j * field.stride + i;
        var x = field.x0 + i * h;
        var d = field.values[index] - border;
        var bandValue = Field.sdfConvex(band, x, y);
        if (bandValue < d) d = bandValue;
        for (var t = 0; t < tabs.length; t++) {
          var dx = x - tabs[t].x;
          var tabValue = Math.sqrt(dx * dx + y * y) - tabs[t].radius;
          if (tabValue < d) d = tabValue;
        }
        values[index] = d;
        topValues[index] = Math.max(d, -field.values[index]);
      }
    }

    var basePolygons = polygonsOf(field, values);
    var topPolygons = polygonsOf(field, topValues);
    if (!basePolygons.length) return null;

    var holes = tabs.map(function (tab) {
      return { x: tab.x, y: 0, ring: circleRingAt(tab.x, 0, tab.hole, HOLE_SEGMENTS) };
    });

    var basePositions = [];
    var topPositions = [];
    var failures = 0;

    basePolygons.forEach(function (polygon) {
      if (!addCapWithHoles(basePositions, polygon, height, holes, false)) failures++;
      if (!addCapWithHoles(basePositions, polygon, 0, holes, true)) failures++;
      addVerticalWalls(basePositions, polygon, 0, height);
    });
    tabs.forEach(function (tab) {
      addVerticalHole(basePositions, tab.x, 0, 0, tab.hole, height, tab.hole, HOLE_SEGMENTS);
    });

    topPolygons.forEach(function (polygon) {
      if (!addCapWithHoles(topPositions, polygon, thickness, holes, false)) failures++;
      if (!addCapWithHoles(topPositions, polygon, 0, holes, true)) failures++;
      addVerticalWalls(topPositions, polygon, 0, thickness);
    });
    tabs.forEach(function (tab) {
      addVerticalHole(topPositions, tab.x, 0, 0, tab.hole, thickness, tab.hole, HOLE_SEGMENTS);
    });

    return {
      base: basePositions,
      top: topPositions,
      height: height,
      length: length,
      width: layout.width,
      hasTunnel: tabs.length > 0,
      failures: failures,
      triangles: basePositions.length / 9 + topPositions.length / 9
    };
  }

  // ---------------------------------------------------------------------------
  // uma peca completa (base + topo)
  // ---------------------------------------------------------------------------

  /**
   * layout: retorno de Font.layout() (contours, width, height)
   * Devolve { base, top, size } com os triangulos em coordenadas locais.
   */
  function buildPiece(layout, options) {
    var p = params(options);
    if (p.holeStyle === 'tab') return buildTabPiece(layout, p);
    return buildTunnelPiece(layout, p);
  }

  function buildTunnelPiece(layout, p) {
    var h = Math.max(0.06, Number(p.quality) || DEFAULTS.quality);
    var border = Math.max(0, Number(p.border));
    var r1 = Math.max(0.5, Number(p.holeIn));
    var r2 = Math.max(0.5, Number(p.holeOut));
    var wall = Math.max(0, Number(p.minWall));
    var maxRadius = Math.max(r1, r2);
    var height = 2 * maxRadius + 2 * wall;
    var length = layout.width + 2 * border;
    var halfLeft = r1 + wall;
    var halfRight = r2 + wall;

    var maxDist = border + 2 * h;
    var halfLeft = r1 + wall;
    var halfRight = r2 + wall;
    var bridge = [
      { x: -length / 2, y: -halfLeft },
      { x: length / 2, y: -halfRight },
      { x: length / 2, y: halfRight },
      { x: -length / 2, y: halfLeft }
    ];

    // O .scad une o texto com a ponte recortada pelo hull do texto, ou seja o
    // contorno final e o hull (a barra de pontas arredondadas). A ponte sozinha
    // daria um trapezio reto, sem acompanhar as letras.
    var hullPoints = convexHull(collectPoints(layout.contours));
    // A guarda do tunel garante parede em volta do furo e deixa a ponta reta,
    // senao o cone abriria pela lateral das letras.
    var guardWall = Math.max(0.7, Math.min(1.2, wall * 0.6));
    var halfSpan = length / 2;

    var textField = Field.build(layout.contours, {
      h: h,
      maxDist: maxDist,
      extraPoints: bridge
    });
    if (textField.empty || layout.width <= 0) return null;

    var count = textField.values.length;
    var baseValues = new Float32Array(count);
    var topValues = new Float32Array(count);
    var stride = textField.stride;

    for (var j = 0; j <= textField.ny; j++) {
      var y = textField.y0 + j * h;
      for (var i = 0; i <= textField.nx; i++) {
        var index = j * stride + i;
        var x = textField.x0 + i * h;
        var text = textField.values[index];
        var base = text - border;
        // hull do texto recortado pela ponte = contorno do .scad
        var hullValue = Field.sdfConvex(hullPoints, x, y) - border;
        var bridgeValue = Field.sdfConvex(bridge, x, y);
        if (hullValue > bridgeValue) bridgeValue = hullValue;
        if (bridgeValue < base) base = bridgeValue;
        // guarda do tunel: parede em volta do furo e ponta reta
        if (x >= -halfSpan && x <= halfSpan) {
          var guard = Math.abs(y) - (radiusAt(x, -halfSpan, length, r1, r2) + guardWall);
          if (guard < base) base = guard;
        }
        baseValues[index] = base;
        // topo = base menos o texto
        topValues[index] = Math.max(base, -text);
      }
    }

    var basePolygons = polygonsOf(textField, baseValues);
    var topPolygons = polygonsOf(textField, topValues);
    if (!basePolygons.length) return null;

    var size = {
      height: height,
      length: length,
      tolerance: Math.max(0.05, h * 0.75)
    };

    var base = buildBase(basePolygons, size, {
      holeIn: r1,
      holeOut: r2
    });
    var top = buildTop(topPolygons, Math.max(0.2, Number(p.topThickness)));

    return {
      base: base.positions,
      top: top.positions,
      height: height,
      length: length,
      width: layout.width,
      hasTunnel: base.hasTunnel,
      failures: (base.failures || 0) + (top.failures || 0),
      triangles: base.positions.length / 9 + top.positions.length / 9
    };
  }

  // ---------------------------------------------------------------------------
  // montagem da grade (igual ao nomes.scad)
  // ---------------------------------------------------------------------------

  function translate(positions, dx, dy, dz, out) {
    for (var i = 0; i < positions.length; i += 3) {
      out.push(positions[i] + dx, positions[i + 1] + dy, positions[i + 2] + dz);
    }
  }

  /**
   * Monta a cena completa. `pieces` vem de buildPiece(), um por nome.
   * Devolve { base, top } com todos os triangulos ja posicionados.
   */
  function buildLayout(pieces, options) {
    var p = params(options);
    var columns = Math.max(1, Math.round(p.columns));
    var spacingX = Number(p.spacingX);
    var spacingY = Number(p.spacingY);
    var distanceSeparate = Number(p.distanceSeparate);
    var distanceBoth = Number(p.distanceBoth);
    var mode = p.mode === 'separados' || p.mode === 'ambos' ? p.mode : 'juntos';
    var parts = p.parts === 'base' || p.parts === 'topo' ? p.parts : 'ambos';
    var withBase = parts !== 'topo';
    var withTop = parts !== 'base';
    var solo = parts !== 'ambos';
    // folga minima entre a base e o topo montados: sem ela as duas pecas
    // dividem a mesma face e o STL fica com arestas usadas por 4 triangulos
    var STACK_GAP = 0.01;

    var base = [];
    var top = [];

    pieces.forEach(function (piece, index) {
      if (!piece) return;
      var col = index % columns;
      var row = Math.floor(index / columns);
      var x = col * spacingX;
      var y = -row * spacingY;
      var height = piece.height;

      if (mode === 'juntos') {
        if (withBase) translate(piece.base, x, y, 0, base);
        if (withTop) translate(piece.top, x, y, parts === 'topo' ? 0 : height + STACK_GAP, top);
      } else if (mode === 'separados') {
        // com uma peca so nao ha o que separar: fica centralizada na celula
        var spread = solo ? 0 : distanceSeparate / 2;
        if (withBase) translate(piece.base, x, y + spread, 0, base);
        if (withTop) translate(piece.top, x, y - spread, 0, top);
      } else {
        if (withBase) translate(piece.base, x, y + distanceBoth, 0, base);
        if (withTop) translate(piece.top, x, y + distanceBoth, height + STACK_GAP, top);
        if (withBase) translate(piece.base, x, y - distanceBoth, 0, base);
        if (withTop) translate(piece.top, x, y - distanceBoth, 0, top);
      }
    });

    return { base: base, top: top };
  }

  // ---------------------------------------------------------------------------
  // STL
  // ---------------------------------------------------------------------------

  /** STL binario a partir de varios arrays de triangulos. */
  function stlBinary(positionArrays) {
    var total = 0;
    positionArrays.forEach(function (positions) { total += positions.length / 9; });
    var buffer = new ArrayBuffer(84 + total * 50);
    var view = new DataView(buffer);
    var header = '3D Mesh Downloader - nomes';
    for (var h = 0; h < 80; h++) {
      view.setUint8(h, h < header.length ? header.charCodeAt(h) : 32);
    }
    view.setUint32(80, total, true);

    var offset = 84;
    positionArrays.forEach(function (positions) {
      for (var i = 0; i < positions.length; i += 9) {
        var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
        var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
        var cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
        var ux = bx - ax, uy = by - ay, uz = bz - az;
        var vx = cx - ax, vy = cy - ay, vz = cz - az;
        var nx = uy * vz - uz * vy;
        var ny = uz * vx - ux * vz;
        var nz = ux * vy - uy * vx;
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        view.setFloat32(offset, nx / len, true);
        view.setFloat32(offset + 4, ny / len, true);
        view.setFloat32(offset + 8, nz / len, true);
        view.setFloat32(offset + 12, ax, true);
        view.setFloat32(offset + 16, ay, true);
        view.setFloat32(offset + 20, az, true);
        view.setFloat32(offset + 24, bx, true);
        view.setFloat32(offset + 28, by, true);
        view.setFloat32(offset + 32, bz, true);
        view.setFloat32(offset + 36, cx, true);
        view.setFloat32(offset + 40, cy, true);
        view.setFloat32(offset + 44, cz, true);
        view.setUint16(offset + 48, 0, true);
        offset += 50;
      }
    });

    return buffer;
  }

  // ---------------------------------------------------------------------------
  // .scad (mesmo desenho, para abrir no OpenSCAD)
  // ---------------------------------------------------------------------------

  function scadText(names, options, fontName, widths) {
    var p = params(options);
    var list = names.map(function (name) {
      return '"' + String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }).join(', ');
    var measured = (widths && widths.length === names.length)
      ? widths.map(num).join(', ')
      : null;
    var tabMode = p.holeStyle === 'tab';
    var band = Math.max(0.8, Math.min(2.4, 8 * 0.3));
    var gap = Math.max(0.5, Number(p.minWall) * 0.5);

    return [
      '// Gerado pelo 3D Mesh Downloader - aba Nomes',
      '// Abra no OpenSCAD e use F6 para renderizar / exportar STL.',
      '',
      '/* [Configuração de Lote e Nomes] */',
      'Nomes = [' + list + '];',
      '// largura real de cada nome (medida nos contornos da fonte)',
      'Larguras = [' + (measured || '[for (n = Nomes) len(n) * Font_Size * 0.75]') + '];',
      '',
      '/* [Modo de Exibição] */',
      'Modo_Exibicao = "' + (p.mode === 'separados' || p.mode === 'ambos' ? p.mode : 'juntos') + '"; // [juntos, separados, ambos]',
      '',
      'Espacamento_X = ' + num(p.spacingX) + ';',
      'Espacamento_Y = ' + num(p.spacingY) + ';',
      'Colunas       = ' + Math.max(1, Math.round(p.columns)) + ';',
      'Distancia_Y_Separado = ' + num(p.distanceSeparate) + ';',
      'Distancia_Y_Ambos    = ' + num(p.distanceBoth) + ';',
      '',
      '/* [Texto e Tipografia] */',
      'Font_Name = "' + String(fontName || 'Chewy').replace(/"/g, '') + '";',
      'Font_Size = ' + num(p.fontSize) + ';',
      '',
      '/* [Dimensões e Geometria] */',
      'Border_Size = ' + num(p.border) + ';',
      '',
      '/* [Furo e Ponteiras] */',
      'Modo_Furo = "' + (tabMode ? 'ponteira' : 'tunel') + '"; // [ponteira, tunel]',
      'Hole_Radius_Entrada = ' + num(p.holeIn) + ';',
      'Hole_Radius_Saida   = ' + num(p.holeOut) + ';',
      'Min_Wall_Thickness  = ' + num(p.minWall) + ';',
      'Afastamento_Ponteira = ' + num(gap) + ';',
      'Meia_Ponte = ' + num(band) + '; // metade da faixa fina que liga as letras',
      'Base_Thickness = (max(Hole_Radius_Entrada, Hole_Radius_Saida) * 2) + (2 * Min_Wall_Thickness);',
      'Top_Thickness  = ' + num(p.topThickness) + ';',
      '',
      'Color_Base_Rosa   = "#FFC0CB";',
      'Color_Topo_Branco = "#FFFFFF";',
      '',
      '// A largura vem medida nos contornos da fonte, nao da estimativa por',
      '// numero de caracteres: as pontas do furo caem sempre dentro do material.',
      'function comprimentoDe(largura) = largura + (Border_Size * 2);',
      'function xPonteiraEsquerda(comprimento) = -(comprimento / 2) - Hole_Radius_Entrada - Afastamento_Ponteira;',
      'function xPonteiraDireita(comprimento)  =  (comprimento / 2) + Hole_Radius_Saida  + Afastamento_Ponteira;',
      '',
      '$fn = 64;',
      '',
      'for (i = [0 : len(Nomes) - 1]) {',
      '    col = i % Colunas;',
      '    row = floor(i / Colunas);',
      '    translate([col * Espacamento_X, -row * Espacamento_Y, 0]) {',
      '        renderChaveiro(Nomes[i], Larguras[i]);',
      '    }',
      '}',
      '',
      'module renderChaveiro(nome_texto, largura) {',
      '    if (Modo_Exibicao == "juntos") {',
      '        renderMontado(nome_texto, largura, [0, 0, 0]);',
      '    } else if (Modo_Exibicao == "separados") {',
      '        renderSeparado(nome_texto, largura, [0, 0, 0]);',
      '    } else if (Modo_Exibicao == "ambos") {',
      '        renderMontado(nome_texto, largura, [0, Distancia_Y_Ambos, 0]);',
      '        renderSeparado(nome_texto, largura, [0, -Distancia_Y_Ambos, 0]);',
      '    }',
      '}',
      '',
      'module renderMontado(nome_texto, largura, pos) {',
      '    translate(pos) {',
      '        color(Color_Base_Rosa) generateBasePeca(nome_texto, largura);',
      '        translate([0, 0, Base_Thickness + 0.01])',
      '            color(Color_Topo_Branco) generateTopoPeca(nome_texto, largura);',
      '    }',
      '}',
      '',
      'module renderSeparado(nome_texto, largura, pos) {',
      '    translate(pos) {',
      '        translate([0, Distancia_Y_Separado / 2, 0])',
      '            color(Color_Base_Rosa) generateBasePeca(nome_texto, largura);',
      '        translate([0, -Distancia_Y_Separado / 2, 0])',
      '            color(Color_Topo_Branco) generateTopoPeca(nome_texto, largura);',
      '    }',
      '}',
      '',
      'module textProfile(nome_texto) {',
      '    text(nome_texto, size = Font_Size, font = Font_Name, halign = "center", valign = "center");',
      '}',
      '',
      'module 2dPonteETexto(nome_texto, largura) {',
      '    comprimento = comprimentoDe(largura);',
      '    half_left  = Hole_Radius_Entrada + Min_Wall_Thickness;',
      '    half_right = Hole_Radius_Saida + Min_Wall_Thickness;',
      '',
      '    union() {',
      '        offset(r = Border_Size) { textProfile(nome_texto); }',
      '        if (Modo_Furo == "tunel") {',
      '            // ponte recortada pelo hull do texto (como no nomes.scad)',
      '            intersection() {',
      '                polygon(points = [',
      '                    [-comprimento/2,  half_left],',
      '                    [ comprimento/2,  half_right],',
      '                    [ comprimento/2, -half_right],',
      '                    [-comprimento/2, -half_left]',
      '                ]);',
      '                hull() { offset(r = Border_Size) { textProfile(nome_texto); } }',
      '            }',
      '        } else {',
      '            // faixa fina ligando as letras + ponteira redonda em cada ponta',
      '            square([comprimento, 2 * Meia_Ponte], center = true);',
      '            translate([xPonteiraEsquerda(comprimento), 0])',
      '                circle(r = Hole_Radius_Entrada + Min_Wall_Thickness);',
      '            translate([xPonteiraDireita(comprimento), 0])',
      '                circle(r = Hole_Radius_Saida + Min_Wall_Thickness);',
      '        }',
      '    }',
      '}',
      '',
      'module furoPonteiras(largura, altura) {',
      '    comprimento = comprimentoDe(largura);',
      '    translate([xPonteiraEsquerda(comprimento), 0, -1])',
      '        cylinder(h = altura + 2, r = Hole_Radius_Entrada);',
      '    translate([xPonteiraDireita(comprimento), 0, -1])',
      '        cylinder(h = altura + 2, r = Hole_Radius_Saida);',
      '}',
      '',
      'module generateBasePeca(nome_texto, largura) {',
      '    comprimento = comprimentoDe(largura);',
      '    difference() {',
      '        linear_extrude(height = Base_Thickness) { 2dPonteETexto(nome_texto, largura); }',
      '        if (Modo_Furo == "tunel") {',
      '            translate([-comprimento/2, 0, Base_Thickness / 2])',
      '                rotate([0, 90, 0])',
      '                    cylinder(h = comprimento, r1 = Hole_Radius_Entrada, r2 = Hole_Radius_Saida);',
      '        } else {',
      '            furoPonteiras(largura, Base_Thickness);',
      '        }',
      '    }',
      '}',
      '',
      'module generateTopoPeca(nome_texto, largura) {',
      '    difference() {',
      '        linear_extrude(height = Top_Thickness) { 2dPonteETexto(nome_texto, largura); }',
      '        translate([0, 0, -1])',
      '            linear_extrude(height = Top_Thickness + 2) { textProfile(nome_texto); }',
      '        if (Modo_Furo == "ponteira") {',
      '            furoPonteiras(largura, Top_Thickness);',
      '        }',
      '    }',
      '}',
      ''
    ].join('\n');
  }

  function num(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return String(Math.round(n * 1000) / 1000);
  }

  return {
    DEFAULTS: DEFAULTS,
    params: params,
    buildPiece: buildPiece,
    buildLayout: buildLayout,
    stlBinary: stlBinary,
    scadText: scadText,
    bounds: bounds
  };
});
