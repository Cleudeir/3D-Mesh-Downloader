/**
 * Agente de geometria: ciclo de conversa com ferramentas.
 *
 * O agente escreve scripts, executa no worker, recebe as medidas e as
 * capturas (topo, baixo, perspectiva, frente, lados) e corrige o que fez.
 * Toda a parte de interface fica no `host` injetado pela página.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./api.js'));
  } else {
    root.IaAgent = factory(root.IaApi);
  }
})(typeof self !== 'undefined' ? self : this, function (Api) {
  'use strict';

  var DEFAULT_STEPS = 50;

  var VIEWS = ['perspective', 'top', 'bottom', 'front', 'back', 'left', 'right'];
  var VIEW_LABEL = {
    perspective: 'perspectiva',
    top: 'topo',
    bottom: 'baixo',
    front: 'frente',
    back: 'trás',
    left: 'esquerda',
    right: 'direita'
  };

  var TOOLS = [
    {
      type: 'function',
      function: {
        name: 'run_geometry',
        description: 'Executa um script JavaScript de geometria no kernel e atualiza a peça na tela. ' +
          'Sempre use esta ferramenta para gerar ou alterar o modelo. Retorna as medidas (mm), o volume, ' +
          'os avisos de malha, os logs e um laudo do inspetor de visão sobre as capturas.',
        parameters: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'Script completo (não um diff). Deve retornar um Solid, uma lista de Solids ou {name, parts:[{name,color,solid}]}.'
            },
            name: { type: 'string', description: 'Nome curto do objeto (ex.: "Caixa organizadora").' },
            description: { type: 'string', description: 'O que a peça é, em uma frase.' },
            notes: { type: 'string', description: 'Decisões de projeto para lembrar depois (medidas, folgas, restrições).' },
            focus: { type: 'string', description: 'Nome exato de uma parte do modelo para isolar e inspecionar nesta execução. O inspetor verá só ela.' }
          },
          required: ['code']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_reference',
        description: 'Busca imagens reais de referência na web (Wikimedia Commons) e recebe um laudo visual ' +
          'delas. Use ANTES de modelar um objeto novo, com uma consulta curta em inglês ' +
          '(ex.: "kettlebell jewelry box"). Não repita a busca para o mesmo objeto.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Consulta curta em inglês.' },
            count: { type: 'integer', minimum: 1, maximum: 4, description: 'Quantidade de imagens (padrão 3).' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'plan_parts',
        description: 'Registra o plano de decomposição de um objeto complexo em partes. Chame antes de construir ' +
          'e use os mesmos nomes nas partes do script e no argumento "focus" de run_geometry. ' +
          'O plano aparece na interface e guia a construção por partes.',
        parameters: {
          type: 'object',
          properties: {
            parts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Nome curto e único (ex.: "corpo", "asa esquerda").' },
                  description: { type: 'string', description: 'O que essa parte é e como ela se encaixa.' }
                },
                required: ['name']
              }
            }
          },
          required: ['parts']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'capture_views',
        description: 'Gera novas capturas do modelo atual e recebe um novo laudo do inspetor de visão. ' +
          'Use quando precisar conferir outro ângulo ou um detalhe específico.',
        parameters: {
          type: 'object',
          properties: {
            views: {
              type: 'array',
              items: { type: 'string', enum: VIEWS },
              description: 'Ângulos desejados. Padrão: perspectiva, topo, frente, direita, baixo.'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'inspect_geometry',
        description: 'Consulta as medidas e a malha do objeto atual sem alterar nada.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_objects',
        description: 'Lista os objetos já criados (memória do estúdio), com nome, descrição e medidas.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'load_object',
        description: 'Lê o script e as medidas de um objeto da biblioteca (somente leitura; não troca a conversa atual). ' +
          'Use para reaproveitar ou adaptar uma solução já criada.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID do objeto retornado por list_objects.' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_object',
        description: 'Atualiza nome, descrição e anotações do objeto atual na biblioteca.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            notes: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_memory',
        description: 'Guarda uma preferência ou convenção do usuário para os próximos objetos ' +
          '(ex.: "paredes de 1,6 mm", "furos sempre com 0,3 mm de folga").',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'Uma frase curta.' }
          },
          required: ['note']
        }
      }
    }
  ];

  function systemPrompt(context) {
    return [
      'Você é o agente de geometria do "Estúdio IA" de uma extensão de impressão 3D.',
      'Sua especialidade é transformar pedidos em geometria paramétrica sólida, bonita e imprimível em FDM.',
      '',
      '## Regras',
      '- Unidades: milímetros. Z para cima. A cena mostra a mesa em z=0; use K.onBed(...) para apoiar a peça.',
      '- Sempre chame run_geometry antes de dizer que a peça está pronta. Nunca invente medidas: use o retorno.',
      '- Depois de executar, leia o laudo do inspetor de visão e as medidas. Se a forma não corresponde ao pedido, corrija e execute de novo.',
      '- O laudo visual é a verdade sobre a forma; as medidas são a verdade sobre o tamanho. Confira as duas.',
      '- Você não recebe as imagens: um inspetor multimodal barato olha as capturas e escreve o laudo. ' +
        'Se precisar de outro ângulo, chame capture_views.',
      '- Peças para FDM: paredes >= 1,2 mm, fundo >= 1,2 mm, folgas de 0,3 mm entre peças móveis, ' +
        'evite balanços acima de 60°, mantenha a base plana. Furos pequenos: >= 1,5 mm.',
      '- Prefira peças úteis e bem proporcionadas. Arredonde cantos que serão tocados.',
      '- Não se limite a caixas e cilindros: trate cada pedido como um objeto 3D completo, com silhueta,',
      '  volumes principais, formas secundárias e detalhes. A complexidade acompanha o pedido (um cubo',
      '  com furo continua sendo um cubo com furo; uma criatura ou um vaso não).',
      '- Estratégia para objetos orgânicos: bloquear o volume com lathe/loft, acrescentar membros,',
      '  pescoços, caudas e chifres com sweep, asas e barbatanas com prism, cortar com subtract e',
      '  compor 5 a 20 formas. Detalhes pequenos (olhos, garras, anéis) podem ser peças separadas.',
      '- Use .union quando precisar de um sólido único; .merge para juntar detalhes decorativos sem',
      '  pagar o custo das booleanas (as cascas podem se sobrepor, o fatiador resolve).',
      '- Objetos complexos: antes do primeiro script, chame plan_parts com 4 a 8 partes.',
      '- Antes de começar um objeto novo/complexo, chame search_reference com uma consulta curta em inglês',
      '  (ex.: "kettlebell jewelry box", "dragon statue") e use o laudo visual para silhueta e proporções.',
      '  Uma referência por objeto; não repita a busca a cada iteração.',
      '- Peças que devem ser removíveis/roscadas/encaixadas (tampa, gaveta, articulação) precisam de',
      '  removable: true na parte. O pipeline não cria pino entre elas; a rosca/encaixe é o único vínculo.',
      '- Construa por partes: cada parte lógica é um item separado em parts, com o mesmo nome do plano.',
      '  Use union/merge dentro da parte. Para inspecionar uma parte, passe focus com o nome dela:',
      '  o inspetor recebe as capturas isoladas daquela parte. No final, rode sem focus para ver o conjunto.',
      '- Ordem sugerida: base/volume principal → membros e apêndices → detalhes e acabamento.',
      '- Não tente resolver uma criatura inteira de uma vez: 4 a 8 execuções focadas rendem mais que uma gigante.',
      '- O pipeline conecta as peças automaticamente: calcula o contato real e adiciona uma parte "juntas"',
      '  com pinos de raio automático. Não crie pinos manuais; foque em posicionar e sobrepor as peças.',
      '  Use K.bridge(a,b) apenas quando quiser um sólido único estrutural.',
      '- Se o retorno listar "peças soltas" (vão maior que 20 mm), aproxime-as ou use K.bridge com from/to.',
      '- Antes de dizer que está pronto, confira no laudo se pescoço↔corpo, asas↔costas, cauda↔corpo,',
      '  patas↔base e chifres/olhos↔cabeça estão ligados. Se o inspetor apontar vão, adicione conector e execute de novo.',
      '- Use PARAMS no topo do script para as medidas principais.',
      '- Seja econômico: 1 a 3 iterações costumam bastar. Não repita o script inteiro na resposta.',
      '- Não escreva um plano longo antes de agir: pense no essencial e chame run_geometry.',
      '- Mantenha o script enxuto (até ~180 linhas), usando funções e loops em vez de repetir blocos.',
      '- Responda SEMPRE em português do Brasil, inclusive nas frases curtas antes de chamar uma ferramenta,',
      '  nos nomes e descrições das peças e no resumo final. Nunca responda em inglês.',
      '- Resumo curto no fim: o que fez, medidas finais e avisos.',
      '- Se o pedido for ambíguo, escolha uma interpretação razoável e diga qual foi, em vez de parar para perguntar.',
      '- A biblioteca de objetos é sua memória. Reaproveite scripts com load_object quando fizer sentido.',
      '',
      '## API do kernel (JavaScript, tudo em mm)',
      'Primitivas (centradas na origem):',
      '  K.box(largura, profundidade, altura)',
      '  K.roundedBox(largura, profundidade, altura, raio)  // cantos e arestas arredondados',
      '  K.cylinder(raio, altura, {segments})',
      '  K.cone(raioBase, raioTopo, altura, {segments})',
      '  K.sphere(raio, {segments, rings})',
      '  K.torus(raioMaior, raioDoTubo, {segments, rings})',
      '  K.tube(raioExterno, raioInterno, altura)',
      '  K.prism(contorno, altura, {holes})   // contorno: [[x,y],...] ou [{outer,holes}]',
      '  K.lathe(perfil, {segments})          // perfil fechado [[r,z],...] girado em torno de Z',
      '  K.loft(aneis, {caps})                // [{z, points:[[x,y],...]}, ...] ou [[[x,y,z],...],...]',
      '  K.sweep(caminho, {radius, segments, radii}) // caminho 3D [[x,y,z],...]; radii = raio absoluto por ponto (perfil circular)',
      '  K.merge(...)                         // junta sólidos sem remover faces internas (rápido)',
      '  K.thread(d, passo, comprimento, {internal, wall, clearance, depth}) // rosca pronta no eixo Z',
      '  K.connector(a, b, {radius, overlap, from, to}) // pino que liga duas peças (só o pino)',
      '  K.connectors([...], {radius, overlap}) // pinos em árvore ligando todas as peças',
      '  K.bridge(a, b, {radius, overlap})      // une duas peças com o pino (um sólido único)',
      '  K.circle(raio, segmentos) / K.ellipse(rx, ry, segmentos) // anéis 2D para loft/prism',
      '  K.text("ABC", {size, height, quality})  // fonte Chewy, sem acentos fora do latim',
      '',
      'Transformações (retornam novo sólido):',
      '  .translate([x,y,z])  .rotate([rx,ry,rz]) // graus, X depois Y depois Z',
      '  .scale([sx,sy,sz])   .mirror("x"|"y"|"z")',
      '',
      'Booleanas (aceitam vários sólidos): .union(...), .subtract(...), .intersect(...).',
      'Sem CSG: .merge(...) concatena as malhas (bom para detalhes sobrepostos).',
      'Utilitários: K.onBed(valor) apoia em z=0 e centraliza em x/y; K.bounds(s), K.measure(s).',
      '',
      'Formatos de retorno aceitos: um Solid, uma lista de Solids, ou',
      '  return { name: "Caixa", parts: [ {name:"corpo", color:"#5b6cff", solid: corpo}, ... ] };',
      'Cores em hexadecimal. Cada peça vira uma cor na tela; o STL junta tudo.',
      '',
      'Exemplo completo:',
      '```js',
      'const P = { w: 80, d: 50, h: 22, wall: 2, r: 4, lid: 3 };',
      'const fora = K.roundedBox(P.w, P.d, P.h, P.r);',
      'const dentro = K.roundedBox(P.w - 2*P.wall, P.d - 2*P.wall, P.h, P.r)',
      '  .translate([0, 0, P.wall]);',
      'const corpo = fora.subtract(dentro).subtract(',
      '  K.box(P.w + 4, 16, 6).translate([0, 0, P.h/2 + 1])',
      ');',
      'const tampa = K.roundedBox(P.w, P.d, P.lid, P.r).translate([0, 0, P.h/2 + 14]);',
      'return K.onBed({',
      '  name: "Caixa com tampa",',
      '  parts: [',
      '    { name: "corpo", color: "#5b6cff", solid: corpo },',
      '    { name: "tampa", color: "#ffb020", solid: tampa }',
      '  ]',
      '});',
      '```',
      '',
      'Exemplo orgânico (vaso com alça, usando revolução + varredura):',
      '```js',
      'const perfil = [[0,0],[20,0],[26,10],[20,30],[24,48],[14,62],[0,64]];',
      'const corpo = K.lathe(perfil, { segments: 64 });',
      'const alca = K.sweep([[24,0,20],[38,0,30],[24,0,46]], { radius: 3.2, segments: 24 });',
      'return K.onBed({',
      '  name: "Vaso com alça",',
      '  parts: [',
      '    { name: "corpo", color: "#5b6cff", solid: corpo.union(alca) },',
      '    { name: "aro", color: "#ffb020", solid: K.torus(6, 1.2).translate([0,0,64]) }',
      '  ]',
      '});',
      '```',
      '',
      'Observações: booleanas produzem "junções T" (boundaryEdges > 0) — isso é normal e não impede imprimir. ' +
        'Preocupe-se com volume > 0 e com formas visivelmente erradas nas capturas.',
      '',
      '## Estado atual do estúdio',
      context || '(sem objeto)'
    ].join('\n');
  }

  function create(host, apiOverride) {
    var client = apiOverride || Api;
    var history = [];
    var controller = null;
    var running = false;

    function emit(type, payload) {
      if (host.onEvent) host.onEvent(type, payload || {});
    }

    function settings() {
      var s = host.getSettings ? host.getSettings() : {};
      return s || {};
    }

    function toolResult(name, args, result) {
      var payload = result || {};
      var text = payload.text || '';
      if (payload.error) text = 'ERRO: ' + payload.error;
      emit('tool', {
        name: name,
        args: args || {},
        ok: !payload.error,
        text: text,
        detail: payload.detail || '',
        stats: payload.stats || null,
        images: payload.images || null,
        report: payload.report || null
      });
      return {
        ok: !payload.error,
        text: text,
        images: payload.images || null,
        detail: payload.detail || ''
      };
    }

    async function runTool(call) {
      var args = call.arguments || {};
      try {
        if (call.name === 'run_geometry') {
          if (!args.code || typeof args.code !== 'string') {
            return toolResult(call.name, args, { error: 'faltou o campo "code" com o script' });
          }
          emit('status', { phase: 'run', label: 'executando o script' });
          var run = await host.runGeometry(args.code, {
            name: args.name,
            description: args.description,
            notes: args.notes,
            focus: args.focus
          });
          var parts = run.stats && run.stats.parts ? run.stats.parts : [];
          var summary = [
            'Script executado' + (run.stats ? ' em ' + run.ms + ' ms' : '') + '.',
            run.stats ? 'medidas: ' + fmtSize(run.stats.size) : '',
            run.stats ? 'volume: ' + fmt(run.stats.volume) + ' mm³' : '',
            run.stats ? 'triângulos: ' + run.stats.triangles : '',
            run.stats ? 'peças: ' + parts.map(function (p) {
              return p.name + ' (' + fmtSize(p.size) + ', ' + fmt(p.volume) + ' mm³)';
            }).join('; ') : '',
            run.stats && run.stats.joints && run.stats.joints.length
              ? 'juntas automáticas: ' + run.stats.joints.length + ' pinos (' +
                run.stats.joints.map(function (j) {
                  return j.a + '↔' + j.b + ' ' + j.gap + ' mm';
                }).join('; ') + ')'
              : '',
            run.stats && run.stats.loose && run.stats.loose.length
              ? 'ATENÇÃO peças soltas: ' + run.stats.loose.map(function (j) {
                return j.a + '↔' + j.b + ' (' + j.gap + ' mm)';
              }).join('; ')
              : '',
            run.focusPart ? 'parte em foco: ' + run.focusPart.name + ' (' + fmtSize(run.focusPart.size) + ', ' +
              fmt(run.focusPart.volume) + ' mm³, ' + run.focusPart.triangles + ' triângulos) — as capturas mostram só ela' : '',
            run.focusMissing ? 'ATENÇÃO: não existe parte chamada "' + run.focusMissing +
              '". Use um dos nomes listados em "peças".' : '',
            run.stats ? 'malha: boundaryEdges=' + run.stats.boundaryEdges +
              ', nonManifoldEdges=' + run.stats.nonManifoldEdges : '',
            run.logs ? 'logs:\n' + run.logs : '',
            run.report ? '\nLaudo do inspetor de visão:\n' + run.report : ''
          ].filter(Boolean).join('\n');
          return toolResult(call.name, args, {
            text: summary,
            detail: summary,
            stats: run.stats,
            images: run.images || null,
            report: run.report || null
          });
        }

        if (call.name === 'capture_views') {
          emit('status', { phase: 'capture', label: 'tirando capturas' });
          var views = Array.isArray(args.views) && args.views.length ? args.views : null;
          var capture = await host.captureViews(views);
          var captureText = 'Capturas prontas: ' + capture.images.map(function (img) {
            return VIEW_LABEL[img.view] || img.view;
          }).join(', ') + '.' +
            (capture.report ? '\n\nLaudo do inspetor de visão:\n' + capture.report : '');
          return toolResult(call.name, args, {
            text: captureText,
            images: capture.images,
            report: capture.report || null
          });
        }

        if (call.name === 'inspect_geometry') {
          var info = await host.inspectGeometry();
          return toolResult(call.name, args, { text: info.text, stats: info.stats });
        }

        if (call.name === 'list_objects') {
          var objects = await host.listObjects();
          return toolResult(call.name, args, { text: objects });
        }

        if (call.name === 'load_object') {
          if (!args.id) return toolResult(call.name, args, { error: 'faltou "id"' });
          emit('status', { phase: 'load', label: 'carregando objeto' });
          var loaded = await host.loadObject(args.id);
          return toolResult(call.name, args, {
            text: loaded && loaded.text ? loaded.text : String(loaded || ''),
            stats: loaded && loaded.stats ? loaded.stats : null
          });
        }

        if (call.name === 'save_object') {
          var saved = await host.saveObject(args);
          return toolResult(call.name, args, { text: saved });
        }

        if (call.name === 'save_memory') {
          if (!args.note) return toolResult(call.name, args, { error: 'faltou "note"' });
          var memory = await host.saveMemory(args.note);
          return toolResult(call.name, args, { text: memory });
        }

        if (call.name === 'search_reference') {
          if (!args.query) return toolResult(call.name, args, { error: 'faltou "query"' });
          emit('status', { phase: 'reference', label: 'buscando referência' });
          var reference = await host.searchReference(args.query, args.count);
          return toolResult(call.name, args, {
            text: reference.text,
            images: reference.images,
            report: reference.report
          });
        }

        if (call.name === 'plan_parts') {
          if (!Array.isArray(args.parts) || !args.parts.length) {
            return toolResult(call.name, args, { error: 'faltou a lista "parts"' });
          }
          emit('status', { phase: 'plan', label: 'planejando as partes' });
          var planText = await host.planParts(args.parts);
          return toolResult(call.name, args, { text: planText });
        }

        return toolResult(call.name, args, { error: 'ferramenta desconhecida: ' + call.name });
      } catch (error) {
        return toolResult(call.name, args, {
          error: error && error.message ? error.message : String(error)
        });
      }
    }

    function wireMessage(message) {
      var out = { role: 'assistant', content: message.content || '' };
      if (message.toolCalls && message.toolCalls.length) {
        out.tool_calls = message.toolCalls.map(function (call) {
          return {
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments || {})
            }
          };
        });
        if (!out.content) out.content = null;
      }
      return out;
    }

    /** Mantém o histórico curto. */
    function compacted() {
      var list = history;
      if (list.length > 26) {
        var cut = list.length - 24;
        list = [list[0]].concat(list.slice(cut));
      }
      return list;
    }

    async function send(text) {
      if (running) throw new Error('o agente já está trabalhando');
      history.push({ role: 'user', content: String(text || '') });
      return runLoop();
    }

    /** Repete o ciclo com o mesmo histórico (timeout/erro de rede). */
    async function retry() {
      if (running) throw new Error('o agente já está trabalhando');
      if (!history.length) throw new Error('não há pedido para repetir');
      return runLoop();
    }

    async function runLoop() {
      if (running) throw new Error('o agente já está trabalhando');
      running = true;
      controller = new AbortController();
      var config = settings();
      var maxSteps = Math.max(1, Math.min(50, Number(config.maxSteps) || DEFAULT_STEPS));

      emit('status', { phase: 'think', label: 'pensando' });

      try {
        for (var step = 0; step < maxSteps; step++) {
          if (!controller || controller.signal.aborted) throw new Error('cancelado');
          var context = host.describeContext ? await host.describeContext() : '';
          var messages = [{ role: 'system', content: systemPrompt(context) }].concat(compacted());

          var streamed = '';
          var startedStream = false;
          var message = await client.chat({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
            messages: messages,
            tools: TOOLS,
            signal: controller.signal,
            sessionId: config.sessionId || 'studio-geometria',
            timeout: config.timeout || 300000,
            reasoningEffort: config.effort || 'low',
            onDelta: function (chunk) {
              if (!chunk) return;
              if (!startedStream) {
                startedStream = true;
                emit('assistant_start', {});
                emit('status', { phase: 'reply', label: 'respondendo' });
              }
              streamed += chunk;
              emit('assistant_delta', { text: chunk });
            }
          });

          history.push(wireMessage(message));
          if (startedStream) {
            emit('assistant_end', { content: message.content || streamed });
          } else if (message.content && message.content.trim()) {
            emit('assistant', { content: message.content, toolCalls: message.toolCalls || [] });
          }

          if (!message.toolCalls || !message.toolCalls.length) {
            emit('status', { phase: 'done', label: 'pronto' });
            return message.content || '';
          }

          var errors = 0;

          for (var c = 0; c < message.toolCalls.length; c++) {
            var call = message.toolCalls[c];
            emit('status', { phase: 'tool', label: labelFor(call.name) });
            emit('tool_start', { id: call.id, name: call.name, args: call.arguments || {} });
            var result = await runTool(call);
            if (!result.ok) errors++;
            history.push({
              role: 'tool',
              tool_call_id: call.id,
              content: result.text || (result.ok ? 'ok' : 'erro')
            });
          }

          if (errors && step >= maxSteps - 1) {
            var limitMessage = 'Parei no limite de ' + maxSteps + ' passos com a peça na mesa. ' +
              'Aumente os passos em Ajustes e peça para continuar de onde parou.';
            emit('assistant', { content: limitMessage });
            emit('status', { phase: 'done', label: 'limite de passos' });
            return limitMessage;
          }
        }

        var stopMessage = 'Parei no limite de ' + maxSteps + ' passos com a peça na mesa. ' +
          'Aumente os passos em Ajustes e peça para continuar de onde parou.';
        emit('assistant', { content: stopMessage });
        emit('status', { phase: 'done', label: 'limite de passos' });
        return stopMessage;
      } finally {
        running = false;
        controller = null;
      }
    }

    function labelFor(name) {
      if (name === 'run_geometry') return 'executando geometria';
      if (name === 'capture_views') return 'tirando capturas';
      if (name === 'load_object') return 'lendo objeto';
      if (name === 'inspect_geometry') return 'medindo';
      if (name === 'plan_parts') return 'planejando as partes';
      if (name === 'search_reference') return 'buscando referência';
      return 'usando ' + name;
    }

    function stop() {
      if (controller) controller.abort();
      running = false;
    }

    function reset() {
      stop();
      history = [];
    }

    function exportHistory() {
      return history.map(function (message) {
        if (Array.isArray(message.content)) {
          return { role: message.role, content: '[capturas]' };
        }
        return { role: message.role, content: message.content };
      }).filter(function (message) {
        if (message.role !== 'user' && message.role !== 'assistant') return false;
        if (typeof message.content !== 'string') return false;
        if (message.role === 'assistant' && !message.content.trim()) return false;
        return true;
      });
    }

    function importHistory(list) {
      if (!Array.isArray(list)) return;
      history = list.filter(function (message) {
        return message && (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string';
      }).map(function (message) {
        return { role: message.role, content: message.content };
      });
    }

    return {
      send: send,
      retry: retry,
      stop: stop,
      reset: reset,
      isRunning: function () { return running; },
      history: function () { return history; },
      exportHistory: exportHistory,
      importHistory: importHistory,
      tools: TOOLS
    };
  }

  function fmt(value) {
    if (!isFinite(value)) return '?';
    return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  }

  function fmtSize(size) {
    if (!size) return '?';
    var biggest = Math.max(size[0], size[1], size[2]);
    if (biggest >= 100) {
      return size.map(function (v) { return (v / 10).toFixed(1); }).join(' × ') + ' cm';
    }
    return size.map(function (v) { return v.toFixed(1); }).join(' × ') + ' mm';
  }

  return {
    create: create,
    systemPrompt: systemPrompt,
    tools: TOOLS,
    VIEWS: VIEWS,
    VIEW_LABEL: VIEW_LABEL
  };
});
