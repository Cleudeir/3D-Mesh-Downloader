/**
 * Test suite for the 3D Mesh Downloader rewrite.
 *
 *   node test/run.js
 */
'use strict';

const { createEnvironment } = require('./harness');
const { buildMockScene } = require('./mock-three');

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

function eq(name, actual, expected) {
  check(name, actual === expected, 'esperado ' + JSON.stringify(expected) + ', obtido ' + JSON.stringify(actual));
}

function section(title) {
  console.log('\n' + title);
}

/** Extracts the vertices of the object whose name matches. */
function objectVertices(obj, objectName) {
  const lines = obj.split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('o ')) {
      inside = line.slice(2).trim() === objectName;
      continue;
    }
    if (inside && line.startsWith('v ')) {
      out.push(line.slice(2).trim().split(/\s+/).map(Number));
    }
  }
  return out;
}

function objectBlock(obj, objectName) {
  const lines = obj.split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('o ')) {
      if (inside) break;
      inside = line.slice(2).trim() === objectName;
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

function countLines(text, prefix) {
  return text.split('\n').filter((l) => l.startsWith(prefix)).length;
}

// ---------------------------------------------------------------------------

function setup() {
  const env = createEnvironment({ hostname: 'example.test' });
  const scene = buildMockScene();
  env.observe(scene);
  return { env, scene };
}

function download(env, options) {
  const replies = env.request({ type: 'MDL_DOWNLOAD', options: options || {} });
  const reply = replies.find((m) => m.type === 'MDL_RESULT');
  return {
    result: reply ? reply.result : null,
    files: env.downloads.slice(),
    obj: env.downloads.length ? env.downloads[0].content : '',
    mtl: env.downloads.length > 1 ? env.downloads[1].content : ''
  };
}

// ---------------------------------------------------------------------------
section('1. Captura de cena');
{
  const { env } = setup();
  const replies = env.request({ type: 'MDL_GET_INFO' });
  const reply = replies.find((m) => m.type === 'MDL_INFO');
  check('a cena foi capturada via __THREE_DEVTOOLS__', !!reply);
  eq('numero de malhas', reply.info.count, 4);
  eq('numero de cenas', reply.info.sceneCount, 1);
  eq('nome da cena', reply.info.scenes[0].name, 'MockScene');
}

// ---------------------------------------------------------------------------
section('2. Exportacao combinada (um unico .obj + .mtl)');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'auto', uvs: 'on', materials: 'on', expandInstances: true });

  check('a operacao terminou com sucesso', out.result && out.result.ok, out.result && out.result.message);
  eq('2 arquivos gerados (.obj + .mtl)', out.files.length, 2);
  eq('nome do .obj', out.files[0].filename, 'example.test.obj');
  eq('nome do .mtl', out.files[1].filename, 'example.test.mtl');

  check('o .obj referencia o .mtl', out.obj.includes('mtllib example.test.mtl'));
  check('o .obj tem 5 objetos (instancia expandida)', countLines(out.obj, 'o ') === 5, 'o -> ' + countLines(out.obj, 'o '));

  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2));
  check('instancia 0 presente', objects.includes('instances_inst0'), objects.join(','));
  check('instancia 1 presente', objects.includes('instances_inst1'), objects.join(','));
}

// ---------------------------------------------------------------------------
section('3. Transformacoes de mundo aplicadas');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });

  const cube = objectVertices(out.obj, 'cube');
  eq('4 vertices no cube', cube.length, 4);
  // local (-1,-1,0) com escala 2, rotacao Rz(90) e translacao (10,20,30)
  check('vertice 0 = (12, 18, 30)', JSON.stringify(cube[0]) === JSON.stringify([12, 18, 30]), JSON.stringify(cube[0]));
  check('vertice 1 = (12, 22, 30)', JSON.stringify(cube[1]) === JSON.stringify([12, 22, 30]), JSON.stringify(cube[1]));
  check('vertice 2 = (8, 22, 30)', JSON.stringify(cube[2]) === JSON.stringify([8, 22, 30]), JSON.stringify(cube[2]));
  check('vertice 3 = (8, 18, 30)', JSON.stringify(cube[3]) === JSON.stringify([8, 18, 30]), JSON.stringify(cube[3]));
}

// ---------------------------------------------------------------------------
section('4. Transformacoes desligadas (espaco local)');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: false, normals: 'none', uvs: 'none', materials: 'none' });

  const cube = objectVertices(out.obj, 'cube');
  check('vertice 0 preserva o espaco local (-1,-1,0)',
    JSON.stringify(cube[0]) === JSON.stringify([-1, -1, 0]), JSON.stringify(cube[0]));
  check('o .obj avisa que o espaco e local',
    out.obj.includes('# WARNING: object transforms were NOT applied'));
}

