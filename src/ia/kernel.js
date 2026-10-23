/**
 * Núcleo de geometria do Estúdio IA.
 *
 * Tudo em milímetros, Z para cima. As formas são malhas fechadas (sopa de
 * triângulos) e as operações booleanas usam BSP (union / subtract / intersect),
 * o suficiente para peças de impressão 3D.
 *
 * Roda no worker (sem DOM). `Field` e `Font` são injetados para permitir
 * extrusão de polígonos com furos e texto.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IaKernel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var EPS = 1e-5;
  var MAX_POLYGONS = 260000;

  var deps = { Field: null, Font: null, font: null };

  function configure(options) {
    options = options || {};
    if (options.Field) deps.Field = options.Field;
    if (options.Font) deps.Font = options.Font;
    if (options.font) deps.font = options.font;
  }

  // -------------------------------------------------------------------------
  // vetores
  // -------------------------------------------------------------------------

  function v(x, y, z) { return [x, y, z]; }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function length(a) { return Math.sqrt(dot(a, a)); }

  function normalize(a) {
    var len = length(a) || 1;
    return [a[0] / len, a[1] / len, a[2] / len];
  }

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function triple(a, fallback) {
    if (Array.isArray(a)) return [num(a[0], fallback), num(a[1], fallback), num(a[2], fallback)];
    if (a && typeof a === 'object') {
      return [num(a.x, fallback), num(a.y, fallback), num(a.z, fallback)];
    }
    var n = num(a, fallback);
    return [n, n, n];
  }

  // -------------------------------------------------------------------------
  // CSG (BSP)
  // -------------------------------------------------------------------------

  function Plane(normal, w) {
    this.normal = normal;
    this.w = w;
  }

  Plane.fromPoints = function (a, b, c) {
    var n = normalize(cross(sub(b, a), sub(c, a)));
    return new Plane(n, dot(n, a));
  };

  Plane.prototype.flip = function () {
    this.normal = [-this.normal[0], -this.normal[1], -this.normal[2]];
    this.w = -this.w;
  };

  Plane.prototype.splitPolygon = function (polygon, coFront, coBack, front, back) {
    var COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
    var polygonType = 0;
    var types = [];

    for (var i = 0; i < polygon.vertices.length; i++) {
      var t = dot(this.normal, polygon.vertices[i]) - this.w;
      var type = (t < -EPS) ? BACK : (t > EPS) ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }

    if (polygonType === COPLANAR) {
      if (dot(this.normal, polygon.plane.normal) > 0) coFront.push(polygon);
      else coBack.push(polygon);
      return;
    }

    if (polygonType === FRONT) { front.push(polygon); return; }
    if (polygonType === BACK) { back.push(polygon); return; }

    var f = [];
    var b = [];
    var count = polygon.vertices.length;

    for (var k = 0; k < count; k++) {
      var j = (k + 1) % count;
      var ti = types[k];
      var tj = types[j];
      var vi = polygon.vertices[k];
      var vj = polygon.vertices[j];

      if (ti !== BACK) f.push(vi);
      if (ti !== FRONT) b.push(vi);

      if ((ti | tj) === SPANNING) {
        var denom = dot(this.normal, sub(vj, vi));
        var t2 = denom === 0 ? 0 : (this.w - dot(this.normal, vi)) / denom;
        var split = [
          vi[0] + t2 * (vj[0] - vi[0]),
          vi[1] + t2 * (vj[1] - vi[1]),
          vi[2] + t2 * (vj[2] - vi[2])
        ];
        f.push(split);
        b.push(split);
      }
    }

    if (f.length >= 3) front.push({ vertices: f, plane: polygon.plane });
    if (b.length >= 3) back.push({ vertices: b, plane: polygon.plane });
  };

  function Node(polygons) {
    this.plane = null;
    this.front = null;
    this.back = null;
    this.polygons = [];
    if (polygons && polygons.length) this.build(polygons);
  }

  Node.prototype.build = function (polygons) {
    if (!polygons.length) return;

    if (!this.plane) {
      this.plane = Plane.fromPoints(
        polygons[0].vertices[0],
        polygons[0].vertices[1],
        polygons[0].vertices[2]
      );
    }

    var front = [];
    var back = [];

    for (var i = 0; i < polygons.length; i++) {
      this.plane.splitPolygon(polygons[i], this.polygons, this.polygons, front, back);
    }

    if (front.length) {
      if (!this.front) this.front = new Node();
      this.front.build(front);
    }
    if (back.length) {
      if (!this.back) this.back = new Node();
      this.back.build(back);
    }
  };

  Node.prototype.allPolygons = function () {
    var out = this.polygons.slice();
    if (this.front) out = out.concat(this.front.allPolygons());
    if (this.back) out = out.concat(this.back.allPolygons());
    return out;
  };

  Node.prototype.invert = function () {
    for (var i = 0; i < this.polygons.length; i++) {
      this.polygons[i].vertices.reverse();
      this.polygons[i].plane.flip();
    }
    if (this.plane) this.plane.flip();
    if (this.front) this.front.invert();
    if (this.back) this.back.invert();
    var temp = this.front;
    this.front = this.back;
    this.back = temp;
  };

  Node.prototype.clipPolygons = function (polygons) {
    if (!this.plane) return polygons.slice();
    var front = [];
    var back = [];
    for (var i = 0; i < polygons.length; i++) {
      this.plane.splitPolygon(polygons[i], front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  };

  Node.prototype.clipTo = function (other) {
    this.polygons = other.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(other);
    if (this.back) this.back.clipTo(other);
  };

  function soupToPolygons(positions) {
    var polygons = [];
    for (var i = 0; i < positions.length; i += 9) {
      var a = [positions[i], positions[i + 1], positions[i + 2]];
      var b = [positions[i + 3], positions[i + 4], positions[i + 5]];
      var c = [positions[i + 6], positions[i + 7], positions[i + 8]];
      var n = cross(sub(b, a), sub(c, a));
      if (length(n) < 1e-10) continue;
      var plane = Plane.fromPoints(a, b, c);
      polygons.push({ vertices: [a, b, c], plane: plane });
    }
    return polygons;
  }

  function polygonsToSoup(polygons) {
    var out = [];
    for (var i = 0; i < polygons.length; i++) {
      var verts = polygons[i].vertices;
      for (var k = 2; k < verts.length; k++) {
        var a = verts[0], b = verts[k - 1], c = verts[k];
        if (length(cross(sub(b, a), sub(c, a))) < 1e-10) continue;
        out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      }
    }
    return out;
  }

  function booleanOp(a, b, op) {
    // Caixas envolventes separadas: não há o que cortar (e o BSP evitaria
    // milhares de divisões desnecessárias).
    var ba = bounds(a);
    var bb = bounds(b);
    var apart = ba.max[0] < bb.min[0] - EPS || bb.max[0] < ba.min[0] - EPS ||
      ba.max[1] < bb.min[1] - EPS || bb.max[1] < ba.min[1] - EPS ||
      ba.max[2] < bb.min[2] - EPS || bb.max[2] < ba.min[2] - EPS;
    if (apart) {
      if (op === 'union') return a.concat(b);
      if (op === 'subtract') return a.slice();
      return [];
    }

    var A = new Node(soupToPolygons(a));
    var B = new Node(soupToPolygons(b));
    var total = A.allPolygons().length + B.allPolygons().length;
    if (total > MAX_POLYGONS) {
      throw new Error('geometria complexa demais para a operação booleana (' +
        total + ' polígonos). Reduza os segmentos.');
    }

    if (op === 'union') {
      A.clipTo(B);
      B.clipTo(A);
      B.invert();
      B.clipTo(A);
      B.invert();
      A.build(B.allPolygons());
    } else if (op === 'subtract') {
      A.invert();
      A.clipTo(B);
      B.clipTo(A);
      B.invert();
      B.clipTo(A);
      B.invert();
      A.build(B.allPolygons());
      A.invert();
    } else {
      A.invert();
      B.clipTo(A);
      B.invert();
      A.clipTo(B);
      B.clipTo(A);
      A.build(B.allPolygons());
      A.invert();
    }

    return polygonsToSoup(A.allPolygons());
  }

  // -------------------------------------------------------------------------
  // Solid
  // -------------------------------------------------------------------------

  function Solid(positions) {
    if (!(this instanceof Solid)) return new Solid(positions);
    this.positions = positions || [];
  }

  Solid.prototype.clone = function () {
    return new Solid(this.positions.slice());
  };

  Solid.prototype.bounds = function () { return bounds(this.positions); };

  Solid.prototype.translate = function (x, y, z) {
    var t = (y === undefined && z === undefined) ? triple(x, 0) : triple([x, y, z], 0);
    var p = this.positions;
    var out = new Array(p.length);
    for (var i = 0; i < p.length; i += 3) {
      out[i] = p[i] + t[0];
      out[i + 1] = p[i + 1] + t[1];
      out[i + 2] = p[i + 2] + t[2];
    }
    return new Solid(out);
  };

  Solid.prototype.rotate = function (rx, ry, rz) {
    var r = (ry === undefined && rz === undefined) ? triple(rx, 0) : triple([rx, ry, rz], 0);
    var ax = r[0] * Math.PI / 180;
    var ay = r[1] * Math.PI / 180;
    var az = r[2] * Math.PI / 180;
    var cx = Math.cos(ax), sx = Math.sin(ax);
    var cy = Math.cos(ay), sy = Math.sin(ay);
    var cz = Math.cos(az), sz = Math.sin(az);
    var p = this.positions;
    var out = new Array(p.length);

    for (var i = 0; i < p.length; i += 3) {
      var x = p[i], y = p[i + 1], z = p[i + 2];
      // X
      var y1 = y * cx - z * sx;
      var z1 = y * sx + z * cx;
      // Y
      var x2 = x * cy + z1 * sy;
      var z2 = -x * sy + z1 * cy;
      // Z
      var x3 = x2 * cz - y1 * sz;
      var y3 = x2 * sz + y1 * cz;
      out[i] = x3;
      out[i + 1] = y3;
      out[i + 2] = z2;
    }
    return new Solid(out);
  };

  Solid.prototype.scale = function (sx, sy, sz) {
    var s = (sy === undefined && sz === undefined) ? triple(sx, 1) : triple([sx, sy, sz], 1);
    var p = this.positions;
    var out = new Array(p.length);
    for (var i = 0; i < p.length; i += 3) {
      out[i] = p[i] * s[0];
      out[i + 1] = p[i + 1] * s[1];
      out[i + 2] = p[i + 2] * s[2];
    }
    return new Solid(out);
  };

  Solid.prototype.mirror = function (axis) {
    var a = String(axis || 'x').toLowerCase();
    var mirrored = this.scale(a === 'x' ? -1 : 1, a === 'y' ? -1 : 1, a === 'z' ? -1 : 1);
    // escala negativa inverte o sentido dos triângulos: volta a normal para fora
    return mirrored.flip();
  };

  Solid.prototype.flip = function () {
    var p = this.positions;
    var out = new Array(p.length);
    for (var i = 0; i < p.length; i += 9) {
      out[i] = p[i]; out[i + 1] = p[i + 1]; out[i + 2] = p[i + 2];
      out[i + 3] = p[i + 6]; out[i + 4] = p[i + 7]; out[i + 5] = p[i + 8];
      out[i + 6] = p[i + 3]; out[i + 7] = p[i + 4]; out[i + 8] = p[i + 5];
    }
    return new Solid(out);
  };

  Solid.prototype.union = function () {
    return booleanAll(this, arguments, 'union');
  };

  Solid.prototype.subtract = function () {
    return booleanAll(this, arguments, 'subtract');
  };

  Solid.prototype.intersect = function () {
    return booleanAll(this, arguments, 'intersect');
  };

  Solid.prototype.merge = function () {
    return merge.apply(null, [this].concat(Array.prototype.slice.call(arguments)));
  };

  function asSolid(value) {
    if (value instanceof Solid) return value;
    if (value && ArrayBuffer.isView(value)) return new Solid(Array.prototype.slice.call(value));
    if (Array.isArray(value)) {
      if (!value.length) return new Solid();
      if (typeof value[0] === 'number') return new Solid(value.slice());
      // lista de sólidos: junta as malhas sem CSG (mais rápido)
      var out = [];
      value.forEach(function (item) {
        var solid = asSolid(item);
        for (var i = 0; i < solid.positions.length; i++) out.push(solid.positions[i]);
      });
      return new Solid(out);
    }
    if (value && value.solid) return asSolid(value.solid);
    if (value && value.parts) return asSolid(value.parts.map(function (p) { return p.solid || p; }));
    if (value && value.positions) return new Solid(value.positions);
    throw new Error('valor de geometria inválido: ' + typeof value);
  }

  function booleanAll(base, args, op) {
    var result = base;
    for (var i = 0; i < args.length; i++) {
      var other = asSolid(args[i]);
      if (!other.positions.length) continue;
      if (!result.positions.length) {
        result = (op === 'union') ? other : result;
        continue;
      }
      result = new Solid(booleanOp(result.positions, other.positions, op));
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // primitivas
  // -------------------------------------------------------------------------

  /** Triângulos de faces convexas: garante normal para fora usando o centro. */
  function convexFaces(positions, center) {
    for (var i = 0; i < positions.length; i += 9) {
      var a = [positions[i], positions[i + 1], positions[i + 2]];
      var b = [positions[i + 3], positions[i + 4], positions[i + 5]];
      var c = [positions[i + 6], positions[i + 7], positions[i + 8]];
      var n = cross(sub(b, a), sub(c, a));
      if (length(n) < 1e-10) continue;
      var fc = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      if (dot(n, sub(fc, center)) < 0) {
        positions[i + 3] = c[0]; positions[i + 4] = c[1]; positions[i + 5] = c[2];
        positions[i + 6] = b[0]; positions[i + 7] = b[1]; positions[i + 8] = b[2];
      }
    }
    return positions;
  }

  function pushTri(out, a, b, c) {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }

  function box(w, d, h) {
    if (w && typeof w === 'object') { d = w.d !== undefined ? w.d : w.y; h = w.h !== undefined ? w.h : w.z; w = w.w !== undefined ? w.w : w.x; }
    w = Math.abs(num(w, 10)); d = Math.abs(num(d, 10)); h = Math.abs(num(h, 10));
    var x = w / 2, y = d / 2, z = h / 2;
    var p = [
      [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
      [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]
    ];
    var out = [];
    var faces = [
      [0, 3, 2, 1], // -Z
      [4, 5, 6, 7], // +Z
      [0, 1, 5, 4], // -Y
      [2, 3, 7, 6], // +Y
      [1, 2, 6, 5], // +X
      [3, 0, 4, 7]  // -X
    ];
    faces.forEach(function (f) {
      pushTri(out, p[f[0]], p[f[1]], p[f[2]]);
      pushTri(out, p[f[0]], p[f[2]], p[f[3]]);
    });
    return new Solid(convexFaces(out, [0, 0, 0]));
  }

  function ring(cx, cy, radius, segments) {
    var out = [];
    for (var i = 0; i < segments; i++) {
      var a = (i / segments) * Math.PI * 2;
      out.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, 0]);
    }
    return out;
  }

  function cylinder(r, h, options) {
    if (r && typeof r === 'object') { h = r.h; if (options === undefined) options = { segments: r.segments }; r = r.r !== undefined ? r.r : r.radius; }
    r = Math.abs(num(r, 5)); h = Math.abs(num(h, 10));
    var segments = Math.max(8, Math.round(num(options && options.segments, 48)));
    var out = [];
    var bottom = [];
    var top = [];
    for (var i = 0; i < segments; i++) {
      var a = (i / segments) * Math.PI * 2;
      var x = Math.cos(a) * r, y = Math.sin(a) * r;
      bottom.push([x, y, -h / 2]);
      top.push([x, y, h / 2]);
    }
    for (var k = 0; k < segments; k++) {
      var n = (k + 1) % segments;
      pushTri(out, bottom[k], bottom[n], top[n]);
      pushTri(out, bottom[k], top[n], top[k]);
      pushTri(out, [0, 0, -h / 2], bottom[n], bottom[k]);
      pushTri(out, [0, 0, h / 2], top[k], top[n]);
    }
    return new Solid(convexFaces(out, [0, 0, 0]));
  }

  function cone(r1, r2, h, options) {
    if (r1 && typeof r1 === 'object') {
      var o = r1;
      h = o.h;
      options = o;
      r1 = o.r1 !== undefined ? o.r1 : o.rBottom;
      r2 = o.r2 !== undefined ? o.r2 : o.rTop;
    }
    r1 = Math.abs(num(r1, 5)); r2 = r2 === undefined ? 0 : Math.abs(num(r2, 0)); h = Math.abs(num(h, 10));
    var segments = Math.max(8, Math.round(num(options && options.segments, 48)));
    var out = [];
    var bottom = [];
    var top = [];
    for (var i = 0; i < segments; i++) {
      var a = (i / segments) * Math.PI * 2;
      var x = Math.cos(a), y = Math.sin(a);
      bottom.push([x * r1, y * r1, -h / 2]);
      top.push([x * r2, y * r2, h / 2]);
    }
    for (var k = 0; k < segments; k++) {
      var n = (k + 1) % segments;
      pushTri(out, bottom[k], bottom[n], top[n]);
      pushTri(out, bottom[k], top[n], top[k]);
      if (r1 > 0) pushTri(out, [0, 0, -h / 2], bottom[n], bottom[k]);
      if (r2 > 0) pushTri(out, [0, 0, h / 2], top[k], top[n]);
    }
    return new Solid(convexFaces(out, [0, 0, 0]));
  }

  function sphere(r, options) {
    if (r && typeof r === 'object') { options = r; r = r.r !== undefined ? r.r : r.radius; }
    r = Math.abs(num(r, 5));
    var seg = Math.max(8, Math.round(num(options && options.segments, 40)));
    var rings = Math.max(4, Math.round(num(options && options.rings, Math.max(6, seg / 2))));
    var out = [];
    var grid = [];
    for (var j = 0; j <= rings; j++) {
      var phi = Math.PI * j / rings;
      var row = [];
      for (var i = 0; i <= seg; i++) {
        var theta = Math.PI * 2 * i / seg;
        row.push([
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.sin(phi) * Math.sin(theta),
          r * Math.cos(phi)
        ]);
      }
      grid.push(row);
    }
    for (var y = 0; y < rings; y++) {
      for (var x = 0; x < seg; x++) {
        var a = grid[y][x], b = grid[y][x + 1], c = grid[y + 1][x + 1], d = grid[y + 1][x];
        if (y !== 0) pushTri(out, a, b, d);
        if (y !== rings - 1) pushTri(out, b, c, d);
      }
    }
    return new Solid(convexFaces(out, [0, 0, 0]));
  }

  function torus(R, r, options) {
    if (R && typeof R === 'object') { options = R; r = R.r !== undefined ? R.r : R.tube; R = R.R !== undefined ? R.R : R.radius; }
    R = Math.abs(num(R, 10)); r = Math.abs(num(r, 3));
    var segU = Math.max(8, Math.round(num(options && options.segments, 48)));
    var segV = Math.max(6, Math.round(num(options && options.rings, 24)));
    var out = [];
    for (var i = 0; i < segU; i++) {
      var u = Math.PI * 2 * i / segU;
      var u2 = Math.PI * 2 * (i + 1) / segU;
      for (var j = 0; j < segV; j++) {
        var v1 = Math.PI * 2 * j / segV;
        var v2 = Math.PI * 2 * (j + 1) / segV;
        var p1 = torusPoint(R, r, u, v1);
        var p2 = torusPoint(R, r, u2, v1);
        var p3 = torusPoint(R, r, u2, v2);
        var p4 = torusPoint(R, r, u, v2);
        pushTri(out, p1, p2, p3);
        pushTri(out, p1, p3, p4);
      }
    }
    return new Solid(out);
  }

  function torusPoint(R, r, u, v) {
    var cu = Math.cos(u), su = Math.sin(u);
    var cv = Math.cos(v), sv = Math.sin(v);
    return [(R + r * cv) * cu, (R + r * cv) * su, r * sv];
  }

  // -------------------------------------------------------------------------
  // extrusão de polígonos
  // -------------------------------------------------------------------------

  function toPoint2D(p) {
    if (Array.isArray(p)) return { x: num(p[0], 0), y: num(p[1], 0) };
    if (p && typeof p === 'object') return { x: num(p.x, 0), y: num(p.y, 0) };
    return { x: 0, y: 0 };
  }

  function normalizeRing(points) {
    var ring = [];
    for (var i = 0; i < (points || []).length; i++) {
      var p = toPoint2D(points[i]);
      var last = ring[ring.length - 1];
      if (last && Math.abs(last.x - p.x) < 1e-7 && Math.abs(last.y - p.y) < 1e-7) continue;
      ring.push(p);
    }
    if (ring.length > 1) {
      var a = ring[0], b = ring[ring.length - 1];
      if (Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7) ring.pop();
    }
    return ring;
  }

  /** Extrusão de um anel (sem furos) com tampas e paredes. */
  function extrudeRings(outer, holes, height, options) {
    if (!deps.Field) throw new Error('kernel sem Field: extrusão indisponível');
    options = options || {};
    var h = Math.abs(num(height, 5));
    var center = options.center !== false;
    var z0 = center ? -h / 2 : 0;
    var z1 = z0 + h;
    var outerRing = normalizeRing(outer);
    var holeRings = (holes || []).map(normalizeRing).filter(function (r) { return r.length >= 3; });
    if (outerRing.length < 3) throw new Error('polígono precisa de pelo menos 3 pontos');

    var mesh = deps.Field.triangulate(outerRing, holeRings);
    var tris = mesh.triangles;
    if (!tris || !tris.length) throw new Error('não foi possível triangular o polígono');

    var out = [];
    tris.forEach(function (t) {
      pushTri(out, [t[0].x, t[0].y, z1], [t[1].x, t[1].y, z1], [t[2].x, t[2].y, z1]);
      pushTri(out, [t[0].x, t[0].y, z0], [t[2].x, t[2].y, z0], [t[1].x, t[1].y, z0]);
    });

    var rings = [outerRing].concat(holeRings);
    rings.forEach(function (ring) {
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i];
        var b = ring[(i + 1) % ring.length];
        pushTri(out, [a.x, a.y, z0], [b.x, b.y, z0], [b.x, b.y, z1]);
        pushTri(out, [a.x, a.y, z0], [b.x, b.y, z1], [a.x, a.y, z1]);
      }
    });

    return new Solid(out);
  }

  /** Prisma: polígono (com furos opcionais) extrudado em Z. */
  function prism(points, height, options) {
    options = options || {};
    var outer = points && points.outer ? points.outer : points;
    var holes = points && points.holes ? points.holes : (options.holes || []);
    return extrudeRings(outer, holes, height, options);
  }

  function roundedRectRing(w, d, radius) {
    w = Math.max(0, num(w, 10));
    d = Math.max(0, num(d, 10));
    var r = Math.max(0, Math.min(num(radius, 0), w / 2, d / 2));
    var x = w / 2, y = d / 2;
    var out = [];
    var steps = 8;
    if (r <= 1e-6) {
      out.push({ x: -x, y: -y }, { x: x, y: -y }, { x: x, y: y }, { x: -x, y: y });
      return out;
    }
    var corners = [
      { cx: x - r, cy: y - r, a0: 0, a1: Math.PI / 2 },
      { cx: -x + r, cy: y - r, a0: Math.PI / 2, a1: Math.PI },
      { cx: -x + r, cy: -y + r, a0: Math.PI, a1: Math.PI * 1.5 },
      { cx: x - r, cy: -y + r, a0: Math.PI * 1.5, a1: Math.PI * 2 }
    ];
    corners.forEach(function (c) {
      for (var i = 0; i <= steps; i++) {
        var a = c.a0 + (c.a1 - c.a0) * i / steps;
        out.push({ x: c.cx + Math.cos(a) * r, y: c.cy + Math.sin(a) * r });
      }
    });
    return out;
  }

  /** Caixa com todas as arestas e cantos arredondados. */
  function roundedBox(w, d, h, radius, options) {
    if (w && typeof w === 'object') {
      var o = w;
      options = o;
      radius = o.r !== undefined ? o.r : o.radius;
      d = o.d !== undefined ? o.d : o.y;
      h = o.h !== undefined ? o.h : o.z;
      w = o.w !== undefined ? o.w : o.x;
    }
    w = Math.abs(num(w, 20)); d = Math.abs(num(d, 20)); h = Math.abs(num(h, 10));
    var r = Math.max(0, Math.min(num(radius, 2), w / 2, d / 2, h / 2));
    if (r <= 1e-6) return box(w, d, h);

    // Três prismas de seção arredondada, um por eixo: a interseção arredonda
    // todas as arestas e cantos. Os prismas são um pouco mais longos que a
    // peça para as tampas não coincidirem (menos faces coplanares no CSG).
    var a = extrudeRings(roundedRectRing(w, d, r), [], h + 2, { center: true });
    var b = extrudeRings(roundedRectRing(w, h, r), [], d + 2, { center: true }).rotate(-90, 0, 0);
    var c = extrudeRings(roundedRectRing(h, d, r), [], w + 2, { center: true }).rotate(0, 90, 0);
    return a.intersect(b, c);
  }

  function tube(rOuter, rInner, h, options) {
    rOuter = Math.abs(num(rOuter, 10));
    rInner = Math.abs(num(rInner, 8));
    h = Math.abs(num(h, 10));
    if (rInner >= rOuter) throw new Error('tube: raio interno maior que o externo');
    return extrudeRings(ring(0, 0, rOuter, 64), [ring(0, 0, rInner, 64)], h, options);
  }

  // -------------------------------------------------------------------------
  // modelagem livre: revolução, loft, varredura
  // -------------------------------------------------------------------------

  function signedVolume(positions) {
    var volume = 0;
    for (var i = 0; i < positions.length; i += 9) {
      var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      var cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return volume;
  }

  function orientOutward(positions) {
    if (signedVolume(positions) >= 0) return positions;
    for (var i = 0; i < positions.length; i += 9) {
      var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      positions[i + 3] = positions[i + 6];
      positions[i + 4] = positions[i + 7];
      positions[i + 5] = positions[i + 8];
      positions[i + 6] = bx;
      positions[i + 7] = by;
      positions[i + 8] = bz;
    }
    return positions;
  }

  /** Círculo 2D (lista de {x,y}) para loft, prism ou sweep. */
  function circle(radius, segments) {
    var r = Math.abs(num(radius, 5));
    var seg = Math.max(3, Math.round(num(segments, 32)));
    var out = [];
    for (var i = 0; i < seg; i++) {
      var a = Math.PI * 2 * i / seg;
      out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return out;
  }

  function ellipse(rx, ry, segments) {
    var a = Math.abs(num(rx, 5));
    var b = Math.abs(num(ry, 3));
    var seg = Math.max(3, Math.round(num(segments, 32)));
    var out = [];
    for (var i = 0; i < seg; i++) {
      var t = Math.PI * 2 * i / seg;
      out.push({ x: Math.cos(t) * a, y: Math.sin(t) * b });
    }
    return out;
  }

  /**
   * Sólido de revolução: gira um perfil fechado [[r,z],...] em torno do eixo Z.
   * Serve para vasos, garrafas, copos, pinos e corpos orgânicos.
   */
  function lathe(profile, options) {
    options = options || {};
    var points = (profile || []).map(function (p) {
      if (Array.isArray(p)) return { r: Math.max(0, num(p[0], 0)), z: num(p[1], 0) };
      return { r: Math.max(0, num(p.r, 0)), z: num(p.z, 0) };
    });
    if (points.length < 3) throw new Error('lathe: perfil precisa de pelo menos 3 pontos');

    var seg = Math.max(8, Math.round(num(options.segments, 48)));
    var poleEpsilon = 1e-4;
    var rings = [];

    points.forEach(function (p) {
      if (p.r <= poleEpsilon) {
        rings.push({ pole: [0, 0, p.z] });
        return;
      }
      var ring = [];
      for (var i = 0; i < seg; i++) {
        var a = Math.PI * 2 * i / seg;
        ring.push([Math.cos(a) * p.r, Math.sin(a) * p.r, p.z]);
      }
      rings.push({ ring: ring });
    });

    var positions = [];
    var count = rings.length;

    for (var j = 0; j < count; j++) {
      var a1 = rings[j];
      var b1 = rings[(j + 1) % count];

      if (a1.pole && b1.pole) continue;
      if (a1.pole) {
        for (var i2 = 0; i2 < seg; i2++) {
          var n2 = (i2 + 1) % seg;
          pushTri(positions, a1.pole, b1.ring[i2], b1.ring[n2]);
        }
        continue;
      }
      if (b1.pole) {
        for (var i3 = 0; i3 < seg; i3++) {
          var n3 = (i3 + 1) % seg;
          pushTri(positions, a1.ring[i3], b1.pole, a1.ring[n3]);
        }
        continue;
      }

      for (var i4 = 0; i4 < seg; i4++) {
        var n4 = (i4 + 1) % seg;
        var p1 = a1.ring[i4], p2 = a1.ring[n4];
        var p3 = b1.ring[n4], p4 = b1.ring[i4];
        pushTri(positions, p1, p2, p3);
        pushTri(positions, p1, p3, p4);
      }
    }

    return new Solid(orientOutward(positions));
  }

  function toPoint3D(p, fallbackZ) {
    if (Array.isArray(p)) return [num(p[0], 0), num(p[1], 0), num(p[2], fallbackZ || 0)];
    return [num(p.x, 0), num(p.y, 0), num(p.z, fallbackZ || 0)];
  }

  /**
   * Loft: liga anéis de pontos (mesma quantidade em todos) formando um corpo.
   * Aceita [{z, points:[[x,y],...]}, ...] ou arrays de [x,y,z].
   */
  function loft(sections, options) {
    options = options || {};
    var rings = (sections || []).map(function (section) {
      if (section && Array.isArray(section.points)) {
        return section.points.map(function (p) { return toPoint3D(p, section.z); });
      }
      return (section || []).map(function (p) { return toPoint3D(p, 0); });
    }).filter(function (ring) { return ring.length > 0; });

    if (rings.length < 2) throw new Error('loft: precisa de pelo menos 2 anéis');
    var count = rings[0].length;
    var pole = 1e-4;
    rings.forEach(function (ring) {
      if (ring.length !== count) throw new Error('loft: todos os anéis precisam ter o mesmo número de pontos');
    });

    function isPole(ring) {
      var p0 = ring[0];
      for (var i = 1; i < ring.length; i++) {
        if (Math.abs(ring[i][0] - p0[0]) > pole || Math.abs(ring[i][1] - p0[1]) > pole ||
          Math.abs(ring[i][2] - p0[2]) > pole) return false;
      }
      return true;
    }

    var positions = [];

    for (var j = 0; j < rings.length - 1; j++) {
      var A = rings[j], B = rings[j + 1];
      var pa = isPole(A), pb = isPole(B);
      if (pa && pb) continue;
      for (var i = 0; i < count; i++) {
        var n = (i + 1) % count;
        if (pa) {
          pushTri(positions, A[0], B[i], B[n]);
        } else if (pb) {
          pushTri(positions, A[i], B[0], A[n]);
        } else {
          pushTri(positions, A[i], A[n], B[n]);
          pushTri(positions, A[i], B[n], B[i]);
        }
      }
    }

    if (options.caps !== false) {
      var first = rings[0];
      if (!isPole(first)) addFanCap(positions, first, true);
      var last = rings[rings.length - 1];
      if (!isPole(last)) addFanCap(positions, last, false);
    }

    return new Solid(orientOutward(positions));
  }

  function addFanCap(positions, ring, reverse) {
    var cx = 0, cy = 0, cz = 0;
    ring.forEach(function (p) { cx += p[0]; cy += p[1]; cz += p[2]; });
    cx /= ring.length; cy /= ring.length; cz /= ring.length;
    var center = [cx, cy, cz];
    for (var i = 0; i < ring.length; i++) {
      var n = (i + 1) % ring.length;
      if (reverse) pushTri(positions, center, ring[n], ring[i]);
      else pushTri(positions, center, ring[i], ring[n]);
    }
  }

  /** Varre um perfil 2D ao longo de um caminho 3D (chifres, caudas, alças). */
  function sweep(path, profile, options) {
    if (profile && typeof profile === 'object' && !Array.isArray(profile) && !profile.points) {
      options = profile;
      profile = options.radius !== undefined ? options.radius : options.r;
    }
    options = options || {};
    var pts = (path || []).map(function (p) { return toPoint3D(p, 0); });
    if (pts.length < 2) throw new Error('sweep: caminho precisa de pelo menos 2 pontos');

    var circleProfile = typeof profile === 'number' || profile === undefined;
    var shape;
    if (typeof profile === 'number' || profile === undefined) {
      shape = circle(num(profile, 3), options.segments || 24).map(function (p) { return [p.x, p.y]; });
    } else if (profile && profile.points) {
      shape = profile.points.map(function (p) { var q = toPoint2D(p); return [q.x, q.y]; });
    } else {
      shape = (profile || []).map(function (p) {
        var q = toPoint2D(p);
        return [q.x, q.y];
      });
    }
    if (!shape.length) throw new Error('sweep: perfil vazio');

    var rings = [];
    var normal = null;

    for (var i = 0; i < pts.length; i++) {
      var prev = pts[Math.max(0, i - 1)];
      var next = pts[Math.min(pts.length - 1, i + 1)];
      var tangent = normalize(sub(next, prev));
      if (!isFinite(tangent[0])) tangent = [0, 0, 1];

      if (!normal) {
        var hint = Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        normal = normalize(cross(hint, tangent));
      } else {
        // parallel transport: mantém o vetor o mais próximo possível
        var projected = sub(normal, [tangent[0] * dot(normal, tangent), tangent[1] * dot(normal, tangent), tangent[2] * dot(normal, tangent)]);
        normal = normalize(projected);
      }
      var binormal = cross(tangent, normal);
      var radiusScale = 1;
      if (options.radii && options.radii[i] !== undefined) {
        if (circleProfile) {
          // perfil circular: radii são raios absolutos por ponto
          var baseRadius = num(profile, 3);
          radiusScale = baseRadius > 1e-9 ? num(options.radii[i], baseRadius) / baseRadius : 1;
        } else {
          // perfil customizado: radii multiplicam o perfil (1 = tamanho original)
          radiusScale = num(options.radii[i], 1);
        }
      }

      var ringPts = shape.map(function (p) {
        var x = p[0] * radiusScale;
        var y = p[1] * radiusScale;
        return [
          pts[i][0] + normal[0] * x + binormal[0] * y,
          pts[i][1] + normal[1] * x + binormal[1] * y,
          pts[i][2] + normal[2] * x + binormal[2] * y
        ];
      });
      rings.push(ringPts);
    }

    return loft(rings, options);
  }

  /** Junta sólidos sem remover as faces internas (rápido para detalhes). */
  function merge() {
    var out = [];
    Array.prototype.slice.call(arguments).forEach(function (value) {
      var solid = asSolid(value);
      for (var i = 0; i < solid.positions.length; i++) out.push(solid.positions[i]);
    });
    return new Solid(out);
  }

  /**
   * Rosca simplificada (perfil retangular escalonado), robusta para impressão.
   * Macho: núcleo + cristas em hélice. Fêmea: cilindro externo menos o macho
   * com folga. Eixo Z, centrada na origem. Use translate/rotate para posicionar.
   */
  function thread(diameter, pitch, length, options) {
    options = options || {};
    var d = Math.abs(num(diameter, 20));
    var p = Math.max(0.5, num(pitch, 2));
    var L = Math.abs(num(length, 10));
    var depth = Math.max(0.3, num(options.depth, Math.min(1.6, p * 0.6)));
    var clearance = Math.max(0, num(options.clearance, 0.25));
    var internal = !!options.internal;
    var wall = Math.max(0.8, num(options.wall, 3));
    var stepsPerTurn = Math.max(8, Math.min(48, Math.round(num(options.stepsPerTurn, 16))));
    var major = d + (internal ? 2 * clearance : 0);
    var coreR = Math.max(0.5, major / 2 - depth);
    var turns = Math.max(0.5, L / p);
    var steps = Math.max(8, Math.round(turns * stepsPerTurn));
    var tabRadius = Math.max(0.2, p * 0.24);

    var tabs = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var z = -L / 2 + L * t;
      var angle = (Math.PI * 2 * (z + L / 2)) / p;
      tabs.push(cylinder(tabRadius, depth, { segments: 8 })
        .rotate(0, 90, 0)
        .translate(coreR + depth / 2, 0, z)
        .rotate(0, 0, angle * 180 / Math.PI));
    }

    var ridge = merge.apply(null, tabs);
    var core = cylinder(coreR, L, { segments: 48 });
    var male = merge(core, ridge);

    if (!internal) return male;

    var outer = cylinder(major / 2 + wall, L, { segments: 64 });
    return outer.subtract(male);
  }

  // -------------------------------------------------------------------------
  // conexões entre peças
  // -------------------------------------------------------------------------

  function distance3(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function addVec(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mulVec(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

  /** Vértice mais próximo de um alvo (usado como âncora do conector). */
  function nearestVertex(positions, target) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < positions.length; i += 3) {
      var dx = positions[i] - target[0];
      var dy = positions[i + 1] - target[1];
      var dz = positions[i + 2] - target[2];
      var d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = [positions[i], positions[i + 1], positions[i + 2]];
      }
    }
    return best || [0, 0, 0];
  }

  /** Cilindro entre dois pontos (eixo arbitrário), fechado. */
  function orientedCylinder(start, end, radius, segments) {
    var axis = normalize(sub(end, start));
    var length = distance3(start, end);
    if (length < 1e-5) return sphere(radius, { segments: segments });
    var hint = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    var right = normalize(cross(axis, hint));
    var up = cross(right, axis);
    var r = Math.abs(num(radius, 2));
    var seg = Math.max(8, Math.round(num(segments, 24)));
    var out = [];
    var base = [];
    var top = [];
    for (var i = 0; i < seg; i++) {
      var a = Math.PI * 2 * i / seg;
      var offset = addVec(mulVec(right, Math.cos(a) * r), mulVec(up, Math.sin(a) * r));
      base.push(addVec(start, offset));
      top.push(addVec(end, offset));
    }
    for (var k = 0; k < seg; k++) {
      var n = (k + 1) % seg;
      pushTri(out, base[k], base[n], top[n]);
      pushTri(out, base[k], top[n], top[k]);
      pushTri(out, start, base[n], base[k]);
      pushTri(out, end, top[k], top[n]);
    }
    return new Solid(convexFaces(out, mulVec(addVec(start, end), 0.5)));
  }

  /**
   * Conector entre duas peças: um pino de material que penetra `overlap` mm em
   * cada lado. Retorna só o pino (não une as peças), para entrar como uma parte
   * "juntas" e preservar as cores.
   */
  function connector(a, b, options) {
    options = options || {};
    var A = asSolid(a);
    var B = asSolid(b);
    var centerA = bounds(A.positions).center;
    var centerB = bounds(B.positions).center;
    var pA = options.from ? triple(options.from, 0) : nearestVertex(A.positions, centerB);
    var pB = options.to ? triple(options.to, 0) : nearestVertex(B.positions, centerA);
    var radius = Math.max(0.4, num(options.radius, 2.2));
    var overlap = Math.max(0, num(options.overlap, 1.8));
    var segments = Math.max(8, Math.round(num(options.segments, 20)));

    var dir = sub(pB, pA);
    if (length(dir) < 1e-4) {
      return sphere(radius, { segments: segments }).translate(pA[0], pA[1], pA[2]);
    }
    dir = normalize(dir);
    var start = sub(pA, mulVec(dir, overlap));
    var end = addVec(pB, mulVec(dir, overlap));
    return orientedCylinder(start, end, radius, segments);
  }

  /** Une duas peças com um pino, devolvendo um único sólido. */
  function bridge(a, b, options) {
    var A = asSolid(a);
    var B = asSolid(b);
    return A.union(B, connector(A, B, options));
  }

  /**
   * Conecta uma lista de peças com uma árvore de pinos (MST pelas âncoras mais
   * próximas). Devolve os pinos fundidos, para adicionar como parte "juntas".
   */
  function connectors(parts, options) {
    return new Solid(connectParts(parts, options).positions);
  }

  function boxGap(a, b) {
    var dx = Math.max(a.min[0] - b.max[0], b.min[0] - a.max[0], 0);
    var dy = Math.max(a.min[1] - b.max[1], b.min[1] - a.max[1], 0);
    var dz = Math.max(a.min[2] - b.max[2], b.min[2] - a.max[2], 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function pointBoxDistanceSq(p, box) {
    var dx = Math.max(box.min[0] - p[0], 0, p[0] - box.max[0]);
    var dy = Math.max(box.min[1] - p[1], 0, p[1] - box.max[1]);
    var dz = Math.max(box.min[2] - p[2], 0, p[2] - box.max[2]);
    return dx * dx + dy * dy + dz * dz;
  }

  /** Pontos da superfície (vértices + centroides + grade) próximos de uma caixa. */
  function nearbySurfacePoints(positions, box, margin, cap) {
    var margin2 = margin * margin;
    var points = [];
    var stride = 1;
    var triangles = Math.floor(positions.length / 9);
    if (triangles > cap) stride = Math.max(1, Math.ceil(triangles / cap));

    for (var t = 0; t < triangles; t += stride) {
      var i = t * 9;
      var a = [positions[i], positions[i + 1], positions[i + 2]];
      var b = [positions[i + 3], positions[i + 4], positions[i + 5]];
      var c = [positions[i + 6], positions[i + 7], positions[i + 8]];
      var center = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      if (pointBoxDistanceSq(a, box) > margin2 && pointBoxDistanceSq(b, box) > margin2 &&
        pointBoxDistanceSq(c, box) > margin2 && pointBoxDistanceSq(center, box) > margin2) continue;

      points.push(a, b, c, center);
      points.push(
        [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
        [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2],
        [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2]
      );

      // faces grandes: grade interna para o contato cair embaixo da peça,
      // não só nas quinas (ex.: tampo de mesa com pernas no meio da face)
      var maxEdge = Math.max(distance3(a, b), distance3(b, c), distance3(c, a));
      var sub = Math.min(10, Math.max(1, Math.ceil(maxEdge / 2.5)));
      if (sub > 1) {
        for (var u = 1; u < sub; u++) {
          for (var v = 1; v < sub - u; v++) {
            var bu = u / sub;
            var bv = v / sub;
            var bw = 1 - bu - bv;
            var p = [
              a[0] * bw + b[0] * bu + c[0] * bv,
              a[1] * bw + b[1] * bu + c[1] * bv,
              a[2] * bw + b[2] * bu + c[2] * bv
            ];
            if (pointBoxDistanceSq(p, box) <= margin2) points.push(p);
          }
        }
      }
    }
    if (points.length > cap * 4) {
      var step = Math.ceil(points.length / (cap * 4));
      var sampled = [];
      for (var k = 0; k < points.length; k += step) sampled.push(points[k]);
      return sampled;
    }
    return points;
  }

  function gridKey(p, cell) {
    return Math.floor(p[0] / cell) + ':' + Math.floor(p[1] / cell) + ':' + Math.floor(p[2] / cell);
  }

  function buildGrid(points, cell) {
    var grid = new Map();
    var c = Math.max(1, cell || 4);
    for (var i = 0; i < points.length; i++) {
      var k = gridKey(points[i], c);
      var list = grid.get(k);
      if (!list) { list = []; grid.set(k, list); }
      list.push(points[i]);
    }
    return { map: grid, cell: c };
  }

  function nearestDistanceSq(p, grid) {
    var c = grid.cell;
    var gx = Math.floor(p[0] / c), gy = Math.floor(p[1] / c), gz = Math.floor(p[2] / c);
    var best = Infinity;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dz = -1; dz <= 1; dz++) {
          var list = grid.map.get((gx + dx) + ':' + (gy + dy) + ':' + (gz + dz));
          if (!list) continue;
          for (var m = 0; m < list.length; m++) {
            var q = list[m];
            var ddx = p[0] - q[0], ddy = p[1] - q[1], ddz = p[2] - q[2];
            var d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < best) best = d2;
          }
        }
      }
    }
    return best;
  }

  /**
   * Par de pontos mais próximos entre duas nuvens de superfície, com grade
   * espacial. É o que dá o ponto real da junta (não o centro das peças).
   */
  function closestPair(pointsA, pointsB, cell) {
    if (!pointsA.length || !pointsB.length) return null;
    var gridB = buildGrid(pointsB, cell);
    var best = { d2: Infinity, a: null, b: null };
    for (var j = 0; j < pointsA.length; j++) {
      var p = pointsA[j];
      var c = gridB.cell;
      var gx = Math.floor(p[0] / c), gy = Math.floor(p[1] / c), gz = Math.floor(p[2] / c);
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          for (var dz = -1; dz <= 1; dz++) {
            var list = gridB.map.get((gx + dx) + ':' + (gy + dy) + ':' + (gz + dz));
            if (!list) continue;
            for (var m = 0; m < list.length; m++) {
              var q = list[m];
              var ddx = p[0] - q[0], ddy = p[1] - q[1], ddz = p[2] - q[2];
              var d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 < best.d2) best = { d2: d2, a: p, b: q };
            }
          }
        }
      }
    }
    if (!best.a) return null;
    return { a: best.a, b: best.b, distance: Math.sqrt(best.d2) };
  }

  /**
   * Centro da área de contato: pega todos os pontos dos dois lados que estão a
   * até 1,5 mm do contato mínimo e devolve a média de cada lado. O pino fica
   * no meio da junta, não na quina mais próxima.
   */
  function contactCenter(pointsA, pointsB, cell, minDistance) {
    var gridA = buildGrid(pointsA, cell);
    var gridB = buildGrid(pointsB, cell);
    var tol = (minDistance + 1.5) * (minDistance + 1.5);
    var nearA = [];
    var nearB = [];

    for (var i = 0; i < pointsA.length; i++) {
      if (nearestDistanceSq(pointsA[i], gridB) <= tol) nearA.push(pointsA[i]);
    }
    for (var j = 0; j < pointsB.length; j++) {
      if (nearestDistanceSq(pointsB[j], gridA) <= tol) nearB.push(pointsB[j]);
    }

    function centroid(list) {
      if (!list.length) return null;
      var sum = [0, 0, 0];
      for (var i = 0; i < list.length; i++) {
        sum[0] += list[i][0]; sum[1] += list[i][1]; sum[2] += list[i][2];
      }
      return [sum[0] / list.length, sum[1] / list.length, sum[2] / list.length];
    }

    function extent(list, center) {
      if (!center) return 0;
      var max = 0;
      for (var i = 0; i < list.length; i++) {
        var dx = list[i][0] - center[0], dy = list[i][1] - center[1], dz = list[i][2] - center[2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > max) max = d;
      }
      return max;
    }

    var ca = centroid(nearA);
    var cb = centroid(nearB);
    return {
      a: ca,
      b: cb,
      extent: Math.min(extent(nearA, ca), extent(nearB, cb))
    };
  }

  /**
   * Separa uma malha nas suas cascas conectadas (pernas, asas, olhos etc. que
   * foram fundidos numa única parte com merge). Cada casca vira um nó da junção.
   */
  function splitShells(positions) {
    var triangles = Math.floor(positions.length / 9);
    if (!triangles) return [];
    var parent = new Array(triangles);
    for (var i = 0; i < triangles; i++) parent[i] = i;

    function find(x) {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    }

    var vertexMap = new Map();
    for (var t = 0; t < triangles; t++) {
      var base = t * 9;
      for (var k = 0; k < 3; k++) {
        var o = base + k * 3;
        var key = Math.round(positions[o] * 100) + ',' +
          Math.round(positions[o + 1] * 100) + ',' +
          Math.round(positions[o + 2] * 100);
        var prev = vertexMap.get(key);
        if (prev === undefined) {
          vertexMap.set(key, t);
        } else {
          var ra = find(t);
          var rb = find(prev);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }

    var groups = new Map();
    for (var m = 0; m < triangles; m++) {
      var root = find(m);
      var list = groups.get(root);
      if (!list) { list = []; groups.set(root, list); }
      list.push(m);
    }

    var shells = [];
    groups.forEach(function (list) {
      var out = new Array(list.length * 9);
      for (var j = 0; j < list.length; j++) {
        var src = list[j] * 9;
        var dst = j * 9;
        for (var q = 0; q < 9; q++) out[dst + q] = positions[src + q];
      }
      shells.push({
        positions: out,
        triangles: list.length,
        bounds: bounds(out),
        volume: Math.abs(signedVolume(out))
      });
    });
    return shells;
  }

  function boxContains(outer, inner) {
    var eps = 0.05;
    return inner.min[0] >= outer.min[0] - eps && inner.max[0] <= outer.max[0] + eps &&
      inner.min[1] >= outer.min[1] - eps && inner.max[1] <= outer.max[1] + eps &&
      inner.min[2] >= outer.min[2] - eps && inner.max[2] <= outer.max[2] + eps;
  }

  /**
   * Técnica genérica de junção: separa cada parte em cascas, encontra o contato
   * real entre cascas de partes diferentes e liga a árvore com pinos centrados
   * na área de contato, com raio proporcional a essa área.
   * Devolve {positions, pins, joints, loose}. Cada pin traz targetPart (a parte
   * menor), para o runner fundir o pino na cor da peça.
   */
  function connectParts(parts, options) {
    options = options || {};
    var result = { positions: [], pins: [], joints: [], loose: [] };
    var nodes = [];

    (parts || []).forEach(function (part, partIndex) {
      var solid = part && part.solid ? asSolid(part.solid) : asSolid(part);
      var shells = splitShells(solid.positions);

      // cascas internas (dome dentro da base, peças fundidas dentro do corpo)
      // não precisam de pino: só as cascas externas/separadas entram na árvore
      var kept = shells.filter(function (shell, index) {
        return !shells.some(function (other, otherIndex) {
          if (otherIndex === index) return false;
          if (!boxContains(other.bounds, shell.bounds)) return false;
          if (other.volume > shell.volume * 1.05) return true;
          return other.volume >= shell.volume && otherIndex < index;
        });
      });

      kept.forEach(function (shell, shellIndex) {
        nodes.push({
          partIndex: partIndex,
          shellIndex: shellIndex,
          name: part && part.name ? part.name : ('peça ' + (partIndex + 1)),
          color: part && part.color ? part.color : '#64748b',
          removable: !!(part && part.removable),
          positions: shell.positions,
          bounds: shell.bounds,
          volume: shell.volume
        });
      });
    });

    if (nodes.length < 2) return result;

    var maxGap = num(options.maxGap, 20);
    var overlap = Math.max(0, num(options.overlap, 2));
    var edges = [];

    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        // não liga cascas irmãs da mesma parte (as pernas entre si, por ex.)
        if (nodes[i].partIndex === nodes[j].partIndex) continue;
        // peça removível/roscada/encaixada: o vínculo é funcional, sem pino
        if (nodes[i].removable || nodes[j].removable) continue;

        var gapAABB = boxGap(nodes[i].bounds, nodes[j].bounds);
        var anchorA = nearestVertex(nodes[i].positions, nodes[j].bounds.center);
        var anchorB = nearestVertex(nodes[j].positions, nodes[i].bounds.center);
        var fallback = { a: anchorA, b: anchorB, distance: distance3(anchorA, anchorB), extent: 0 };
        var pair = null;

        if (gapAABB <= 14) {
          var ptsA = nearbySurfacePoints(nodes[i].positions, nodes[j].bounds, 8, 1400);
          var ptsB = nearbySurfacePoints(nodes[j].positions, nodes[i].bounds, 8, 1400);
          if (ptsA.length && ptsB.length) {
            pair = closestPair(ptsA, ptsB, 4);
            if (pair) {
              var center = contactCenter(ptsA, ptsB, 4, pair.distance);
              if (center.a && center.b) {
                pair.a = center.a;
                pair.b = center.b;
                pair.extent = center.extent;
              }
            }
          }
        }
        if (!pair) pair = fallback;

        edges.push({
          i: i,
          j: j,
          distance: pair.distance,
          pa: pair.a,
          pb: pair.b,
          extent: pair.extent || 0,
          gap: gapAABB
        });
      }
    }

    edges.sort(function (a, b) { return a.distance - b.distance; });

    var parent = [];
    for (var k = 0; k < nodes.length; k++) parent.push(k);
    function find(x) {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    }

    var used = 0;
    for (var e = 0; e < edges.length && used < nodes.length - 1; e++) {
      var edge = edges[e];
      var ra = find(edge.i);
      var rb = find(edge.j);
      if (ra === rb) continue;
      parent[ra] = rb;
      used++;

      if (edge.distance <= 0.25) continue;

      var nodeA = nodes[edge.i];
      var nodeB = nodes[edge.j];
      var sizeA = nodeA.bounds.size;
      var sizeB = nodeB.bounds.size;
      var minA = Math.min(sizeA[0], sizeA[1], sizeA[2]);
      var minB = Math.min(sizeB[0], sizeB[1], sizeB[2]);
      var autoRadius = Math.max(1, Math.min(3.2, Math.min(minA, minB) * 0.35));
      var radius = options.radius !== undefined
        ? Math.max(0.4, num(options.radius, 2.4))
        : Math.min(autoRadius, Math.max(0.8, edge.extent * 0.45));
      var segments = options.segments !== undefined
        ? Math.max(8, Math.round(num(options.segments, 20)))
        : Math.max(12, Math.round(18 + radius * 3));

      if (edge.distance > maxGap) {
        result.loose.push({ a: nodeA.name, b: nodeB.name, gap: Math.round(edge.distance * 10) / 10 });
        continue;
      }

      var dir = normalize(sub(edge.pb, edge.pa));
      if (!isFinite(dir[0]) || length(sub(edge.pb, edge.pa)) < 1e-5) continue;

      var pin = orientedCylinder(
        sub(edge.pa, mulVec(dir, overlap)),
        addVec(edge.pb, mulVec(dir, overlap)),
        radius,
        segments
      );
      for (var p = 0; p < pin.positions.length; p++) result.positions.push(pin.positions[p]);

      result.pins.push({
        a: edge.i,
        b: edge.j,
        targetPart: nodeA.volume <= nodeB.volume ? nodeA.partIndex : nodeB.partIndex,
        positions: pin.positions,
        radius: Math.round(radius * 10) / 10,
        gap: Math.round(edge.distance * 100) / 100
      });

      result.joints.push({
        a: nodeA.name,
        b: nodeB.name,
        gap: Math.round(edge.distance * 100) / 100,
        radius: Math.round(radius * 10) / 10
      });
    }

    // cascas que não conseguiram nenhuma aresta viram "soltas"
    var mainRoot = find(0);
    for (var n = 1; n < nodes.length; n++) {
      if (nodes[n].removable) continue;
      if (find(n) === mainRoot) continue;
      result.loose.push({ a: nodes[n].name, b: 'conjunto', gap: null });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // texto
  // -------------------------------------------------------------------------

  function text(str, options) {
    options = options || {};
    if (!deps.Field || !deps.Font || !deps.font) {
      throw new Error('fonte não carregada: o texto não está disponível agora');
    }
    var size = num(options.size, 10);
    var height = num(options.height, 3);
    var quality = Math.max(0.12, num(options.quality, 0.4));
    var value = String(str === undefined ? '' : str);
    var layout = deps.font.layout(value, size);
    if (!layout.contours || !layout.contours.length) throw new Error('texto sem contorno: "' + value + '"');

    var field = deps.Field.build(layout.contours, { h: quality, maxDist: quality * 2 });
    if (field.empty) throw new Error('texto vazio: "' + value + '"');

    var rings = deps.Field.contour(field, 0)
      .map(function (r) { return deps.Field.simplify(r, Math.max(0.01, quality / 8)); })
      .filter(function (r) { return r.length >= 3; });
    var polygons = deps.Field.groupRings(rings);
    if (!polygons.length) throw new Error('texto sem contorno fechado: "' + value + '"');

    var out = [];
    polygons.forEach(function (polygon) {
      var solid = extrudeRings(polygon.outer, polygon.holes, height, { center: true });
      for (var i = 0; i < solid.positions.length; i++) out.push(solid.positions[i]);
    });

    var result = new Solid(out);
    if (options.center !== false) {
      var centerX = (layout.minX + layout.maxX) / 2;
      var centerY = (layout.minY + layout.maxY) / 2;
      result = result.translate(-centerX, -centerY, 0);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // utilidades
  // -------------------------------------------------------------------------

  /** Move o modelo para a mesa: base em z=0 e centro em x=y=0. */
  function onBed(value) {
    if (value && value.parts) {
      var normalized = normalizeParts(value);
      var parts = normalized.parts;
      var min = [Infinity, Infinity, Infinity];
      var max = [-Infinity, -Infinity, -Infinity];
      parts.forEach(function (part) {
        var p = part.positions;
        for (var i = 0; i < p.length; i += 3) {
          for (var k = 0; k < 3; k++) {
            if (p[i + k] < min[k]) min[k] = p[i + k];
            if (p[i + k] > max[k]) max[k] = p[i + k];
          }
        }
      });
      if (!isFinite(min[0])) return value;
      var dx = -(min[0] + max[0]) / 2;
      var dy = -(min[1] + max[1]) / 2;
      var dz = -min[2];
      return {
        name: value.name,
        parts: parts.map(function (part) {
          return {
            name: part.name,
            color: part.color,
            removable: !!part.removable,
            solid: new Solid(part.positions).translate(dx, dy, dz)
          };
        })
      };
    }
    var solid = asSolid(value);
    if (!solid.positions.length) return solid;
    var b = bounds(solid.positions);
    return solid.translate(-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]);
  }

  function bounds(positions) {
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < positions.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        var value = positions[i + k];
        if (value < min[k]) min[k] = value;
        if (value > max[k]) max[k] = value;
      }
    }
    if (!positions.length || !isFinite(min[0])) {
      return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
    }
    return {
      min: min,
      max: max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    };
  }

  function measure(positions) {
    var volume = 0;
    var area = 0;
    var edges = new Map();
    var triangles = 0;

    function key(x, y, z) {
      return Math.round(x * 1000) / 1000 + ',' + Math.round(y * 1000) / 1000 + ',' + Math.round(z * 1000) / 1000;
    }

    for (var i = 0; i < positions.length; i += 9) {
      var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
      var cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];

      volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      var n = cross([bx - ax, by - ay, bz - az], [cx - ax, cy - ay, cz - az]);
      area += length(n) / 2;
      triangles++;

      var ka = key(ax, ay, az), kb = key(bx, by, bz), kc = key(cx, cy, cz);
      addEdge(edges, ka, kb);
      addEdge(edges, kb, kc);
      addEdge(edges, kc, ka);
    }

    var boundary = 0;
    var nonManifold = 0;
    edges.forEach(function (count) {
      if (count === 1) boundary++;
      else if (count > 2) nonManifold++;
    });

    var b = bounds(positions);
    return {
      triangles: triangles,
      volume: Math.abs(volume),
      area: area,
      size: b.size,
      min: b.min,
      max: b.max,
      center: b.center,
      boundaryEdges: boundary,
      nonManifoldEdges: nonManifold,
      watertight: boundary === 0 && nonManifold === 0
    };
  }

  function addEdge(map, a, b) {
    var key = a < b ? a + '|' + b : b + '|' + a;
    map.set(key, (map.get(key) || 0) + 1);
  }

  function stlBinary(solids, name) {
    var arrays = solids.map(function (s) { return asSolid(s).positions; });
    var total = 0;
    arrays.forEach(function (p) { total += p.length / 9; });

    var buffer = new ArrayBuffer(84 + total * 50);
    var view = new DataView(buffer);
    var header = '3D Mesh Downloader - estudo IA' + (name ? ' - ' + name : '');
    for (var h = 0; h < 80; h++) {
      view.setUint8(h, h < header.length ? header.charCodeAt(h) : 32);
    }
    view.setUint32(80, total, true);
    var offset = 84;

    arrays.forEach(function (positions) {
      for (var i = 0; i < positions.length; i += 9) {
        var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
        var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
        var cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
        var nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        var ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        var nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
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

  // -------------------------------------------------------------------------
  // normalização do retorno do script
  // -------------------------------------------------------------------------

  var DEFAULT_COLORS = ['#5b6cff', '#ffb020', '#22c55e', '#f43f5e', '#0ea5e9', '#a855f7'];

  function normalizeParts(value) {
    var name = value && value.name ? String(value.name) : '';
    var raw = [];

    if (value && value.parts && Array.isArray(value.parts)) {
      raw = value.parts;
    } else if (value instanceof Solid) {
      raw = [{ solid: value }];
    } else if (Array.isArray(value)) {
      raw = value;
    } else if (value && value.solid) {
      raw = [value];
    } else if (value && value.positions) {
      raw = [{ solid: value }];
    } else if (value === undefined || value === null) {
      throw new Error('o script não retornou geometria (retorne K.box(...) ou {parts:[...]})');
    } else {
      throw new Error('retorno do script não é geometria: ' + typeof value);
    }

    if (!raw.length) throw new Error('o script retornou uma lista vazia de peças');

    var parts = [];
    raw.forEach(function (item, index) {
      var solid;
      var partName = 'peça ' + (index + 1);
      var color = DEFAULT_COLORS[index % DEFAULT_COLORS.length];

      if (item instanceof Solid) {
        solid = item;
      } else if (item && item.positions) {
        solid = new Solid(item.positions);
      } else if (item && item.solid) {
        solid = asSolid(item.solid);
        partName = item.name ? String(item.name) : partName;
        color = typeof item.color === 'string' ? item.color : color;
      } else {
        solid = asSolid(item);
      }

      if (item && item.name && !(item instanceof Solid)) partName = String(item.name);
      if (item && typeof item.color === 'string') color = item.color;

      var positions = solid.positions;
      if (!positions || !positions.length) return;
      var copy = positions instanceof Float32Array ? positions : new Float32Array(positions);
      parts.push({
        name: partName,
        color: color,
        removable: !!(item && !(item instanceof Solid) && item.removable),
        positions: copy
      });
    });

    if (!parts.length) throw new Error('nenhuma peça com triângulos foi gerada');

    var total = 0;
    parts.forEach(function (p) { total += p.positions.length / 9; });
    if (total > 300000) {
      throw new Error('malha com ' + total + ' triângulos (limite 300 mil). Reduza os segmentos.');
    }

    return { name: name, parts: parts };
  }

  function api() {
    return {
      VERSION: VERSION,
      Solid: Solid,
      solid: function (positions) { return new Solid(positions); },
      box: box,
      cylinder: cylinder,
      cone: cone,
      sphere: sphere,
      torus: torus,
      prism: prism,
      tube: tube,
      roundedBox: roundedBox,
      lathe: lathe,
      loft: loft,
      sweep: sweep,
      merge: merge,
      thread: thread,
      connector: connector,
      connectors: connectors,
      bridge: bridge,
      circle: circle,
      ellipse: ellipse,
      text: text,
      onBed: onBed,
      union: function () { return asSolid(Array.prototype.slice.call(arguments)).union(); },
      bounds: function (s) { return bounds(asSolid(s).positions); },
      measure: function (s) { return measure(asSolid(s).positions); }
    };
  }

  return {
    VERSION: VERSION,
    api: api,
    configure: configure,
    measure: measure,
    bounds: bounds,
    stlBinary: stlBinary,
    normalizeParts: normalizeParts,
    asSolid: asSolid,
    splitShells: splitShells,
    connectParts: connectParts
  };
});
