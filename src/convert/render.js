/**
 * Previa 3D do conversor (WebGL2, sem three.js).
 *
 * Uma malha por peca, cor solida por uniform (o 3MF usa uma cor por peca
 * tambem), normais planas calculadas no fragment shader pelas derivadas -
 * entao nao precisa duplicar vertices nem guardar buffer de normais.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConvertRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FOV = 35 * Math.PI / 180;

  var VERTEX_SRC = [
    '#version 300 es',
    'in vec3 aPos;',
    'uniform mat4 uView;',
    'uniform mat4 uProj;',
    'out vec3 vPos;',
    'void main() {',
    '  vPos = aPos;',
    '  gl_Position = uProj * uView * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  var FRAGMENT_SRC = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vPos;',
    'uniform vec3 uColor;',
    'out vec4 outColor;',
    'void main() {',
    '  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));',
    '  vec3 key = normalize(vec3(0.42, -0.58, 0.78));',
    '  vec3 fill = normalize(vec3(-0.55, 0.35, 0.25));',
    '  float d = abs(dot(n, key));',
    '  float f = abs(dot(n, fill));',
    '  float shade = 0.44 + 0.46 * d + 0.14 * f;',
    '  outColor = vec4(uColor * shade, 1.0);',
    '}'
  ].join('\n');

  function multiply(a, b) {
    var out = new Float32Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  function lookAt(eye, target, up) {
    var zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    var zlen = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
    zx /= zlen; zy /= zlen; zz /= zlen;

    var xx = up[1] * zz - up[2] * zy;
    var xy = up[2] * zx - up[0] * zz;
    var xz = up[0] * zy - up[1] * zx;
    var xlen = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1;
    xx /= xlen; xy /= xlen; xz /= xlen;

    var yx = zy * xz - zz * xy;
    var yy = zz * xx - zx * xz;
    var yz = zx * xy - zy * xx;

    var out = new Float32Array(16);
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('shader: ' + log);
    }
    return shader;
  }

  function create(canvas) {
    var gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) return null;

    var program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(program));
    }

    var aPos = gl.getAttribLocation(program, 'aPos');
    var uView = gl.getUniformLocation(program, 'uView');
    var uProj = gl.getUniformLocation(program, 'uProj');
    var uColor = gl.getUniformLocation(program, 'uColor');

    var meshes = [];
    var view = {
      yaw: -0.9,
      pitch: 0.55,
      zoom: 1,
      center: [0, 0, 0],
      radius: 10,
      distance: 40
    };
    var scheduled = false;
    var disposed = false;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);

    function resize() {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      var height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }

    function schedule() {
      if (scheduled || disposed) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        draw();
      });
    }

    function eyePosition() {
      var dist = view.distance * view.zoom;
      var cp = Math.cos(view.pitch);
      return [
        view.center[0] + cp * Math.cos(view.yaw) * dist,
        view.center[1] + cp * Math.sin(view.yaw) * dist,
        view.center[2] + Math.sin(view.pitch) * dist
      ];
    }

    function draw() {
      if (disposed) return;
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!meshes.length) return;

      var aspect = canvas.width / Math.max(1, canvas.height);
      var near = Math.max(0.05, view.distance * 0.01);
      var far = view.distance * 20 + view.radius * 20;
      var proj = perspective(FOV, aspect, near, far);
      var viewMatrix = lookAt(eyePosition(), view.center, [0, 0, 1]);

      gl.useProgram(program);
      gl.uniformMatrix4fv(uProj, false, proj);
      gl.uniformMatrix4fv(uView, false, viewMatrix);

      meshes.forEach(function (mesh) {
        if (!mesh.count) return;
        gl.bindVertexArray(mesh.vao);
        gl.uniform3f(uColor, mesh.color[0] / 255, mesh.color[1] / 255, mesh.color[2] / 255);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      });
      gl.bindVertexArray(null);
    }

    function clearMeshes() {
      meshes.forEach(function (mesh) {
        gl.deleteVertexArray(mesh.vao);
        gl.deleteBuffer(mesh.buffer);
      });
      meshes = [];
    }

    function setParts(parts) {
      clearMeshes();
      (parts || []).forEach(function (part) {
        var positions = part.positions;
        if (!positions || !positions.length) return;
        var vao = gl.createVertexArray();
        var buffer = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        meshes.push({
          vao: vao,
          buffer: buffer,
          count: positions.length / 3,
          positions: positions,
          color: (part.color || [205, 205, 210]).slice()
        });
      });
      fit();
      schedule();
    }

    function fit() {
      var min = [Infinity, Infinity, Infinity];
      var max = [-Infinity, -Infinity, -Infinity];
      meshes.forEach(function (mesh) {
        var positions = mesh.positions;
        for (var i = 0; i < positions.length; i += 3) {
          for (var k = 0; k < 3; k++) {
            var value = positions[i + k];
            if (value < min[k]) min[k] = value;
            if (value > max[k]) max[k] = value;
          }
        }
      });
      if (!isFinite(min[0])) {
        view.center = [0, 0, 0];
        view.radius = 10;
        view.distance = 40;
        return;
      }
      view.center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      view.radius = Math.max(1, Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
      view.distance = view.radius / Math.sin(FOV / 2) * 1.15;
      view.zoom = 1;
    }

    function setColor(index, color) {
      if (!meshes[index]) return;
      meshes[index].color = [color[0], color[1], color[2]];
      schedule();
    }

    function setView(kind) {
      if (kind === 'top') {
        view.pitch = 1.53;
        view.yaw = -Math.PI / 2;
      } else if (kind === 'front') {
        view.pitch = 0.02;
        view.yaw = -Math.PI / 2;
      } else if (kind === 'side') {
        view.pitch = 0.02;
        view.yaw = 0;
      } else {
        view.pitch = 0.55;
        view.yaw = -0.9;
      }
      view.zoom = 1;
      schedule();
    }

    // --- interacao ---
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
      view.zoom *= Math.exp(event.deltaY * 0.0012);
      view.zoom = Math.max(0.2, Math.min(6, view.zoom));
      schedule();
    }, { passive: false });

    canvas.addEventListener('dblclick', function () {
      fit();
      schedule();
    });

    window.addEventListener('resize', schedule);

    resize();

    return {
      setParts: function (parts) { setParts(parts); },
      setColor: setColor,
      setView: setView,
      reset: function () { fit(); schedule(); },
      redraw: schedule,
      dispose: function () {
        disposed = true;
        clearMeshes();
        gl.getExtension('WEBGL_lose_context') && gl.getExtension('WEBGL_lose_context').loseContext();
      }
    };
  }

  return { create: create };
});
