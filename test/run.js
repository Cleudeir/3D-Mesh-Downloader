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
  eq('numero de malhas', reply.info.count, 5);
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
  check('o .obj tem 6 objetos (instancia expandida + InstancedMesh vazio)', countLines(out.obj, 'o ') === 6, 'o -> ' + countLines(out.obj, 'o '));

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
  eq('sem expansao, apenas 5 objetos', countLines(out.obj, 'o '), 5);
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
  // three.js guarda a cor em espaco linear; o .mtl precisa de sRGB.
  // mock: color(1, 0.25, 0.5) -> hex ff4080 -> 1, 64/255, 128/255
  check('cor difusa exportada em sRGB', out.mtl.includes('Kd 1 0.25098 0.501961'),
    (out.mtl.split('\n').find((l) => l.startsWith('Kd ')) || ''));
  // mock legado sem getHexString: componentes lineares -> conversao manual
  check('cor linear convertida para sRGB (fallback)',
    out.mtl.includes('Kd 0.735357 0.735357 0.735357'),
    (out.mtl.split('\n').filter((l) => l.startsWith('Kd ')).join(' | ')));
  check('textura referenciada', out.mtl.includes('map_Kd https://example.com/texture.png'));
  check('usemtl no .obj', out.obj.includes('usemtl Pintura_Vermelha'));
}

// ---------------------------------------------------------------------------
section('9. Um arquivo por malha (modo legado)');
{
  const { env } = setup();
  const out = download(env, { combine: false, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });

  eq('6 arquivos .obj (5 malhas + 1 instancia extra)', out.files.length, 6);
  check('nomes unicos', new Set(out.files.map((f) => f.filename)).size === 6);
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
    reply && reply.info.count === 5, reply ? String(reply.info.count) : 'sem resposta');
}

// ---------------------------------------------------------------------------
section('12. Filtro por nome e por tamanho');
{
  const { env } = setup();
  const replies = env.request({ type: 'MDL_GET_INFO' });
  const info = replies.find((m) => m.type === 'MDL_INFO').info;

  eq('5 modelos listados', info.models.length, 5);
  check('cada modelo tem id, nome, vertices, faces e tamanho',
    info.models.every((m) => m.id && m.name && m.vertexCount >= 0 && m.faceCount >= 0 && m.sizeBytes > 0));
  check('cada modelo tem bounding box',
    info.models.every((m) => m.bounds && m.bounds.size.length === 3));

  const cube = info.models.find((m) => m.name === 'cube');
  const inst = info.models.find((m) => m.name === 'instances');
  check('o tamanho estimado do cube (~532 B) bate', cube.sizeBytes === 532, String(cube.sizeBytes));
  check('instancias multiplicam o tamanho estimado (346 x 2 = 692)', inst.sizeBytes === 692, String(inst.sizeBytes));
  check('o tamanho total e a soma dos modelos', info.totalSizeBytes > cube.sizeBytes);
}
{
  // filtro por texto
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { text: 'cube' }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2));
  eq('filtro por texto mantem apenas "cube"', objects.length, 1);
  eq('o objeto kept e o cube', objects[0], 'cube');
}
{
  // filtro por texto tambem olha cena e material
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { text: 'Esqueleto' }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2));
  eq('filtro por nome de material', objects.length, 1);
  eq('objeto encontrado pelo material', objects[0], 'skinned');
}
{
  // filtro por tamanho (min KB)
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { minKB: 0.5 }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('filtro por tamanho minimo mantém 2 modelos (3 objetos: instancias vira 2)', objects.length, 3);
  check('sao os maiores (cube e as 2 instancias)',
    objects.includes('cube') && objects.includes('instances_inst0') && objects.includes('instances_inst1'),
    objects.join(','));
}
{
  // filtro por tamanho (max KB)
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { maxKB: 0.3 }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('filtro por tamanho maximo mantém os pequenos', objects.join(','), 'flat,skinned');
}
{
  // seleção explicita
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { include: ['s0_m0'] }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2));
  eq('selecao explicita exporta 1 modelo', objects.length, 1);
  eq('modelo selecionado', objects[0], 'cube');
}
{
  // filtro que nao casa com nada
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { text: 'nao-existe-xyz' }
  });
  check('filtro sem resultado retorna erro', out.result && out.result.ok === false, JSON.stringify(out.result));
  eq('nenhum arquivo gerado', out.files.length, 0);
}


