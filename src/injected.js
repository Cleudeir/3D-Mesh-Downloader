/**
 * 3D Mesh Downloader - injected.js
 *
 * Runs in the page MAIN world (document_start) so it can reach three.js internals.
 * Responsibilities:
 *   1. Hook three.js so we can capture the Scene(s) being rendered.
 *   2. Walk the scene graph and rebuild the geometry as a Wavefront .OBJ (+ .mtl).
 *
 * Hook strategy (three.js is captured on every build layout we know of):
 *   A. `window.__THREE_DEVTOOLS__` - three.js dispatches an 'observe' CustomEvent:
 *        - detail = Scene     (every release we tested, r150 -> r181)
 *        - detail = Renderer  (WebGLRenderer constructor)
 *      We install an accessor so a page that later defines its own
 *      __THREE_DEVTOOLS__ cannot silently steal the hook.
 *   B. `renderer.render(scene, camera)` - patched on the instance (renderer) and on
 *      `THREE.WebGLRenderer.prototype` (UMD builds that expose a global THREE).
 *      This is the safety net for builds/frameworks that never dispatch 'observe'.
 *
 * No dependency on the three.js namespace: every matrix operation below is
 * implemented from scratch so the script works with any three.js version.
 */
(function () {
  'use strict';

  var VERSION = '2.0.0';
  var INSTALL_FLAG = '__THREE_MESH_DOWNLOADER_INSTALLED__';

  // Guard against double injection (content script + manual run).
  if (window[INSTALL_FLAG]) return;
  window[INSTALL_FLAG] = true;

  /** Captured scenes: Map<Scene, { name: string }> */
  var scenes = new Map();
  /** Renderers whose `render` we already patched. */
  var patchedRenderers = new WeakSet();
  /** Prototypes already patched (per constructor). */
  var patchedPrototypes = new WeakSet();

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function isScene(obj) {
    return !!obj && obj.isScene === true;
  }

  function isRenderer(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.isWebGLRenderer === true || obj.isWebGPURenderer === true) return true;
    // Duck typing: anything that renders and owns a canvas.
    return typeof obj.render === 'function' && !!obj.domElement;
  }

  function sanitizeName(name, fallback) {
    var out = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    if (!out) out = fallback || 'mesh';
    if (out.length > 80) out = out.slice(0, 80);
    return out;
  }

  function uniqueName(name, used) {
    var candidate = name;
    var n = 1;
    while (used.has(candidate)) {
      candidate = name + '_' + n;
      n++;
    }
    used.add(candidate);
    return candidate;
  }

  /** Reads one component of a (possibly interleaved) buffer attribute. */
  function getComponent(attr, index, component) {
    if (typeof attr.getComponent === 'function') {
      try {
        return attr.getComponent(index, component);
      } catch (e) {
        /* fall through */
      }
    }
    switch (component) {
      case 0: return attr.getX(index);
      case 1: return attr.getY(index);
      case 2: return attr.getZ(index);
      default: return attr.getW(index);
    }
  }

  // ---------------------------------------------------------------------------
  // Matrix math (column-major, same layout as three.js Matrix4.elements)
  // ---------------------------------------------------------------------------

  var IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  /** result = a * b (three.js `multiplyMatrices` semantics). */
  function multiplyMatrices(a, b) {
    var te = new Array(16);
    var a11 = a[0], a12 = a[4], a13 = a[8], a14 = a[12];
    var a21 = a[1], a22 = a[5], a23 = a[9], a24 = a[13];
    var a31 = a[2], a32 = a[6], a33 = a[10], a34 = a[14];
    var a41 = a[3], a42 = a[7], a43 = a[11], a44 = a[15];
    var b11 = b[0], b12 = b[4], b13 = b[8], b14 = b[12];
    var b21 = b[1], b22 = b[5], b23 = b[9], b24 = b[13];
    var b31 = b[2], b32 = b[6], b33 = b[10], b34 = b[14];
    var b41 = b[3], b42 = b[7], b43 = b[11], b44 = b[15];

    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;

    return te;
  }

  /** Applies a 4x4 matrix to a point, with perspective divide. */
  function applyMatrix4(e, x, y, z) {
    var w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    return [
      (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
      (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
      (e[2] * x + e[6] * y + e[10] * z + e[14]) * w
    ];
  }

  /**
   * Normal matrix = transpose(inverse(upper-left 3x3)), column-major 3x3.
   * Returns null when the matrix is not invertible.
   */
  function normalMatrixFrom(e) {
    var m = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
    var n11 = m[0], n21 = m[1], n31 = m[2];
    var n12 = m[3], n22 = m[4], n32 = m[5];
    var n13 = m[6], n23 = m[7], n33 = m[8];

    var t11 = n33 * n22 - n32 * n23;
    var t12 = n32 * n13 - n33 * n12;
    var t13 = n23 * n12 - n22 * n13;
    var det = n11 * t11 + n21 * t12 + n31 * t13;

    if (!det || !isFinite(det)) return null;
    var id = 1 / det;

    var inv = [
      t11 * id,
      (n31 * n23 - n33 * n21) * id,
      (n32 * n21 - n31 * n22) * id,
      t12 * id,
      (n33 * n11 - n31 * n13) * id,
      (n31 * n12 - n32 * n11) * id,
      t13 * id,
      (n21 * n13 - n23 * n11) * id,
      (n22 * n11 - n21 * n12) * id
    ];

    // transpose (column-major)
    return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
  }

  function applyNormalMatrix(m, x, y, z) {
    var nx = m[0] * x + m[3] * y + m[6] * z;
    var ny = m[1] * x + m[4] * y + m[7] * z;
    var nz = m[2] * x + m[5] * y + m[8] * z;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!len || !isFinite(len)) return [0, 0, 0];
    return [nx / len, ny / len, nz / len];
  }

  // ---------------------------------------------------------------------------
  // three.js hooks
  // ---------------------------------------------------------------------------

  function captureScene(scene) {
    if (!scene || typeof scene !== 'object') return false;
    if (scenes.has(scene)) return false;
    var name = (scene.name && String(scene.name).trim()) || 'Scene';
    scenes.set(scene, { name: name });
    console.debug('[3D Mesh Downloader] scene captured:', name);
    return true;
  }

  function patchRenderer(renderer) {
    if (!renderer || patchedRenderers.has(renderer)) return;
    patchedRenderers.add(renderer);
    ['render', 'renderAsync'].forEach(function (fn) {
      var original = renderer[fn];
      if (typeof original !== 'function') return;
      renderer[fn] = function (scene) {
        try {
          captureScene(scene);
        } catch (e) {
          /* never break the page */
        }
        return original.apply(this, arguments);
      };
    });
  }

  function patchThreeNamespace(ns) {
    if (!ns) return false;
    var ctor = ns.WebGLRenderer;
    if (!ctor || !ctor.prototype) return false;
    var proto = ctor.prototype;
    if (patchedPrototypes.has(proto)) return true;
    patchedPrototypes.add(proto);

    var original = proto.render;
    if (typeof original === 'function') {
      proto.render = function (scene) {
        try {
          captureScene(scene);
        } catch (e) {
          /* never break the page */
        }
        return original.apply(this, arguments);
      };
    }
    return true;
  }

  function onObserve(event) {
    var detail = event && event.detail;
    if (!detail) return;
    if (isScene(detail)) {
      captureScene(detail);
      return;
    }
    if (isRenderer(detail)) {
      patchRenderer(detail);
    }
  }

  /** Installs the __THREE_DEVTOOLS__ hook as a non-clobberable accessor. */
  function installDevToolsHook() {
    var own = new EventTarget();
    var foreign = null;

    function attach(target) {
      if (!target || typeof target.addEventListener !== 'function') return;
      try {
        if (target.__threeMeshDownloaderHooked) return;
        target.__threeMeshDownloaderHooked = true;
      } catch (e) {
        /* frozen object: still attach, we simply cannot mark it */
      }
      target.addEventListener('observe', onObserve);
      // Older three.js releases dispatched a 'render' event carrying the scene.
      target.addEventListener('render', onObserve);
    }

    attach(own);
    attach(window.__THREE_DEVTOOLS__);

    try {
      Object.defineProperty(window, '__THREE_DEVTOOLS__', {
        configurable: true,
        enumerable: false,
        get: function () {
          return foreign || own;
        },
        set: function (value) {
          foreign = value;
          attach(value);
        }
      });
    } catch (e) {
      try {
        window.__THREE_DEVTOOLS__ = own;
      } catch (e2) {
        /* give up on hook A */
      }
    }
  }

  /** Installs the global THREE namespace hook (UMD builds). */
  function installThreeNamespaceHook() {
    var threeNs = window.THREE;
    patchThreeNamespace(threeNs);

    try {
      Object.defineProperty(window, 'THREE', {
        configurable: true,
        enumerable: true,
        get: function () {
          return threeNs;
        },
        set: function (value) {
          threeNs = value;
          patchThreeNamespace(value);
        }
      });
    } catch (e) {
      /* ignore */
    }

    // A page may define `var THREE = ...` which replaces the accessor with a plain
    // data property. Re-check for a short while so we do not lose the hook.
    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      patchThreeNamespace(window.THREE);
      if (attempts >= 30) clearInterval(timer);
    }, 500);
  }

  // ---------------------------------------------------------------------------
  // Scene graph traversal
  // ---------------------------------------------------------------------------

  function collectMeshes(scene) {
    var out = [];
    if (!scene) return out;

    if (typeof scene.traverse === 'function') {
      try {
        scene.traverse(function (object) {
          if (object && object.isMesh && object.geometry) out.push(object);
        });
        return out;
      } catch (e) {
        /* fall back to manual walk */
      }
    }

    (function walk(object) {
      if (!object) return;
      if (object.isMesh && object.geometry) out.push(object);
      var children = object.children;
      if (children && children.length) {
        for (var i = 0; i < children.length; i++) walk(children[i]);
      }
    })(scene);

    return out;
  }

  // ---------------------------------------------------------------------------
  // Geometry extraction
  // ---------------------------------------------------------------------------

  /** Reads the world matrix of an object, refreshing it when possible. */
  function worldMatrixOf(object) {
    try {
      if (typeof object.updateWorldMatrix === 'function') {
        object.updateWorldMatrix(true, false);
      } else if (typeof object.updateMatrixWorld === 'function') {
        object.updateMatrixWorld(true);
      }
    } catch (e) {
      /* ignore */
    }
    if (object.matrixWorld && object.matrixWorld.elements) return object.matrixWorld.elements;
    return IDENTITY;
  }

  /** Reads the 4x4 matrix of one instance of an InstancedMesh. */
  function instanceMatrixOf(instanced, index) {
    var attr = instanced.instanceMatrix;
    if (!attr) return IDENTITY;
    var out = new Array(16);
    var arr = attr.array;
    if (arr && arr.length >= (index + 1) * 16) {
      for (var i = 0; i < 16; i++) out[i] = arr[index * 16 + i];
      return out;
    }
    // Fallback: reconstruct from the attribute accessors (column-major).
    for (var c = 0; c < 4; c++) {
      out[c * 4 + 0] = getComponent(attr, index, 0);
      out[c * 4 + 1] = getComponent(attr, index, 1);
      out[c * 4 + 2] = getComponent(attr, index, 2);
      out[c * 4 + 3] = getComponent(attr, index, 3);
    }
    return out;
  }

  /**
   * Computes skinned vertex positions for a SkinnedMesh, reproducing the
   * transformation the GPU shader performs:
   *   skinned = sum_i w_i * (B_i * Binv_i) * (bindMatrix * p)
   *   result  = bindMatrixInverse * skinned
   */
  function skinnedPositions(mesh, count) {
    var skeleton = mesh.skeleton;
    var attributes = mesh.geometry.attributes;
    var skinIndex = attributes.skinIndex;
    var skinWeight = attributes.skinWeight;
    var position = attributes.position;

    if (!skeleton || !skeleton.bones || !skeleton.bones.length) return null;
    if (!skeleton.boneInverses || skeleton.boneInverses.length !== skeleton.bones.length) return null;
    if (!skinIndex || !skinWeight || !position) return null;

    var boneMatrices = skeleton.bones.map(function (bone, i) {
      var boneWorld = bone && bone.matrixWorld && bone.matrixWorld.elements ? bone.matrixWorld.elements : IDENTITY;
      var inverse = skeleton.boneInverses[i] && skeleton.boneInverses[i].elements
        ? skeleton.boneInverses[i].elements
        : IDENTITY;
      return multiplyMatrices(boneWorld, inverse);
    });

    var bind = mesh.bindMatrix && mesh.bindMatrix.elements ? mesh.bindMatrix.elements : IDENTITY;
    var bindInverse = mesh.bindMatrixInverse && mesh.bindMatrixInverse.elements
      ? mesh.bindMatrixInverse.elements
      : IDENTITY;

    var out = new Float32Array(count * 3);

    for (var i = 0; i < count; i++) {
      var sv = applyMatrix4(bind, position.getX(i), position.getY(i), position.getZ(i));
      var ax = 0, ay = 0, az = 0;

      for (var j = 0; j < 4; j++) {
        var w = getComponent(skinWeight, i, j);
        if (!w) continue;
        var boneIndex = getComponent(skinIndex, i, j);
        var m = boneMatrices[boneIndex];
        if (!m) continue;
        var t = applyMatrix4(m, sv[0], sv[1], sv[2]);
        ax += w * t[0];
        ay += w * t[1];
        az += w * t[2];
      }

      var p = applyMatrix4(bindInverse, ax, ay, az);
      out[i * 3 + 0] = p[0];
      out[i * 3 + 1] = p[1];
      out[i * 3 + 2] = p[2];
    }

    return out;
  }

  /** Builds the face list of a geometry, honouring groups when present. */
  function buildIndexList(geometry) {
    var index = geometry.index;
    var position = geometry.attributes.position;
    var count = position.count;
    var list;

    if (index) {
      var n = index.count;
      list = new Array(n);
      for (var i = 0; i < n; i++) list[i] = index.getX(i);
    } else {
      list = new Array(count);
      for (var j = 0; j < count; j++) list[j] = j;
    }
    return list;
  }

  /** Splits the index list into { materialIndex, indices } groups. */
  function geometryGroups(geometry, indices) {
    var groups = geometry.groups;
    if (!groups || !groups.length) {
      return [{ materialIndex: 0, indices: indices }];
    }
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var start = group.start || 0;
      var count = group.count === undefined ? indices.length : group.count;
      var slice = indices.slice(start, start + count);
      if (!slice.length) continue;
      out.push({ materialIndex: group.materialIndex || 0, indices: slice });
    }
    return out.length ? out : [{ materialIndex: 0, indices: indices }];
  }

  // ---------------------------------------------------------------------------
  // Materials
  // ---------------------------------------------------------------------------

  function textureUrl(texture) {
    if (!texture) return null;
    try {
      if (texture.source && texture.source.data) {
        if (texture.source.data.src) return texture.source.data.src;
        if (texture.source.data.url) return texture.source.data.url;
      }
      if (texture.image) {
        if (texture.image.src) return texture.image.src;
        if (texture.image.currentSrc) return texture.image.currentSrc;
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /**
   * The diffuse colour as sRGB.
   *
   * three.js stores Material.color in the working (linear) colour space when
   * color management is enabled, but .mtl expects sRGB. getHexString('srgb')
   * does the conversion for us; the manual path is the fallback.
   */
  function materialColorSRGB(material) {
    try {
      if (material.color && typeof material.color.getHexString === 'function') {
        var hex = material.color.getHexString('srgb');
        return [
          parseInt(hex.slice(0, 2), 16) / 255,
          parseInt(hex.slice(2, 4), 16) / 255,
          parseInt(hex.slice(4, 6), 16) / 255
        ];
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (material.color && typeof material.color.r === 'number') {
        return [
          linearToSRGB(material.color.r),
          linearToSRGB(material.color.g),
          linearToSRGB(material.color.b)
        ];
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /** Linear -> sRGB transfer function. */
  function linearToSRGB(c) {
    if (c <= 0.0031308) return c * 12.92;
    return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function describeMaterial(material, index) {
    if (!material) {
      return { name: 'default', color: null, map: null, roughness: null, metalness: null };
    }
    var name = sanitizeName(material.name || 'material_' + (material.id != null ? material.id : index), 'material_' + index);
    return {
      name: name,
      color: materialColorSRGB(material),
      map: textureUrl(material.map),
      roughness: typeof material.roughness === 'number' ? material.roughness : null,
      metalness: typeof material.metalness === 'number' ? material.metalness : null
    };
  }

  function materialsOf(mesh) {
    var material = mesh.material;
    if (Array.isArray(material)) return material;
    if (material) return [material];
    return [null];
  }

  // ---------------------------------------------------------------------------
  // OBJ writer
  // ---------------------------------------------------------------------------

  function fmt(n) {
    if (!isFinite(n)) n = 0;
    // Trim trailing zeros, keep it compact but lossless enough for importers.
    var s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  /**
   * @param {Array} jobs  list of { mesh, worldMatrix, suffix }
   * @param {Object} options
   * @returns {{ obj: string, mtl: string|null, stats: Object }}
   */
  function buildOBJ(jobs, options) {
    var out = [];
    var stats = { meshes: 0, vertices: 0, faces: 0, normals: 0, uvs: 0, materials: 0, skipped: [] };

    out.push('# Wavefront OBJ generated by 3D Mesh Downloader v' + VERSION);
    out.push('# source: ' + (location.hostname || 'unknown'));
    out.push('# exported: ' + new Date().toISOString());
    if (options.applyTransforms === false) {
      out.push('# WARNING: object transforms were NOT applied (local space)');
    }
    out.push('');

    var materialTable = new Map();
    var objectNames = new Set();
    var vOffset = 0, vtOffset = 0, vnOffset = 0;
    var usedMaterials = [];

    for (var j = 0; j < jobs.length; j++) {
      var job = jobs[j];
      var mesh = job.mesh;
      var geometry = mesh.geometry;
      var position = geometry.attributes.position;
      if (!position || !position.count) {
        stats.skipped.push((mesh.name || 'mesh') + ' (sem vertices)');
        continue;
      }

      var count = position.count;
      var world = job.worldMatrix;
      var normalMatrix = normalMatrixFrom(world);

      // --- positions -------------------------------------------------------
      var localPositions = null;
      if (mesh.isSkinnedMesh) {
        localPositions = skinnedPositions(mesh, count);
      }
      if (!localPositions) {
        localPositions = new Float32Array(count * 3);
        for (var p = 0; p < count; p++) {
          localPositions[p * 3 + 0] = position.getX(p);
          localPositions[p * 3 + 1] = position.getY(p);
          localPositions[p * 3 + 2] = position.getZ(p);
        }
      }

      var worldPositions = new Float32Array(count * 3);
      if (options.applyTransforms === false) {
        worldPositions.set(localPositions);
      } else {
        for (var q = 0; q < count; q++) {
          var t = applyMatrix4(world, localPositions[q * 3], localPositions[q * 3 + 1], localPositions[q * 3 + 2]);
          worldPositions[q * 3 + 0] = t[0];
          worldPositions[q * 3 + 1] = t[1];
          worldPositions[q * 3 + 2] = t[2];
        }
      }

      // --- normals ---------------------------------------------------------
      var normalAttr = geometry.attributes.normal;
      var worldNormals = null;
      if (options.normals !== 'none' && normalAttr && normalAttr.count === count) {
        worldNormals = new Float32Array(count * 3);
        for (var n = 0; n < count; n++) {
          var nx = normalAttr.getX(n), ny = normalAttr.getY(n), nz = normalAttr.getZ(n);
          if (options.applyTransforms !== false && normalMatrix) {
            var r = applyNormalMatrix(normalMatrix, nx, ny, nz);
            nx = r[0]; ny = r[1]; nz = r[2];
          }
          worldNormals[n * 3 + 0] = nx;
          worldNormals[n * 3 + 1] = ny;
          worldNormals[n * 3 + 2] = nz;
        }
      }

      // --- uvs -------------------------------------------------------------
      var uvAttr = geometry.attributes.uv;
      var hasUvs = options.uvs !== 'none' && uvAttr && uvAttr.count === count;

      // --- indices ---------------------------------------------------------
      var indices = buildIndexList(geometry);
      var groups = geometryGroups(geometry, indices);

      // Flat shading fallback: when there are no normals we duplicate the
      // vertices per triangle and compute the face normal ourselves.
      var expand = options.normals === 'auto' && !worldNormals;
      if (expand) {
        var expanded = expandTriangles(worldPositions, hasUvs ? uvAttr : null, groups);
        worldPositions = expanded.positions;
        worldNormals = expanded.normals;
        if (hasUvs) {
          uvAttr = expanded.uvs;
          hasUvs = true;
        }
        groups = [{ materialIndex: 0, indices: expanded.indices }];
        count = expanded.positions.length / 3;
      }

      // --- materials -------------------------------------------------------
      var meshMaterials = materialsOf(mesh);
      var objectName = uniqueName(
        sanitizeName(mesh.name || 'mesh', 'mesh') + (job.suffix || ''),
        objectNames
      );

      out.push('o ' + objectName);

      // vertices
      for (var v = 0; v < count; v++) {
        out.push('v ' + fmt(worldPositions[v * 3]) + ' ' + fmt(worldPositions[v * 3 + 1]) + ' ' + fmt(worldPositions[v * 3 + 2]));
      }
      stats.vertices += count;

      // uvs
      if (hasUvs) {
        for (var u = 0; u < count; u++) {
          out.push('vt ' + fmt(uvAttr.getX(u)) + ' ' + fmt(uvAttr.getY(u)));
        }
        stats.uvs += count;
        vtOffset += count;
      }

      // normals
      if (worldNormals) {
        for (var nn = 0; nn < count; nn++) {
          out.push('vn ' + fmt(worldNormals[nn * 3]) + ' ' + fmt(worldNormals[nn * 3 + 1]) + ' ' + fmt(worldNormals[nn * 3 + 2]));
        }
        stats.normals += count;
        vnOffset += count;
      }

      // faces
      for (var g2 = 0; g2 < groups.length; g2++) {
        var group = groups[g2];
        var matIndex = Math.min(group.materialIndex, meshMaterials.length - 1);
        var info = describeMaterial(meshMaterials[matIndex], matIndex);
        if (!materialTable.has(info.name)) {
          materialTable.set(info.name, info);
          usedMaterials.push(info);
        }
        out.push('usemtl ' + info.name);

        var faceIndices = group.indices;
        for (var f = 0; f + 2 < faceIndices.length; f += 3) {
          var parts = [];
          for (var k = 0; k < 3; k++) {
            var idx = faceIndices[f + k] + vOffset + 1;
            var ref = '' + idx;
            if (hasUvs || worldNormals) {
              ref += '/';
              if (hasUvs) ref += (faceIndices[f + k] + vtOffset + 1);
              else ref += '';
              if (worldNormals) ref += '/' + (faceIndices[f + k] + vnOffset + 1);
            }
            parts.push(ref);
          }
          out.push('f ' + parts.join(' '));
          stats.faces++;
        }
      }

      vOffset += count;
      stats.meshes++;
    }

    stats.materials = materialTable.size;

    // --- .mtl --------------------------------------------------------------
    var mtl = null;
    if (options.materials !== 'none' && materialTable.size) {
      mtl = [];
      mtl.push('# Material library generated by 3D Mesh Downloader v' + VERSION);
      mtl.push('');
      for (var mi = 0; mi < usedMaterials.length; mi++) {
        var m = usedMaterials[mi];
        mtl.push('newmtl ' + m.name);
        if (m.color) {
          mtl.push('Kd ' + fmt(m.color[0]) + ' ' + fmt(m.color[1]) + ' ' + fmt(m.color[2]));
        }
        if (m.roughness != null) mtl.push('Pr ' + fmt(m.roughness));
        if (m.metalness != null) mtl.push('Pm ' + fmt(m.metalness));
        if (m.map) mtl.push('map_Kd ' + m.map);
        mtl.push('');
      }
      mtl = mtl.join('\n');
    }

    if (mtl) {
      // insert the mtllib reference right after the header
      out.splice(5, 0, 'mtllib ' + (options.baseName || 'scene') + '.mtl');
    }

    return { obj: out.join('\n') + '\n', mtl: mtl, stats: stats };
  }

  /** Duplicates vertices per triangle and computes flat (face) normals. */
  function expandTriangles(positions, uvAttr, groups) {
    var newPositions = [];
    var newNormals = [];
    var newUvs = [];
    var newIndices = [];

    for (var g = 0; g < groups.length; g++) {
      var indices = groups[g].indices;
      for (var f = 0; f + 2 < indices.length; f += 3) {
        var tri = [indices[f], indices[f + 1], indices[f + 2]];
        var ax = positions[tri[0] * 3], ay = positions[tri[0] * 3 + 1], az = positions[tri[0] * 3 + 2];
        var bx = positions[tri[1] * 3], by = positions[tri[1] * 3 + 1], bz = positions[tri[1] * 3 + 2];
        var cx = positions[tri[2] * 3], cy = positions[tri[2] * 3 + 1], cz = positions[tri[2] * 3 + 2];

        var ux = bx - ax, uy = by - ay, uz = bz - az;
        var vx = cx - ax, vy = cy - ay, vz = cz - az;
        var nx = uy * vz - uz * vy;
        var ny = uz * vx - ux * vz;
        var nz = ux * vy - uy * vx;
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len && isFinite(len)) { nx /= len; ny /= len; nz /= len; } else { nx = ny = nz = 0; }

        for (var t = 0; t < 3; t++) {
          var src = tri[t];
          newPositions.push(positions[src * 3], positions[src * 3 + 1], positions[src * 3 + 2]);
          newNormals.push(nx, ny, nz);
          if (uvAttr) newUvs.push(uvAttr.getX(src), uvAttr.getY(src));
          newIndices.push(newIndices.length);
        }
      }
    }

    var uvs = null;
    if (uvAttr && newUvs.length) {
      uvs = {
        count: newUvs.length / 2,
        getX: function (i) { return newUvs[i * 2]; },
        getY: function (i) { return newUvs[i * 2 + 1]; }
      };
    }

    return {
      positions: new Float32Array(newPositions),
      normals: new Float32Array(newNormals),
      uvs: uvs,
      indices: newIndices
    };
  }

  // ---------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------

  function downloadFile(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    setTimeout(function () {
      try { link.remove(); } catch (e) { /* ignore */ }
      URL.revokeObjectURL(url);
    }, 30000);
  }

  // ---------------------------------------------------------------------------
  // Job building + entry points
  // ---------------------------------------------------------------------------

  function buildJobs(options) {
    var jobs = [];
    var seen = new Set();

    scenes.forEach(function (info, scene) {
      var meshes = collectMeshes(scene);
      meshes.forEach(function (mesh) {
        if (seen.has(mesh)) return;
        seen.add(mesh);

        var baseWorld = worldMatrixOf(mesh);

        if (mesh.isInstancedMesh && options.expandInstances !== false && mesh.instanceMatrix) {
          var total = mesh.instanceMatrix.count || 0;
          for (var i = 0; i < total; i++) {
            jobs.push({
              mesh: mesh,
              worldMatrix: multiplyMatrices(baseWorld, instanceMatrixOf(mesh, i)),
              suffix: '_inst' + i
            });
          }
          return;
        }

        jobs.push({ mesh: mesh, worldMatrix: baseWorld, suffix: '' });
      });
    });

    return jobs;
  }

  function defaultOptions() {
    return {
      applyTransforms: true,
      normals: 'auto',
      uvs: 'on',
      expandInstances: true,
      materials: 'on',
      combine: true
    };
  }

  function mergeOptions(raw) {
    var opts = defaultOptions();
    if (!raw || typeof raw !== 'object') return opts;
    Object.keys(opts).forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined && raw[key] !== null) {
        opts[key] = raw[key];
      }
    });
    return opts;
  }

  function sceneInfo() {
    var list = [];
    var total = 0;
    scenes.forEach(function (info, scene) {
      var meshes = collectMeshes(scene);
      total += meshes.length;
      list.push({
        name: info.name,
        meshes: meshes.length,
        meshNames: meshes.slice(0, 50).map(function (m) { return m.name || '(sem nome)'; })
      });
    });
    return { sceneCount: scenes.size, count: total, scenes: list };
  }

  function runExport(rawOptions) {
    var options = mergeOptions(rawOptions);
    var jobs = buildJobs(options);

    if (!jobs.length) {
      return { ok: false, message: 'Nenhuma malha encontrada nesta pagina.' };
    }

    var baseName = sanitizeName(location.hostname || 'scene', 'scene');
    options.baseName = baseName;

    var files = [];

    if (options.combine !== false) {
      var combined = buildOBJ(jobs, options);
      var objName = baseName + '.obj';
      downloadFile(objName, combined.obj, 'model/obj');
      files.push(objName);

      if (combined.mtl) {
        var mtlName = baseName + '.mtl';
        downloadFile(mtlName, combined.mtl, 'model/mtl');
        files.push(mtlName);
      }

      return {
        ok: true,
        files: files,
        stats: combined.stats,
        message: files.length + ' arquivo(s) gerado(s).'
      };
    }

    // One file per mesh (legacy behaviour).
    var stats = { meshes: 0, vertices: 0, faces: 0, normals: 0, uvs: 0, materials: 0, skipped: [] };
    var usedNames = new Set();
    jobs.forEach(function (job, index) {
      var single = buildOBJ([job], options);
      var name = sanitizeName((job.mesh.name || 'mesh') + (job.suffix || ''), 'mesh');
      name = uniqueName(name, usedNames);
      var fileName = name + '.obj';
      downloadFile(fileName, single.obj, 'model/obj');
      files.push(fileName);
      stats.meshes += single.stats.meshes;
      stats.vertices += single.stats.vertices;
      stats.faces += single.stats.faces;
      stats.normals += single.stats.normals;
      stats.uvs += single.stats.uvs;
    });

    return {
      ok: true,
      files: files,
      stats: stats,
      message: files.length + ' arquivo(s) gerado(s).'
    };
  }

  // ---------------------------------------------------------------------------
  // Page <-> content script bridge
  // ---------------------------------------------------------------------------

  function reply(message) {
    window.postMessage(message, '*');
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'MDL_GET_INFO') {
      var info = sceneInfo();
      reply({ type: 'MDL_INFO', info: info, version: VERSION });
    } else if (data.type === 'MDL_DOWNLOAD') {
      var result;
      try {
        result = runExport(data.options);
      } catch (error) {
        console.error('[3D Mesh Downloader]', error);
        result = { ok: false, message: 'Erro durante a exportacao: ' + (error && error.message ? error.message : error) };
      }
      reply({ type: 'MDL_RESULT', result: result });
    }
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  installDevToolsHook();
  installThreeNamespaceHook();

  console.debug('[3D Mesh Downloader] v' + VERSION + ' ready');
})();
