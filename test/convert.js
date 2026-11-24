/**
 * Testes do conversor 3MF: leitura de GLB/OBJ/STL e escrita do pacote 3MF.
 *
 *   node test/convert.js
 */
'use strict';

const zlib = require('zlib');
const Load = require('../src/convert/load.js');
const Mf3 = require('../src/convert/mf3.js');
const Split = require('../src/split/3mf.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  \u2713 ' + name);
  } else {
    failed++;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

function close(a, b, tolerance) {
  return Math.abs(a - b) <= (tolerance || 1e-6);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function buildGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const binChunk = bin ? Buffer.concat([bin, Buffer.alloc(binPad)]) : null;

  const total = 12 + 8 + jsonChunk.length + (binChunk ? 8 + binChunk.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);

  if (binChunk) {
    const at = 20 + jsonChunk.length;
    out.writeUInt32LE(binChunk.length, at);
    out.writeUInt32LE(0x004e4942, at + 4);
    binChunk.copy(out, at + 8);
  }
  return out;
}

function triangleBin() {
  const bin = Buffer.alloc(36 + 6);
  const positions = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ];
  positions.forEach((value, index) => bin.writeFloatLE(value, index * 4));
  bin.writeUInt16LE(0, 36);
  bin.writeUInt16LE(1, 38);
  bin.writeUInt16LE(2, 40);
  return bin;
}

function triangleGlb(options) {
  const opts = options || {};
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: opts.translation || [0, 0, 0], name: 'tri' }],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: opts.colorName || 'vermelho', pbrMetallicRoughness: { baseColorFactor: opts.color || [1, 0, 0, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    buffers: [{ byteLength: 42 }]
  };
  return buildGlb(json, triangleBin());
}

function arrayBufferOf(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function gltfJsonWithBin() {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: 'vermelho', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    buffers: [{ uri: 'scene.bin', byteLength: 42 }]
  };
}

/** ZIP com deflate (metodo 8), como um pacote glTF exportado. */
function zipDeflated(files) {
  const parts = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data);
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw) >>> 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    parts.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, ...centrals, eocd]);
}

function binaryStl(positions) {
  const triangles = positions.length / 9;
  const out = Buffer.alloc(84 + triangles * 50);
  out.writeUInt32LE(triangles, 80);
  for (let t = 0; t < triangles; t++) {
    const at = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) {
      out.writeFloatLE(positions[t * 9 + k], at + k * 4);
    }
  }
  return out;
}

function unzipStored(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const size = buffer.readUInt32LE(offset + 18);
    const crc = buffer.readUInt32LE(offset + 14);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + size);
    files.set(name, {
      data: data,
      text: data.toString('utf8'),
      crcOk: (zlib.crc32(data) >>> 0) === (crc >>> 0)
    });
    offset = start + size;
  }
  return files;
}

// ---------------------------------------------------------------------------
// glTF / GLB
// ---------------------------------------------------------------------------

section('glTF/GLB: geometria, transformacao e cor do material');

{
  const result = Load.parseFiles([{ name: 'tri.glb', buffer: triangleGlb({ translation: [10, 0, 0] }) }]);
  check('GLB vira uma peca', result.parts.length === 1, 'pecas: ' + result.parts.length);
  check('GLB tem 1 triangulo', result.parts[0].faces === 1);
  check('posicoes em sopa (9 floats)', result.parts[0].positions.length === 9);
  check('translacao do node aplicada no X',
    close(result.parts[0].positions[0], 10), 'x: ' + result.parts[0].positions[0]);
  check('cor do material linear -> sRGB',
    result.parts[0].color[0] === 255 && result.parts[0].color[1] === 0 && result.parts[0].color[2] === 0,
    JSON.stringify(result.parts[0].color));
  check('GLB sugere metro -> mm (1000)', result.unitScale === 1000);
  check('GLB e Y para cima', result.yUp === true);
  check('nome da peca usa o node', /tri/.test(result.parts[0].name), result.parts[0].name);
}

{
  const glb = triangleGlb({ color: [0, 1, 0, 1] });
  const parsed = Load.parseGlb(glb);
  const result = Load.parseFiles([{ name: 'verde.glb', buffer: glb }]);
  check('parseGlb devolve JSON e bin', parsed.json && parsed.bin && parsed.bin.length >= 42);
  check('cor verde vira [0,255,0]',
    result.parts[0].color[1] === 255 && result.parts[0].color[0] === 0,
    JSON.stringify(result.parts[0].color));
}

// ---------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------

section('OBJ: faces, grupos por material e .mtl');