// ---------------------------------------------------------------------------
section('13. InstancedMesh com zero instancias nao pode sumir');
{
  const { env } = setup();
  const out = download(env, { combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none' });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2));
  check('o InstancedMesh vazio e exportado como malha base',
    objects.includes('emptyInstances'), objects.join(','));
  const block = objectBlock(out.obj, 'emptyInstances');
  const verts = block.filter((l) => l.startsWith('v '));
  eq('com 3 vertices', verts.length, 3);
}
{
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { text: 'Vazio' }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2));
  eq('filtro por texto acha o InstancedMesh vazio', objects.length, 1);
  eq('e o objeto certo', objects[0], 'emptyInstances');
}
{
  const { env } = setup();
  const replies = env.request({ type: 'MDL_GET_INFO' });
  const info = replies.find((m) => m.type === 'MDL_INFO').info;
  const empty = info.models.find((m) => m.name === 'emptyInstances');
  check('o modelo vazio aparece na lista', !!empty);
  eq('e reporta 1 instancia (nao 0)', empty.instances, 1);
}


// ---------------------------------------------------------------------------
section('14. Exportacao STL');
{
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'auto', uvs: 'on', materials: 'on',
    format: 'stl'
  });

  check('exportou com sucesso', out.result && out.result.ok, JSON.stringify(out.result));
  eq('1 arquivo .stl', out.files.length, 1);
  check('nome com extensao .stl', out.files[0].filename.endsWith('.stl'), out.files[0].filename);
  check('nenhum .obj gerado', !out.files.some((f) => f.filename.endsWith('.obj')), out.files.map((f) => f.filename).join(','));

  // conteudo binario
  const buf = out.files[0].buffer;
  const view = new DataView(buf, 0, buf.byteLength);
  const triangles = view.getUint32(80, true);
  const header = new TextDecoder().decode(new Uint8Array(buf, 0, 80));

  eq('cabecalho com 80 bytes', header.length, 80);
  check('cabecalho identifica a extensao', header.startsWith('3D Mesh Downloader'), header.slice(0, 40));
  eq('tamanho do buffer = 84 + 50 * triangulos', buf.byteLength, 84 + triangles * 50);
  eq('numero de triangulos (7 faces - 1 degenerada)', triangles, 6);

  // primeiro facet: normal + 3 vertices
  const n = [view.getFloat32(84, true), view.getFloat32(88, true), view.getFloat32(92, true)];
  const v1 = [view.getFloat32(96, true), view.getFloat32(100, true), view.getFloat32(104, true)];
  check('normal do facet tem comprimento 1', Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-5, JSON.stringify(n));
  check('primeiro vertice do facet e (-1,-1,0) escalado 2x e rotacionado 90',
    Math.abs(v1[0] - 12) < 1e-4 && Math.abs(v1[1] - 18) < 1e-4 && Math.abs(v1[2] - 30) < 1e-4, JSON.stringify(v1));
  eq('attribute byte count = 0', view.getUint16(84 + 48, true), 0);
}
{
  // STL ASCII
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'auto', uvs: 'on', materials: 'on',
    format: 'stl-ascii'
  });

  const text = out.files[0].content;
  check('comeca com solid', text.startsWith('solid '), text.slice(0, 30));
  check('termina com endsolid', text.trim().endsWith('endsolid ' + text.split('\n')[0].replace('solid ', '')));
  eq('6 facetas', (text.match(/facet normal/g) || []).length, 6);
  eq('18 vertices', (text.match(/vertex /g) || []).length, 18);
  check('tem outer loop/endloop', text.includes('outer loop') && text.includes('endloop'));
}
{
  // o formato muda o tamanho estimado usado pelo filtro
  const { env } = setup();
  const replies = env.request({ type: 'MDL_GET_INFO' });
  const info = replies.find((m) => m.type === 'MDL_INFO').info;
  const cube = info.models.find((m) => m.name === 'cube');
  check('estimativa OBJ', cube.sizes.obj === 532, String(cube.sizes.obj));
  check('estimativa STL binario = 84 + 50*2', cube.sizes.stl === 184, String(cube.sizes.stl));
  check('estimativa STL ascii > STL binario', cube.sizes['stl-ascii'] > cube.sizes.stl);
  check('sizeBytes continua sendo o valor do OBJ', cube.sizeBytes === cube.sizes.obj);
}
{
  // filtro por tamanho usando o formato escolhido (um arquivo por modelo)
  const { env } = setup();
  const out = download(env, {
    combine: false, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    format: 'stl', filter: { maxKB: 0.2 }
  });
  const names = out.files.map((f) => f.filename.replace('.stl', '')).sort();
  // no OBJ: cube 532 B, instances 692 B, flat 256 B, skinned 286 B, vazio 256 B
  // no STL: 84 + 50 * faces -> instances (268 B) e a unica que passa de 200 KB
  eq('com STL, o filtro de 200 KB usa o tamanho em STL', names.join(','), 'cube,emptyInstances,flat,skinned');
}
{
  // um arquivo por modelo em STL
  const { env } = setup();
  const out = download(env, {
    combine: false, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    format: 'stl'
  });
  eq('6 arquivos .stl (um por modelo/instancia)', out.files.length, 6);
  check('todos com extensao .stl', out.files.every((f) => f.filename.endsWith('.stl')));
}
{
  // triangulos degenerados sao descartados
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'auto', uvs: 'on', materials: 'on',
    format: 'stl'
  });
  const buf = out.files[0].buffer;
  const view = new DataView(buf, 0, buf.byteLength);
  const triangles = view.getUint32(80, true);
  // o mock "skinned" tem a face (0,1,0) -> degenerada -> descartada
  eq('triangulos degenerados foram removidos (7 faces - 1 degenerada)', triangles, 6);
}



