/**
 * Testes do Estúdio IA: kernel de geometria, medições, STL e ciclo do agente.
 *
 *   node test/ia.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Kernel = require('../src/ia/kernel.js');
const Field = require('../src/nomes/field.js');
const Font = require('../src/nomes/font.js');
const Agent = require('../src/ia/agent.js');
const Api = require('../src/ia/api.js');

const font = Font.parse(new Uint8Array(fs.readFileSync(path.join(__dirname, '../src/fonts/Chewy-Regular.ttf'))));
Kernel.configure({ Field, Font, font });
const K = Kernel.api();

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

function near(name, actual, expected, tolerance) {
  const delta = Math.abs(actual - expected);
  check(name, delta <= tolerance, 'esperado ' + expected + ', obtido ' + actual + ' (delta ' + delta + ')');
}

function section(title) {
  console.log('\n' + title);
}

function solidBox(w, d, h) {
  return K.box(w, d, h);
}

// ---------------------------------------------------------------------------

function testKernel() {
  section('Kernel: primitivas e medições');

  const box = Kernel.measure(solidBox(20, 10, 5).positions);
  near('caixa tem volume 1000 mm³', box.volume, 1000, 0.001);
  check('caixa é fechada', box.watertight);
  check('caixa tem 12 triângulos', box.triangles === 12);
  check('tamanho da caixa', box.size.join(',') === '20,10,5');

  const cyl = Kernel.measure(K.cylinder(5, 10, { segments: 96 }).positions);
  near('cilindro r5 h10 (96 lados)', cyl.volume, Math.PI * 25 * 10, 8);

  const hole = solidBox(20, 20, 10).subtract(K.cylinder(4, 20));
  const holeStats = Kernel.measure(hole.positions);
  near('caixa com furo passante', holeStats.volume, 20 * 20 * 10 - Math.PI * 16 * 10, 40);
  check('furo não deixa faces soltas', holeStats.nonManifoldEdges === 0);
  check('furo cabe dentro do tamanho', holeStats.size.join(',') === '20,20,10');

  const rounded = Kernel.measure(K.roundedBox(30, 30, 30, 3).positions);
  const a = 24, b = 24, c = 24, r = 3;
  const steiner = a * b * c + 2 * (a * b + a * c + b * c) * r +
    Math.PI * (a + b + c) * r * r + 4 / 3 * Math.PI * r * r * r;
  near('caixa arredondada segue Steiner', rounded.volume, steiner, 120);
  check('caixa arredondada tem menos de 30 arestas não-manifold', rounded.nonManifoldEdges < 30,
    String(rounded.nonManifoldEdges));

  const bed = K.onBed(K.box(20, 10, 4));
  const bedStats = Kernel.measure(bed.positions);
  check('onBed apoia em z=0', Math.abs(bedStats.min[2]) < 1e-6);
  check('onBed centraliza em x', Math.abs(bedStats.center[0]) < 1e-6 && Math.abs(bedStats.center[1]) < 1e-6);

  // regressão: transformações na forma de array (a forma documentada)
  const moved = Kernel.measure(solidBox(10, 10, 10).translate([30, 5, 2]).positions);
  check('translate([x,y,z]) desloca de verdade', Math.abs(moved.center[0] - 30) < 1e-6 &&
    Math.abs(moved.center[1] - 5) < 1e-6 && Math.abs(moved.center[2] - 2) < 1e-6);
  const rotated = Kernel.measure(solidBox(20, 2, 2).rotate([0, 0, 90]).positions);
  check('rotate([x,y,z]) gira de verdade', Math.abs(rotated.size[0] - 2) < 0.01 &&
    Math.abs(rotated.size[1] - 20) < 0.01);
  const scaled = Kernel.measure(solidBox(10, 10, 10).scale([2, 1, 0.5]).positions);
  check('scale([x,y,z]) escala de verdade', scaled.size.join(',') === '20,10,5');

  const lathe = Kernel.measure(K.lathe([[5, 0], [10, 0], [10, 20], [5, 20]], { segments: 96 }).positions);
  near('lathe de um tubo', lathe.volume, Math.PI * (100 - 25) * 20, 100);
  check('lathe é fechado', lathe.watertight);

  const loft = Kernel.measure(K.loft([
    { z: 0, points: K.circle(10, 96) },
    { z: 20, points: K.circle(5, 96) }
  ]).positions);
  near('loft de um tronco de cone', loft.volume, Math.PI * 20 / 3 * (100 + 50 + 25), 100);
  check('loft é fechado', loft.watertight);

  const swept = Kernel.measure(K.sweep([[0, 0, 0], [0, 0, 20]], { radius: 5, segments: 96 }).positions);
  near('sweep de um cilindro', swept.volume, Math.PI * 25 * 20, 100);
  check('sweep é fechado', swept.watertight);

  const tapered = Kernel.measure(K.sweep([[0, 0, 0], [0, 0, 20]], {
    radius: 4,
    segments: 96,
    radii: [4, 3]
  }).positions);
  near('sweep com radii absolutos afina', tapered.volume, Math.PI * 20 / 3 * (16 + 12 + 9), 100);

  const merged = Kernel.measure(K.merge(solidBox(10, 10, 10), solidBox(10, 10, 10).translate([20, 0, 0])).positions);
  check('merge soma os volumes', Math.abs(merged.volume - 2000) < 1e-6);

  const left = solidBox(10, 10, 10);
  const right = solidBox(10, 10, 10).translate([12, 0, 0]);
  const pinStats = Kernel.measure(K.connector(left, right, { from: [5, 0, 0], to: [7, 0, 0], radius: 2, overlap: 1.5 }).positions);
  check('connector atravessa o vão', pinStats.size[0] >= 4.9, String(pinStats.size[0]));
  check('connector é fechado', pinStats.watertight);

  const bridged = Kernel.measure(K.bridge(left, right, { from: [5, 0, 0], to: [7, 0, 0], radius: 2, overlap: 1.5 }).positions);
  check('bridge une as duas caixas', bridged.volume > 2000 && bridged.size[0] === 22);

  const many = Kernel.measure(K.connectors([left, right, solidBox(10, 10, 10).translate([24, 0, 0])], {
    radius: 2,
    overlap: 1.5
  }).positions);
  check('connectors cria pinos para a árvore', many.triangles > 0);

  const auto = Kernel.connectParts([left, right], { overlap: 2 });
  check('connectParts detecta a junta', auto.joints.length === 1 && auto.positions.length > 0);
  check('connectParts informa o vão', auto.joints[0].gap > 0 && auto.joints[0].gap < 8);
  check('connectParts devolve o pino e o alvo', auto.pins.length === 1 &&
    auto.pins[0].positions.length > 0 &&
    (auto.pins[0].targetPart === 0 || auto.pins[0].targetPart === 1));

  const touching = Kernel.connectParts([left, solidBox(10, 10, 10).translate([10, 0, 0])]);
  check('peças encostadas não recebem pino', touching.joints.length === 0);

  const chain = Kernel.connectParts([left, right, solidBox(10, 10, 10).translate([24, 0, 0])]);
  check('connectParts conecta a cadeia inteira', chain.joints.length >= 2);

  const legs = K.merge(
    solidBox(6, 6, 10).translate([-12, 0, 10]),
    solidBox(6, 6, 10).translate([12, 0, 10])
  );
  check('splitShells separa duas pernas', Kernel.splitShells(legs.positions).length === 2);
  const base = solidBox(40, 40, 4);
  const legsAuto = Kernel.connectParts([
    { name: 'base', solid: base },
    { name: 'patas', solid: legs }
  ], { overlap: 2 });
  check('connectParts liga cada perna separadamente', legsAuto.pins.length === 2);
  check('pinos das pernas vão para a parte patas', legsAuto.pins.every(function (pin) {
    return pin.targetPart === 1;
  }));

  const mergedShells = K.merge(solidBox(20, 20, 20), solidBox(10, 10, 10));
  const contained = Kernel.connectParts([
    { name: 'a', solid: mergedShells },
    { name: 'b', solid: solidBox(5, 5, 5).translate([22, 0, 0]) }
  ], { overlap: 2 });
  check('casca interna não gera pino extra', contained.pins.length === 1);

  const maleThread = Kernel.measure(K.thread(20, 2, 10).positions);
  check('rosca macho gera malha', maleThread.triangles > 1000 && maleThread.volume > 0);
  const femaleThread = Kernel.measure(K.thread(20, 2, 10, { internal: true, wall: 3 }).positions);
  check('rosca fêmea gera malha', femaleThread.triangles > 2000 && femaleThread.volume > 0);
  check('rosca fêmea tem furo', femaleThread.volume < Math.PI * 13 * 13 * 10);

  const removableParts = Kernel.normalizeParts({
    parts: [{ name: 'tampa', solid: solidBox(10, 10, 2), removable: true }]
  });
  check('normalizeParts preserva removable', removableParts.parts[0].removable === true);
  const removableAuto = Kernel.connectParts([
    { name: 'corpo', solid: solidBox(20, 20, 10) },
    { name: 'tampa', solid: solidBox(10, 10, 2).translate([0, 0, 7]), removable: true }
  ], { overlap: 2 });
  check('peça removível não recebe pino', removableAuto.pins.length === 0 && removableAuto.loose.length === 0);

  const organic = K.lathe([[0, 0], [18, 0], [24, 12], [16, 32], [20, 50], [0, 52]], { segments: 48 })
    .union(K.sweep([[24, 0, 20], [38, 0, 28], [26, 0, 44]], { radius: 3, segments: 24 }));
  check('corpo orgânico composto gera malha', Kernel.measure(organic.positions).triangles > 500);

  const model = Kernel.normalizeParts({
    name: 'Duas peças',
    parts: [
      { name: 'a', color: '#ff0000', solid: K.box(10, 10, 10) },
      { name: 'b', color: '#00ff00', solid: K.box(5, 5, 5).translate(20, 0, 0) }
    ]
  });
  check('normalizeParts mantém nome', model.name === 'Duas peças');
  check('normalizeParts mantém duas peças', model.parts.length === 2);
  check('normalizeParts mantém cor', model.parts[0].color === '#ff0000');
  check('normalizeParts converte para Float32Array', model.parts[0].positions instanceof Float32Array);

  const stl = Kernel.stlBinary(model.parts.map((p) => p.positions), 'teste');
  check('STL tem cabeçalho + facets', stl.byteLength === 84 + (12 + 12) * 50,
    String(stl.byteLength));
  const view = new DataView(stl);
  check('STL declara 24 triângulos', view.getUint32(80, true) === 24);
}

function testText() {
  section('Kernel: texto');
  const letters = K.text('AB', { size: 10, height: 3, quality: 0.35 });
  const stats = Kernel.measure(letters.positions);
  check('texto gera triângulos', stats.triangles > 100, String(stats.triangles));
  check('texto tem volume', stats.volume > 1);
  check('texto fica fechado', stats.watertight);
  check('texto tem altura 3', Math.abs(stats.size[2] - 3) < 0.001);

  const names = K.text('A', { size: 8, height: 2 });
  const cut = names.subtract(K.box(40, 40, 1).translate(0, 0, 0.6));
  check('texto pode ser cortado por booleanas', Kernel.measure(cut.positions).triangles > 0);
}

// ---------------------------------------------------------------------------

function testApi() {
  section('API: catálogo de modelos');
  check('modelo principal padrão é DeepSeek V4.1 Flash', Api.DEFAULT_MODEL === 'deepseek-v4.1-flash');
  check('inspetor padrão é GPT 5.6 Luna', Api.DEFAULT_VISION_MODEL === 'gpt-5.6-luna');
  check('modelo principal usa chat/completions',
    Api.modelInfo('deepseek-v4.1-flash').protocol === 'chat');
  check('modelo de visão usa Responses', Api.modelInfo('gpt-5.6-luna').protocol === 'responses');
  check('modelo de visão marca vision', Api.modelInfo('gpt-5.6-luna').vision === true);
  check('modelos principais não incluem visão',
    Api.mainModels().every((m) => !m.vision));
  check('endereço base normalizado', Api.normalizeBase('opencode.ai/x/') === 'https://opencode.ai/x');
}

async function testAgent() {
  section('Agente: ciclo de ferramentas e streaming');

  const events = [];
  let runCalls = [];
  let apiCalls = 0;

  const host = {
    getSettings: () => ({
      apiKey: 'test',
      baseUrl: 'https://example.test/v1',
      model: 'deepseek-v4.1-flash',
      maxSteps: 6,
      sessionId: 'ses-test'
    }),
    describeContext: () => 'Objeto atual: teste',
    runGeometry: (code, meta) => {
      runCalls.push({ code: code, meta: meta });
      return Promise.resolve({
        stats: { size: [10, 10, 10], volume: 1000, triangles: 12, parts: [] },
        logs: '',
        ms: 5,
        images: [{ view: 'top', dataUrl: 'data:image/jpeg;base64,x' }],
        report: 'Laudo: cubo fechado e centrado.'
      });
    },
    captureViews: () => Promise.resolve({ images: [], report: 'Laudo extra.' }),
    inspectGeometry: () => Promise.resolve({ text: 'ok', stats: null }),
    listObjects: () => Promise.resolve('vazio'),
    loadObject: () => Promise.resolve({ text: 'ok' }),
    saveObject: () => Promise.resolve('ok'),
    saveMemory: () => Promise.resolve('ok'),
    planParts: () => Promise.resolve('plano ok'),
    onEvent: (type, payload) => events.push({ type, payload })
  };

  const fakeApi = {
    chat: async (options) => {
      apiCalls++;
      if (apiCalls === 1) {
        options.onDelta('Vou criar ');
        options.onDelta('o cubo.');
        return {
          role: 'assistant',
          content: 'Vou criar o cubo.',
          toolCalls: [{
            id: 'call_1',
            name: 'run_geometry',
            arguments: { code: 'return K.onBed(K.box(10,10,10));', name: 'Cubo' }
          }]
        };
      }
      options.onDelta('Pronto.');
      return { role: 'assistant', content: 'Pronto.', toolCalls: [] };
    }
  };

  const agent = Agent.create(host, fakeApi);
  const answer = await agent.send('Faça um cubo');
  check('agente terminou com a resposta final', answer === 'Pronto.');
  check('agente chamou run_geometry uma vez', runCalls.length === 1);
  check('run_geometry recebeu o script', runCalls[0].code.includes('K.box'));
  check('agente fez duas chamadas à API', apiCalls === 2);

  const types = events.map((e) => e.type);
  check('eventos de streaming foram emitidos', types.includes('assistant_start') &&
    types.includes('assistant_delta') && types.includes('assistant_end'));
  check('evento tool_start foi emitido', types.includes('tool_start'));
  check('evento tool foi emitido', types.includes('tool'));
  const toolEvent = events.find((e) => e.type === 'tool');
  check('ferramenta recebeu o laudo do inspetor', toolEvent.payload.report.includes('Laudo: cubo'));
  check('ferramenta recebeu as capturas', toolEvent.payload.images.length === 1);
  check('status terminou em pronto', events.some((e) => e.type === 'status' && e.payload.phase === 'done'));

  const history = agent.exportHistory();
  check('histórico guarda o pedido do usuário', history[0].content === 'Faça um cubo');
  check('histórico tem resposta final', history[history.length - 1].content === 'Pronto.');
  check('histórico não guarda tool results', history.every((m) => m.role !== 'tool'));

  const second = Agent.create(host, {
    chat: async () => ({ role: 'assistant', content: 'Olá', toolCalls: [] })
  });
  await second.send('oi');
  check('segunda conversa começa limpa', second.exportHistory().length === 2);
}

async function testAgentPlan() {
  section('Agente: decomposição em partes');

  let planArgs = null;
  let focusReceived = null;
  let searchArgs = null;
  let calls = 0;

  const host = {
    getSettings: () => ({
      apiKey: 'test',
      baseUrl: 'https://example.test/v1',
      model: 'deepseek-v4.1-flash',
      maxSteps: 8,
      sessionId: 'ses-test'
    }),
    describeContext: () => 'Objeto atual: dragão',
    searchReference: (query, count) => {
      searchArgs = { query: query, count: count };
      return Promise.resolve({
        text: 'Referências para "' + query + '": 1 imagem.\n\nLaudo da referência',
        images: [],
        report: 'Laudo da referência'
      });
    },
    planParts: (parts) => {
      planArgs = parts;
      return Promise.resolve('Plano registrado');
    },
    runGeometry: (code, meta) => {
      focusReceived = meta.focus;
      return Promise.resolve({
        stats: {
          size: [70, 20, 40],
          volume: 12000,
          triangles: 5000,
          parts: [{ name: 'corpo', size: [70, 20, 40], volume: 12000, triangles: 5000 }]
        },
        logs: '',
        ms: 30,
        images: [],
        report: 'Laudo: corpo orgânico ok.',
        focusPart: { name: 'corpo', size: [70, 20, 40], volume: 12000, triangles: 5000 }
      });
    },
    captureViews: () => Promise.resolve({ images: [], report: '' }),
    inspectGeometry: () => Promise.resolve({ text: 'ok', stats: null }),
    listObjects: () => Promise.resolve(''),
    loadObject: () => Promise.resolve({ text: '' }),
    saveObject: () => Promise.resolve('ok'),
    saveMemory: () => Promise.resolve('ok'),
    onEvent: () => {}
  };

  const fakeApi = {
    chat: async () => {
      calls++;
      if (calls === 1) {
        return {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'ref_1',
            name: 'search_reference',
            arguments: { query: 'dragon statue', count: 2 }
          }]
        };
      }
      if (calls === 2) {
        return {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'plan_1',
            name: 'plan_parts',
            arguments: { parts: [{ name: 'base' }, { name: 'corpo' }, { name: 'asas' }] }
          }]
        };
      }
      if (calls === 3) {
        return {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'run_1',
            name: 'run_geometry',
            arguments: { code: 'return K.onBed(K.box(1,1,1));', focus: 'corpo' }
          }]
        };
      }
      return { role: 'assistant', content: 'Corpo pronto.', toolCalls: [] };
    }
  };

  const agent = Agent.create(host, fakeApi);
  const answer = await agent.send('Crie um dragão');
  check('search_reference recebeu a consulta', searchArgs && searchArgs.query === 'dragon statue');
  check('plan_parts recebeu as três partes', planArgs && planArgs.length === 3);
  check('run_geometry recebeu focus="corpo"', focusReceived === 'corpo');
  check('agente terminou o ciclo por partes', answer === 'Corpo pronto.');
  check('histórico registra o pedido e a resposta', agent.exportHistory().length === 2);
}

function main() {
  testKernel();
  testText();
  testApi();
  return testAgent().then(testAgentPlan).then(function () {
    console.log('\n' + passed + ' passaram, ' + failed + ' falharam');
    if (failed) {
      console.log('\nFalhas:');
      failures.forEach((f) => console.log(' - ' + f));
      process.exit(1);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