{
  const obj = [
    'v 0 0 0',
    'v 1 0 0',
    'v 1 1 0',
    'v 0 1 0',
    'usemtl vermelho',
    'f 1 2 3',
    'usemtl azul',
    'f 1 3 4',
    'f 1 2 4'
  ].join('\n');
  const mtl = [
    'newmtl vermelho',
    'Kd 1 0 0',
    'newmtl azul',
    'Kd 0 0 1'
  ].join('\n');

  const result = Load.parseFiles([{ name: 'quad.obj', buffer: Buffer.from(obj) }]);
  check('sem .mtl: um grupo por usemtl', result.parts.length === 2, 'pecas: ' + result.parts.length);
  check('peca vermelha com 1 triangulo', result.parts[0].faces === 1);
  check('peca azul com 2 triangulos (leque)', result.parts[1].faces === 2);
  check('cores da paleta sao diferentes',
    result.parts[0].color.join() !== result.parts[1].color.join());

  const withMtl = Load.parseFiles([
    { name: 'quad.obj', buffer: Buffer.from(obj) },
    { name: 'quad.mtl', buffer: Buffer.from(mtl) }
  ]);
  check('Kd do .mtl vale como cor',
    withMtl.parts[0].color.join() === '255,0,0' && withMtl.parts[1].color.join() === '0,0,255',
    JSON.stringify(withMtl.parts.map((p) => p.color)));
  check('OBJ usa mm como unidade', withMtl.unitScale === 1);
  check('OBJ e Y para cima', withMtl.yUp === true);
}

{
  const negative = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f -3 -2 -1'].join('\n');
  const result = Load.parseFiles([{ name: 'neg.obj', buffer: Buffer.from(negative) }]);
  check('indices negativos do OBJ', result.parts.length === 1 && result.parts[0].faces === 1);
  check('indices negativos leem os vertices certos',
    close(result.parts[0].positions[6], 0) && close(result.parts[0].positions[7], 1));
}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

section('STL: binario e ASCII');

{
  const result = Load.parseFiles([{
    name: 'tri.stl',
    buffer: binaryStl([0, 0, 0, 1, 0, 0, 0, 1, 0])
  }]);
  check('STL binario vira uma peca', result.parts.length === 1);
  check('STL binario tem 1 triangulo', result.parts[0].faces === 1);
  check('STL le os vertices', close(result.parts[0].positions[3], 1));
  check('STL e Z para cima', result.yUp === false);
  check('STL usa mm', result.unitScale === 1);
}

{
  const ascii = [
    'solid teste',
    'facet normal 0 0 1',
    'outer loop',
    'vertex 0 0 0',
    'vertex 2 0 0',
    'vertex 0 2 0',
    'endloop',
    'endfacet',
    'endsolid teste'
  ].join('\n');
  const result = Load.parseFiles([{ name: 'tri-ascii.stl', buffer: Buffer.from(ascii) }]);
  check('STL ASCII tem 1 triangulo', result.parts[0].faces === 1);
  check('STL ASCII le os vertices', close(result.parts[0].positions[3], 2));
}

// ---------------------------------------------------------------------------
// transformacao
// ---------------------------------------------------------------------------

section('Transformacao: escala e eixo');

{
  const parts = [{
    name: 'p',
    faces: 1,
    color: [1, 2, 3],
    positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
  }];
  const scaled = Load.transform(parts, { scale: 10, yUp: false });
  check('escala multiplica as posicoes', close(scaled[0].positions[0], 10));
  check('escala nao mexe no original', close(parts[0].positions[0], 1));
  check('cor e nome preservados', scaled[0].color.join() === '1,2,3' && scaled[0].name === 'p');

  const zUp = Load.transform(parts, { scale: 1, yUp: true });
  check('Y para cima: Y vira Z', close(zUp[0].positions[2], 2) && close(zUp[0].positions[1], -3));
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

section('3MF: pacote, cores e deduplicacao');

{
  const parts = [
    { name: 'base', color: [255, 0, 0], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    { name: 'topo', color: [0, 0, 255], positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]) }
  ];
  const bytes = Mf3.build(parts);
  const files = unzipStored(bytes);

  check('pacote tem [Content_Types].xml', files.has('[Content_Types].xml'));
  check('pacote tem _rels/.rels', files.has('_rels/.rels'));
  check('pacote tem 3D/3dmodel.model', files.has('3D/3dmodel.model'));
  check('CRC confere nas tres entradas', Array.from(files.values()).every((file) => file.crcOk));

  const xml = files.get('3D/3dmodel.model').text;
  check('modelo em milimetros', xml.indexOf('unit="millimeter"') !== -1);
  check('duas cores no basematerials', (xml.match(/<base /g) || []).length === 2, xml.slice(0, 400));
  check('cor vermelha em hex', xml.indexOf('displaycolor="#FF0000FF"') !== -1);
  check('cor azul em hex', xml.indexOf('displaycolor="#0000FFFF"') !== -1);
  check('dois objetos', (xml.match(/<object /g) || []).length === 2);
  check('dois itens no build', (xml.match(/<item /g) || []).length === 2);
  check('pindex aponta para a cor certa',
    xml.indexOf('name="base" pid="1" pindex="0"') !== -1 &&
    xml.indexOf('name="topo" pid="1" pindex="1"') !== -1, xml.slice(0, 900));
}