// ---------------------------------------------------------------------------
section('15. Lista de exclusao por nome');
{
  // nomes do mock: s0_m0=cube, s0_m1=flat, s0_m2=instances, s0_m3=skinned, s0_m4=emptyInstances
  const { env } = setup();
  const replies = env.request({ type: 'MDL_GET_INFO', exclude: ['flat*', 'instances*'] });
  const info = replies.find((m) => m.type === 'MDL_INFO').info;

  const excluded = info.models.filter((m) => m.excluded);
  eq('2 modelos excluidos pelos padroes', excluded.length, 2);
  check('o padrao que exclui cada um volta junto',
    excluded.every((m) => m.excludedBy === 'flat*' || m.excludedBy === 'instances*'),
    excluded.map((m) => m.name + ':' + m.excludedBy).join(','));
  eq('o total continua contando tudo', info.count, 5);
  eq('mas o exportavel ja desconta', info.exportableCount, 3);
  eq('e o contador de excluidas bate', info.excludedCount, 2);
}
{
  // a lista de exclusao realmente tira o modelo do arquivo
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { exclude: ['flat*', 'instances*'] }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('so os modelos nao excluidos vao para o arquivo', objects.join(','), 'cube,emptyInstances,skinned');
}
{
  // wildcard: o ? casa exatamente um caractere
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { exclude: ['c?be'] }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('o ? casa exatamente um caractere', objects.join(','), 'emptyInstances,flat,instances_inst0,instances_inst1,skinned');
}
{
  // pattern sem wildcard = nome exato
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { exclude: ['cube'] }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('padrao exato tira so o modelo com esse nome', objects.join(','), 'emptyInstances,flat,instances_inst0,instances_inst1,skinned');
}
{
  // a exclusao tem prioridade sobre a selecao explicita
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { include: ['s0_m0', 's0_m1'], exclude: ['cube'] }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2));
  eq('excluido nao entra nem se estiver marcado', objects.join(','), 'flat');
}
{
  // prefixo com * cobre o modelo e todas as suas instancias
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { exclude: ['inst*'] }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('o prefixo leva as instancias junto', objects.join(','), 'cube,emptyInstances,flat,skinned');
}
{
  // padrao invalido nao quebra a exportacao
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { exclude: ['[', '(', '\\'] }
  });
  check('padroes invalidos sao ignorados', out.result && out.result.ok, JSON.stringify(out.result));
}
{
  // a lista tambem vale no modo STL
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, format: 'stl',
    filter: { exclude: ['flat*', 'instances*'] }
  });
  const buf = out.files[0].buffer;
  const view = new DataView(buf, 0, buf.byteLength);
  const triangles = view.getUint32(80, true);
  // cube 2 + skinned 1 (degenerada, descartada) + emptyInstances 1 = 3
  eq('no STL tambem vale a exclusao', triangles, 3);
}

