/**
 * Previa 3D em canvas puro (sem three.js): rasteriza os triangulos com
 * z-buffer, sombreamento plano e orbita com o mouse.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NomesRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create(canvas) {
    var ctx = canvas.getContext('2d', { alpha: false });
    var view = {
      yaw: -0.85,
      pitch: 0.62,
      zoom: 1.18,
      target: [0, 0, 0],
      radius: 10
    };
    var layers = [];
    var width = 0;
    var height = 0;
    var image = null;
    var depth = null;
    var scheduled = false;
    var zoomFactor = 1;

    var LIGHT = normalize([0.35, -0.75, 0.85]);
    var FILL = normalize([-0.6, 0.3, 0.4]);

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width * dpr));
      height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      image = ctx.createImageData(width, height);
      depth = new Float32Array(width * height);
      paintBackground();
    }

    function paintBackground() {
      // leve gradiente vertical
      if (!image) return;
      var data = image.data;
      for (var y = 0; y < height; y++) {
        var t = y / Math.max(1, height - 1);
        var r = Math.round(246 - 12 * t);
        var g = Math.round(247 - 12 * t);
        var b = Math.round(251 - 10 * t);
        for (var x = 0; x < width; x++) {
          var i = (y * width + x) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
      }
    }

    function setScene(scene, options) {
      options = options || {};
      layers = [];
      if (scene.base && scene.base.length) {
        layers.push({ positions: scene.base, color: options.baseColor || [255, 192, 203] });
      }
      if (scene.top && scene.top.length) {
        layers.push({ positions: scene.top, color: options.topColor || [246, 247, 250] });
      }
      fit();
      draw();
    }

    /** Enquadra a cena toda na camera. */
    function fit() {
      var min = [Infinity, Infinity, Infinity];
      var max = [-Infinity, -Infinity, -Infinity];
      layers.forEach(function (layer) {
        for (var i = 0; i < layer.positions.length; i += 3) {
          for (var k = 0; k < 3; k++) {
            var v = layer.positions[i + k];
            if (v < min[k]) min[k] = v;
            if (v > max[k]) max[k] = v;
          }
        }
      });
      if (!isFinite(min[0])) {
        view.target = [0, 0, 0];
        view.radius = 10;
        view.fitDistance = 60;
        return;
      }
      view.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      view.min = min;
      view.max = max;
      var size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
      view.radius = Math.max(4, size / 2);
      view.fitDistance = requiredDistance();
      zoomFactor = 1;
    }

    /**
     * Distancia minima para a caixa da cena caber na tela, olhando na
     * orientacao atual. Projeta os 8 cantos e resolve a desigualdade da
     * projecao perspectiva (sem tentativa e erro).
     */
    function requiredDistance() {
      if (!view.min || !view.max) return 60;
      var basis = orientationBasis();
      var focal = 1 / Math.tan((32 * Math.PI / 180) / 2);
      var scale = focal * (height / 2);
      var needed = 0;

      for (var c = 0; c < 8; c++) {
        var point = [
          (c & 1) ? view.max[0] : view.min[0],
          (c & 2) ? view.max[1] : view.min[1],
          (c & 4) ? view.max[2] : view.min[2]
        ];
        var dx = point[0] - view.target[0];
        var dy = point[1] - view.target[1];
        var dz = point[2] - view.target[2];

        var xr = dx * basis.right[0] + dy * basis.right[1] + dz * basis.right[2];
        var yr = dx * basis.up[0] + dy * basis.up[1] + dz * basis.up[2];
        var zr = dx * basis.forward[0] + dy * basis.forward[1] + dz * basis.forward[2];

        needed = Math.max(needed, 2 * Math.abs(xr) * scale / width - zr);
        needed = Math.max(needed, 2 * Math.abs(yr) * scale / height - zr);
      }

      return Math.max(5, needed * 1.12);
    }

    function orientationBasis() {
      var cp = Math.cos(view.pitch);
      var sp = Math.sin(view.pitch);
      var forward = [-cp * Math.cos(view.yaw), -cp * Math.sin(view.yaw), -sp];
      var right = normalize(cross(forward, [0, 0, 1]));
      var up = cross(right, forward);
      return { forward: forward, right: right, up: up };
    }

    function resetView() {
      view.yaw = -0.85;
      view.pitch = 0.62;
      zoomFactor = 1;
      view.fitDistance = requiredDistance();
      draw();
    }

    function setView(kind) {
      if (kind === 'top') {
        view.pitch = 1.55;
        view.yaw = -Math.PI / 2;
      } else if (kind === 'front') {
        view.pitch = 0.02;
        view.yaw = -Math.PI / 2;
      } else {
        view.yaw = -0.85;
        view.pitch = 0.62;
      }
      zoomFactor = 1;
      view.fitDistance = requiredDistance();
      draw();
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        draw();
      });
    }

    function draw() {
      if (!image) resize();
      paintBackground();
      depth.fill(Infinity);

      var eye = eyePosition();
      var basis = cameraBasis(eye);
      var focal = 1 / Math.tan((32 * Math.PI / 180) / 2);
      var cx = width / 2;
      var cy = height / 2;
      var scale = focal * (height / 2);
      var data = image.data;

      layers.forEach(function (layer) {
        var positions = layer.positions;
        for (var t = 0; t < positions.length; t += 9) {
          var ax = positions[t], ay = positions[t + 1], az = positions[t + 2];
          var bx = positions[t + 3], by = positions[t + 4], bz = positions[t + 5];
          var gx = positions[t + 6], gy = positions[t + 7], gz = positions[t + 8];

          // normal e descarte de face de tras
          var ux = bx - ax, uy = by - ay, uz = bz - az;
          var vx = gx - ax, vy = gy - ay, vz = gz - az;
          var nx = uy * vz - uz * vy;
          var ny = uz * vx - ux * vz;
          var nz = ux * vy - uy * vx;
          var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nlen < 1e-9) continue;
          nx /= nlen; ny /= nlen; nz /= nlen;

          var dx = ax - eye[0], dy = ay - eye[1], dz = az - eye[2];
          if (nx * dx + ny * dy + nz * dz > 0) continue;

          var pa = project(ax, ay, az, eye, basis, scale, cx, cy);
          var pb = project(bx, by, bz, eye, basis, scale, cx, cy);
          var pc = project(gx, gy, gz, eye, basis, scale, cx, cy);
          if (!pa || !pb || !pc) continue;

          var minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
          var maxX = Math.min(width - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
          var minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
          var maxY = Math.min(height - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
          if (minX > maxX || minY > maxY) continue;

          var area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
          if (Math.abs(area) < 1e-9) continue;
          var inv = 1 / area;

          var lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
          var fill = Math.max(0, nx * FILL[0] + ny * FILL[1] + nz * FILL[2]);
          var shade = 0.34 + 0.58 * lambert + 0.18 * fill;
          if (shade > 1.12) shade = 1.12;

          var color = layer.color;
          var cr = Math.min(255, color[0] * shade);
          var cg = Math.min(255, color[1] * shade);
          var cb = Math.min(255, color[2] * shade);

          for (var y = minY; y <= maxY; y++) {
            var py = y + 0.5;
            var row = y * width;
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

      ctx.putImageData(image, 0, 0);
    }

    function eyePosition() {
      var dist = view.fitDistance * view.zoom * zoomFactor;
      var cp = Math.cos(view.pitch);
      return [
        view.target[0] + cp * Math.cos(view.yaw) * dist,
        view.target[1] + cp * Math.sin(view.yaw) * dist,
        view.target[2] + Math.sin(view.pitch) * dist
      ];
    }

    function cameraBasis(eye) {
      var forward = normalize([
        view.target[0] - eye[0],
        view.target[1] - eye[1],
        view.target[2] - eye[2]
      ]);
      var right = normalize(cross(forward, [0, 0, 1]));
      var up = cross(right, forward);
      return { forward: forward, right: right, up: up };
    }

    function project(x, y, z, eye, basis, scale, cx, cy) {
      var dx = x - eye[0];
      var dy = y - eye[1];
      var dz = z - eye[2];
      var depthValue = dx * basis.forward[0] + dy * basis.forward[1] + dz * basis.forward[2];
      if (depthValue < 0.05) return null;
      var sx = cx + (dx * basis.right[0] + dy * basis.right[1] + dz * basis.right[2]) / depthValue * scale;
      var sy = cy - (dx * basis.up[0] + dy * basis.up[1] + dz * basis.up[2]) / depthValue * scale;
      return [sx, sy, depthValue];
    }

    // -------------------------------------------------------------------------
    // interacao
    // -------------------------------------------------------------------------

    var dragging = false;
    var lastX = 0;
    var lastY = 0;

    canvas.addEventListener('pointerdown', function (event) {
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
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
      zoomFactor *= Math.exp(event.deltaY * 0.0012);
      zoomFactor = Math.max(0.25, Math.min(4, zoomFactor));
      schedule();
    }, { passive: false });

    canvas.addEventListener('dblclick', resetView);

    window.addEventListener('resize', function () {
      resize();
      view.fitDistance = requiredDistance();
      schedule();
    });

    resize();

    return {
      setScene: setScene,
      resetView: resetView,
      setView: setView,
      redraw: schedule,
      getView: function () { return view; }
    };
  }

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

  return { create: create };
});
