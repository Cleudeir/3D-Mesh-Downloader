/**
 * Mock objects that mimic the three.js API surface used by injected.js.
 * Pure data - no dependency on three.js itself.
 */
'use strict';

/** Builds a column-major TRS matrix with the same layout as three.js Matrix4. */
function composeMatrix(pos, rot, scale) {
  var cx = Math.cos(rot.x), sx = Math.sin(rot.x);
  var cy = Math.cos(rot.y), sy = Math.sin(rot.y);
  var cz = Math.cos(rot.z), sz = Math.sin(rot.z);

  var m = new Array(16);
  m[0] = cy * cz;
  m[1] = cx * sz + cz * sx * sy;
  m[2] = sx * sz - cx * cz * sy;
  m[3] = 0;

  m[4] = -cy * sz;
  m[5] = cx * cz - sx * sy * sz;
  m[6] = cz * sx + cx * sy * sz;
  m[7] = 0;

  m[8] = sy;
  m[9] = -cy * sx;
  m[10] = cx * cy;
  m[11] = 0;

  m[0] *= scale.x; m[1] *= scale.y; m[2] *= scale.z;
  m[4] *= scale.x; m[5] *= scale.y; m[6] *= scale.z;
  m[8] *= scale.x; m[9] *= scale.y; m[10] *= scale.z;

  m[12] = pos.x; m[13] = pos.y; m[14] = pos.z; m[15] = 1;
  return m;
}

/** Minimal BufferAttribute-like object. */
function attribute(count, getter) {
  return {
    count: count,
    getX: function (i) { return getter(i)[0]; },
    getY: function (i) { return getter(i)[1]; },
    getZ: function (i) { return getter(i)[2]; },
    getW: function (i) { return getter(i)[3]; }
  };
}

function positionAttribute(flat) {
  var count = flat.length / 3;
  return attribute(count, function (i) { return [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]; });
}

function normalAttribute(flat) {
  var count = flat.length / 3;
  return attribute(count, function (i) { return [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]; });
}

function uvAttribute(flat) {
  var count = flat.length / 2;
  return attribute(count, function (i) { return [flat[i * 2], flat[i * 2 + 1]]; });
}

function indexAttribute(list) {
  return {
    count: list.length,
    getX: function (i) { return list[i]; }
  };
}

function matrix4(elements) {
  return { elements: elements, isMatrix4: true };
}

function object3d(name, options) {
  options = options || {};
  var pos = options.position || { x: 0, y: 0, z: 0 };
  var rot = options.rotation || { x: 0, y: 0, z: 0 };
  var scale = options.scale || { x: 1, y: 1, z: 1 };
  var world = options.worldMatrix || composeMatrix(pos, rot, scale);

  return {
    name: name,
    type: 'Object3D',
    isObject3D: true,
    position: pos,
    rotation: rot,
    scale: scale,
    matrixWorld: matrix4(world),
    children: options.children || [],
    updateWorldMatrix: function () { /* already up to date */ },
    updateMatrixWorld: function () { /* already up to date */ }
  };
}

function mesh(name, geometry, material, options) {
  var obj = object3d(name, options);
  obj.type = 'Mesh';
  obj.isMesh = true;
  obj.geometry = geometry;
  obj.material = material || null;
  return obj;
}

/**
 * Builds a full mock scene:
 *   scene
 *    |- "cube"        mesh with transform, normals, uvs, index
 *    |- group
 *    |    |- "flat"    mesh without normals (flat shading path)
 *    |- "instances"  InstancedMesh with 2 instances
 *    |- "skinned"    SkinnedMesh with 1 bone
 */
function buildMockScene() {
  var scene = object3d('MockScene', {});
  scene.type = 'Scene';
  scene.isScene = true;

  // --- cube: translated + rotated + scaled ---------------------------------
  var cubePositions = [
    -1, -1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0
  ];
  var cubeNormals = [
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1
  ];
  var cubeUvs = [0, 0, 1, 0, 1, 1, 0, 1];

  var cubeGeometry = {
    attributes: {
      position: positionAttribute(cubePositions),
      normal: normalAttribute(cubeNormals),
      uv: uvAttribute(cubeUvs)
    },
    index: indexAttribute([0, 1, 2, 0, 2, 3]),
    groups: []
  };

  var cubeMaterial = {
    id: 7,
    name: 'Pintura Vermelha',
    color: { r: 1, g: 0.25, b: 0.25 },
    roughness: 0.4,
    metalness: 0,
    map: { image: { src: 'https://example.com/texture.png' } }
  };

  var cube = mesh('cube', cubeGeometry, cubeMaterial, {
    position: { x: 10, y: 20, z: 30 },
    rotation: { x: 0, y: 0, z: Math.PI / 2 },
    scale: { x: 2, y: 2, z: 2 }
  });

  // --- flat: no normals, no uv ---------------------------------------------
  var flatGeometry = {
    attributes: {
      position: positionAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0])
    },
    index: indexAttribute([0, 1, 2]),
    groups: []
  };
  var flat = mesh('flat', flatGeometry, { id: 8, name: 'Sem Normal', color: { r: 0.2, g: 0.4, b: 0.9 } });

  var group = object3d('group', { children: [flat] });

  // --- instances ------------------------------------------------------------
  var instanceGeometry = {
    attributes: {
      position: positionAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normal: normalAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1])
    },
    index: indexAttribute([0, 1, 2]),
    groups: []
  };
  var instances = mesh('instances', instanceGeometry, { id: 9, name: 'Instancia', color: { r: 1, g: 1, b: 1 } });
  instances.isInstancedMesh = true;
  instances.instanceMatrix = {
    count: 2,
    array: new Float32Array([
      5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1,
      3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 20, 0, 0, 1
    ])
  };

  // --- skinned --------------------------------------------------------------
  var skinnedGeometry = {
    attributes: {
      position: positionAttribute([0, 0, 0, 1, 0, 0]),
      skinIndex: attribute(2, function () { return [0, 0, 0, 0]; }),
      skinWeight: attribute(2, function () { return [1, 0, 0, 0]; }),
      normal: normalAttribute([0, 0, 1, 0, 0, 1])
    },
    index: indexAttribute([0, 1, 0]),
    groups: []
  };
  var skinned = mesh('skinned', skinnedGeometry, { id: 10, name: 'Esqueleto', color: { r: 0.5, g: 0.5, b: 0.5 } });
  skinned.isSkinnedMesh = true;
  skinned.bindMatrix = matrix4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  skinned.bindMatrixInverse = matrix4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  var bone = object3d('bone', { position: { x: 0, y: 0, z: 0 } });
  bone.matrixWorld = matrix4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]);
  skinned.skeleton = {
    bones: [bone],
    boneInverses: [matrix4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])]
  };

  scene.children = [cube, group, instances, skinned];
  return scene;
}

module.exports = {
  composeMatrix: composeMatrix,
  buildMockScene: buildMockScene,
  object3d: object3d,
  mesh: mesh,
  attribute: attribute
};