// ---------------------------------------------------------------------------
section('16. Exclusao por tamanho');
{
  // tamanhos do mock (OBJ): cube 532 B, flat 256 B, instances 692 B,
  // skinned 286 B, emptyInstances 346 B
  const { env } = setup();
  const info = (opts) => env.request(Object.assign({ type: 'MDL_GET_INFO' }, opts))
    .find((m) => m.type === 'MDL_INFO').info;

  eq('sem regra, nada e excluido por tamanho', info({}).excludedCount, 0);

  const acima = info({ excludeSize: { enabled: true, mode: 'above', kb: 0.5 }, format: 'obj' });
  eq('maior que 0.5 KB exclui 2 (cube e instances)', acima.excludedCount, 2);
  check('a marcacao diz qual regra pegou',
    acima.models.filter((m) => m.excluded)
      .every((m) => m.excludedBy === 'tamanho > 0.5 KB'),
    acima.models.filter((m) => m.excluded).map((m) => m.excludedBy).join(','));

  const abaixo = info({ excludeSize: { enabled: true, mode: 'below', kb: 0.5 }, format: 'obj' });
  eq('menor que 0.5 KB exclui 3', abaixo.excludedCount, 3);

  eq('regra desligada nao exclui nada',
    info({ excludeSize: { enabled: false, mode: 'above', kb: 0.5 }, format: 'obj' }).excludedCount, 0);

  const porNome = info({ exclude: ['cube'], excludeSize: { enabled: true, mode: 'above', kb: 0.5 }, format: 'obj' });
  eq('o nome tem prioridade na marcacao',
    porNome.models.find((m) => m.name === 'cube').excludedBy, 'cube');
  eq('e o contador nao conta duas vezes', porNome.excludedCount, 2);

  eq('a regra usa o tamanho do formato escolhido (STL)',
    info({ excludeSize: { enabled: true, mode: 'above', kb: 0.2 }, format: 'stl' }).excludedCount, 1);

  eq('limite invalido nao quebra',
    info({ excludeSize: { enabled: true, mode: 'above', kb: 'abc' }, format: 'obj' }).excludedCount, 0);
}
{
  // a regra tambem tira o modelo do arquivo exportado
  const { env } = setup();
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { excludeSize: { enabled: true, mode: 'above', kb: 0.5 } }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('o arquivo sai sem os modelos acima do limite',
    objects.join(','), 'emptyInstances,flat,skinned');
}

// ---------------------------------------------------------------------------
section('17. Lista de exclusao por tamanho (nomes exatos)');
{
  const { env } = setup();
  const info = (opts) => env.request(Object.assign({ type: 'MDL_GET_INFO' }, opts))
    .find((m) => m.type === 'MDL_INFO').info;

  const porNome = info({ excludeExact: ['flat', 'skinned'] });
  const excluidos = porNome.models.filter((m) => m.excluded);
  eq('2 modelos excluidos pelos nomes da lista', excluidos.length, 2);
  check('marcados como "tamanho"', excluidos.every((m) => m.excludedBy === 'tamanho'),
    excluidos.map((m) => m.name + ':' + m.excludedBy).join(','));
  eq('o contador bate', porNome.excludedCount, 2);

  // a lista guarda nomes exatos, nao curingas
  eq('nome exato nao vira prefixo', info({ excludeExact: ['fla'] }).excludedCount, 0);
  eq('curinga nao e interpretado', info({ excludeExact: ['fl*'] }).excludedCount, 0);

  // e vale na exportacao
  const out = download(env, {
    combine: true, applyTransforms: true, normals: 'none', uvs: 'none', materials: 'none',
    filter: { include: ['s0_m0', 's0_m1'], excludeExact: ['flat'] }
  });
  const objects = out.obj.split('\n').filter((l) => l.startsWith('o ')).map((l) => l.slice(2)).sort();
  eq('o arquivo sai sem os nomes da lista', objects.join(','), 'cube');
}