// ---------------------------------------------------------------------------
section('5. Normais e UVs');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'auto', uvs: 'on', materials: 'none' });

  check('normais exportadas (vn)', countLines(out.obj, 'vn ') > 0, 'vn -> ' + countLines(out.obj, 'vn '));
  check('UVs exportadas (vt)', countLines(out.obj, 'vt ') > 0, 'vt -> ' + countLines(out.obj, 'vt '));

  const flatBlock = objectBlock(out.obj, 'flat');
  const flatNormals = flatBlock.filter((l) => l.startsWith('vn ')).map((l) => l.slice(3).trim().split(/\s+/).map(Number));
  eq('a malha sem atributo de normal foi expandida (3 normais)', flatNormals.length, 3);
  check('normal planar calculada = (0,0,1)',
    JSON.stringify(flatNormals[0]) === JSON.stringify([0, 0, 1]), JSON.stringify(flatNormals[0]));
}

{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });
  eq('sem normais quando desativado', countLines(out.obj, 'vn '), 0);
  eq('sem UVs quando desativado', countLines(out.obj, 'vt '), 0);
}

// ---------------------------------------------------------------------------
section('6. InstancedMesh expandido');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });

  const i0 = objectVertices(out.obj, 'instances_inst0');
  const i1 = objectVertices(out.obj, 'instances_inst1');
  eq('instancia 0 tem 3 vertices', i0.length, 3);
  check('instancia 0 escalada 5x -> (5,0,0)',
    JSON.stringify(i0[1]) === JSON.stringify([5, 0, 0]), JSON.stringify(i0[1]));
  check('instancia 1 escalada 3x e transladada -> (23,0,0)',
    JSON.stringify(i1[1]) === JSON.stringify([23, 0, 0]), JSON.stringify(i1[1]));
}

{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none', expandInstances: false });
  eq('sem expansao, apenas 4 objetos', countLines(out.obj, 'o '), 4);
}

// ---------------------------------------------------------------------------
section('7. SkinnedMesh com esqueleto');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });

  const skinned = objectVertices(out.obj, 'skinned');
  eq('2 vertices no skinned', skinned.length, 2);
  // o osso esta em (100,0,0) e o peso e 1.0 -> o vertice desloca para +100 em X
  check('vertice deformado pelo osso -> (101,0,0)',
    JSON.stringify(skinned[1]) === JSON.stringify([101, 0, 0]), JSON.stringify(skinned[1]));
}

// ---------------------------------------------------------------------------
section('8. Materiais (.mtl)');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'on' });

  check('o .mtl foi gerado', out.mtl.length > 0);
  check('newmtl com o nome saneado', out.mtl.includes('newmtl Pintura_Vermelha'), out.mtl.split('\n')[3]);
  check('cor difusa exportada', out.mtl.includes('Kd 1 0.25 0.25'));
  check('textura referenciada', out.mtl.includes('map_Kd https://example.com/texture.png'));
  check('usemtl no .obj', out.obj.includes('usemtl Pintura_Vermelha'));
}

// ---------------------------------------------------------------------------
section('9. Um arquivo por malha (modo legado)');
{
  const { env } = setup();
  const out = download(env, { combine: false, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });

  eq('5 arquivos .obj (4 malhas + 1 instancia extra)', out.files.length, 5);
  check('nomes unicos', new Set(out.files.map((f) => f.filename)).size === 5);
}

// ---------------------------------------------------------------------------
section('10. Indices das faces');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });

  const cubeBlock = objectBlock(out.obj, 'cube');
  const faces = cubeBlock.filter((l) => l.startsWith('f '));
  eq('2 faces no cubo', faces.length, 2);
  eq('face 1', faces[0], 'f 1 2 3');
  eq('face 2', faces[1], 'f 1 3 4');
}

// ---------------------------------------------------------------------------
section('11. Robustez');
{
  const env = createEnvironment({ hostname: 'example.test' });
  const replies = env.request({ type: 'MDL_DOWNLOAD', options: {} });
  const reply = replies.find((m) => m.type === 'MDL_RESULT');
  check('sem cena capturada, retorna erro em vez de quebrar',
    reply && reply.result && reply.result.ok === false, JSON.stringify(reply && reply.result));
  eq('nenhum download disparado', env.downloads.length, 0);
}

{
  // A pagina define o proprio __THREE_DEVTOOLS__ depois da extensao:
  // o hook nao pode ser roubado silenciosamente.
  const env = createEnvironment({ hostname: 'example.test' });
  const foreign = new (require('vm').runInContext('EventTarget', env.sandbox))();
  env.sandbox.__THREE_DEVTOOLS__ = foreign;
  env.observe(buildMockScene());
  const replies = env.request({ type: 'MDL_GET_INFO' });
  const reply = replies.find((m) => m.type === 'MDL_INFO');
  check('hook sobrevive a um __THREE_DEVTOOLS__ definido pela pagina',
    reply && reply.info.count === 4, reply ? String(reply.info.count) : 'sem resposta');
}

// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(58));
console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  console.log('\n  Falhas:');
  failures.forEach((f) => console.log('   - ' + f));
}
console.log('-'.repeat(58));
process.exit(failed ? 1 : 0);
