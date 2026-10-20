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
console.log('\n' + '-'.repeat(58));
console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failures.length) {
  console.log('\n  Falhas:');
  failures.forEach((f) => console.log('   - ' + f));
}
console.log('-'.repeat(58));
process.exit(failed ? 1 : 0);