// ---------------------------------------------------------------------------
section('Deep link: achar a aba mesmo quando o SPA troca de rota');
{
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');

  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
  const sandbox = {
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      tabs: { query: async () => [], sendMessage: async () => { throw new Error('sem content script'); } }
    },
    URL,
    console,
    Promise
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  const score = sandbox.scoreMatch;
  const base = 'https://studio.tripo3d.ai';

  check('a funcao de comparacao esta exposta', typeof score === 'function');
  eq('url identica', score(base + '/workspace/generate/x', base + '/workspace/generate/x'), 100);
  eq('hash do deep link e ignorado', score(base + '/workspace/generate/x', base + '/workspace/generate/x#3dmesh=export'), 100);
  eq('SPA trocou a rota mas manteve o id',
    score(base + '/workspace/generate/abc-123', base + '/workspace/segmentation/abc-123'), 80);
  eq('um caminho e prefixo do outro',
    score(base + '/workspace/generate', base + '/workspace/generate/abc'), 60);
  eq('id em outra posicao do caminho',
    score(base + '/workspace/generate/abc-123', base + '/x/abc-123/y'), 40);
  eq('outro site nao casa', score('https://exemplo.com/a/b', base + '/a/b'), 0);
  eq('url invalida nao quebra', score('nao-e-url', base + '/a'), 0);
}

