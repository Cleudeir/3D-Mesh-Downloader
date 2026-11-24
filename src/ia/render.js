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
    // Rascunho do LLaMA-Mesh: contorno atrás do modelo, nunca entra no STL.
    var reference = [];
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
    // Durante o arraste/zoom a cena é desenhada numa resolução menor e
    // ampliada; ao soltar, volta a desenhar em cheio. Malhas densas (centenas
    // de milhares de triângulos) continuam respondendo ao mouse.
    var liveImage = null;
    var liveDepth = null;
    var liveWidth = 0;
    var liveHeight = 0;
    var quality = 1;
    var qualityScale = 0.55;
    var qualityTimer = 0;
    var lowResCanvas = null;
    var lowResCtx = null;
    var back = [244, 246, 250];
    var back2 = [232, 236, 244];

    if (options.background) {
      back = options.background[0];
      back2 = options.background[1];
    }

    function countTriangles() {
      triangleCount = 0;
      parts.forEach(function (part) { triangleCount += part.positions.length / 9; });
      reference.forEach(function (part) { triangleCount += part.positions.length / 9; });
    }

    function setModel(nextParts) {
      parts = (nextParts || []).filter(function (p) { return p && p.positions && p.positions.length; });
      countTriangles();
      if (quality !== 1) {
        quality = 1;
        if (qualityTimer) {
          window.clearTimeout(qualityTimer);
          qualityTimer = 0;
        }
      }
      resize();
      fit();
      schedule();
    }

    function setReference(nextParts) {
      reference = (nextParts || []).filter(function (p) {
        return p && ((p.positions && p.positions.length) || (p.points && p.points.length));
      });
      countTriangles();
      fit();
      schedule();
    }

    function fit() {
      var min = [Infinity, Infinity, Infinity];
      var max = [-Infinity, -Infinity, -Infinity];
      parts.concat(reference).forEach(function (part) {
        var p = part.positions || part.points;
        if (!p) return;
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
        liveImage = null;
        liveDepth = null;
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

    function lowerQuality() {
      if (triangleCount < 120000) return;
      if (quality !== qualityScale) {
        quality = qualityScale;
        schedule();
      }
      if (qualityTimer) window.clearTimeout(qualityTimer);
      qualityTimer = window.setTimeout(restoreQuality, 220);
    }

    function restoreQuality() {
      if (qualityTimer) {
        window.clearTimeout(qualityTimer);
        qualityTimer = 0;
      }
      if (quality === 1) return;
      quality = 1;
      schedule();
    }

    function drawLive() {
      if (!width || !height) resize();
      var w = Math.max(1, Math.round(width * quality));
      var h = Math.max(1, Math.round(height * quality));
      if (!liveImage || liveWidth !== w || liveHeight !== h) {
        liveWidth = w;
        liveHeight = h;
        liveImage = ctx.createImageData(w, h);
        liveDepth = new Float32Array(w * h);
      }
      paintScene(liveImage, liveDepth, w, h, camera(), {
        grid: showGrid,
        axes: showAxes,
        reference: true
      });
      if (w === width && h === height) {
        ctx.putImageData(liveImage, 0, 0);
        return;
      }
      if (!lowResCanvas) {
        lowResCanvas = document.createElement('canvas');
        lowResCtx = lowResCanvas.getContext('2d');
      }
      if (lowResCanvas.width !== w || lowResCanvas.height !== h) {
        lowResCanvas.width = w;
        lowResCanvas.height = h;
      }
      lowResCtx.putImageData(liveImage, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(lowResCanvas, 0, 0, w, h, 0, 0, width, height);
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
      var ortho = cam.ortho;

      // Base da câmera em variáveis locais: o laço de triângulos não cria
      // arrays nem objetos por triângulo.
      var fx = cam.basis.forward[0], fy = cam.basis.forward[1], fz = cam.basis.forward[2];
      var rx = cam.basis.right[0], ry = cam.basis.right[1], rz = cam.basis.right[2];
      var ux = cam.basis.up[0], uy = cam.basis.up[1], uz = cam.basis.up[2];
      var ex = cam.eye[0], ey = cam.eye[1], ez = cam.eye[2];
      var pa = [0, 0, 0], pb = [0, 0, 0], pc = [0, 0, 0];

      function projectInto(x, y, z, out) {
        var dx = x - ex, dy = y - ey, dz = z - ez;
        var depthValue = dx * fx + dy * fy + dz * fz;
        var right = dx * rx + dy * ry + dz * rz;
        var up = dx * ux + dy * uy + dz * uz;
        if (ortho) {
          out[0] = cx + right * orthoScale;
          out[1] = cy - up * orthoScale;
          out[2] = depthValue;
          out[3] = 1;
        } else if (depthValue < 0.05) {
          out[3] = 0;
        } else {
          out[0] = cx + right / depthValue * scaleFactor;
          out[1] = cy - up / depthValue * scaleFactor;
          out[2] = depthValue;
          out[3] = 1;
        }
      }

      // O rascunho é um contorno atrás do modelo: desenha antes e não escreve
      // no z-buffer, então as peças paramétricas sempre ficam na frente dele.
      if (opts && opts.reference) {
        paintReference(data, w, h, cam, cx, cy, scaleFactor, orthoScale);
      }

      parts.forEach(function (part) {
        var color = hexToRgb(part.color || '#5b6cff');
        var positions = part.positions;

        for (var i = 0; i < positions.length; i += 9) {
          var ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
          var bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
          var gx = positions[i + 6], gy = positions[i + 7], gz = positions[i + 8];

          var vx = bx - ax, vy = by - ay, vz = bz - az;
          var wx = gx - ax, wy = gy - ay, wz = gz - az;
          var nx = vy * wz - vz * wy;
          var ny = vz * wx - vx * wz;
          var nz = vx * wy - vy * wx;
          var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nlen < 1e-10) continue;
          nx /= nlen; ny /= nlen; nz /= nlen;

          if (ortho) {
            if (nx * fx + ny * fy + nz * fz > 0) continue;
          } else {
            var dx0 = ax - ex, dy0 = ay - ey, dz0 = az - ez;
            if (nx * dx0 + ny * dy0 + nz * dz0 > 0) continue;
          }

          projectInto(ax, ay, az, pa);
          projectInto(bx, by, bz, pb);
          projectInto(gx, gy, gz, pc);
          if (!pa[3] || !pb[3] || !pc[3]) continue;

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

    function paintReference(data, w, h, cam, cx, cy, scaleFactor, orthoScale) {
      reference.forEach(function (part) {
        var color = hexToRgb(part.color || '#6f5cff');

        // Antes das faces, o LLaMA-Mesh só emitiu vértices: mostra a nuvem
        // de pontos para o rascunho não ficar invisível durante o streaming.
        if (part.points && part.points.length) {
          var points = part.points;
          for (var pi = 0; pi < points.length; pi += 3) {
            var pp = project(points[pi], points[pi + 1], points[pi + 2],
              cam, cx, cy, scaleFactor, orthoScale);
            if (!pp) continue;
            var px = Math.round(pp[0]);
            var py = Math.round(pp[1]);
            blend(data, w, h, px, py, color, 0.8);
            blend(data, w, h, px + 1, py, color, 0.45);
            blend(data, w, h, px, py + 1, color, 0.45);
          }
        }

        var positions = part.positions;
        if (!positions || !positions.length) return;
        for (var i = 0; i < positions.length; i += 9) {
          var pa = project(positions[i], positions[i + 1], positions[i + 2],
            cam, cx, cy, scaleFactor, orthoScale);
          var pb = project(positions[i + 3], positions[i + 4], positions[i + 5],
            cam, cx, cy, scaleFactor, orthoScale);
          var pc = project(positions[i + 6], positions[i + 7], positions[i + 8],
            cam, cx, cy, scaleFactor, orthoScale);
          if (!pa || !pb || !pc) continue;
          line(data, w, h, pa[0], pa[1], pb[0], pb[1], color, 0.42);
          line(data, w, h, pb[0], pb[1], pc[0], pc[1], color, 0.42);
          line(data, w, h, pc[0], pc[1], pa[0], pa[1], color, 0.42);
        }
      });
    }

    function line(data, w, h, x0, y0, x1, y1, color, alpha) {
      var dx = x1 - x0;
      var dy = y1 - y0;
      var steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
      for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        blend(data, w, h, Math.round(x0 + dx * t), Math.round(y0 + dy * t), color, alpha);
      }
    }

    function blend(data, w, h, x, y, color, alpha) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      var offset = (y * w + x) * 4;
      data[offset] = Math.round(data[offset] * (1 - alpha) + color[0] * alpha);
      data[offset + 1] = Math.round(data[offset + 1] * (1 - alpha) + color[1] * alpha);
      data[offset + 2] = Math.round(data[offset + 2] * (1 - alpha) + color[2] * alpha);
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
        paintScene(image, depth, w, h, cam, {
          grid: !!opts.grid,
          axes: false,
          reference: !!opts.reference
        });
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
      lowerQuality();
      schedule();
    });

    function endDrag() {
      dragging = false;
      restoreQuality();
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', function () { if (dragging) endDrag(); });

    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      view.zoom *= Math.exp(event.deltaY * 0.0012);
      view.zoom = Math.max(0.25, Math.min(4, view.zoom));
      lowerQuality();
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
      setReference: setReference,
      setView: setView,
      resetView: resetView,
      snapshot: snapshot,
      redraw: schedule,
      getView: function () { return view; },
      getParts: function () { return parts; },
      getReference: function () { return reference; },
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