{
  // quadrado com vertices repetidos na sopa: 6 vertices -> 4 unicos
  const quad = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0,
    0, 0, 0, 1, 1, 0, 0, 1, 0
  ]);
  const xml = Mf3.modelXml([{ name: 'quad', color: [10, 20, 30], positions: quad }]);
  check('vertices repetidos viram um so', (xml.match(/<vertex /g) || []).length === 4,
    'vertices: ' + (xml.match(/<vertex /g) || []).length);
  check('dois triangulos preservados', (xml.match(/<triangle /g) || []).length === 2);
  check('cores iguais compartilham o mesmo material',
    (xml.match(/<base /g) || []).length === 1);
}

{
  const rounded = Mf3.modelXml([{
    name: 'a&b <c>',
    color: [300, -5, 12.6],
    positions: new Float32Array([0.123456789, 0, 0, 1.00004, 0, 0, 0, 1, 0])
  }]);
  check('nome com caracteres de XML e escapado', rounded.indexOf('name="a&amp;b &lt;c&gt;"') !== -1);
  check('cor fora de faixa e limitada', rounded.indexOf('displaycolor="#FF000DFF"') !== -1, rounded.slice(0, 300));
  check('coordenadas arredondadas', rounded.indexOf('x="0.1235"') !== -1);
  check('coordenadas iguais ao arredondar deduplicam', rounded.indexOf('x="1"') !== -1 || rounded.indexOf('x="1.0"') !== -1);
}

{
  let threw = false;
  try {
    Mf3.build([{ name: 'vazia', color: [0, 0, 0], positions: new Float32Array(0) }]);
  } catch (e) {
    threw = true;
  }
  check('sem triangulos: build recusa', threw);
}

// ---------------------------------------------------------------------------
// ZIP com glTF
// ---------------------------------------------------------------------------

async function zipSection() {
  section('ZIP com glTF: abre o pacote e acha o modelo');

  const stored = Buffer.from(Split.zipFiles([
    { name: 'scene.gltf', data: Buffer.from(JSON.stringify(gltfJsonWithBin())) },
    { name: 'scene.bin', data: triangleBin() },
    { name: 'texture.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) }
  ]));

  const fromStored = await Load.parseInputs([{ name: 'mclaren.zip', buffer: arrayBufferOf(stored) }]);
  check('ZIP (store) abre o scene.gltf', fromStored.parts.length === 1 && fromStored.kind === 'gltf');
  check('ZIP usa o nome do pacote', fromStored.name === 'mclaren', fromStored.name);
  check('ZIP resolve o scene.bin externo', close(fromStored.parts[0].positions[3], 1),
    String(fromStored.parts[0].positions[3]));
  check('ZIP mantem a cor do material', fromStored.parts[0].color[0] === 255,
    JSON.stringify(fromStored.parts[0].color));

  const deflated = zipDeflated([
    { name: 'scene.gltf', data: Buffer.from(JSON.stringify(gltfJsonWithBin())) },
    { name: 'scene.bin', data: triangleBin() },
    { name: 'textures/albedo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
  ]);

  const fromDeflated = await Load.parseInputs([{ name: 'senna.zip', buffer: arrayBufferOf(deflated) }]);
  check('ZIP deflate abre', fromDeflated.parts.length === 1 &&
    fromDeflated.parts[0].faces === 1);
  check('ZIP deflate le o binario', close(fromDeflated.parts[0].positions[7], 1),
    String(fromDeflated.parts[0].positions[7]));
  check('textura no ZIP e ignorada', fromDeflated.parts[0].faces === 1);

  let message = '';
  try {
    const empty = Buffer.from(Split.zipFiles([{ name: 'leia-me.txt', data: 'oi' }]));
    await Load.parseInputs([{ name: 'vazio.zip', buffer: arrayBufferOf(empty) }]);
  } catch (error) {
    message = error.message;
  }
  check('ZIP sem modelo e recusado com aviso', /nao tem/.test(message), message);
}

// ---------------------------------------------------------------------------

zipSection().then(function () {
  console.log('\n' + '-'.repeat(58));
  if (failed) {
    console.log(failed + ' falha(s):');
    failures.forEach((failure) => console.log('  - ' + failure));
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch(function (error) {
  console.error('falha inesperada:', error && error.message ? error.message : error);
  process.exit(1);
});

