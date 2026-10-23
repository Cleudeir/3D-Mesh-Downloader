/**
 * Cliente da API OpenCode Go (compatível com OpenAI chat/completions).
 *
 * A chave fica só no armazenamento local da extensão e é enviada direto
 * para opencode.ai, sem intermediários.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IaApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_BASE = 'https://opencode.ai/inference/go/openai/v1';
  var SESSION_HEADER = 'x-opencode-session';
  var DEFAULT_MODEL = 'deepseek-v4.1-flash';
  var DEFAULT_VISION_MODEL = 'gpt-5.6-luna';

  // Modelos do plano Go separados por protocolo. O agente principal usa
  // chat/completions (DeepSeek etc.); as imagens vão para um inspetor de visão
  // barato via Responses API (GPT 6 Luna).
  var MODELS = [
    { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', protocol: 'chat', role: 'main', note: 'padrão do agente' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', protocol: 'chat', role: 'main' },
    { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', protocol: 'chat', role: 'main', note: 'muito barato' },
    { id: 'glm-5.3', label: 'GLM-5.3', protocol: 'chat', role: 'main' },
    { id: 'glm-5.2', label: 'GLM-5.2', protocol: 'chat', role: 'main' },
    { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', protocol: 'chat', role: 'main' },
    { id: 'kimi-k3', label: 'Kimi K3', protocol: 'chat', role: 'main' },
    { id: 'minimax-m3', label: 'MiniMax M3', protocol: 'chat', role: 'main' },
    { id: 'minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', protocol: 'chat', role: 'main' },
    { id: 'mimo-v2.6-flash', label: 'MiMo-V2.6-Flash', protocol: 'chat', role: 'main' },
    { id: 'mimo-v2.6-pro', label: 'MiMo-V2.6-Pro', protocol: 'chat', role: 'main' },
    { id: 'hy3', label: 'Hy3', protocol: 'chat', role: 'main' },
    { id: 'step-5-preview', label: 'Step 5 Preview', protocol: 'chat', role: 'main' },
    { id: 'longcat-2.0', label: 'LongCat-2.0', protocol: 'chat', role: 'main' },
    { id: 'qwen3.8-max', label: 'Qwen3.8 Max', protocol: 'chat', role: 'main' },
    { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', protocol: 'responses', role: 'vision', vision: true, note: 'padrão do inspetor' },
    { id: 'grok-4.7', label: 'Grok 4.7', protocol: 'responses', role: 'vision', vision: true },
    { id: 'grok-4.6', label: 'Grok 4.6', protocol: 'responses', role: 'vision', vision: true },
    { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor', protocol: 'responses', role: 'vision', vision: true },
    { id: 'muse-spark-1.2-contributor', label: 'Muse Spark 1.2 Contributor', protocol: 'responses', role: 'vision', vision: true }
  ];

  function modelInfo(id) {
    for (var i = 0; i < MODELS.length; i++) if (MODELS[i].id === id) return MODELS[i];
    return { id: id, label: id, vision: false, protocol: 'chat', role: 'main' };
  }

  function mainModels() {
    return MODELS.filter(function (model) { return model.role === 'main'; });
  }

  function visionModels() {
    return MODELS.filter(function (model) { return model.vision; });
  }

  function chat(options) {
    var base = normalizeBase(options.baseUrl);
    var controller = new AbortController();
    var timedOut = false;
    var abortReason = '';
    var timer = null;
    var streaming = typeof options.onDelta === 'function';

    function arm(ms, reason) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timedOut = true;
        abortReason = reason;
        controller.abort();
      }, ms);
    }

    // streaming: o relógio é de silêncio (renovado a cada chunk), não total.
    // Assim um raciocínio longo que continua enviando tokens não é abortado.
    arm(streaming ? (options.firstByteTimeout || 150000) : (options.timeout || 300000),
      streaming ? 'first' : 'total');

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
    }

    var body = {
      model: options.model,
      messages: options.messages,
      stream: streaming
    };
    if (options.tools && options.tools.length) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
    }
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens;
    if (options.reasoningEffort && options.reasoningEffort !== 'default') {
      body.reasoning_effort = options.reasoningEffort === 'off' ? 'none' : options.reasoningEffort;
    }

    return fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + options.apiKey,
        [SESSION_HEADER]: options.sessionId || 'studio-geometria'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          throw new Error(errorMessage(response.status, data, text));
        });
      }
      if (streaming) {
        return readStream(response, options.onDelta, function () {
          arm(options.stallTimeout || 90000, 'stall');
        });
      }
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!data) throw new Error('resposta vazia da API');
        var choice = data.choices && data.choices[0];
        if (!choice) throw new Error('resposta sem "choices"');
        var message = normalizeMessage(choice.message || {});
        if (choice.finish_reason === 'length' && !message.content.trim() &&
          (!message.toolCalls || !message.toolCalls.length)) {
          throw new Error('o modelo gastou o limite de tokens só raciocinando e não chegou a agir. ' +
            'Tente um pedido mais direto ou um modelo com mais saída.');
        }
        return message;
      });
    }).catch(function (error) {
      clearTimeout(timer);
      if (timedOut) {
        if (abortReason === 'stall') {
          throw new Error('a API ficou mais de ' + Math.round((options.stallTimeout || 90000) / 1000) +
            ' s sem enviar dados. O pedido não foi perdido; clique em "Tentar de novo".');
        }
        if (abortReason === 'first') {
          throw new Error('a API não começou a responder em ' +
            Math.round((options.firstByteTimeout || 150000) / 1000) +
            ' s. Clique em "Tentar de novo".');
        }
        throw new Error('a API demorou mais de ' + Math.round((options.timeout || 300000) / 1000) +
          ' s para responder. Clique em "Tentar de novo".');
      }
      if (error && error.name === 'AbortError') throw new Error('cancelado');
      if (error && /Failed to fetch|NetworkError|Load failed/i.test(String(error.message))) {
        throw new Error('não foi possível falar com a API. Verifique a conexão e clique em "Tentar de novo".');
      }
      throw error;
    }).then(function (message) {
      clearTimeout(timer);
      return message;
    });
  }

  /** Lê o SSE do chat/completions acumulando texto e tool calls. */
  function readStream(response, onDelta, onActivity) {
    if (!response.body || !response.body.getReader) {
      return response.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        var choice = data && data.choices && data.choices[0];
        if (!choice) throw new Error('resposta sem "choices"');
        return normalizeMessage(choice.message || {});
      });
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var content = '';
    var calls = [];
    var finishReason = null;

    function handleLine(line) {
      line = line.trim();
      if (!line || line.indexOf('data:') !== 0) return;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      var event;
      try { event = JSON.parse(payload); } catch (e) { return; }
      var choice = event.choices && event.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      var delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls.forEach(function (part) {
          var index = typeof part.index === 'number' ? part.index : 0;
          if (!calls[index]) {
            calls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          if (part.id) calls[index].id = part.id;
          var fn = part.function || {};
          if (fn.name) calls[index].function.name += fn.name;
          if (fn.arguments) calls[index].function.arguments += fn.arguments;
        });
      }
    }

    function pump() {
      return reader.read().then(function (chunk) {
        if (onActivity) onActivity();
        if (chunk.done) {
          if (buffer) handleLine(buffer);
          var message = normalizeMessage({
            content: content,
            tool_calls: calls.filter(Boolean)
          });
          if (finishReason === 'length' && !message.content.trim() &&
            (!message.toolCalls || !message.toolCalls.length)) {
            throw new Error('o modelo gastou o limite de tokens só raciocinando e não chegou a agir. ' +
              'Tente um pedido mais direto ou um modelo com mais saída.');
          }
          return message;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        lines.forEach(handleLine);
        return pump();
      });
    }

    return pump();
  }

  function normalizeBase(baseUrl) {
    var base = String(baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    return base;
  }

  /**
   * Inspetor de visão: manda as capturas para um modelo multimodal barato
   * (Responses API) e recebe um laudo em texto. O agente principal nunca
   * recebe as imagens — só o laudo.
   */
  function vision(options) {
    var base = normalizeBase(options.baseUrl);
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, options.timeout || 120000);

    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
    }

    var content = [{ type: 'input_text', text: String(options.prompt || '') }];
    (options.images || []).forEach(function (url) {
      content.push({ type: 'input_image', image_url: url });
    });

    var body = {
      model: options.model,
      input: [{ role: 'user', content: content }],
      max_output_tokens: options.maxTokens || 700,
      store: false
    };

    return fetch(base + '/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + options.apiKey,
        [SESSION_HEADER]: options.sessionId || 'studio-geometria'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!response.ok) throw new Error(errorMessage(response.status, data, text));
        if (!data) throw new Error('resposta vazia do inspetor de visão');
        var report = responseText(data);
        if (!report) throw new Error('o inspetor de visão não retornou texto');
        return report;
      });
    }).catch(function (error) {
      clearTimeout(timer);
      if (timedOut) throw new Error('o inspetor de visão demorou mais de ' +
        Math.round((options.timeout || 120000) / 1000) + ' s');
      if (error && error.name === 'AbortError') throw new Error('cancelado');
      if (error && /Failed to fetch|NetworkError|Load failed/i.test(String(error.message))) {
        throw new Error('não foi possível falar com o inspetor de visão. Verifique a conexão.');
      }
      throw error;
    }).then(function (report) {
      clearTimeout(timer);
      return report;
    });
  }

  function responseText(data) {
    if (typeof data.output_text === 'string' && data.output_text.trim()) {
      return data.output_text.trim();
    }
    var out = [];
    (data.output || []).forEach(function (item) {
      if (!item || !item.content) return;
      item.content.forEach(function (part) {
        if (part && part.type === 'output_text' && part.text) out.push(part.text);
      });
    });
    return out.join('\n').trim();
  }

  function normalizeMessage(message) {
    var content = message.content;
    if (Array.isArray(content)) {
      content = content.map(function (part) {
        return typeof part === 'string' ? part : (part && part.text) || '';
      }).join('');
    }
    var calls = [];

    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach(function (call, index) {
        var fn = call.function || {};
        var args = fn.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch (e) { args = {}; }
        }
        calls.push({
          id: call.id || 'call_' + Date.now() + '_' + index,
          name: fn.name || '',
          arguments: args || {}
        });
      });
    } else if (message.function_call) {
      var legacy = message.function_call;
      var legacyArgs = legacy.arguments;
      if (typeof legacyArgs === 'string') {
        try { legacyArgs = JSON.parse(legacyArgs); } catch (e) { legacyArgs = {}; }
      }
      calls.push({
        id: 'call_' + Date.now(),
        name: legacy.name || '',
        arguments: legacyArgs || {}
      });
    }

    return {
      role: 'assistant',
      content: typeof content === 'string' ? content : '',
      toolCalls: calls,
      raw: message
    };
  }

  function errorMessage(status, data, text) {
    var detail = '';
    if (data && data.error) {
      detail = data.error.message || data.error.type || JSON.stringify(data.error);
    } else if (text) {
      detail = String(text).slice(0, 300);
    }
    if (status === 401 || status === 403) {
      return 'chave da API recusada (' + status + '). Confira a chave em Ajustes.';
    }
    if (status === 402) {
      return 'sem créditos ou limite do plano Go atingido.';
    }
    if (status === 404) {
      return 'modelo ou endereço não encontrado (404). Confira o modelo e a URL base.';
    }
    if (status === 429) {
      return 'limite de uso temporário (429). Espere um pouco e tente de novo.';
    }
    return 'erro ' + status + (detail ? ': ' + detail : '');
  }

  function testConnection(options) {
    return chat(Object.assign({}, options, {
      messages: [{ role: 'user', content: 'Responda apenas "ok".' }],
      tools: [],
      maxTokens: 16,
      temperature: 0,
      timeout: 45000
    }));
  }

  return {
    DEFAULT_BASE: DEFAULT_BASE,
    DEFAULT_MODEL: DEFAULT_MODEL,
    DEFAULT_VISION_MODEL: DEFAULT_VISION_MODEL,
    MODELS: MODELS,
    modelInfo: modelInfo,
    mainModels: mainModels,
    visionModels: visionModels,
    chat: chat,
    vision: vision,
    testConnection: testConnection,
    normalizeBase: normalizeBase
  };
});