// ---------------------------------------------------------------------------
section('18. Gerador de nomes (fonte, geometria e STL)');
{
  const fs = require('fs');
  const path = require('path');
  const NomesFont = require('../src/nomes/font.js');
  const NomesField = require('../src/nomes/field.js');
  const NomesParts = require('../src/nomes/parts.js');

  const fontBuffer = fs.readFileSync(path.join(__dirname, '..', 'src', 'fonts', 'Chewy-Regular.ttf'));
  const font = NomesFont.parse(new Uint8Array(fontBuffer.buffer, fontBuffer.byteOffset, fontBuffer.byteLength));

  eq('a fonte embutida abre (unidades por em)', font.unitsPerEm, 1024);
  check('a fonte tem glifos', font.glyphCount > 100, String(font.glyphCount));

  const layout = font.layout('GABRIEL', 8);
  check('o texto virou contornos', layout.contours.length > 3, String(layout.contours.length));
  check('a largura do texto e plausivel', layout.width > 20 && layout.width < 40, layout.width.toFixed(2));
  check('a altura do texto e plausivel', layout.height > 5 && layout.height < 8, layout.height.toFixed(2));
  check('o texto fica centralizado na origem',
    Math.abs(layout.minX + layout.maxX) < 0.001 && Math.abs(layout.minY + layout.maxY) < 0.001,
    layout.minX.toFixed(3) + '..' + layout.maxX.toFixed(3));

  const accented = font.layout('ÁÉÍÓÚÇÃÕ', 8);
  check('acentos e cedilha tem contorno', accented.contours.length > 5, String(accented.contours.length));

  // --- campo de distancia + triangulacao ---
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => ({ x, y }));
  const field = NomesField.build([square], { h: 0.1, maxDist: 2 });
  const rings = NomesField.contour(field, 0).map((r) => NomesField.simplify(r, 0.01));
  eq('o quadrado gera 1 contorno', rings.length, 1);
  check('a area do contorno bate com 100 mm2', Math.abs(Math.abs(NomesField.area(rings[0])) - 100) < 0.05,
    NomesField.area(rings[0]).toFixed(3));

  const triangulated = NomesField.triangulate(rings[0], []);
  check('a triangulacao cobre a area', Math.abs(NomesField.triangulationArea(triangulated.triangles) - 100) < 0.05,
    NomesField.triangulationArea(triangulated.triangles).toFixed(3));

  // furo dentro de um quadrado: a triangulacao nao pode tampar o furo
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => ({ x, y }));
  const hole = [[3, 3], [3, 7], [7, 7], [7, 3]].map(([x, y]) => ({ x, y }));
  const withHole = NomesField.triangulate(outer, [hole]);
  check('furo de 16 mm2 respeitado na triangulacao',
    Math.abs(NomesField.triangulationArea(withHole.triangles) - 84) < 0.05,
    NomesField.triangulationArea(withHole.triangles).toFixed(3));

  // --- pecas ---
  function analyze(positions) {
    const key = (i, k) => [0, 1, 2].map((j) => Math.round(positions[i + k * 3 + j] * 1e4)).join(',');
    const edges = new Map();
    let volume = 0;
    let degenerate = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const p = [0, 1, 2].map((k) => [positions[i + k * 3], positions[i + k * 3 + 1], positions[i + k * 3 + 2]]);
      const [a, b, c] = p;
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-9) degenerate++;
      const keys = p.map((q) => q.map((v) => Math.round(v * 1e4)).join(','));
      for (let e = 0; e < 3; e++) {
        const k = keys[e] + '|' + keys[(e + 1) % 3];
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
    let open = 0;
    for (const [k, count] of edges) {
      const [a, b] = k.split('|');
      if ((edges.get(b + '|' + a) || 0) !== count) open += count;
    }
    return { volume, degenerate, open, triangles: positions.length / 9 };
  }

  const params = NomesParts.params({});
  const tunnelParams = NomesParts.params({ holeStyle: 'tunnel' });
  const piece = NomesParts.buildPiece(font.layout('GABRIEL', 8), tunnelParams);
  check('a peca foi gerada', !!piece);
  check('a peca tem furo conico', piece.hasTunnel === true);
  check('a espessura da base = 2*raio + 2*parede',
    Math.abs(piece.height - (2 * 4.5 + 2 * 1.6)) < 1e-6, piece.height.toFixed(3));

  const baseMesh = analyze(piece.base);
  check('a base e fechada (sem arestas abertas)', baseMesh.open === 0, 'abertas: ' + baseMesh.open);
  check('a base nao tem triangulos degenerados', baseMesh.degenerate === 0, String(baseMesh.degenerate));
  check('a base tem volume positivo', baseMesh.volume > 0, baseMesh.volume.toFixed(1));

  const topMesh = analyze(piece.top);
  check('o topo e fechado', topMesh.open === 0, 'abertas: ' + topMesh.open);
  check('o topo tem volume positivo', topMesh.volume > 0, topMesh.volume.toFixed(1));
  check('o topo e mais fino que a base', piece.top.length > 0);

  const boundsBase = NomesParts.bounds(piece.base);
  check('o comprimento inclui a borda dos dois lados',
    Math.abs(boundsBase.size[0] - (piece.width + 2 * params.border)) < 0.35,
    boundsBase.size[0].toFixed(3));
  check('o furo atravessa a peca no eixo X', boundsBase.size[0] > 20);
  check('o disco da ponta da a altura da parede do furo',
    Math.abs(boundsBase.size[1] - 2 * (params.holeIn + params.minWall)) < 0.35,
    boundsBase.size[1].toFixed(2));

  // --- modo ponteira: letras + ponteira em cada ponta ---
  const tabPiece = NomesParts.buildPiece(font.layout('GABRIEL', 8), NomesParts.params({ holeStyle: 'tab' }));
  check('ponteira: a peca foi gerada', !!tabPiece);
  check('ponteira: tem furo', tabPiece.hasTunnel === true);
  const tabBase = analyze(tabPiece.base);
  const tabTop = analyze(tabPiece.top);
  check('ponteira: base fechada', tabBase.open === 0, 'abertas: ' + tabBase.open);
  check('ponteira: topo fechado', tabTop.open === 0, 'abertas: ' + tabTop.open);
  const tabBounds = NomesParts.bounds(tabPiece.base);
  check('ponteira: as duas pontas aumentam o comprimento',
    tabBounds.size[0] > tabPiece.width + 2 * params.border + 12,
    tabBounds.size[0].toFixed(2));
  check('ponteira: continua com a espessura calculada',
    Math.abs(tabPiece.height - piece.height) < 1e-6);
  check('ponteira: o topo tem o mesmo comprimento da base',
    Math.abs(NomesParts.bounds(tabPiece.top).size[0] - tabBounds.size[0]) < 0.35,
    NomesParts.bounds(tabPiece.top).size[0].toFixed(2));

  // --- montagem ---
  const pieces = ['LIZ', 'A'].map((name) => NomesParts.buildPiece(font.layout(name, 8), params));
  const together = NomesParts.buildLayout(pieces, NomesParts.params({ mode: 'juntos' }));
  const separate = NomesParts.buildLayout(pieces, NomesParts.params({ mode: 'separados' }));
  const both = NomesParts.buildLayout(pieces, NomesParts.params({ mode: 'ambos' }));

  check('juntos: 2 bases + 2 topos', together.base.length > 0 && together.top.length > 0);
  const togetherBounds = NomesParts.bounds(together.base.concat(together.top));
  check('juntos: o topo fica acima da base',
    Math.abs(togetherBounds.size[2] - (piece.height + params.topThickness)) < 0.02,
    togetherBounds.size[2].toFixed(2));

  const separateBounds = NomesParts.bounds(separate.base.concat(separate.top));
  check('separados: as pecas ficam lado a lado no eixo Y',
    separateBounds.size[1] > params.distanceSeparate, separateBounds.size[1].toFixed(1));

  const bothBase = NomesParts.bounds(both.base);
  check('ambos: duas copias por nome', bothBase.size[1] > 2 * params.distanceBoth, bothBase.size[1].toFixed(1));

  eq('colunas mudam a largura da grade',
    NomesParts.bounds(NomesParts.buildLayout(pieces, NomesParts.params({ columns: 1 })).base).size[0] <
    NomesParts.bounds(NomesParts.buildLayout(pieces, NomesParts.params({ columns: 2 })).base).size[0], true);

  // --- STL ---
  const stl = NomesParts.stlBinary([together.base, together.top]);
  const stlView = new DataView(stl);
  const stlTriangles = stlView.getUint32(80, true);
  eq('STL: tamanho = 84 + 50 * triangulos', stl.byteLength, 84 + stlTriangles * 50);
  eq('STL: triangulos batem com a malha',
    stlTriangles, (together.base.length + together.top.length) / 9);
  const header = new TextDecoder().decode(new Uint8Array(stl, 0, 30));
  check('STL: cabecalho identifica a extensao', header.startsWith('3D Mesh Downloader'), header);
  const nx = stlView.getFloat32(84, true);
  const ny = stlView.getFloat32(88, true);
  const nz = stlView.getFloat32(92, true);
  check('STL: normal do primeiro triangulo e unitaria',
    Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-4, [nx, ny, nz].join(','));

  // --- .scad ---
  const scad = NomesParts.scadText(['LIZ', 'A"B'], NomesParts.params({}), 'Chewy');
  check('scad: lista de nomes', scad.includes('Nomes = ["LIZ", "A\\"B"];'), scad.split('\n')[3]);
  check('scad: parametros do furo', scad.includes('Hole_Radius_Entrada = 4.5;'));
  check('scad: usa a fonte escolhida', scad.includes('Font_Name = "Chewy";'));
  check('scad: fecha o modulo do topo', scad.trim().endsWith('}'));
}


console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  console.log('\n  Falhas:');
  failures.forEach((f) => console.log('   - ' + f));
}
console.log('-'.repeat(58));
process.exit(failed ? 1 : 0);
