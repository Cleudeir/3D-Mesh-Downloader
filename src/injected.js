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

  var VERSION = '2.2.0';
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
  // Model descriptors (used by the popup filter)
  // ---------------------------------------------------------------------------

  /**
   * Rough size of the OBJ fragment a mesh would produce, in bytes.
   * Used by the "size" filter, so an estimate is enough - the exact file
   * size is reported after the export.
   */
  /**
   * Estimated size of the file each mesh would produce, per export format.
   * Used by the "size" filter, so an estimate is enough.
   *
   *   obj       - "v"/"vt"/"vn"/"f" lines plus the object headers
   *   stl       - binary STL: 84 byte header + 50 bytes per triangle
   *   stl-ascii - ASCII STL: roughly 70 bytes per triangle
   */
  function estimateModelSize(mesh, vertexCount, faceCount, instances) {
    var hasNormals = !!mesh.geometry.attributes.normal;
    var hasUvs = !!mesh.geometry.attributes.uv;
    var n = instances || 1;

    var obj = vertexCount * 30 + faceCount * 38 + 128;
    if (hasNormals) obj += vertexCount * 30;
    if (hasUvs) obj += vertexCount * 22;

    return {
      obj: Math.round(obj * n),
      stl: Math.round((84 + faceCount * 50) * n),
      'stl-ascii': Math.round((64 + faceCount * 72) * n)
    };
  }

  /** The size a model will take in the given export format. */
  function sizeForFormat(model, format) {
    if (!model.sizes) return model.sizeBytes || 0;
    var key = format === 'stl' || format === 'stl-ascii' ? format : 'obj';
    return model.sizes[key] || model.sizeBytes || 0;
  }

  /** World-space bounding box of a mesh (local bbox corners transformed). */
  function modelBounds(mesh) {
    var position = mesh.geometry.attributes.position;
    if (!position || !position.count) return null;

    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < position.count; i++) {
      var x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    }

    var world = worldMatrixOf(mesh);
    var lo = [Infinity, Infinity, Infinity];
    var hi = [-Infinity, -Infinity, -Infinity];
    for (var c = 0; c < 8; c++) {
      var p = applyMatrix4(
        world,
        (c & 1) ? max[0] : min[0],
        (c & 2) ? max[1] : min[1],
        (c & 4) ? max[2] : min[2]
      );
      for (var a = 0; a < 3; a++) {
        if (p[a] < lo[a]) lo[a] = p[a];
        if (p[a] > hi[a]) hi[a] = p[a];
      }
    }

    return {
      min: lo,
      max: hi,
      size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
      center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
    };
  }

  /** Serializable description of a single mesh found in a scene. */
  function describeModel(mesh, sceneInfo, sceneIndex, meshIndex, exportName) {
    var geometry = mesh.geometry;
    var position = geometry.attributes.position;
    var vertexCount = position ? position.count : 0;
    var index = geometry.index;
    var faceCount = index ? Math.floor(index.count / 3) : Math.floor(vertexCount / 3);
    var instances = mesh.isInstancedMesh && mesh.instanceMatrix ? mesh.instanceMatrix.count : 1;
    if (instances < 1) instances = 1; // InstancedMesh vazio: exporta a malha base
    var materials = [];
    materialsOf(mesh).forEach(function (m, i) { materials.push(describeMaterial(m, i).name); });
    var sizes = estimateModelSize(mesh, vertexCount, faceCount, instances);

    return {
      id: 's' + sceneIndex + '_m' + meshIndex,
      name: mesh.name || ('mesh_' + meshIndex),
      // nome que o modelo recebe no arquivo exportado (pode ganhar sufixo
      // _1, _2... quando varios modelos têm o mesmo nome)
      exportName: exportName || mesh.name || ('mesh_' + meshIndex),
      scene: sceneInfo.name,
      mesh: mesh,
      vertexCount: vertexCount,
      faceCount: faceCount,
      instances: instances,
      materials: materials,
      sizeBytes: sizes.obj,
      sizes: sizes,
      bounds: modelBounds(mesh)
    };
  }

  /** Every mesh found across every captured scene. */
  function collectModels() {
    var models = [];
    var sceneIndex = 0;
    scenes.forEach(function (sceneInfo, scene) {
      var meshes = collectMeshes(scene);
      var used = new Set();
      for (var meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
        var base = sanitizeName(meshes[meshIndex].name || 'mesh', 'mesh');
        models.push(describeModel(meshes[meshIndex], sceneInfo, sceneIndex, meshIndex, uniqueName(base, used)));
      }
      sceneIndex++;
    });
    return models;
  }

  /** Does a model pass the active text/size filter? */
  function matchesFilter(model, filter, format) {
    if (!filter) return true;

    if (filter.text) {
      var needle = String(filter.text).toLowerCase();
      var haystack = (model.name + ' ' + model.scene + ' ' + model.materials.join(' ')).toLowerCase();
      if (haystack.indexOf(needle) === -1) return false;
    }

    var size = sizeForFormat(model, format);

    if (filter.minKB !== null && filter.minKB !== undefined && filter.minKB !== '') {
      if (size < Number(filter.minKB) * 1024) return false;
    }
    if (filter.maxKB !== null && filter.maxKB !== undefined && filter.maxKB !== '') {
      if (size > Number(filter.maxKB) * 1024) return false;
    }

    return true;
  }

  /**
   * Wildcard pattern -> RegExp.
   *   *  any sequence of characters
   *   ?  exactly one character
   * Matching is case insensitive and anchored, so "X_*" matches "X_1" but not
   * "XYZ", and "X*" matches the whole family "X", "X_1", "XYZ"...
   */
  function patternToRegExp(pattern) {
    var escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    escaped = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + escaped + '$', 'i');
  }

  /**
   * The exclusion pattern that matches this model, or null.
   *
   * Casa com tres nomes:
   *   - o nome original da malha            ("X")
   *   - o nome que ela recebe na exportacao  ("X_1")
   *   - o nome de exportacao sem o sufixo    ("X")
   *
   * Assim da para escrever "X*" (a familia inteira), "X_1" (so o segundo) ou
   * "X?" (X seguido de um caractere).
   */
  function exclusionMatch(model, patterns) {
    if (!patterns || !patterns.length) return null;
    var names = [String(model && model.name ? model.name : '')];
    if (model && model.exportName && model.exportName !== model.name) {
      names.push(String(model.exportName));
      var base = String(model.exportName).replace(/_\d+$/, '');
      if (base && base !== model.exportName) names.push(base);
    }
    for (var i = 0; i < patterns.length; i++) {
      var pattern = String(patterns[i] || '').trim();
      if (!pattern) continue;
      var regex;
      try {
        regex = patternToRegExp(pattern);
      } catch (e) {
        continue;
      }
      for (var n = 0; n < names.length; n++) {
        if (regex.test(names[n])) return pattern;
      }
    }
    return null;
  }

  /** Is the model name matched by any exclusion pattern? */
  function isExcluded(model, patterns) {
    return exclusionMatch(model, patterns) !== null;
  }

  /**
   * Exclusao por nome exato (a lista "por tamanho" guarda os nomes concretos
   * que casaram com a regra). Sem curinga: e o nome da malha e pronto.
   */
  function exactExclusion(model, names) {
    if (!names || !names.length) return null;
    var candidates = [String(model && model.name ? model.name : '')];
    if (model && model.exportName) candidates.push(String(model.exportName));

    for (var i = 0; i < names.length; i++) {
      var wanted = String(names[i] || '').trim();
      if (!wanted) continue;
      for (var c = 0; c < candidates.length; c++) {
        if (candidates[c].toLowerCase() === wanted.toLowerCase()) return 'tamanho';
      }
    }
    return null;
  }

  /**
   * Exclusao por tamanho.
   *
   *   { enabled: true, mode: 'above', kb: 50 } -> exclui o que for MAIOR que 50 KB
   *   { enabled: true, mode: 'below', kb: 50 } -> exclui o que for MENOR que 50 KB
   *
   * O tamanho e o estimado para o formato escolhido - o mesmo numero que o
   * popup mostra na lista, entao "50 KB" significa a mesma coisa nos dois.
   */
  function sizeExclusion(model, rule, format) {
    if (!rule || !rule.enabled) return null;
    var kb = Number(rule.kb);
    if (!isFinite(kb) || kb < 0) return null;

    var limit = kb * 1024;
    var size = sizeForFormat(model, format);
    var above = rule.mode !== 'below';

    if (above ? size > limit : size < limit) {
      return 'tamanho ' + (above ? '>' : '<') + ' ' + kb + ' KB';
    }
    return null;
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
  /**
   * Converts one mesh (or one instance of it) into a transportable payload:
   * world-space positions/normals/uvs plus the face list per material.
   */
  function extractModel(job, options) {
    var mesh = job.mesh;
    var geometry = mesh.geometry;
    var position = geometry.attributes.position;
    if (!position || !position.count) return null;

    var count = position.count;
    var world = job.worldMatrix;
    var normalMatrix = normalMatrixFrom(world);

    // --- positions ---------------------------------------------------------
    var local = mesh.isSkinnedMesh ? skinnedPositions(mesh, count) : null;
    if (!local) {
      local = new Float32Array(count * 3);
      for (var p = 0; p < count; p++) {
        local[p * 3] = position.getX(p);
        local[p * 3 + 1] = position.getY(p);
        local[p * 3 + 2] = position.getZ(p);
      }
    }

    var positions = new Float32Array(count * 3);
    if (options.applyTransforms === false) {
      positions.set(local);
    } else {
      for (var q = 0; q < count; q++) {
        var t = applyMatrix4(world, local[q * 3], local[q * 3 + 1], local[q * 3 + 2]);
        positions[q * 3] = t[0];
        positions[q * 3 + 1] = t[1];
        positions[q * 3 + 2] = t[2];
      }
    }

    // --- normals -----------------------------------------------------------
    var normalAttr = geometry.attributes.normal;
    var normals = null;
    if (options.normals !== 'none' && normalAttr && normalAttr.count === count) {
      normals = new Float32Array(count * 3);
      for (var n = 0; n < count; n++) {
        var nx = normalAttr.getX(n), ny = normalAttr.getY(n), nz = normalAttr.getZ(n);
        if (options.applyTransforms !== false && normalMatrix) {
          var r = applyNormalMatrix(normalMatrix, nx, ny, nz);
          nx = r[0]; ny = r[1]; nz = r[2];
        }
        normals[n * 3] = nx;
        normals[n * 3 + 1] = ny;
        normals[n * 3 + 2] = nz;
      }
    }

    // --- uvs ----------------------------------------------------------------
    var uvAttr = geometry.attributes.uv;
    var uvs = null;
    if (options.uvs !== 'none' && uvAttr && uvAttr.count === count) {
      uvs = new Float32Array(count * 2);
      for (var u = 0; u < count; u++) {
        uvs[u * 2] = uvAttr.getX(u);
        uvs[u * 2 + 1] = uvAttr.getY(u);
      }
    }

    // --- faces --------------------------------------------------------------
    var indices = buildIndexList(geometry);
    var groups = geometryGroups(geometry, indices);

    // Flat shading fallback: no normal attribute -> duplicate the vertices
    // per triangle and compute the face normal ourselves.
    if (options.normals === 'auto' && !normals) {
      var expanded = expandTriangles(positions, uvs, groups);
      positions = expanded.positions;
      normals = expanded.normals;
      uvs = expanded.uvs;
      groups = [{ materialIndex: 0, indices: expanded.indices }];
      count = positions.length / 3;
    }

    // --- one part per material ---------------------------------------------
    var meshMaterials = materialsOf(mesh);
    var parts = [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var matIndex = Math.min(group.materialIndex, meshMaterials.length - 1);
      var info = describeMaterial(meshMaterials[matIndex], matIndex);
      var faces = [];
      for (var f = 0; f + 2 < group.indices.length; f += 3) {
        faces.push(group.indices[f], group.indices[f + 1], group.indices[f + 2]);
      }
      parts.push({ material: info, faces: new Int32Array(faces) });
    }

    return {
      name: job.name,
      positions: positions,
      normals: normals,
      uvs: uvs,
      parts: parts,
      vertexCount: count
    };
  }

  /** Builds one face reference: "v", "v/vt", "v//vn" or "v/vt/vn". */
  function faceRef(v, vt, vn) {
    var s = String(v);
    if (vt === null && vn === null) return s;
    if (vt === null) return s + '//' + vn;
    if (vn === null) return s + '/' + vt;
    return s + '/' + vt + '/' + vn;
  }

  /** Appends a model to the OBJ buffer, using the given global offsets. */
  function writeModel(out, model, vOffset, vtOffset, vnOffset) {
    var positions = model.positions;
    var count = model.vertexCount;

    out.push('o ' + model.name);

    for (var v = 0; v < count; v++) {
      out.push('v ' + fmt(positions[v * 3]) + ' ' + fmt(positions[v * 3 + 1]) + ' ' + fmt(positions[v * 3 + 2]));
    }

    if (model.uvs) {
      for (var u = 0; u < count; u++) {
        out.push('vt ' + fmt(model.uvs[u * 2]) + ' ' + fmt(model.uvs[u * 2 + 1]));
      }
    }

    if (model.normals) {
      for (var n = 0; n < count; n++) {
        out.push('vn ' + fmt(model.normals[n * 3]) + ' ' + fmt(model.normals[n * 3 + 1]) + ' ' + fmt(model.normals[n * 3 + 2]));
      }
    }

    for (var p = 0; p < model.parts.length; p++) {
      var part = model.parts[p];
      out.push('usemtl ' + part.material.name);
      var faces = part.faces;
      for (var f = 0; f < faces.length; f += 3) {
        var a = faces[f], b = faces[f + 1], c = faces[f + 2];
        out.push('f ' +
          faceRef(a + vOffset + 1, model.uvs ? a + vtOffset + 1 : null, model.normals ? a + vnOffset + 1 : null) + ' ' +
          faceRef(b + vOffset + 1, model.uvs ? b + vtOffset + 1 : null, model.normals ? b + vnOffset + 1 : null) + ' ' +
          faceRef(c + vOffset + 1, model.uvs ? c + vtOffset + 1 : null, model.normals ? c + vnOffset + 1 : null));
      }
    }
  }

  /**
   * @param {Array} models  list of payloads produced by extractModel()
   * @param {Object} options
   * @returns {{ obj: string, mtl: string|null, stats: Object }}
   */
  function buildOBJ(models, options) {
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
    var usedMaterials = [];
    var vOffset = 0, vtOffset = 0, vnOffset = 0;

    for (var j = 0; j < models.length; j++) {
      var model = models[j];
      if (!model) {
        stats.skipped.push('(modelo vazio)');
        continue;
      }

      writeModel(out, model, vOffset, vtOffset, vnOffset);

      for (var mp = 0; mp < model.parts.length; mp++) {
        var info = model.parts[mp].material;
        if (!materialTable.has(info.name)) {
          materialTable.set(info.name, info);
          usedMaterials.push(info);
        }
      }

      stats.meshes++;
      stats.vertices += model.vertexCount;
      stats.faces += model.parts.reduce(function (acc, part) { return acc + part.faces.length / 3; }, 0);
      if (model.normals) stats.normals += model.vertexCount;
      if (model.uvs) stats.uvs += model.vertexCount;

      vOffset += model.vertexCount;
      if (model.uvs) vtOffset += model.vertexCount;
      if (model.normals) vnOffset += model.vertexCount;
    }

    stats.materials = materialTable.size;

    // --- .mtl --------------------------------------------------------------
    var mtl = null;
    if (options.materials !== 'none' && materialTable.size) {
      var mtlLines = [];
      mtlLines.push('# Material library generated by 3D Mesh Downloader v' + VERSION);
      mtlLines.push('');
      for (var mi = 0; mi < usedMaterials.length; mi++) {
        var m = usedMaterials[mi];
        mtlLines.push('newmtl ' + m.name);
        if (m.color) {
          mtlLines.push('Kd ' + fmt(m.color[0]) + ' ' + fmt(m.color[1]) + ' ' + fmt(m.color[2]));
        }
        if (m.roughness != null) mtlLines.push('Pr ' + fmt(m.roughness));
        if (m.metalness != null) mtlLines.push('Pm ' + fmt(m.metalness));
        if (m.map) mtlLines.push('map_Kd ' + m.map);
        mtlLines.push('');
      }
      mtl = mtlLines.join('\n');
    }

    if (mtl) {
      // insert the mtllib reference right after the header
      out.splice(5, 0, 'mtllib ' + (options.baseName || 'scene') + '.mtl');
    }

    return { obj: out.join('\n') + '\n', mtl: mtl, stats: stats };
  }

  /** Duplicates vertices per triangle and computes flat (face) normals. */
  function expandTriangles(positions, uvData, groups) {
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
          if (uvData) newUvs.push(uvData[src * 2], uvData[src * 2 + 1]);
          newIndices.push(newIndices.length);
        }
      }
    }

    var uvs = null;
    if (uvData && newUvs.length) uvs = new Float32Array(newUvs);

    return {
      positions: new Float32Array(newPositions),
      normals: new Float32Array(newNormals),
      uvs: uvs,
      indices: newIndices
    };
  }
  // ---------------------------------------------------------------------------
  // STL writer
  // ---------------------------------------------------------------------------

  /**
   * Flattens the models into triangles in world space.
   *
   * STL has no notion of objects, materials, UVs or vertex normals: every
   * facet carries a single normal, computed from its own three vertices, and
   * all the meshes are merged into a single soup of triangles.
   *
   * Returns a Float32Array with 12 floats per triangle:
   *   ax ay az | bx by bz | cx cy cz | nx ny nz
   */
  function collectTriangles(models) {
    var count = 0;

    // first pass: how many valid (non degenerate) triangles there are
    for (var m = 0; m < models.length; m++) {
      var model = models[m];
      for (var part = 0; part < model.parts.length; part++) {
        var faces = model.parts[part].faces;
        for (var f = 0; f + 2 < faces.length; f += 3) {
          if (triangleNormal(model.positions, faces[f], faces[f + 1], faces[f + 2])) count++;
        }
      }
    }

    var out = new Float32Array(count * 12);
    var w = 0;

    for (var m2 = 0; m2 < models.length; m2++) {
      var model2 = models[m2];
      var p = model2.positions;
      for (var part2 = 0; part2 < model2.parts.length; part2++) {
        var faces2 = model2.parts[part2].faces;
        for (var f2 = 0; f2 + 2 < faces2.length; f2 += 3) {
          var ia = faces2[f2], ib = faces2[f2 + 1], ic = faces2[f2 + 2];
          var n = triangleNormal(p, ia, ib, ic);
          if (!n) continue;

          out[w++] = p[ia * 3]; out[w++] = p[ia * 3 + 1]; out[w++] = p[ia * 3 + 2];
          out[w++] = p[ib * 3]; out[w++] = p[ib * 3 + 1]; out[w++] = p[ib * 3 + 2];
          out[w++] = p[ic * 3]; out[w++] = p[ic * 3 + 1]; out[w++] = p[ic * 3 + 2];
          out[w++] = n[0]; out[w++] = n[1]; out[w++] = n[2];
        }
      }
    }

    return out;
  }

  /** Facet normal of a triangle, or null when the triangle is degenerate. */
  function triangleNormal(p, ia, ib, ic) {
    var ax = p[ia * 3], ay = p[ia * 3 + 1], az = p[ia * 3 + 2];
    var bx = p[ib * 3], by = p[ib * 3 + 1], bz = p[ib * 3 + 2];
    var cx = p[ic * 3], cy = p[ic * 3 + 1], cz = p[ic * 3 + 2];

    var ux = bx - ax, uy = by - ay, uz = bz - az;
    var vx = cx - ax, vy = cy - ay, vz = cz - az;
    var nx = uy * vz - uz * vy;
    var ny = uz * vx - ux * vz;
    var nz = ux * vy - uy * vx;

    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!len || !isFinite(len)) return null;
    return [nx / len, ny / len, nz / len];
  }

  /** Binary STL: 80 byte header + 4 byte triangle count + 50 bytes per facet. */
  function buildBinarySTL(models) {
    var tris = collectTriangles(models);
    var count = tris.length / 12;

    var buffer = new ArrayBuffer(84 + count * 50);
    var view = new DataView(buffer);

    var header = ('3D Mesh Downloader v' + VERSION + ' - ' + (location.hostname || 'scene')).slice(0, 79);
    for (var i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i) & 0x7f);
    view.setUint32(80, count, true);

    var off = 84;
    for (var t = 0; t < count; t++) {
      var b = t * 12;
      view.setFloat32(off, tris[b + 9], true);
      view.setFloat32(off + 4, tris[b + 10], true);
      view.setFloat32(off + 8, tris[b + 11], true);
      for (var v = 0; v < 3; v++) {
        view.setFloat32(off + 12 + v * 12, tris[b + v * 3], true);
        view.setFloat32(off + 16 + v * 12, tris[b + v * 3 + 1], true);
        view.setFloat32(off + 20 + v * 12, tris[b + v * 3 + 2], true);
      }
      view.setUint16(off + 48, 0, true);
      off += 50;
    }

    return { buffer: buffer, triangles: count };
  }

  /** ASCII STL: readable, but roughly 40% bigger than the binary one. */
  function buildAsciiSTL(models) {
    var tris = collectTriangles(models);
    var count = tris.length / 12;
    var name = sanitizeName(location.hostname || 'scene', 'scene');

    var lines = ['solid ' + name];
    for (var t = 0; t < count; t++) {
      var b = t * 12;
      lines.push('  facet normal ' + fmt(tris[b + 9]) + ' ' + fmt(tris[b + 10]) + ' ' + fmt(tris[b + 11]));
      lines.push('    outer loop');
      for (var v = 0; v < 3; v++) {
        lines.push('      vertex ' + fmt(tris[b + v * 3]) + ' ' + fmt(tris[b + v * 3 + 1]) + ' ' + fmt(tris[b + v * 3 + 2]));
      }
      lines.push('    endloop');
      lines.push('  endfacet');
    }
    lines.push('endsolid ' + name);

    return { text: lines.join('\n') + '\n', triangles: count };
  }
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
    var filter = options.filter || {};
    var include = Array.isArray(filter.include) ? new Set(filter.include) : null;

    collectModels().forEach(function (model) {
      var mesh = model.mesh;

      // explicit selection (the popup checkboxes)
      if (include && !include.has(model.id)) return;
      // exclusion list (the "nao deve ser capturado" patterns)
      if (isExcluded(model, filter.exclude)) return;
      // nomes exatos (lista "por tamanho" materializada)
      if (exactExclusion(model, filter.excludeExact)) return;
      // size rule (o "nao capturar modelos acima/abaixo de N KB")
      if (sizeExclusion(model, filter.excludeSize, options.format)) return;
      // text / size filter
      if (!matchesFilter(model, filter, options.format)) return;

      var baseWorld = worldMatrixOf(mesh);

      if (mesh.isInstancedMesh && options.expandInstances !== false && mesh.instanceMatrix) {
        var total = mesh.instanceMatrix.count || 0;
        // An InstancedMesh with zero instances renders nothing but still holds
        // geometry: export its base mesh instead of dropping it silently.
        if (total > 0) {
          for (var i = 0; i < total; i++) {
            jobs.push({
              mesh: mesh,
              worldMatrix: multiplyMatrices(baseWorld, instanceMatrixOf(mesh, i)),
              suffix: '_inst' + i,
              modelId: model.id
            });
          }
          return;
        }
      }

      jobs.push({ mesh: mesh, worldMatrix: baseWorld, suffix: '', modelId: model.id });
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
      combine: true,
      format: 'obj',
      filter: { text: '', minKB: null, maxKB: null, include: null, exclude: null, excludeExact: null, excludeSize: null }
    };
  }

  function mergeOptions(raw) {
    var opts = defaultOptions();
    if (!raw || typeof raw !== 'object') return opts;

    Object.keys(opts).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
      if (key === 'filter') return; // handled below
      if (raw[key] !== undefined && raw[key] !== null) opts[key] = raw[key];
    });

    if (raw.filter && typeof raw.filter === 'object') {
      var f = raw.filter;
      if (f.text !== undefined && f.text !== null) opts.filter.text = String(f.text);
      if (f.minKB !== undefined && f.minKB !== null && f.minKB !== '') opts.filter.minKB = Number(f.minKB);
      if (f.maxKB !== undefined && f.maxKB !== null && f.maxKB !== '') opts.filter.maxKB = Number(f.maxKB);
      if (Array.isArray(f.include)) opts.filter.include = f.include.slice();
      if (Array.isArray(f.exclude)) {
        opts.filter.exclude = f.exclude
          .map(function (p) { return String(p || '').trim(); })
          .filter(function (p) { return p.length > 0; });
      }
      if (Array.isArray(f.excludeExact)) {
        opts.filter.excludeExact = f.excludeExact
          .map(function (p) { return String(p || '').trim(); })
          .filter(function (p) { return p.length > 0; });
      }
      if (f.excludeSize && typeof f.excludeSize === 'object') {
        var sizeRule = f.excludeSize;
        var kb = Number(sizeRule.kb);
        opts.filter.excludeSize = {
          enabled: sizeRule.enabled !== false,
          mode: sizeRule.mode === 'below' ? 'below' : 'above',
          kb: isFinite(kb) && kb >= 0 ? kb : 50
        };
      }
    }

    if (raw.format === 'stl' || raw.format === 'stl-ascii' || raw.format === 'obj') {
      opts.format = raw.format;
    }

    return opts;
  }

  function sceneInfo(excludePatterns, excludeSize, format, excludeExact) {
    var list = [];
    var models = collectModels();

    scenes.forEach(function (info, scene) {
      var meshes = collectMeshes(scene);
      list.push({
        name: info.name,
        meshes: meshes.length,
        meshNames: meshes.slice(0, 50).map(function (m) { return m.name || '(sem nome)'; })
      });
    });

    // only plain data goes through postMessage (structured clone)
    var excludedCount = 0;
    var modelList = models.map(function (m) {
      var excludedBy = exclusionMatch(m, excludePatterns) ||
        exactExclusion(m, excludeExact) ||
        sizeExclusion(m, excludeSize, format);
      if (excludedBy) excludedCount++;
      return {
        id: m.id,
        name: m.name,
        exportName: m.exportName,
        scene: m.scene,
        vertexCount: m.vertexCount,
        faceCount: m.faceCount,
        instances: m.instances,
        materials: m.materials,
        sizeBytes: m.sizeBytes,
        sizes: m.sizes,
        excluded: !!excludedBy,
        excludedBy: excludedBy || null,
        bounds: m.bounds
      };
    });

    return {
      sceneCount: scenes.size,
      count: models.length,
      excludedCount: excludedCount,
      exportableCount: models.length - excludedCount,
      scenes: list,
      models: modelList,
      totalSizeBytes: modelList.reduce(function (acc, m) { return acc + m.sizeBytes; }, 0)
    };
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

    // Extract every job into a payload once, so the combined and the
    // per-mesh modes share the exact same geometry.
    var models = [];
    var usedNames = new Set();
    jobs.forEach(function (job) {
      var model = extractModel(job, options);
      if (!model) return;
      model.name = uniqueName(
        sanitizeName(job.mesh.name || 'mesh', 'mesh') + (job.suffix || ''),
        usedNames
      );
      models.push(model);
    });

    if (!models.length) {
      return { ok: false, message: 'Nenhuma malha encontrada com os filtros atuais.' };
    }

    var isSTL = options.format === 'stl' || options.format === 'stl-ascii';

    // ---- STL: the conversion happens here, the .obj never hits the disk ----
    if (isSTL) {
      var stlStats = { meshes: 0, vertices: 0, faces: 0, normals: 0, uvs: 0, materials: 0, skipped: [] };

      if (options.combine !== false) {
        var stlName = baseName + '.stl';
        stlStats.meshes = models.length;
        if (options.format === 'stl') {
          var binary = buildBinarySTL(models);
          downloadFile(stlName, binary.buffer, 'model/stl');
          stlStats.faces = binary.triangles;
          stlStats.vertices = binary.triangles * 3;
          files.push(stlName);
          return {
            ok: true,
            files: files,
            stats: stlStats,
            format: 'stl',
            bytes: binary.buffer.byteLength,
            message: 'STL binario: ' + binary.triangles + ' triangulo(s).'
          };
        }
        var ascii = buildAsciiSTL(models);
        downloadFile(stlName, ascii.text, 'model/stl');
        stlStats.faces = ascii.triangles;
        stlStats.vertices = ascii.triangles * 3;
        files.push(stlName);
        return {
          ok: true,
          files: files,
          stats: stlStats,
          format: 'stl-ascii',
          bytes: ascii.text.length,
          message: 'STL ascii: ' + ascii.triangles + ' triangulo(s).'
        };
      }

      // One file per model.
      models.forEach(function (model) {
        var one = options.format === 'stl' ? buildBinarySTL([model]) : buildAsciiSTL([model]);
        var fileName = model.name + '.stl';
        if (options.format === 'stl') downloadFile(fileName, one.buffer, 'model/stl');
        else downloadFile(fileName, one.text, 'model/stl');
        files.push(fileName);
        stlStats.meshes++;
        stlStats.faces += one.triangles;
        stlStats.vertices += one.triangles * 3;
      });

      return {
        ok: true,
        files: files,
        stats: stlStats,
        format: options.format,
        message: files.length + ' arquivo(s) STL gerado(s).'
      };
    }

    // ---- OBJ (+ .mtl) ------------------------------------------------------
    if (options.combine !== false) {
      var combined = buildOBJ(models, options);
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
        format: 'obj',
        bytes: combined.obj.length + (combined.mtl ? combined.mtl.length : 0),
        message: files.length + ' arquivo(s) gerado(s).'
      };
    }

    // One file per mesh (legacy behaviour).
    var stats = { meshes: 0, vertices: 0, faces: 0, normals: 0, uvs: 0, materials: 0, skipped: [] };
    models.forEach(function (model) {
      var single = buildOBJ([model], options);
      var fileName = model.name + '.obj';
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
      format: 'obj',
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
      var info = sceneInfo(data.exclude, data.excludeSize, data.format, data.excludeExact);
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
