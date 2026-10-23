/**
 * Renderizador do Estúdio IA: canvas puro (sem three.js), z-buffer,
 * sombreamento plano, várias peças com cor, vistas ortográficas e captura
 * de imagens para o agente.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IaRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VIEWS = {
    perspective: { yaw: -0.85, pitch: 0.62, ortho: false },
    top: { yaw: -Math.PI / 2, pitch: Math.PI / 2, ortho: true },
    bottom: { yaw: -Math.PI / 2, pitch: -Math.PI / 2, ortho: true },
    front: { yaw: -Math.PI / 2, pitch: 0, ortho: true },
    back: { yaw: Math.PI / 2, pitch: 0, ortho: true },
    right: { yaw: 0, pitch: 0, ortho: true },
    left: { yaw: Math.PI, pitch: 0, ortho: true }
  };

  var LIGHT = normalize([0.35, -0.75, 0.9]);
  var FILL = normalize([-0.6, 0.35, 0.5]);
  var FOV = 32 * Math.PI / 180;

  function create(canvas, options) {
    options = options || {};
    var ctx = canvas.getContext('2d', { alpha: false });
    var parts = [];
    var view = {
      yaw: VIEWS.perspective.yaw,
      pitch: VIEWS.perspective.pitch,
      ortho: false,
      zoom: 1,
      fitDistance: 60,
      orthoScale: 8,
      target: [0, 0, 0]
    };
    var bbox = { min: [-10, -10, -10], max: [10, 10, 10], size: [20, 20, 20] };
    var width = 0;
    var height = 0;
    var triangleCount = 0;
    var scheduled = false;
    var showGrid = options.grid !== false;
    var showAxes = options.axes !== false;
    var back = [244, 246, 250];
    var back2 = [232, 236, 244];

    if (options.background) {
      back = options.background[0];
      back2 = options.background[1];
    }

    function setModel(nextParts) {
      parts = (nextParts || []).filter(function (p) { return p && p.positions && p.positions.length; });
      triangleCount = 0;
      parts.forEach(function (part) { triangleCount += part.positions.length / 9; });
      resize();
      fit();
      schedule();
    }

    function fit() {
      var min = [Infinity, Infinity, Infinity];
      var max = [-Infinity, -Infinity, -Infinity];
      parts.forEach(function (part) {
        var p = part.positions;
        for (var i = 0; i < p.length; i += 3) {
          for (var k = 0; k < 3; k++) {
            var value = p[i + k];
            if (value < min[k]) min[k] = value;
            if (value > max[k]) max[k] = value;
          }
        }
      });
      if (!isFinite(min[0])) {
        bbox = { min: [-10, -10, 0], max: [10, 10, 10], size: [20, 20, 10] };
        view.target = [0, 0, 5];
      } else {
        bbox = {
          min: min,
          max: max,
          size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
        };
        view.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      }
      updateFraming();
    }

    function updateFraming() {
      view.orthoScale = requiredOrthoScale();
      view.fitDistance = requiredDistance();
    }

    function setView(name) {
      var preset = VIEWS[name];
      if (!preset) return;
      view.yaw = preset.yaw;
      view.pitch = preset.pitch;
      view.ortho = preset.ortho;
      view.zoom = 1;
      updateFraming();
      schedule();
    }

    function resetView() {
      setView('perspective');
    }

    function orientationBasis() {
      var cp = Math.cos(view.pitch);
      var sp = Math.sin(view.pitch);
      var forward = [-cp * Math.cos(view.yaw), -cp * Math.sin(view.yaw), -sp];
      // evita degeneração no topo/baixo (forward paralelo a Z)
      var right = normalize([-Math.sin(view.yaw), Math.cos(view.yaw), 0]);
      var up = cross(right, forward);
      return { forward: normalize(forward), right: right, up: up };
    }

    function requiredDistance(overW, overH) {
      var basis = orientationBasis();
      var focal = 1 / Math.tan(FOV / 2);
      var w = Math.max(1, overW || width || canvas.clientWidth || 640);
      var h = Math.max(1, overH || height || canvas.clientHeight || 480);
      var scale = focal * (h / 2);
      var needed = 0;
      for (var c = 0; c < 8; c++) {
        var point = [
          (c & 1) ? bbox.max[0] : bbox.min[0],
          (c & 2) ? bbox.max[1] : bbox.min[1],
          (c & 4) ? bbox.max[2] : bbox.min[2]
        ];
        var dx = point[0] - view.target[0];
        var dy = point[1] - view.target[1];
        var dz = point[2] - view.target[2];
        var xr = dx * basis.right[0] + dy * basis.right[1] + dz * basis.right[2];
        var yr = dx * basis.up[0] + dy * basis.up[1] + dz * basis.up[2];
        var zr = dx * basis.forward[0] + dy * basis.forward[1] + dz * basis.forward[2];
        needed = Math.max(needed, 2 * Math.abs(xr) * scale / w - zr);
        needed = Math.max(needed, 2 * Math.abs(yr) * scale / h - zr);
      }
      return Math.max(5, needed * 1.14);
    }

    function requiredOrthoScale(overW, overH) {
      var basis = orientationBasis();
      var halfW = 0;
      var halfH = 0;
      for (var c = 0; c < 8; c++) {
        var point = [
          (c & 1) ? bbox.max[0] : bbox.min[0],
          (c & 2) ? bbox.max[1] : bbox.min[1],
          (c & 4) ? bbox.max[2] : bbox.min[2]
        ];
        var dx = point[0] - view.target[0];
        var dy = point[1] - view.target[1];
        var dz = point[2] - view.target[2];
        halfW = Math.max(halfW, Math.abs(dx * basis.right[0] + dy * basis.right[1] + dz * basis.right[2]));
        halfH = Math.max(halfH, Math.abs(dx * basis.up[0] + dy * basis.up[1] + dz * basis.up[2]));
      }
      var w = Math.max(1, overW || width || canvas.clientWidth || 640);
      var h = Math.max(1, overH || height || canvas.clientHeight || 480);
      var sx = halfW > 0.001 ? (w * 0.46) / halfW : 1;
      var sy = halfH > 0.001 ? (h * 0.46) / halfH : 1;
      return Math.min(sx, sy);
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      // malhas muito densas: evita renderizar em 2x e travar a interação
      if (triangleCount > 60000) dpr = 1;
      var nextW = Math.max(1, Math.round(rect.width * dpr));
      var nextH = Math.max(1, Math.round(rect.height * dpr));
      if (nextW !== width || nextH !== height) {
        width = nextW;
        height = nextH;
        canvas.width = width;
        canvas.height = height;
        updateFraming();
      }
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        resize();
        drawLive();
      });
    }

    function drawLive() {
      if (!width || !height) resize();
      var image = ctx.createImageData(width, height);
      var depth = new Float32Array(width * height);
      paintScene(image, depth, width, height, camera(), {
        grid: showGrid,
        axes: showAxes
      });
      ctx.putImageData(image, 0, 0);
    }

    function camera() {
      var basis = orientationBasis();
      var dist = view.ortho
        ? Math.max(bbox.size[0], bbox.size[1], bbox.size[2]) * 3 + 100
        : view.fitDistance * view.zoom;
      var cp = Math.cos(view.pitch);
      var sp = Math.sin(view.pitch);
      var eye = [
        view.target[0] + cp * Math.cos(view.yaw) * dist,
        view.target[1] + cp * Math.sin(view.yaw) * dist,
        view.target[2] + sp * dist
      ];
      return {
        eye: eye,
        basis: basis,
        ortho: view.ortho,
        focal: 1 / Math.tan(FOV / 2),
        scale: view.ortho ? view.orthoScale / view.zoom : 1,
        zoom: view.zoom
      };
    }

    function paintScene(image, depth, w, h, cam, opts) {
      var data = image.data;
      depth.fill(Infinity);
      paintBackground(data, w, h);

      var focal = cam.focal;
      var scaleFactor = focal * (h / 2);
      var cx = w / 2;
      var cy = h / 2;
      var orthoScale = cam.scale;

      parts.forEach(function (part) {
        var color = hexToRgb(part.color || '#5b6cff');
        var positions = part.positions;

        for (var i = 0; i < positions.length; i += 9) {
          var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
          var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
          var gx = positions[i + 6], gy = positions[i + 7], gz = positions[i + 8];

          var ux = bx - ax, uy = by - ay, uz = bz - az;
          var vx = gx - ax, vy = gy - ay, vz = gz - az;
          var nx = uy * vz - uz * vy;
          var ny = uz * vx - ux * vz;
          var nz = ux * vy - uy * vx;
          var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nlen < 1e-10) continue;
          nx /= nlen; ny /= nlen; nz /= nlen;

          if (cam.ortho) {
            if (nx * cam.basis.forward[0] + ny * cam.basis.forward[1] + nz * cam.basis.forward[2] > 0) continue;
          } else {
            var dx0 = ax - cam.eye[0], dy0 = ay - cam.eye[1], dz0 = az - cam.eye[2];
            if (nx * dx0 + ny * dy0 + nz * dz0 > 0) continue;
          }

          var pa = project(ax, ay, az, cam, cx, cy, scaleFactor, orthoScale);
          var pb = project(bx, by, bz, cam, cx, cy, scaleFactor, orthoScale);
          var pc = project(gx, gy, gz, cam, cx, cy, scaleFactor, orthoScale);
          if (!pa || !pb || !pc) continue;

          var minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
          var maxX = Math.min(w - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
          var minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
          var maxY = Math.min(h - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
          if (minX > maxX || minY > maxY) continue;

          var area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
          if (Math.abs(area) < 1e-9) continue;
          var inv = 1 / area;

          var lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
          var fill = Math.max(0, nx * FILL[0] + ny * FILL[1] + nz * FILL[2]);
          var shade = 0.36 + 0.56 * lambert + 0.16 * fill;
          if (shade > 1.1) shade = 1.1;
          var cr = Math.min(255, color[0] * shade);
          var cg = Math.min(255, color[1] * shade);
          var cb = Math.min(255, color[2] * shade);

          for (var y = minY; y <= maxY; y++) {
            var py = y + 0.5;
            var row = y * w;
            for (var x = minX; x <= maxX; x++) {
              var px = x + 0.5;
              var w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) * inv;
              if (w0 < 0) continue;
              var w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) * inv;
              if (w1 < 0) continue;
              var w2 = 1 - w0 - w1;
              if (w2 < 0) continue;

              var z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
              var index = row + x;
              if (z >= depth[index]) continue;
              depth[index] = z;

              var offset = index * 4;
              data[offset] = cr;
              data[offset + 1] = cg;
              data[offset + 2] = cb;
              data[offset + 3] = 255;
            }
          }
        }
      });

      if (opts && opts.grid) paintGrid(data, depth, w, h, cam, cx, cy, scaleFactor, orthoScale);
      if (opts && opts.axes) paintAxes(data, w, h, cam);
    }

    function paintBackground(data, w, h) {
      for (var y = 0; y < h; y++) {
        var t = y / Math.max(1, h - 1);
        var r = Math.round(back[0] + (back2[0] - back[0]) * t);
        var g = Math.round(back[1] + (back2[1] - back[1]) * t);
        var b = Math.round(back[2] + (back2[2] - back[2]) * t);
        for (var x = 0; x < w; x++) {
          var i = (y * w + x) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
      }
    }

    function project(x, y, z, cam, cx, cy, perspectiveScale, orthoScale) {
      var dx = x - cam.eye[0];
      var dy = y - cam.eye[1];
      var dz = z - cam.eye[2];
      var depthValue = dx * cam.basis.forward[0] + dy * cam.basis.forward[1] + dz * cam.basis.forward[2];
      var rx = dx * cam.basis.right[0] + dy * cam.basis.right[1] + dz * cam.basis.right[2];
      var ry = dx * cam.basis.up[0] + dy * cam.basis.up[1] + dz * cam.basis.up[2];

      if (cam.ortho) {
        return [cx + rx * orthoScale, cy - ry * orthoScale, depthValue];
      }
      if (depthValue < 0.05) return null;
      return [cx + rx / depthValue * perspectiveScale, cy - ry / depthValue * perspectiveScale, depthValue];
    }

    function paintGrid(data, depth, w, h, cam, cx, cy, perspectiveScale, orthoScale) {
      var extent = Math.max(60, Math.ceil(Math.max(bbox.size[0], bbox.size[1]) / 2 / 10) * 10 + 30);
      if (extent > 600) extent = 600;
      var step = 10;
      var zBase = 0;

      function plot(wx, wy, shade) {
        var p = project(wx, wy, zBase, cam, cx, cy, perspectiveScale, orthoScale);
        if (!p) return;
        var x = Math.round(p[0]);
        var y = Math.round(p[1]);
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        var index = y * w + x;
        if (p[2] > depth[index] - 0.02) return;
        var offset = index * 4;
        var c = shade;
        data[offset] = Math.round(data[offset] * 0.35 + c[0] * 0.65);
        data[offset + 1] = Math.round(data[offset + 1] * 0.35 + c[1] * 0.65);
        data[offset + 2] = Math.round(data[offset + 2] * 0.35 + c[2] * 0.65);
      }

      var minor = [188, 196, 212];
      var major = [158, 169, 190];
      for (var g = -extent; g <= extent; g += step) {
        var color = (g % 50 === 0) ? major : minor;
        for (var t = -extent; t <= extent; t += 0.9) {
          plot(g, t, color);
          plot(t, g, color);
        }
      }
    }

    function paintAxes(data, w, h, cam) {
      var len = 26;
      var p0 = [34, 34, 0];
      var axes = [
        { dir: [1, 0, 0], color: [220, 80, 80] },
        { dir: [0, 1, 0], color: [70, 160, 90] },
        { dir: [0, 0, 1], color: [80, 110, 220] }
      ];
      axes.forEach(function (axis) {
        var dx = axis.dir[0] * cam.basis.right[0] + axis.dir[1] * cam.basis.right[1] + axis.dir[2] * cam.basis.right[2];
        var dy = axis.dir[0] * cam.basis.up[0] + axis.dir[1] * cam.basis.up[1] + axis.dir[2] * cam.basis.up[2];
        setPixel(data, w, h, p0[0], p0[1], [140, 146, 158]);
        for (var i = 1; i <= len; i++) {
          setPixel(data, w, h, p0[0] + dx * i, p0[1] - dy * i, axis.color);
        }
      });
    }

    function setPixel(data, w, h, x, y, color) {
      var ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
      var offset = (iy * w + ix) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }

    // -----------------------------------------------------------------------
    // captura (usada pelo agente)
    // -----------------------------------------------------------------------

    var snap = null;
    var snapCtx = null;

    function snapshot(names, opts) {
      opts = opts || {};
      var w = Math.max(160, Math.round(opts.width || 480));
      var h = Math.max(120, Math.round(opts.height || 360));
      if (!snap) {
        snap = document.createElement('canvas');
        snapCtx = snap.getContext('2d', { alpha: false });
      }
      snap.width = w;
      snap.height = h;

      var saved = { yaw: view.yaw, pitch: view.pitch, ortho: view.ortho, zoom: view.zoom };
      var savedFit = { distance: view.fitDistance, orthoScale: view.orthoScale };
      var list = names && names.length ? names : ['perspective', 'top', 'front', 'right', 'bottom'];
      var out = [];

      list.forEach(function (name) {
        var preset = VIEWS[name] || VIEWS.perspective;
        view.yaw = preset.yaw;
        view.pitch = preset.pitch;
        view.ortho = preset.ortho;
        view.zoom = 1;
        view.fitDistance = requiredDistance(w, h);
        view.orthoScale = requiredOrthoScale(w, h);
        var cam = camera();
        var image = snapCtx.createImageData(w, h);
        var depth = new Float32Array(w * h);
        paintScene(image, depth, w, h, cam, { grid: !!opts.grid, axes: false });
        snapCtx.putImageData(image, 0, 0);
        out.push({
          view: name,
          width: w,
          height: h,
          dataUrl: snap.toDataURL('image/jpeg', opts.quality || 0.74)
        });
      });

      view.yaw = saved.yaw;
      view.pitch = saved.pitch;
      view.ortho = saved.ortho;
      view.zoom = saved.zoom;
      view.fitDistance = savedFit.distance;
      view.orthoScale = savedFit.orthoScale;
      return out;
    }

    // -----------------------------------------------------------------------
    // interação
    // -----------------------------------------------------------------------

    var dragging = false;
    var lastX = 0;
    var lastY = 0;

    canvas.addEventListener('pointerdown', function (event) {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* ignora */ }
    });

    canvas.addEventListener('pointermove', function (event) {
      if (!dragging) return;
      var dx = event.clientX - lastX;
      var dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      view.yaw -= dx * 0.008;
      view.pitch += dy * 0.008;
      var limit = Math.PI / 2 - 0.02;
      if (view.ortho) {
        // ao arrastar numa vista ortográfica, volta para a perspectiva
        view.ortho = false;
        updateFraming();
      }
      if (view.pitch > limit) view.pitch = limit;
      if (view.pitch < -limit) view.pitch = -limit;
      schedule();
    });

    function endDrag() { dragging = false; }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', function () { if (dragging) endDrag(); });

    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      view.zoom *= Math.exp(event.deltaY * 0.0012);
      view.zoom = Math.max(0.25, Math.min(4, view.zoom));
      schedule();
    }, { passive: false });

    canvas.addEventListener('dblclick', resetView);

    window.addEventListener('resize', function () {
      resize();
      updateFraming();
      schedule();
    });

    resize();

    return {
      setModel: setModel,
      setView: setView,
      resetView: resetView,
      snapshot: snapshot,
      redraw: schedule,
      getView: function () { return view; },
      getParts: function () { return parts; },
      debug: function () {
        return { view: view, bbox: bbox, camera: camera(), width: width, height: height };
      }
    };
  }

  // -------------------------------------------------------------------------

  function normalize(v) {
    var len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function hexToRgb(hex) {
    var value = String(hex || '').replace('#', '');
    if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    var number = parseInt(value, 16);
    if (!isFinite(number)) return [91, 108, 255];
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }

  return { create: create, VIEWS: Object.keys(VIEWS) };
});
