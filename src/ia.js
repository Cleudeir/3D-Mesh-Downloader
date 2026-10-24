/**
 * Estúdio IA - interface.
 *
 * Chat à esquerda, ambiente 3D à direita. O agente escreve scripts, executa no
 * sandbox, recebe capturas e medidas, e a biblioteca guarda o script de cada
 * objeto como memória.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'iaStudioWorkspace';
  var MAX_OBJECTS = 50;
  var MAX_VERSIONS = 12;
  var RUN_TIMEOUT = 25000;
  var BENCHMARK_PROMPT = 'Crie um kettlebell de duas partes: corpo oco com rosca fêmea e tampa com rosca macho e alça, ' +
    'baseado na imagem de referência. Use milímetros, paredes de ~2 mm, base plana e a tampa removível (removable: true).';

  function emptyBenchmark() {
    return {
      reference: null,
      prompt: BENCHMARK_PROMPT,
      selected: [],
      results: [],
      running: false,
      at: null
    };
  }

  var els = {};
  [
    'objectName', 'modelSelect', 'openSettings', 'messages', 'prompt', 'sendButton',
    'stopAgent', 'newChat', 'setupBanner', 'setupOpen', 'suggest',
    'preview', 'empty', 'hud', 'views', 'captureButton', 'exportStl', 'dock',
    'dockToggle', 'dockBody', 'paneObjects', 'paneScript', 'objectCount',
    'scriptEditor', 'runScript', 'saveVersion', 'versionSelect', 'downloadScript',
    'scriptStatus', 'agentDot', 'agentState', 'settingsDialog', 'settingsForm',
    'settingsClose', 'apiKey', 'baseUrl', 'settingsModel', 'visionModel', 'maxSteps', 'effort',
    'testApi', 'clearWorkspace', 'settingsStatus', 'settingsSave',
    'imageDialog', 'imageLarge', 'imageCaption',
    'activity', 'activityLabel', 'activityTime', 'activitySteps',
    'stageStatus', 'stageStatusText', 'chatObject', 'partsBar',
    'attachment', 'attachmentThumb', 'attachmentName', 'attachmentRemove',
    'attachImage', 'imageFile',
    'openBenchmark', 'benchmarkDialog', 'bmClose', 'bmRefThumb', 'bmRefName',
    'bmUpload', 'bmImageFile', 'bmUseCurrent', 'bmSearchQuery', 'bmSearch',
    'bmRefReport', 'bmPrompt', 'bmModels', 'bmRun', 'bmStop', 'bmStatus',
    'bmCheap', 'bmMid', 'bmExpensive', 'bmRanking', 'bmResults',
    'bmGuard', 'bmGuardStatus', 'bmGuardOpen'
  ].forEach(function (id) { els[id] = document.getElementById(id); });


  var state = {
    settings: {
      apiKey: '',
      baseUrl: IaApi.DEFAULT_BASE,
      model: IaApi.DEFAULT_MODEL,
      visionModel: IaApi.DEFAULT_VISION_MODEL,
      maxSteps: 50,
      effort: 'low'
    },
    objects: [],
    memory: [],
    chat: [],
    transcript: [],
    currentId: null,
    sessionId: 'ses-' + Date.now().toString(36),
    script: '',
    model: null,
    stats: null,
    images: [],
    pendingName: '',
    lastRequest: '',
    reference: null,
    pendingImage: null,
    plan: [],
    focus: '',
    busy: false,
    versionIndex: -1,
    benchmark: emptyBenchmark(),
    ui: { dock: 'objects', collapsed: false, view: 'perspective' }
  };

  var renderer = null;
  var agent = null;
  var scoutController = null;
  var referenceController = null;
  var benchmarkController = null;
  var benchmarkRefController = null;
  var saveTimer = null;
  var scrollTimer = null;
  var restoring = false;

  // -------------------------------------------------------------------------
  // armazenamento
  // -------------------------------------------------------------------------

  function storeGet(key) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(key, function (items) {
            resolve(items ? items[key] : null);
          });
          return;
        }
      } catch (e) { /* usa localStorage */ }
      try {
        var raw = localStorage.getItem(key);
        resolve(raw ? JSON.parse(raw) : null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function storeSet(key, value) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [key]: value }, function () { resolve(); });
          return;
        }
      } catch (e) { /* usa localStorage */ }
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* sem espaço */ }
      resolve();
    });
  }

  function payload() {
    return {
      version: 2,
      savedAt: Date.now(),
      settings: state.settings,
      objects: state.objects,
      memory: state.memory,
      chat: state.chat,
      transcript: state.transcript,
      currentId: state.currentId,
      sessionId: state.sessionId,
      pendingName: state.pendingName,
      ui: state.ui,
      plan: state.plan,
      focus: state.focus,
      reference: state.reference,
      benchmark: state.benchmark
    };
  }

  function save(immediate) {
    persistChat();
    if (saveTimer) clearTimeout(saveTimer);
    if (immediate) {
      saveTimer = null;
      return storeSet(STORAGE_KEY, payload());
    }
    saveTimer = setTimeout(function () {
      saveTimer = null;
      storeSet(STORAGE_KEY, payload());
    }, 280);
  }

  /** Conversa e histórico da interface pertencem ao objeto atual. */
  function persistChat() {
    if (agent) state.chat = agent.exportHistory();
    var obj = currentObject();
    if (obj) {
      obj.chat = state.chat;
      obj.transcript = state.transcript;
      obj.lastRequest = state.lastRequest;
      obj.plan = state.plan;
      obj.focus = state.focus;
      obj.reference = state.reference;
    }
  }

  function restore(data) {
    if (!data || typeof data !== 'object') return;
    if (data.settings && typeof data.settings === 'object') {
      Object.keys(state.settings).forEach(function (key) {
        if (data.settings[key] !== undefined) state.settings[key] = data.settings[key];
      });
    }
    if (Array.isArray(data.objects)) {
      state.objects = data.objects.filter(validObject).map(function (obj) {
        obj.chat = Array.isArray(obj.chat) ? obj.chat : [];
        obj.versions = Array.isArray(obj.versions) ? obj.versions : [];
        obj.transcript = Array.isArray(obj.transcript) ? obj.transcript : [];
        obj.draft = typeof obj.draft === 'string' ? obj.draft : '';
        obj.lastRequest = typeof obj.lastRequest === 'string' ? obj.lastRequest : '';
        obj.plan = Array.isArray(obj.plan) ? obj.plan : [];
        obj.focus = typeof obj.focus === 'string' ? obj.focus : '';
        obj.reference = obj.reference && typeof obj.reference === 'object' ? obj.reference : null;
        return obj;
      });
    }
    if (Array.isArray(data.memory)) state.memory = data.memory.filter(function (m) { return typeof m === 'string'; }).slice(-40);
    if (Array.isArray(data.chat)) state.chat = data.chat;
    if (Array.isArray(data.transcript)) state.transcript = data.transcript;
    if (Array.isArray(data.plan)) {
      state.plan = data.plan.filter(function (item) { return item && typeof item.name === 'string'; });
    }
    if (typeof data.focus === 'string') state.focus = data.focus;
    if (data.reference && typeof data.reference === 'object') state.reference = data.reference;
    if (data.benchmark && typeof data.benchmark === 'object') {
      state.benchmark = Object.assign(emptyBenchmark(), data.benchmark);
      state.benchmark.running = false;
      if (!Array.isArray(state.benchmark.results)) state.benchmark.results = [];
      if (!Array.isArray(state.benchmark.selected)) state.benchmark.selected = [];
      if (!state.benchmark.prompt) state.benchmark.prompt = BENCHMARK_PROMPT;
    }
    if (typeof data.currentId === 'string') state.currentId = data.currentId;
    if (typeof data.sessionId === 'string' && data.sessionId) state.sessionId = data.sessionId;
    if (typeof data.pendingName === 'string') state.pendingName = data.pendingName;
    if (data.ui && typeof data.ui === 'object') {
      if (data.ui.dock === 'objects' || data.ui.dock === 'script') state.ui.dock = data.ui.dock;
      state.ui.collapsed = !!data.ui.collapsed;
      if (typeof data.ui.view === 'string') state.ui.view = data.ui.view;
    }

    // Migração: a conversa global antiga passa a pertencer ao objeto atual.
    var obj = currentObject();
    if (obj) {
      if (Array.isArray(data.chat) && data.chat.length && !obj.chat.length) obj.chat = data.chat;
      if (Array.isArray(data.transcript) && data.transcript.length && !obj.transcript.length) {
        obj.transcript = data.transcript;
      }
      if (!obj.transcript.length && obj.chat.length) {
        obj.transcript = obj.chat.map(function (message) {
          return { role: message.role, text: message.content };
        });
      }
      state.chat = obj.chat || [];
      state.transcript = obj.transcript || [];
      state.lastRequest = obj.lastRequest || '';
      state.plan = obj.plan || [];
      state.focus = obj.focus || '';
      state.reference = obj.reference || null;
    }
  }

  function validObject(obj) {
    return obj && typeof obj === 'object' && typeof obj.id === 'string' && typeof obj.script === 'string';
  }

  /** Corrige configurações antigas ou de modelos que trocaram de protocolo. */
  function sanitizeSettings() {
    var main = IaApi.modelInfo(state.settings.model);
    if (main.protocol !== 'chat' || main.role !== 'main') {
      state.settings.model = IaApi.DEFAULT_MODEL;
    }
    var eye = IaApi.modelInfo(state.settings.visionModel);
    if (!eye.vision) state.settings.visionModel = IaApi.DEFAULT_VISION_MODEL;
    var steps = Math.round(Number(state.settings.maxSteps) || 50);
    if (steps === 12 || steps === 18 || steps === 24) steps = 50; // padrões antigos que travavam objetos complexos
    state.settings.maxSteps = Math.max(1, Math.min(50, steps));
    if (['low', 'medium', 'high', 'off'].indexOf(state.settings.effort) === -1) {
      state.settings.effort = 'low';
    }
  }

  // -------------------------------------------------------------------------
  // executor (sandbox + blob worker)
  // -------------------------------------------------------------------------

  var executor = (function () {
    var frame = null;
    var ready = false;
    var booted = false;
    var seq = 0;
    var pending = new Map();
    var waiting = [];
    var bootTimer = null;
    var bootError = null;
    var bootRetries = 0;
    var bootVersion = 0;
    var messageBound = false;
    var visibilityBound = false;

    function teardown(reason) {
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      if (frame) {
        try { frame.remove(); } catch (e) { /* já saiu */ }
        frame = null;
      }
      ready = false;
      booted = false;
      bootError = null;
      if (reason) failAll(reason);
    }

    function armBootWatchdog() {
      if (bootTimer) clearTimeout(bootTimer);
      bootTimer = setTimeout(function () {
        bootTimer = null;
        if (ready) return;
        bootError = 'o executor de geometria não iniciou. Reiniciando o sandbox...';
        failAll(bootError);
        teardown();
        if (bootRetries < 1) {
          bootRetries += 1;
          setTimeout(function () { init(); }, 900);
        }
      }, 60000);
    }

    function init(force) {
      if (booted && !force) return;
      if (force) teardown('executor de geometria reiniciado; tente de novo');
      booted = true;
      ready = false;
      bootError = null;
      frame = document.createElement('iframe');
      frame.src = 'ia/sandbox-v2.html?v=' + Date.now().toString(36) + '-' + (++bootVersion);
      frame.title = 'executor de geometria';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.display = 'none';
      if (!messageBound) {
        window.addEventListener('message', onMessage);
        messageBound = true;
      }
      if (!visibilityBound) {
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible' && booted && !ready) {
            init(true);
          }
        });
        visibilityBound = true;
      }
      document.body.appendChild(frame);
      armBootWatchdog();
    }

    function onMessage(event) {
      if (!frame || event.source !== frame.contentWindow) return;
      var data = event.data || {};
      if (data.channel !== 'ia-geometry') return;

      if (data.type === 'ready') {
        ready = true;
        bootError = null;
        bootRetries = 0;
        if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
        var queue = waiting;
        waiting = [];
        queue.forEach(function (item) { send(item); });
        return;
      }

      if (data.type === 'fatal') {
        failAll(data.error || 'falha no executor de geometria');
        teardown();
        return;
      }

      if (data.type === 'killed') {
        ready = false;
        armBootWatchdog();
        return;
      }

      if (data.type === 'result') {
        var item = pending.get(data.id);
        if (!item) return;
        pending.delete(data.id);
        clearTimeout(item.timer);
        item.resolve(data);
      }
    }

    function send(item) {
      if (!frame || !ready) {
        waiting.push(item);
        if (!item.queuedAt) item.queuedAt = Date.now();
        return;
      }
      if (item.started) return;
      item.started = true;
      item.timer = setTimeout(function () {
        if (!pending.has(item.id)) return;
        pending.delete(item.id);
        waiting = waiting.filter(function (entry) { return entry.id !== item.id; });
        if (frame) {
          frame.contentWindow.postMessage({ channel: 'ia-geometry', type: 'kill' }, '*');
        }
        ready = false;
        armBootWatchdog();
        item.reject(new Error('o script passou de ' + Math.round(item.limit / 1000) +
          ' s e foi interrompido. Simplifique a geometria (menos segmentos) ou tente outra abordagem.'));
      }, item.limit);
      try {
        frame.contentWindow.postMessage({
          channel: 'ia-geometry',
          type: 'run',
          id: item.id,
          code: item.code
        }, '*');
      } catch (e) {
        clearTimeout(item.timer);
        item.timer = null;
        item.started = false;
        item.reject(new Error('não foi possível enviar o script ao executor'));
      }
    }

    function failAll(message) {
      var error = new Error(message);
      pending.forEach(function (item) {
        clearTimeout(item.timer);
        item.reject(error);
      });
      pending.clear();
      waiting = [];
    }

    function run(code, timeout) {
      init();
      var id = ++seq;
      var limit = Math.max(1000, Number(timeout) || RUN_TIMEOUT);
      return new Promise(function (resolve, reject) {
        var item = {
          id: id,
          code: code,
          limit: limit,
          started: false,
          resolve: resolve,
          reject: reject
        };
        pending.set(id, item);
        send(item);
      });
    }

    return { init: init, run: run };
  })();

  // -------------------------------------------------------------------------
  // render / modelo
  // -------------------------------------------------------------------------

  function applyModel(model, stats) {
    state.model = model;
    state.stats = stats || null;
    if (state.focus && !findPart(state.focus)) state.focus = '';
    syncPlanWithModel();
    renderer.setModel(currentParts());
    els.empty.hidden = !!(model && model.parts && model.parts.length);
    updateHud();
    renderPartsBar();
    if (model && model.parts && model.parts.length) flashViewport();
  }

  function flashViewport() {
    var viewport = els.preview.parentElement;
    if (!viewport) return;
    viewport.classList.remove('flash');
    void viewport.offsetWidth;
    viewport.classList.add('flash');
    setTimeout(function () { viewport.classList.remove('flash'); }, 700);
  }

  function thumb() {
    try {
      var savedFocus = state.focus;
      state.focus = '';
      renderer.setModel(modelParts());
      var shots = renderer.snapshot(['perspective'], {
        width: 320,
        height: 220,
        quality: 0.7,
        grid: false
      });
      state.focus = savedFocus;
      renderer.setModel(currentParts());
      return shots.length ? shots[0].dataUrl : '';
    } catch (e) {
      return '';
    }
  }

  function capture(views) {
    var images = renderer.snapshot(views || ['perspective', 'top', 'front', 'right', 'bottom'], {
      width: 512,
      height: 384,
      quality: 0.75,
      grid: false
    });
    state.images = images;
    return images;
  }

  function updateHud() {
    var stats = state.stats;
    if (!stats) {
      els.hud.textContent = '';
      return;
    }
    var bits = [];
    if (state.focus) {
      var focusInfo = findStatsPart(state.focus);
      bits.push('<span><b>parte:</b> ' + escapeHtml(state.focus) +
        (focusInfo ? ' · ' + fmtSize(focusInfo.size) + ' · ' + fmtVolume(focusInfo.volume) : '') +
        '</span>');
    }
    if (stats.parts && stats.parts.length > 1) {
      bits.push('<span><b>' + stats.parts.length + '</b> peças</span>');
    }
    if (stats.joints && stats.joints.length) {
      bits.push('<span title="O pipeline criou estes pinos automaticamente."><b>' +
        stats.joints.length + '</b> juntas</span>');
    }
    if (stats.loose && stats.loose.length) {
      var looseTitle = stats.loose.map(function (item) {
        return item.a + ' ↔ ' + item.b + ' (' + Number(item.gap).toFixed(1) + ' mm)';
      }).join('; ');
      bits.push('<span class="badge-warn" title="' + escapeHtml(looseTitle) + '">' +
        stats.loose.length + ' solta(s)</span>');
    }
    bits.push('<span><b>' + fmtInt(stats.triangles) + '</b> triângulos</span>');
    bits.push('<span>' + fmtSize(stats.size) + '</span>');
    bits.push('<span><b>' + fmtVolume(stats.volume) + '</b></span>');
    if (stats.nonManifoldEdges > 0) {
      bits.push('<span class="badge-warn" title="Arestas compartilhadas por mais de duas faces; costuma vir de faces coplanares nas booleanas.">' +
        stats.nonManifoldEdges + ' arestas não-manifold</span>');
    }
    els.hud.innerHTML = bits.join('');
  }

  function fmtInt(value) {
    return Number(value || 0).toLocaleString('pt-BR');
  }

  function fmtSize(size) {
    if (!size) return '—';
    var biggest = Math.max(size[0], size[1], size[2]);
    if (biggest >= 100) {
      return size.map(function (v) { return (v / 10).toFixed(1); }).join(' × ') + ' cm';
    }
    return size.map(function (v) { return v.toFixed(1); }).join(' × ') + ' mm';
  }

  function fmtVolume(mm3) {
    var value = Number(mm3) || 0;
    if (value >= 1000) {
      return (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' cm³';
    }
    return value.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' mm³';
  }

  // -------------------------------------------------------------------------
  // objetos e versões
  // -------------------------------------------------------------------------

  function currentObject() {
    if (!state.currentId) return null;
    for (var i = 0; i < state.objects.length; i++) {
      if (state.objects[i].id === state.currentId) return state.objects[i];
    }
    return null;
  }

  function syncObjectUI() {
    var obj = currentObject();
    els.objectName.value = obj ? obj.name : '';
    if (els.chatObject) {
      els.chatObject.textContent = obj ? obj.name : 'nova conversa';
      els.chatObject.classList.toggle('has-object', !!obj);
    }
  }

  // -------------------------------------------------------------------------
  // partes e foco
  // -------------------------------------------------------------------------

  function normalizePartName(name) {
    return String(name || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }

  function modelParts() {
    return state.model && Array.isArray(state.model.parts) ? state.model.parts : [];
  }

  function findPart(name) {
    var key = normalizePartName(name);
    if (!key) return null;
    var parts = modelParts();
    for (var i = 0; i < parts.length; i++) {
      if (normalizePartName(parts[i].name) === key) return parts[i];
    }
    return null;
  }

  function findStatsPart(name) {
    var key = normalizePartName(name);
    if (!key || !state.stats || !Array.isArray(state.stats.parts)) return null;
    for (var i = 0; i < state.stats.parts.length; i++) {
      if (normalizePartName(state.stats.parts[i].name) === key) return state.stats.parts[i];
    }
    return null;
  }

  function currentParts() {
    var parts = modelParts();
    if (!state.focus) return parts;
    var key = normalizePartName(state.focus);
    var filtered = parts.filter(function (part) {
      return normalizePartName(part.name) === key;
    });
    return filtered.length ? filtered : parts;
  }

  function syncPlanWithModel() {
    var parts = modelParts();
    state.plan.forEach(function (item) {
      if (item.status === 'reviewed') return;
      var match = null;
      for (var i = 0; i < parts.length; i++) {
        if (normalizePartName(parts[i].name) === normalizePartName(item.name)) { match = parts[i]; break; }
      }
      if (match) item.status = 'built';
    });
  }

  function partStatusLabel(status) {
    if (status === 'reviewed') return 'revisada';
    if (status === 'built') return 'construída';
    return 'planejada';
  }

  function markPartReviewed(name) {
    var key = normalizePartName(name);
    var item = null;
    for (var i = 0; i < state.plan.length; i++) {
      if (normalizePartName(state.plan[i].name) === key) { item = state.plan[i]; break; }
    }
    if (!item) return;
    item.status = 'reviewed';
    renderPartsBar();
    save();
  }

  function setFocus(name) {
    state.focus = name || '';
    if (state.focus && !findPart(state.focus)) state.focus = '';
    var obj = currentObject();
    if (obj) obj.focus = state.focus;
    renderer.setModel(currentParts());
    updateHud();
    renderPartsBar();
    save();
  }

  function renderPartsBar() {
    if (!els.partsBar) return;
    var parts = modelParts();
    if (!state.plan.length && !parts.length) {
      els.partsBar.hidden = true;
      els.partsBar.textContent = '';
      return;
    }
    els.partsBar.hidden = false;
    els.partsBar.textContent = '';

    var title = document.createElement('span');
    title.className = 'ptitle';
    title.textContent = 'partes';
    els.partsBar.appendChild(title);

    els.partsBar.appendChild(partChip('Conjunto', null, null, !state.focus, false, ''));
    var allChip = els.partsBar.lastChild;
    allChip.disabled = false;
    allChip.dataset.focus = '';
    allChip.title = 'Ver todas as partes';

    state.plan.forEach(function (item) {
      var part = findPart(item.name);
      var info = findStatsPart(item.name);
      var reviewed = item.status === 'reviewed';
      els.partsBar.appendChild(partChip(
        item.name,
        part,
        info,
        !!part && normalizePartName(state.focus) === normalizePartName(part.name),
        !part,
        item.description || '',
        reviewed
      ));
    });

    parts.forEach(function (part) {
      var inPlan = state.plan.some(function (item) {
        return normalizePartName(item.name) === normalizePartName(part.name);
      });
      if (inPlan) return;
      els.partsBar.appendChild(partChip(
        part.name || 'peça',
        part,
        findStatsPart(part.name),
        normalizePartName(state.focus) === normalizePartName(part.name),
        false,
        '',
        false
      ));
    });
  }

  function partChip(label, part, info, active, planned, description, reviewed) {
    var button = document.createElement('button');
    button.type = 'button';
    button.classList.toggle('active', !!active);
    button.classList.toggle('planned', !!planned);
    button.classList.toggle('done', !!part && (!!reviewed || !planned));

    var icon = document.createElement('span');
    icon.className = 'picon';
    icon.textContent = part ? (reviewed ? '✓' : '●') : '○';
    button.appendChild(icon);

    var name = document.createElement('span');
    name.textContent = label;
    button.appendChild(name);

    if (part) {
      var count = document.createElement('span');
      count.className = 'pcount';
      count.textContent = info ? fmtInt(info.triangles) : '';
      button.appendChild(count);
      button.dataset.focus = part.name;
      button.title = 'Isolar "' + part.name + '"' +
        (info ? ' · ' + fmtSize(info.size) + ' · ' + fmtVolume(info.volume) : '');
    } else {
      button.disabled = true;
      button.title = description || 'ainda não construída';
    }
    return button;
  }

  function ensureObject(meta) {
    meta = meta || {};
    var obj = currentObject();
    if (obj) return obj;

    var name = (meta.name && String(meta.name).trim()) ||
      (els.objectName.value.trim()) ||
      state.pendingName ||
      'Objeto ' + (state.objects.length + 1);

    obj = {
      id: 'obj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      name: name,
      description: meta.description || '',
      notes: meta.notes || '',
      script: '',
      stats: null,
      thumb: '',
      chat: agent ? agent.exportHistory() : [],
      transcript: state.transcript.slice(),
      draft: els.scriptEditor.value || '',
      lastRequest: state.lastRequest || '',
      plan: state.plan.slice(),
      focus: state.focus || '',
      reference: state.reference || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      versions: []
    };
    state.objects.unshift(obj);
    state.currentId = obj.id;
    cropObjects();
    syncObjectUI();
    return obj;
  }

  function cropObjects() {
    if (state.objects.length <= MAX_OBJECTS) return;
    for (var i = state.objects.length - 1; i >= 0 && state.objects.length > MAX_OBJECTS; i--) {
      if (state.objects[i].id !== state.currentId) state.objects.splice(i, 1);
    }
  }

  function addVersion(obj, script, note, stats) {
    var last = obj.versions[obj.versions.length - 1];
    if (last && last.script === script && note !== 'manual') return;
    obj.versions.push({
      at: Date.now(),
      script: script,
      note: note || 'agente',
      stats: stats ? {
        triangles: stats.triangles,
        size: stats.size,
        volume: stats.volume
      } : null
    });
    if (obj.versions.length > MAX_VERSIONS) obj.versions.splice(0, obj.versions.length - MAX_VERSIONS);
  }

  function renderObjects() {
    var pane = els.paneObjects;
    var scroll = pane.scrollTop;
    pane.textContent = '';
    els.objectCount.textContent = String(state.objects.length);

    if (!state.objects.length) {
      var empty = document.createElement('div');
      empty.className = 'objects-empty';
      empty.textContent = 'Os objetos criados aparecem aqui, com o script e uma miniatura.';
      pane.appendChild(empty);
      return;
    }

    state.objects.forEach(function (obj) {
      var card = document.createElement('div');
      card.className = 'object-card' + (obj.id === state.currentId ? ' active' : '');
      card.dataset.id = obj.id;
      card.title = obj.description || obj.name;

      if (obj.thumb) {
        var img = document.createElement('img');
        img.className = 'thumb';
        img.src = obj.thumb;
        img.alt = obj.name;
        card.appendChild(img);
      } else {
        var placeholder = document.createElement('div');
        placeholder.className = 'thumb';
        card.appendChild(placeholder);
      }

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '×';
      del.title = 'Apagar este objeto';
      del.dataset.del = obj.id;
      card.appendChild(del);

      var info = document.createElement('div');
      info.className = 'info';
      var name = document.createElement('b');
      name.textContent = obj.name || 'Sem nome';
      var meta = document.createElement('span');
      meta.textContent = objectMeta(obj);
      info.appendChild(name);
      info.appendChild(meta);
      card.appendChild(info);

      pane.appendChild(card);
    });

    pane.scrollTop = scroll;
  }

  function objectMeta(obj) {
    var bits = [];
    if (obj.stats) {
      bits.push(fmtSize(obj.stats.size));
      bits.push(fmtVolume(obj.stats.volume));
    }
    var messages = (obj.transcript || []).length;
    if (messages) bits.push(messages + (messages === 1 ? ' mensagem' : ' mensagens'));
    if (obj.versions && obj.versions.length) bits.push(obj.versions.length + ' versões');
    if (!bits.length) bits.push('sem medidas');
    return bits.join(' · ');
  }

  function findObject(id) {
    for (var i = 0; i < state.objects.length; i++) {
      if (state.objects[i].id === id) return state.objects[i];
    }
    return null;
  }

  /** Troca o objeto ativo: script, cena e conversa viajam juntos. */
  function openObject(id) {
    if (state.busy) return Promise.reject(new Error('espere o agente terminar antes de trocar de objeto'));
    var obj = findObject(id);
    if (!obj) return Promise.reject(new Error('objeto não encontrado: ' + id));

    persistChat();
    state.currentId = obj.id;
    state.script = obj.script;
    state.stats = obj.stats;
    state.lastRequest = obj.lastRequest || '';
    state.plan = obj.plan || [];
    state.focus = obj.focus || '';
    state.reference = obj.reference || null;
    clearAttachment();
    state.chat = obj.chat || [];
    state.transcript = obj.transcript || [];
    els.scriptEditor.value = obj.draft || obj.script;
    els.scriptStatus.textContent = obj.draft && obj.draft !== obj.script
      ? 'rascunho não executado' : '';
    els.scriptStatus.className = 'script-status';
    syncObjectUI();
    renderObjects();
    updateVersionSelect();
    renderChat(state.transcript);
    if (agent) agent.importHistory(state.chat);
    save();

    if (!obj.script.trim()) {
      els.empty.hidden = false;
      renderPartsBar();
      return Promise.resolve({
        text: 'Objeto "' + obj.name + '" está vazio (ainda sem script).',
        stats: null
      });
    }

    return executor.run(obj.script, 60000).then(function (result) {
      if (!result.ok) {
        els.scriptStatus.textContent = 'erro ao reconstruir: ' + result.error;
        els.scriptStatus.className = 'script-status err';
        throw new Error(result.error);
      }
      applyModel(result.model, result.stats);
      obj.stats = result.stats;
      obj.thumb = thumb();
      renderObjects();
      save();
      return {
        text: 'Objeto aberto: "' + obj.name + '".',
        stats: result.stats
      };
    });
  }

  /** Leitura para o agente: não troca a conversa atual. */
  function readObject(id) {
    var obj = findObject(id);
    if (!obj) return Promise.reject(new Error('objeto não encontrado: ' + id));
    return Promise.resolve({
      text: 'Objeto "' + obj.name + '" (somente leitura — a conversa atual continua a mesma).\n' +
        (obj.description ? 'Descrição: ' + obj.description + '\n' : '') +
        (obj.stats ? 'Medidas: ' + fmtSize(obj.stats.size) + ', ' + fmtVolume(obj.stats.volume) + '\n' : '') +
        'Script:\n```js\n' + obj.script + '\n```',
      stats: obj.stats
    });
  }

  // -------------------------------------------------------------------------
  // execução
  // -------------------------------------------------------------------------

  function handleResult(result) {
    if (!result.ok) {
      els.scriptStatus.textContent = result.error || 'falha ao executar';
      els.scriptStatus.className = 'script-status err';
      return false;
    }
    applyModel(result.model, result.stats);
    els.scriptStatus.textContent = fmtInt(result.stats.triangles) + ' triângulos · ' +
      fmtSize(result.stats.size) + ' · ' + fmtVolume(result.stats.volume) +
      ' · ' + (result.ms || 0) + ' ms';
    els.scriptStatus.className = 'script-status ok';
    return true;
  }

  function runManual() {
    if (state.busy) return;
    var code = els.scriptEditor.value;
    if (!code.trim()) {
      els.scriptStatus.textContent = 'o script está vazio';
      els.scriptStatus.className = 'script-status err';
      return;
    }
    state.busy = true;
    setBusy(true, 'executando script');
    els.runScript.disabled = true;
    executor.run(code).then(function (result) {
      if (!handleResult(result)) return;
      state.script = code;
      var obj = ensureObject({
        name: (result.model && result.model.name) || ''
      });
      obj.script = code;
      obj.draft = code;
      obj.stats = result.stats;
      obj.updatedAt = Date.now();
      obj.thumb = thumb();
      addVersion(obj, code, 'manual', result.stats);
      save();
      renderObjects();
      flashCard();
      updateVersionSelect();
      els.objectName.value = obj.name;
      setAgentState('script executado', 'ok');
    }).catch(function (error) {
      els.scriptStatus.textContent = error.message;
      els.scriptStatus.className = 'script-status err';
      setAgentState('erro no script', 'err');
    }).finally(function () {
      state.busy = false;
      setBusy(false);
      els.runScript.disabled = false;
    });
  }

  // -------------------------------------------------------------------------
  // inspetor de visão (modelo barato separado)
  // -------------------------------------------------------------------------

  function visionConfigured() {
    return !!IaApi.modelInfo(state.settings.visionModel).vision;
  }

  function buildInspectorPrompt(extra) {
    var obj = currentObject();
    var lines = [
      'Você é o inspetor visual de um estúdio de geometria 3D para impressão FDM.',
      'Olhe as capturas do modelo atual (perspectiva, topo, baixo, frente e lados) e escreva um laudo curto em português.',
      'No máximo 9 linhas. Diga o que está certo e o que está errado na FORMA:',
      'silhueta, furos e aberturas, paredes, peças soltas, alinhamento, simetria e se a peça corresponde ao pedido.',
      'Conexões: verifique se cada parte está ligada à vizinha (pescoço→corpo, asas→costas, cauda→corpo,',
      'patas→base, chifres/olhos→cabeça). Aponte QUALQUER vão, peça flutuando ou junta apenas encostada,',
      'dizendo entre quais partes está o vão. Isso é mais importante que o acabamento.',
      'Não escreva código. Não invente medidas. Se um detalhe não aparecer, diga em qual vista olhou.',
      '',
      'Pedido do usuário: ' + (state.lastRequest || '(não informado)'),
      'Objeto: ' + (obj ? obj.name : '(sem nome)') + (obj && obj.description ? ' — ' + obj.description : '')
    ];
    if (state.stats) {
      lines.push('Medidas informadas: ' + fmtSize(state.stats.size) + ', volume ' + fmtVolume(state.stats.volume) + '.');
      if (state.stats.parts) {
        lines.push('Peças: ' + state.stats.parts.map(function (p) { return p.name; }).join(', ') + '.');
      }
      if (state.stats.loose && state.stats.loose.length) {
        lines.push('Aviso da geometria: possíveis peças soltas — ' + state.stats.loose.map(function (item) {
          return item.a + '↔' + item.b;
        }).join('; ') + '. Confirme nas capturas.');
      }
    }
    if (extra) lines.push('Observação: ' + extra);
    return lines.join('\n');
  }

  function scoutReport(images, extra) {
    if (!visionConfigured()) {
      return Promise.reject(new Error('escolha um modelo de visão em Ajustes'));
    }
    if (scoutController) scoutController.abort();
    scoutController = new AbortController();
    var guard = scoutController;
    return IaApi.vision({
      apiKey: state.settings.apiKey,
      baseUrl: state.settings.baseUrl,
      model: state.settings.visionModel,
      prompt: buildInspectorPrompt(extra),
      images: images.map(function (image) { return image.dataUrl; }),
      sessionId: state.sessionId,
      signal: guard.signal,
      timeout: 120000
    }).finally(function () {
      if (scoutController === guard) scoutController = null;
    });
  }

  // -------------------------------------------------------------------------
  // referência visual (busca antes de modelar)
  // -------------------------------------------------------------------------

  function referencePrompt(query) {
    return [
      'Você é engenheiro de produto e diretor de arte.',
      'Estas imagens são referências reais para modelar um objeto 3D imprimível: "' + query + '".',
      'Descreva em no máximo 8 linhas: silhueta, proporções, volumes principais, detalhes característicos,',
      'como as partes se conectam e o que não pode faltar. Não escreva código nem invente medidas exatas.'
    ].join('\n');
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('falha ao ler a imagem')); };
      reader.readAsDataURL(blob);
    });
  }

  function searchReference(query, count) {
    var q = String(query || '').trim();
    if (!q) return Promise.reject(new Error('consulta de referência vazia'));
    var n = Math.max(1, Math.min(4, Number(count) || 3));
    var api = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
      '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap') +
      '&gsrnamespace=6&gsrlimit=' + Math.max(6, n * 2) +
      '&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=640&format=json&origin=*';

    return fetch(api).then(function (response) {
      if (!response.ok) throw new Error('busca HTTP ' + response.status);
      return response.json();
    }).then(function (data) {
      var pages = data && data.query && data.query.pages
        ? Object.keys(data.query.pages).map(function (key) { return data.query.pages[key]; })
        : [];
      var picks = [];
      pages.forEach(function (page) {
        var info = page.imageinfo && page.imageinfo[0];
        if (!info) return;
        var mime = String(info.mime || '');
        if (!/^image\/(jpeg|png|webp)/.test(mime)) return;
        var src = info.thumburl || info.url;
        if (!src) return;
        if (picks.length < n) {
          picks.push({ title: page.title || 'referência', url: src, page: info.descriptionurl || '' });
        }
      });

      if (!picks.length) {
        return { query: q, images: [], report: 'Nenhuma imagem de referência encontrada para "' + q + '".' };
      }

      return Promise.all(picks.map(function (pick) {
        return fetch(pick.url).then(function (response) {
          if (!response.ok) throw new Error('imagem HTTP ' + response.status);
          return response.blob();
        }).then(blobToDataUrl).then(function (dataUrl) {
          return { title: pick.title, url: pick.url, dataUrl: dataUrl };
        }).catch(function () {
          return null;
        });
      })).then(function (list) {
        var images = list.filter(Boolean);
        if (!images.length) {
          return { query: q, images: [], report: 'As referências foram encontradas, mas não puderam ser baixadas.' };
        }
        if (!visionConfigured()) {
          return { query: q, images: images, report: 'Inspetor de visão desligado; use as imagens como inspiração.' };
        }
        return IaApi.vision({
          apiKey: state.settings.apiKey,
          baseUrl: state.settings.baseUrl,
          model: state.settings.visionModel,
          prompt: referencePrompt(q),
          images: images.map(function (image) { return image.dataUrl; }),
          sessionId: state.sessionId,
          timeout: 120000
        }).then(function (report) {
          return { query: q, images: images, report: report };
        }).catch(function (error) {
          return {
            query: q,
            images: images,
            report: 'Não foi possível analisar as referências: ' +
              (error && error.message ? error.message : error)
          };
        });
      });
    }).catch(function (error) {
      return {
        query: q,
        images: [],
        report: 'Busca de referência falhou: ' + (error && error.message ? error.message : error)
      };
    });
  }

  // -------------------------------------------------------------------------
  // imagem de referência enviada pelo usuário
  // -------------------------------------------------------------------------

  function normalizeImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () {
        var max = 1024;
        var scale = Math.min(1, max / Math.max(image.width, image.height));
        var width = Math.max(1, Math.round(image.width * scale));
        var height = Math.max(1, Math.round(image.height * scale));

        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        var full = canvas.toDataURL('image/jpeg', 0.86);

        var tw = Math.min(320, width);
        var th = Math.max(1, Math.round(height * tw / width));
        var thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = tw;
        thumbCanvas.height = th;
        var thumbCtx = thumbCanvas.getContext('2d');
        thumbCtx.fillStyle = '#ffffff';
        thumbCtx.fillRect(0, 0, tw, th);
        thumbCtx.drawImage(canvas, 0, 0, tw, th);

        resolve({ dataUrl: full, thumb: thumbCanvas.toDataURL('image/jpeg', 0.7) });
      };
      image.onerror = function () { reject(new Error('imagem inválida')); };
      image.src = dataUrl;
    });
  }

  function renderAttachment() {
    var image = state.pendingImage;
    els.attachment.hidden = !image;
    if (!image) return;
    els.attachmentThumb.src = image.thumb || image.dataUrl;
    els.attachmentName.textContent = image.name || 'imagem';
  }

  function clearAttachment() {
    state.pendingImage = null;
    if (els.attachment) els.attachment.hidden = true;
    if (els.attachmentThumb) els.attachmentThumb.removeAttribute('src');
    if (els.imageFile) els.imageFile.value = '';
  }

  function attachFile(file) {
    if (state.busy || !file) return;
    if (!/^image\//.test(file.type || '')) {
      appendAssistant('O arquivo precisa ser uma imagem (JPG, PNG, WebP...).', true);
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      appendAssistant('A imagem é grande demais (limite 12 MB).', true);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      normalizeImage(reader.result).then(function (image) {
        state.pendingImage = {
          dataUrl: image.dataUrl,
          thumb: image.thumb,
          name: file.name || 'referência'
        };
        renderAttachment();
        els.prompt.focus();
      }).catch(function (error) {
        appendAssistant('Não foi possível preparar a imagem: ' + error.message, true);
      });
    };
    reader.onerror = function () {
      appendAssistant('Não foi possível ler a imagem.', true);
    };
    reader.readAsDataURL(file);
  }

  function analyzeReference(image, text) {
    if (!visionConfigured()) {
      return Promise.reject(new Error('inspetor de visão desligado em Ajustes'));
    }
    if (referenceController) referenceController.abort();
    referenceController = new AbortController();
    var guard = referenceController;
    return IaApi.vision({
      apiKey: state.settings.apiKey,
      baseUrl: state.settings.baseUrl,
      model: state.settings.visionModel,
      prompt: referencePrompt(text || 'imagem de referência enviada pelo usuário'),
      images: [image.dataUrl],
      sessionId: state.sessionId,
      signal: guard.signal,
      timeout: 120000
    }).finally(function () {
      if (referenceController === guard) referenceController = null;
    });
  }

  function showReference(image, report) {
    var wrap = document.createElement('div');
    wrap.className = 'tool-log';
    var line = document.createElement('div');
    line.className = 'tool-item';
    var icon = document.createElement('span');
    icon.className = 'ticon';
    icon.textContent = '🖼';
    var body = document.createElement('div');
    body.style.minWidth = '0';
    body.style.flex = '1';

    var head = document.createElement('div');
    var name = document.createElement('span');
    name.className = 'tname';
    name.textContent = 'referência';
    var info = document.createElement('span');
    info.className = 'tinfo';
    info.textContent = ' · imagem do usuário';
    head.appendChild(name);
    head.appendChild(info);
    body.appendChild(head);

    if (image && (image.thumb || image.dataUrl)) {
      var thumb = document.createElement('img');
      thumb.src = image.thumb || image.dataUrl;
      thumb.alt = 'imagem de referência';
      thumb.style.cssText = 'display:block;width:58px;height:58px;object-fit:cover;' +
        'border-radius:7px;border:1px solid var(--line);margin-top:5px;cursor:zoom-in;background:#fff';
      thumb.addEventListener('click', function () {
        els.imageLarge.src = image.dataUrl || image.thumb;
        els.imageCaption.textContent = 'referência';
        if (typeof els.imageDialog.showModal === 'function') els.imageDialog.showModal();
      });
      body.appendChild(thumb);
    }

    var block = document.createElement('div');
    block.className = 'inspector';
    block.textContent = report || 'sem laudo';
    body.appendChild(block);

    line.appendChild(icon);
    line.appendChild(body);
    wrap.appendChild(line);
    els.messages.appendChild(wrap);
    scrollMessages();

    if (!restoring) {
      state.transcript.push({
        role: 'reference',
        text: '',
        report: report || '',
        thumb: (image && image.thumb) || ''
      });
      save();
    }
  }

  function sendWithReference(text, image) {
    if (state.busy) return;
    if (!ensureKey()) return;

    var request = text || 'Modele a partir desta imagem de referência.';
    state.lastRequest = request;
    els.prompt.value = '';
    autosize();
    clearAttachment();

    appendUser(request, [{
      view: 'referência',
      dataUrl: image.dataUrl,
      preview: image.thumb
    }]);

    state.busy = true;
    setBusy(true, 'analisando referência');
    setAgentState('analisando referência', 'live');

    analyzeReference(image, request).then(function (report) {
      state.reference = {
        query: request,
        report: report,
        thumb: image.thumb || '',
        source: 'upload',
        at: Date.now()
      };
      var obj = currentObject();
      if (obj) obj.reference = state.reference;
      save();
      showReference(image, report);
      var agentText = request +
        '\n\n[Imagem de referência enviada pelo usuário — laudo do inspetor de visão]\n' +
        report +
        '\n\nUse esta referência para modelar: respeite forma, proporções e detalhes.';
      return executeAgent(agentText, 'modelando a partir da referência');
    }).catch(function (error) {
      var message = error && error.message ? error.message : String(error);
      if (message === 'cancelado') {
        state.busy = false;
        setBusy(false);
        appendAssistant('Interrompido.', true);
        return;
      }
      var note = 'A imagem de referência não pôde ser analisada: ' + message +
        '. Modele pelo pedido textual.';
      showReference(image, note);
      return executeAgent(request + '\n\n' + note, 'modelando');
    });
  }

  // -------------------------------------------------------------------------
  // benchmark de modelos (mesma referência, juiz de visão, nota do usuário)
  // -------------------------------------------------------------------------

  function benchmarkModelList() {
    return IaApi.mainModels();
  }

  function benchmarkSetStatus(text, kind) {
    if (els.bmStatus) {
      els.bmStatus.textContent = text || '';
      els.bmStatus.className = kind || '';
    }
    if (els.bmGuardStatus) els.bmGuardStatus.textContent = text || 'Acompanhe pelo painel.';
  }

  function benchmarkRefQueryLabel(reference) {
    if (!reference) return 'sem referência';
    return reference.query || 'imagem de referência';
  }

  function benchmarkReferenceFrom(image, report, query, source) {
    state.benchmark.reference = {
      image: image.dataUrl || image.image || image.thumb || '',
      thumb: image.thumb || image.dataUrl || image.image || '',
      report: report || '',
      query: query || 'imagem de referência',
      source: source || 'upload',
      at: Date.now()
    };
    renderBenchmarkReference();
    save();
  }

  function benchmarkAttachFile(file) {
    if (!file || state.benchmark.running) return;
    if (!/^image\//.test(file.type || '')) {
      benchmarkSetStatus('o arquivo precisa ser uma imagem', 'err');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      benchmarkSetStatus('imagem grande demais (limite 12 MB)', 'err');
      return;
    }
    if (benchmarkRefController) benchmarkRefController.abort();
    benchmarkRefController = new AbortController();
    var guard = benchmarkRefController;
    var query = file.name || 'imagem enviada';
    benchmarkSetStatus('preparando a imagem...', '');
    var reader = new FileReader();
    reader.onload = function () {
      normalizeImage(reader.result).then(function (image) {
        if (guard !== benchmarkRefController) return;
        benchmarkReferenceFrom(image, 'Analisando a referência...', query, 'upload');
        if (!visionConfigured()) {
          state.benchmark.reference.report = 'Inspetor de visão desligado em Ajustes; a imagem foi anexada, mas sem laudo.';
          renderBenchmarkReference();
          save();
          benchmarkSetStatus('referência anexada (sem laudo de visão)', 'err');
          return;
        }
        benchmarkSetStatus('analisando a referência...', '');
        IaApi.vision({
          apiKey: state.settings.apiKey,
          baseUrl: state.settings.baseUrl,
          model: state.settings.visionModel,
          prompt: referencePrompt(query),
          images: [image.dataUrl],
          sessionId: state.sessionId,
          signal: guard.signal,
          timeout: 120000
        }).then(function (report) {
          if (guard !== benchmarkRefController) return;
          state.benchmark.reference.report = report;
          renderBenchmarkReference();
          save();
          benchmarkSetStatus('referência pronta', 'ok');
        }).catch(function (error) {
          if (guard !== benchmarkRefController) return;
          var message = error && error.message ? error.message : String(error);
          state.benchmark.reference.report = 'A imagem foi anexada, mas o laudo falhou: ' + message;
          renderBenchmarkReference();
          save();
          benchmarkSetStatus('laudo da referência falhou', 'err');
        });
      }).catch(function (error) {
        benchmarkSetStatus('não foi possível preparar a imagem: ' + error.message, 'err');
      });
    };
    reader.onerror = function () { benchmarkSetStatus('não foi possível ler a imagem', 'err'); };
    reader.readAsDataURL(file);
  }

  function benchmarkSearch(query) {
    var q = String(query || '').trim();
    if (!q) { benchmarkSetStatus('digite uma busca para a referência', 'err'); return; }
    if (state.benchmark.running) return;
    benchmarkSetStatus('buscando referência...', '');
    if (benchmarkRefController) benchmarkRefController.abort();
    benchmarkRefController = new AbortController();
    var guard = benchmarkRefController;
    searchReference(q, 3).then(function (result) {
      if (guard !== benchmarkRefController) return;
      var first = result.images && result.images[0];
      if (!first) {
        benchmarkSetStatus('nenhuma imagem encontrada; tente outro termo', 'err');
        return;
      }
      return normalizeImage(first.dataUrl).then(function (image) {
        if (guard !== benchmarkRefController) return;
        benchmarkReferenceFrom(image, result.report, result.query || q, 'search');
        var failed = /^Não foi possível analisar|^Busca de referência falhou|^Inspetor de visão desligado/i
          .test(String(result.report || ''));
        benchmarkSetStatus(failed
          ? 'referência encontrada, mas o laudo de visão falhou'
          : 'referência pronta', failed ? 'err' : 'ok');
      });
    }).catch(function (error) {
      if (guard !== benchmarkRefController) return;
      benchmarkSetStatus('busca falhou: ' + error.message, 'err');
    });
  }

  function benchmarkUseCurrent() {
    var reference = state.reference;
    if (!reference || !(reference.thumb || reference.image)) {
      benchmarkSetStatus('o objeto atual não tem referência', 'err');
      return;
    }
    state.benchmark.reference = {
      image: reference.image || reference.thumb,
      thumb: reference.thumb || reference.image,
      report: reference.report || '',
      query: reference.query || 'referência do objeto atual',
      source: 'current',
      at: Date.now()
    };
    renderBenchmarkReference();
    save();
    benchmarkSetStatus('referência do objeto atual copiada', 'ok');
  }

  function benchmarkSystemPrompt() {
    return [
      'Você é um engenheiro de geometria 3D para impressão FDM. Unidades em milímetros, Z para cima.',
      'Escreva um script JavaScript completo e autocontido que retorne um Solid, uma lista de Solids ou {name, parts:[{name,color,solid}]}.',
      'Kernel disponível (K):',
      'K.box(w,d,h), K.roundedBox(w,d,h,r), K.cylinder(r,h,{segments}), K.cone(r1,r2,h), K.sphere(r), K.torus(R,r), K.tube(rOut,rIn,h),',
      'K.prism(contorno, altura, {holes}), K.lathe(perfil, {segments}), K.loft(aneis), K.sweep(caminho, {radius,segments,radii}),',
      'K.thread(diametro, passo, comprimento, {internal, wall, clearance, depth}), K.merge(...), K.connector(a,b,{...}), K.bridge(a,b),',
      'K.text(str,{size,height}), K.circle(r,seg), K.ellipse(rx,ry,seg), K.onBed(valor).',
      'Métodos dos Solids: .translate([x,y,z]), .rotate([rx,ry,rz]), .scale([sx,sy,sz]), .union(...), .subtract(...), .intersect(...), .merge(...).',
      'Regras: paredes >= 1,2 mm; base apoiada em z=0; peças permanentes sobrepostas em >= 1,5 mm;',
      'para tampa/rosca removível use removable:true na parte; use K.thread para roscas; não crie pinos manuais.',
      'K já existe no sandbox: não declare K nem importe nada. Use apenas o K global.',
      'O script precisa executar em menos de 50 s no sandbox: use segmentos moderados (24 a 64) e evite booleanas pesadas.',
      'Responda chamando run_geometry com o script completo. Não faça perguntas, não use outras ferramentas e não itere.'
    ].join('\n');
  }

  function benchmarkJudgePrompt(request) {
    return [
      'Você é um juiz de benchmark de modelagem 3D. A primeira imagem é a referência; as seguintes são capturas do modelo gerado.',
      'Pedido: ' + request,
      'Avalie de 0 a 10: silhueta, proporções, detalhes, conexão/printabilidade, semelhança geral.',
      'Considere se o modelo corresponde ao pedido e à referência, e se as partes estão conectadas de forma imprimível.',
      'Se o pedido previr peças removíveis/roscadas, elas são intencionalmente separadas: avalie a rosca e o encaixe, não exija que estejam fundidas.',
      'Responda SOMENTE com JSON: {"silhouette":n,"proportions":n,"details":n,"connection":n,"overall":n,"critique":"uma frase"}'
    ].join('\n');
  }

  function clampScore(value, fallback) {
    var number = Number(value);
    if (!isFinite(number)) return fallback;
    return Math.max(0, Math.min(10, number));
  }

  function parseJudge(text) {
    var raw = String(text || '');
    var json = null;
    var match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { json = JSON.parse(match[0]); } catch (e) { json = null; }
    }
    if (json && typeof json === 'object') {
      return {
        silhouette: clampScore(json.silhouette, 5),
        proportions: clampScore(json.proportions, 5),
        details: clampScore(json.details, 5),
        connection: clampScore(json.connection, 5),
        overall: clampScore(json.overall, 5),
        critique: String(json.critique || '').slice(0, 500)
      };
    }
    function grab(key) {
      var found = raw.match(new RegExp('"?\\b' + key + '\\b"?\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)', 'i'));
      return found ? clampScore(found[1].replace(',', '.'), 5) : 5;
    }
    return {
      silhouette: grab('silhouette'),
      proportions: grab('proportions'),
      details: grab('details'),
      connection: grab('connection'),
      overall: grab('overall'),
      critique: raw.slice(0, 500)
    };
  }

  function benchmarkAutoScore(judge) {
    if (!judge) return null;
    var value = 0.5 * judge.overall + 0.3 * judge.silhouette + 0.2 * judge.proportions;
    return Math.round(value * 10) / 10;
  }

  function benchmarkSaveObject(model, prompt, reference, code, result, thumbUrl) {
    var now = Date.now();
    var obj = {
      id: 'bm-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name: 'Benchmark · ' + model.label,
      description: String(prompt || '').slice(0, 180),
      notes: 'Benchmark automático. Modelo: ' + model.label + '. Referência: ' + benchmarkRefQueryLabel(reference) + '.',
      script: code,
      draft: code,
      stats: result.stats,
      thumb: thumbUrl,
      chat: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: 'Gerado no benchmark com ' + model.label + '.' }
      ],
      transcript: [
        { role: 'user', text: prompt },
        { role: 'assistant', text: 'Gerado no benchmark com ' + model.label + '.' }
      ],
      lastRequest: prompt,
      plan: [],
      focus: '',
      reference: reference ? {
        query: reference.query,
        report: reference.report,
        thumb: reference.thumb,
        source: reference.source,
        at: now
      } : null,
      versions: [{
        at: now,
        script: code,
        note: 'benchmark ' + model.id,
        stats: result.stats ? {
          triangles: result.stats.triangles,
          size: result.stats.size,
          volume: result.stats.volume
        } : null
      }],
      benchmark: true,
      benchmarkModel: model.id,
      createdAt: now,
      updatedAt: now
    };
    state.objects.unshift(obj);
    cropObjects();
    save();
    renderObjects();
    return obj;
  }

  async function benchmarkOne(model, prompt, reference, signal, onStatus) {
    var runTool = IaAgent.tools.filter(function (tool) {
      return tool.function && tool.function.name === 'run_geometry';
    })[0];
    if (!runTool) throw new Error('ferramenta run_geometry indisponível');
    var messages = [
      { role: 'system', content: benchmarkSystemPrompt() },
      {
        role: 'user',
        content: 'Pedido do benchmark: ' + prompt +
          (reference.report ? '\n\nLaudo da imagem de referência:\n' + reference.report : '') +
          '\n\nGere o script completo e responda chamando run_geometry. Não responda só com texto.'
      }
    ];
    var call = null;
    for (var attempt = 0; attempt < 2 && !call; attempt++) {
      if (signal.aborted) throw new Error('cancelado');
      onStatus(attempt === 0 ? 'pensando' : 'tentando de novo');
      var message = await IaApi.chat({
        apiKey: state.settings.apiKey,
        baseUrl: state.settings.baseUrl,
        model: model.id,
        messages: messages,
        tools: [runTool],
        reasoningEffort: state.settings.effort || 'low',
        sessionId: state.sessionId,
        signal: signal,
        timeout: 300000,
        onDelta: function () {}
      });
      call = (message.toolCalls || []).filter(function (item) {
        return item.name === 'run_geometry';
      })[0] || null;
      if (!call) {
        messages.push({ role: 'assistant', content: message.content || '' });
        messages.push({ role: 'user', content: 'Chame run_geometry agora, com o script completo. Não responda apenas com texto.' });
      }
    }
    if (!call) throw new Error('o modelo não chamou run_geometry');
    var code = call.arguments && typeof call.arguments.code === 'string' ? call.arguments.code : '';
    code = code.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    if (!code) throw new Error('run_geometry veio sem código');

    onStatus('executando');
    var result = await executor.run(code, 60000);
    if (!result || !result.ok) throw new Error((result && result.error) || 'o script falhou');

    onStatus('capturando');
    renderer.setModel(result.model.parts);
    var views = renderer.snapshot(['perspective', 'top', 'front', 'right'], {
      width: 512,
      height: 384,
      quality: 0.75,
      grid: false
    });
    var thumbShot = renderer.snapshot(['perspective'], {
      width: 320,
      height: 220,
      quality: 0.7,
      grid: false
    });
    var thumbUrl = thumbShot.length ? thumbShot[0].dataUrl : '';

    onStatus('salvando');
    var obj = benchmarkSaveObject(model, prompt, reference, code, result, thumbUrl);

    var judge = null;
    var judgeError = '';
    onStatus('julgando');
    if (!visionConfigured()) {
      judgeError = 'inspetor de visão desligado';
    } else {
      try {
        var judgeText = await IaApi.vision({
          apiKey: state.settings.apiKey,
          baseUrl: state.settings.baseUrl,
          model: state.settings.visionModel,
          prompt: benchmarkJudgePrompt(prompt),
          images: [reference.image || reference.thumb].concat(views.map(function (view) {
            return view.dataUrl;
          })),
          sessionId: state.sessionId,
          signal: signal,
          timeout: 120000
        });
        judge = parseJudge(judgeText);
      } catch (error) {
        judgeError = error && error.message ? error.message : String(error);
      }
    }

    return {
      ok: true,
      objectId: obj.id,
      stats: result.stats,
      thumb: thumbUrl,
      views: views,
      judge: judge,
      judgeError: judgeError,
      autoScore: benchmarkAutoScore(judge),
      ms: result.ms
    };
  }

  function benchmarkFindResult(index) {
    var results = state.benchmark.results || [];
    var i = Number(index);
    return isFinite(i) && results[i] ? results[i] : null;
  }

  async function runBenchmark() {
    if (state.benchmark.running) return;
    if (state.busy) {
      benchmarkSetStatus('espere o agente atual terminar', 'err');
      return;
    }
    var reference = state.benchmark.reference;
    if (!reference || !(reference.image || reference.thumb)) {
      benchmarkSetStatus('envie ou busque uma imagem de referência primeiro', 'err');
      return;
    }
    var models = benchmarkModelList().filter(function (model) {
      return state.benchmark.selected.indexOf(model.id) !== -1;
    });
    if (!models.length) {
      benchmarkSetStatus('selecione ao menos um modelo', 'err');
      return;
    }
    var allModels = benchmarkModelList();
    var replaceAll = models.length === allModels.length;
    if (state.benchmark.results.length && !confirm(replaceAll
      ? 'Substituir os resultados do benchmark anterior?'
      : 'Atualizar os modelos selecionados e manter os resultados dos outros?')) return;

    var prompt = String(els.bmPrompt.value || state.benchmark.prompt || BENCHMARK_PROMPT).trim();
    state.benchmark.prompt = prompt;
    var selectedIds = models.map(function (model) { return model.id; });
    state.benchmark.results = state.benchmark.results.filter(function (result) {
      return selectedIds.indexOf(result.model) === -1;
    });
    state.benchmark.running = true;
    state.benchmark.at = Date.now();
    benchmarkController = new AbortController();
    var signal = benchmarkController.signal;
    els.bmRun.disabled = true;
    els.bmRun.hidden = true;
    els.bmStop.hidden = false;
    els.bmStop.disabled = false;
    benchmarkSetStatus('0/' + models.length + ' · preparando', '');
    renderBenchmarkResults();
    save();

    try {
      for (var i = 0; i < models.length; i++) {
        if (signal.aborted) break;
        var model = models[i];
        var result = {
          model: model.id,
          label: model.label,
          status: 'pensando',
          startedAt: Date.now()
        };
        state.benchmark.results.push(result);
        benchmarkSetStatus((i + 1) + '/' + models.length + ' · ' + model.label + ' · pensando', '');
        renderBenchmarkResults();
        save();
        try {
          var out = await benchmarkOne(model, prompt, reference, signal, function (status) {
            result.status = status;
            benchmarkSetStatus((i + 1) + '/' + models.length + ' · ' + model.label + ' · ' +
              benchmarkStatusLabel(status), '');
            renderBenchmarkResults();
          });
          delete out.views;
          Object.assign(result, out);
          result.status = 'done';
        } catch (error) {
          var message = error && error.message ? error.message : String(error);
          if (signal.aborted || message === 'cancelado') {
            result.status = 'cancelled';
            result.error = 'parado';
          } else {
            result.status = 'error';
            result.error = message;
          }
        }
        result.finishedAt = Date.now();
        renderBenchmarkResults();
        save();
      }
    } finally {
      state.benchmark.running = false;
      benchmarkController = null;
      if (els.bmGuard) els.bmGuard.hidden = true;
      var order = benchmarkModelList().map(function (model) { return model.id; });
      state.benchmark.results.sort(function (a, b) {
        var ai = order.indexOf(a.model);
        var bi = order.indexOf(b.model);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      });
      renderer.setModel(currentParts());
      updateHud();
      renderPartsBar();
      els.bmRun.disabled = false;
      els.bmRun.hidden = false;
      els.bmStop.hidden = true;
      var done = state.benchmark.results.filter(function (item) { return item.status === 'done'; }).length;
      benchmarkSetStatus('benchmark concluído · ' + done + ' resultado(s)', 'ok');
      renderBenchmarkResults();
      save(true);
    }
  }

  function benchmarkStatusLabel(status) {
    if (status === 'pensando' || status === 'thinking') return 'pensando';
    if (status === 'tentando de novo') return 'tentando de novo';
    if (status === 'executando' || status === 'executing') return 'executando';
    if (status === 'capturando' || status === 'capturing') return 'capturando';
    if (status === 'salvando' || status === 'saving') return 'salvando';
    if (status === 'julgando' || status === 'judging') return 'julgando';
    if (status === 'done') return 'pronto';
    if (status === 'error') return 'erro';
    if (status === 'cancelled') return 'parado';
    return status || 'aguardando';
  }

  function renderBenchmarkReference() {
    if (!els.bmRefThumb) return;
    var reference = state.benchmark.reference;
    els.bmRefThumb.textContent = '';
    if (reference && (reference.thumb || reference.image)) {
      var img = document.createElement('img');
      img.src = reference.thumb || reference.image;
      img.alt = 'referência do benchmark';
      els.bmRefThumb.appendChild(img);
      els.bmRefName.textContent = reference.query || 'imagem de referência';
      els.bmRefName.title = reference.query || '';
      els.bmRefReport.textContent = reference.report || 'Sem laudo de referência.';
    } else {
      var empty = document.createElement('span');
      empty.textContent = 'sem referência';
      els.bmRefThumb.appendChild(empty);
      els.bmRefName.textContent = 'Envie uma imagem';
      els.bmRefName.title = '';
      els.bmRefReport.textContent = 'O laudo da imagem de referência aparece aqui.';
    }
    els.bmUseCurrent.hidden = !state.reference;
  }

  function renderBenchmarkModels() {
    if (!els.bmModels) return;
    els.bmModels.textContent = '';
    benchmarkModelList().forEach(function (model) {
      var label = document.createElement('label');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = model.id;
      input.checked = state.benchmark.selected.indexOf(model.id) !== -1;
      input.addEventListener('change', function () {
        var index = state.benchmark.selected.indexOf(model.id);
        if (input.checked && index === -1) state.benchmark.selected.push(model.id);
        if (!input.checked && index !== -1) state.benchmark.selected.splice(index, 1);
        save();
      });
      var text = document.createElement('span');
      text.textContent = model.label;
      label.appendChild(input);
      label.appendChild(text);
      els.bmModels.appendChild(label);
    });
  }

  function benchmarkSelectCheap() {
    var cheap = benchmarkModelList().filter(function (model) {
      return /flash/i.test(model.label);
    }).map(function (model) {
      return model.id;
    });
    if (!cheap.length) return;
    state.benchmark.selected = cheap;
    renderBenchmarkModels();
    save();
    benchmarkSetStatus(cheap.length + ' modelos Flash selecionados', 'ok');
  }

  function benchmarkSelectMid() {
    var mid = ['glm-5.3', 'glm-5.2', 'kimi-k2.7-code', 'minimax-m3', 'mimo-v2.6-pro', 'hy3', 'step-5-preview', 'longcat-2.0'];
    var known = benchmarkModelList().map(function (model) { return model.id; });
    state.benchmark.selected = mid.filter(function (id) { return known.indexOf(id) !== -1; });
    renderBenchmarkModels();
    save();
    benchmarkSetStatus(state.benchmark.selected.length + ' modelos intermediários selecionados', 'ok');
  }

  function benchmarkSelectExpensive() {
    var costly = ['deepseek-v4-pro', 'kimi-k3', 'qwen3.8-max'];
    var known = benchmarkModelList().map(function (model) { return model.id; });
    state.benchmark.selected = costly.filter(function (id) { return known.indexOf(id) !== -1; });
    renderBenchmarkModels();
    save();
    benchmarkSetStatus(state.benchmark.selected.length + ' modelos topo de linha selecionados', 'ok');
  }

  function renderBenchmarkRanking() {
    if (!els.bmRanking) return;
    var done = (state.benchmark.results || []).filter(function (result) {
      return result.status === 'done';
    });
    if (!done.length) {
      els.bmRanking.textContent = state.benchmark.running ? 'benchmark em andamento...' : 'sem resultados ainda';
      return;
    }
    var sorted = done.slice().sort(function (a, b) {
      var av = a.userScore != null ? a.userScore : (a.autoScore != null ? a.autoScore : -1);
      var bv = b.userScore != null ? b.userScore : (b.autoScore != null ? b.autoScore : -1);
      return bv - av;
    });
    var parts = sorted.slice(0, 5).map(function (result, index) {
      var score = result.userScore != null
        ? 'sua nota <b>' + result.userScore + '</b>'
        : 'auto <b>' + (result.autoScore != null ? result.autoScore.toFixed(1) : '—') + '</b>';
      return '<span><b>' + (index + 1) + '.</b> ' + escapeHtml(result.label) + ' — ' + score + '</span>';
    });
    els.bmRanking.innerHTML = 'Ranking: ' + parts.join(' · ');
  }

  function renderBenchmarkResults() {
    if (!els.bmResults) return;
    renderBenchmarkRanking();
    els.bmResults.textContent = '';
    var results = state.benchmark.results || [];
    if (!results.length) {
      var empty = document.createElement('div');
      empty.className = 'bm-empty';
      empty.textContent = state.benchmark.running
        ? 'Benchmark em andamento...'
        : 'Configure a referência, escolha os modelos e rode o benchmark.';
      els.bmResults.appendChild(empty);
      return;
    }

    results.forEach(function (result, index) {
      var running = result.status !== 'done' && result.status !== 'error' && result.status !== 'cancelled';
      var card = document.createElement('div');
      card.className = 'bm-card' + (result.status === 'done' ? ' done' : '') +
        (result.status === 'error' ? ' error' : '') + (running ? ' running' : '');
      card.dataset.result = String(index);

      var head = document.createElement('div');
      head.className = 'bm-card-head';
      var name = document.createElement('b');
      name.textContent = result.label || result.model || 'modelo';
      name.title = result.label || result.model || '';
      var badge = document.createElement('span');
      badge.className = 'bm-badge';
      badge.textContent = benchmarkStatusLabel(result.status);
      head.appendChild(name);
      head.appendChild(badge);
      card.appendChild(head);

      if (result.thumb) {
        var img = document.createElement('img');
        img.className = 'bm-thumb';
        img.src = result.thumb;
        img.alt = 'resultado de ' + (result.label || result.model || 'modelo');
        card.appendChild(img);
      } else {
        var placeholder = document.createElement('div');
        placeholder.className = 'bm-thumb placeholder';
        placeholder.textContent = running ? benchmarkStatusLabel(result.status) : 'sem captura';
        card.appendChild(placeholder);
      }

      var metrics = document.createElement('div');
      metrics.className = 'bm-metrics';
      if (result.stats) {
        var bits = [
          fmtSize(result.stats.size),
          fmtVolume(result.stats.volume),
          fmtInt(result.stats.triangles) + ' triângulos'
        ];
        if (result.stats.parts) bits.push(result.stats.parts.length + ' peças');
        if (result.stats.joints && result.stats.joints.length) bits.push(result.stats.joints.length + ' juntas');
        if (result.stats.loose && result.stats.loose.length) bits.push(result.stats.loose.length + ' solta(s)');
        if (result.stats.nonManifoldEdges > 0) bits.push(fmtInt(result.stats.nonManifoldEdges) + ' não-manifold');
        if (result.ms) bits.push((result.ms / 1000).toFixed(1) + ' s');
        metrics.textContent = bits.join(' · ');
      } else {
        metrics.textContent = running ? 'aguardando geometria' : 'sem geometria';
      }
      card.appendChild(metrics);

      var judge = document.createElement('div');
      judge.className = 'bm-judge';
      if (result.judge) {
        var line = document.createElement('div');
        line.textContent = 'Silhueta ' + result.judge.silhouette.toFixed(0) +
          ' · Proporções ' + result.judge.proportions.toFixed(0) +
          ' · Detalhes ' + result.judge.details.toFixed(0) +
          ' · Conexão ' + result.judge.connection.toFixed(0);
        judge.appendChild(line);
        var overall = document.createElement('div');
        overall.innerHTML = 'Semelhança <b>' + result.judge.overall.toFixed(1) + '</b>' +
          (result.autoScore != null ? ' · auto <span class="bm-score">' + result.autoScore.toFixed(1) + '</span>' : '');
        judge.appendChild(overall);
        if (result.judge.critique) {
          var critique = document.createElement('p');
          critique.textContent = result.judge.critique;
          judge.appendChild(critique);
        }
      } else if (result.judgeError) {
        judge.textContent = 'Juiz: ' + result.judgeError;
      } else if (result.status === 'done') {
        judge.textContent = 'Juiz sem laudo.';
      } else {
        judge.textContent = running ? 'aguardando o juiz de visão' : '';
      }
      card.appendChild(judge);

      if (result.error) {
        var error = document.createElement('div');
        error.className = 'bm-error';
        error.textContent = result.error;
        card.appendChild(error);
      }

      var vote = document.createElement('div');
      vote.className = 'bm-vote';
      var voteLabel = document.createElement('span');
      voteLabel.textContent = 'sua nota';
      var select = document.createElement('select');
      select.dataset.vote = '';
      select.title = 'Sua nota para este resultado';
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '—';
      select.appendChild(blank);
      for (var n = 1; n <= 10; n++) {
        var option = document.createElement('option');
        option.value = String(n);
        option.textContent = String(n);
        select.appendChild(option);
      }
      select.value = result.userScore != null ? String(result.userScore) : '';
      var comment = document.createElement('input');
      comment.type = 'text';
      comment.dataset.comment = '';
      comment.placeholder = 'comentário';
      comment.value = result.userComment || '';
      vote.appendChild(voteLabel);
      vote.appendChild(select);
      vote.appendChild(comment);
      if (result.objectId) {
        var open = document.createElement('button');
        open.type = 'button';
        open.dataset.open = result.objectId;
        open.textContent = 'Abrir';
        open.disabled = !!state.benchmark.running;
        vote.appendChild(open);
      }
      card.appendChild(vote);

      els.bmResults.appendChild(card);
    });
  }

  function openBenchmark() {
    if (!els.benchmarkDialog) return;
    if (els.bmGuard) els.bmGuard.hidden = true;
    if (!state.benchmark.prompt) state.benchmark.prompt = BENCHMARK_PROMPT;
    if (!state.benchmark.selected.length) {
      state.benchmark.selected = benchmarkModelList().map(function (model) { return model.id; });
    }
    els.bmPrompt.value = state.benchmark.prompt;
    els.bmSearchQuery.value = (state.benchmark.reference && state.benchmark.reference.query) || '';
    renderBenchmarkReference();
    renderBenchmarkModels();
    renderBenchmarkResults();
    benchmarkSetStatus(state.benchmark.running ? 'benchmark em andamento...' : '', '');
    els.bmRun.disabled = !!state.benchmark.running;
    els.bmRun.hidden = !!state.benchmark.running;
    els.bmStop.hidden = !state.benchmark.running;
    if (typeof els.benchmarkDialog.showModal === 'function') {
      if (!els.benchmarkDialog.open) els.benchmarkDialog.showModal();
    }
  }

  function closeBenchmark() {
    if (state.benchmark.running) {
      if (!confirm('O benchmark continua rodando em segundo plano. Fechar o painel?')) return;
      if (els.bmGuard) els.bmGuard.hidden = false;
      benchmarkSetStatus(els.bmStatus ? els.bmStatus.textContent : 'Benchmark em andamento...', '');
    } else if (benchmarkRefController) {
      benchmarkRefController.abort();
      benchmarkRefController = null;
    }
    if (els.benchmarkDialog && els.benchmarkDialog.open) els.benchmarkDialog.close();
  }

  // -------------------------------------------------------------------------
  // host do agente
  // -------------------------------------------------------------------------

  var host = {
    getSettings: function () {
      return {
        apiKey: state.settings.apiKey,
        baseUrl: state.settings.baseUrl,
        model: state.settings.model,
        maxSteps: state.settings.maxSteps,
        effort: state.settings.effort || 'low',
        sessionId: state.sessionId,
        timeout: 300000
      };
    },

    describeContext: function () {
      var obj = currentObject();
      var lines = [];
      if (obj) {
        lines.push('Objeto atual: "' + obj.name + '" (id ' + obj.id + ')');
        if (obj.description) lines.push('Descrição: ' + obj.description);
        if (obj.notes) lines.push('Anotações: ' + obj.notes);
        if (state.stats) {
          lines.push('Medidas: ' + fmtSize(state.stats.size) + ', volume ' + fmtVolume(state.stats.volume) +
            ', ' + fmtInt(state.stats.triangles) + ' triângulos.');
          if (state.stats.joints && state.stats.joints.length) {
            lines.push('Juntas automáticas: ' + state.stats.joints.length + ' pinos já adicionados pelo pipeline' +
              ' (parte "juntas"). Não crie pinos manuais.');
          }
          if (state.stats.loose && state.stats.loose.length) {
            lines.push('Peças soltas: ' + state.stats.loose.map(function (item) {
              return item.a + '↔' + item.b + ' (' + Number(item.gap).toFixed(1) + ' mm)';
            }).join('; ') + '. Aproxime-as ou use K.bridge.');
          }
        }
        lines.push('');
        lines.push('Script atual (edite e reenvie o script completo em run_geometry):');
        lines.push('```js');
        lines.push(clipScript(obj.script));
        lines.push('```');
        if (state.reference && state.reference.report) {
          lines.push('');
          lines.push('Referência visual já buscada: ' + state.reference.query);
          lines.push(state.reference.report);
        }
      } else {
        lines.push('Nenhum objeto criado ainda. Comece do zero.');
      }

      lines.push('');
      lines.push('Biblioteca (' + state.objects.length + ' objetos):');
      if (state.objects.length) {
        state.objects.slice(0, 20).forEach(function (item) {
          lines.push('- ' + item.id + ' · "' + item.name + '" · ' +
            (item.stats ? fmtSize(item.stats.size) : 'sem medidas') +
            (item.description ? ' · ' + item.description : ''));
        });
      } else {
        lines.push('- (vazia)');
      }

      if (state.memory.length) {
        lines.push('');
        lines.push('Memória do usuário:');
        state.memory.slice(-12).forEach(function (note) { lines.push('- ' + note); });
      }

      if (state.plan.length) {
        lines.push('');
        lines.push('Plano de partes (trabalhe uma por vez e use focus="nome" em run_geometry):');
        state.plan.forEach(function (item) {
          var info = findStatsPart(item.name);
          lines.push('- ' + item.name + ' [' + partStatusLabel(item.status) + ']' +
            (info ? ' · ' + fmtSize(info.size) + ' · ' + fmtVolume(info.volume) +
              ' · ' + fmtInt(info.triangles) + ' triângulos' : '') +
            (item.description ? ' — ' + item.description : ''));
        });
        if (state.focus) lines.push('Parte em foco agora: ' + state.focus);
        var extras = modelParts().filter(function (part) {
          return !state.plan.some(function (item) {
            return normalizePartName(item.name) === normalizePartName(part.name);
          });
        });
        if (extras.length) {
          lines.push('Peças no modelo fora do plano: ' + extras.map(function (p) { return p.name; }).join(', '));
        }
      }

      lines.push('');
      lines.push('Inspetor de visão: ' + (visionConfigured()
        ? state.settings.visionModel + ' (analisa automaticamente após cada execução)'
        : 'desligado em Ajustes'));

      return lines.join('\n');
    },

    runGeometry: function (code, meta) {
      announce('executando o script');
      return executor.run(code).then(function (result) {
        if (!result.ok) {
          els.scriptStatus.textContent = result.error || 'falha ao executar';
          els.scriptStatus.className = 'script-status err';
          if (result.logs) els.scriptStatus.textContent += ' · ' + result.logs;
          var detail = result.error || 'falha ao executar';
          if (result.stack) detail += '\n' + result.stack;
          if (result.logs) detail += '\nlogs:\n' + result.logs;
          throw new Error(detail);
        }

        state.script = code;
        els.scriptEditor.value = code;

        var requestedFocus = meta && meta.focus ? String(meta.focus).trim() : '';
        state.focus = '';
        var focusMissing = '';
        if (requestedFocus) {
          var foundFocus = null;
          for (var fi = 0; fi < result.model.parts.length; fi++) {
            if (normalizePartName(result.model.parts[fi].name) === normalizePartName(requestedFocus)) {
              foundFocus = result.model.parts[fi].name;
              break;
            }
          }
          if (foundFocus) state.focus = foundFocus;
          else focusMissing = requestedFocus;
        }

        handleResult(result);

        var obj = ensureObject({
          name: (meta && meta.name) || (result.model && result.model.name) || '',
          description: meta && meta.description,
          notes: meta && meta.notes
        });
        obj.script = code;
        obj.draft = code;
        obj.stats = result.stats;
        obj.updatedAt = Date.now();
        if (meta && meta.name && String(meta.name).trim()) obj.name = String(meta.name).trim();
        if (meta && meta.description) obj.description = meta.description;
        if (meta && meta.notes) {
          obj.notes = obj.notes ? obj.notes + '\n' + meta.notes : meta.notes;
        }
        obj.thumb = thumb();
        addVersion(obj, code, 'agente', result.stats);
        save();
        renderObjects();
        flashCard();
        updateVersionSelect();
        syncObjectUI();

        var images = [];
        var report = null;
        if (visionConfigured()) {
          announce('capturando vistas');
          try { images = capture(); } catch (e) { images = []; }
        }
        if (images.length) {
          announce('inspetor de visão analisando');
          var focusExtra = state.focus
            ? 'Parte em foco: "' + state.focus + '" (as capturas mostram somente essa parte isolada).'
            : '';
          return scoutReport(images, focusExtra).then(function (text) {
            report = text;
            if (state.focus) markPartReviewed(state.focus);
            return finish();
          }).catch(function (error) {
            report = 'Inspetor de visão indisponível: ' +
              (error && error.message ? error.message : error) + '. Use as medidas e os logs.';
            return finish();
          });
        }

        return finish();

        function finish() {
          var focusPart = null;
          if (state.focus && result.stats && result.stats.parts) {
            for (var pi = 0; pi < result.stats.parts.length; pi++) {
              if (normalizePartName(result.stats.parts[pi].name) === normalizePartName(state.focus)) {
                focusPart = result.stats.parts[pi];
                break;
              }
            }
          }
          return {
            stats: result.stats,
            logs: result.logs,
            ms: result.ms,
            images: images,
            report: report || (visionConfigured() ? null : 'Inspetor de visão desligado em Ajustes; avalie pelas medidas.'),
            focusPart: focusPart,
            focusMissing: focusMissing
          };
        }
      });
    },

    captureViews: function (views) {
      var images = capture(views);
      if (!visionConfigured()) {
        return Promise.resolve({ images: images, report: 'Inspetor de visão desligado em Ajustes.' });
      }
      announce('inspetor de visão analisando');
      var extra = state.focus
        ? 'Parte em foco: "' + state.focus + '" (capturas isoladas dessa parte).'
        : '';
      return scoutReport(images, extra).then(function (report) {
        return { images: images, report: report };
      }).catch(function (error) {
        return {
          images: images,
          report: 'Inspetor de visão indisponível: ' +
            (error && error.message ? error.message : error) + '.'
        };
      });
    },

    inspectGeometry: function () {
      if (!state.model || !state.stats) {
        return Promise.resolve({ text: 'Nenhum modelo na mesa ainda.', stats: null });
      }
      var stats = state.stats;
      var obj = currentObject();
      var text = [
        'Objeto: ' + (obj ? obj.name : '(sem nome)'),
        'Parte em foco: ' + (state.focus || 'conjunto'),
        'Medidas: ' + fmtSize(stats.size),
        'Volume: ' + fmtVolume(stats.volume) + ' (' + fmtInt(stats.volume) + ' mm³)',
        'Área: ' + fmtInt(stats.area) + ' mm²',
        'Triângulos: ' + fmtInt(stats.triangles),
        'Peças: ' + (stats.parts || []).map(function (p) {
          return p.name + ' ' + fmtSize(p.size) + ' / ' + fmtVolume(p.volume);
        }).join('; '),
        'Arestas de borda (junções T): ' + stats.boundaryEdges,
        'Arestas não-manifold: ' + stats.nonManifoldEdges
      ].join('\n');
      return Promise.resolve({ text: text, stats: stats });
    },

    listObjects: function () {
      if (!state.objects.length) return Promise.resolve('A biblioteca está vazia.');
      var lines = state.objects.map(function (obj) {
        return '- ' + obj.id + ' · "' + obj.name + '"' +
          (obj.stats ? ' · ' + fmtSize(obj.stats.size) + ' · ' + fmtVolume(obj.stats.volume) : '') +
          (obj.description ? ' · ' + obj.description : '');
      });
      return Promise.resolve('Objetos salvos (memória):\n' + lines.join('\n'));
    },

    loadObject: function (id) {
      return readObject(id).then(function (result) {
        return { text: result.text, stats: result.stats };
      });
    },

    saveObject: function (args) {
      var obj = currentObject();
      if (!obj) return Promise.resolve('Nenhum objeto atual para atualizar.');
      if (args.name && String(args.name).trim()) obj.name = String(args.name).trim();
      if (args.description) obj.description = args.description;
      if (args.notes) obj.notes = args.notes;
      obj.updatedAt = Date.now();
      save();
      renderObjects();
      syncObjectUI();
      return Promise.resolve('Objeto "' + obj.name + '" atualizado.');
    },

    saveMemory: function (note) {
      var text = String(note || '').trim();
      if (!text) return Promise.resolve('Nada para guardar.');
      if (state.memory.indexOf(text) === -1) state.memory.push(text);
      if (state.memory.length > 40) state.memory = state.memory.slice(-40);
      save();
      return Promise.resolve('Memória atualizada: ' + text);
    },

    searchReference: function (query, count) {
      return searchReference(query, count).then(function (result) {
        var images = (result.images || []).map(function (image) {
          return { view: image.title || 'referência', dataUrl: image.dataUrl, url: image.url };
        });
        state.reference = {
          query: result.query || String(query || ''),
          report: result.report || '',
          at: Date.now()
        };
        var obj = currentObject();
        if (obj) obj.reference = state.reference;
        save();
        var text = 'Referências para "' + state.reference.query + '": ' + images.length +
          ' imagem(ns).\n\n' + state.reference.report;
        return { text: text, images: images, report: state.reference.report };
      });
    },

    planParts: function (parts) {
      var previous = {};
      state.plan.forEach(function (item) {
        previous[normalizePartName(item.name)] = item;
      });

      var seen = {};
      var list = [];
      (parts || []).forEach(function (item) {
        var name = String(item && item.name || '').trim();
        if (!name) return;
        var key = normalizePartName(name);
        if (seen[key]) return;
        seen[key] = true;
        var old = previous[key];
        list.push({
          name: name,
          description: item && item.description ? String(item.description) : '',
          status: old ? old.status : 'planned'
        });
      });

      if (!list.length) return Promise.reject(new Error('o plano precisa de pelo menos uma parte com nome'));
      state.plan = list.slice(0, 16);
      syncPlanWithModel();
      var obj = currentObject();
      if (obj) obj.plan = state.plan;
      save();
      renderPartsBar();

      var lines = state.plan.map(function (item, index) {
        return (index + 1) + '. ' + item.name + ' [' + partStatusLabel(item.status) + ']' +
          (item.description ? ' — ' + item.description : '');
      });
      return Promise.resolve('Plano registrado com ' + state.plan.length + ' partes:\n' + lines.join('\n') +
        '\n\nConstrua uma parte por vez e use focus="nome" em run_geometry. O inspetor verá só a parte isolada.');
    },

    onEvent: function (type, data) {
      if (type === 'status') {
        announce(data.label, data.phase === 'done' ? 'ok' : 'live');
      } else if (type === 'assistant_start') {
        startAssistantLive();
      } else if (type === 'assistant_delta') {
        deltaAssistant(data.text || '');
      } else if (type === 'assistant_end') {
        endAssistantLive(data.content || '');
      } else if (type === 'assistant') {
        if (data.content && data.content.trim()) appendAssistant(data.content);
      } else if (type === 'tool_start') {
        showPendingTool(data);
      } else if (type === 'tool') {
        removePendingTool();
        appendTool(data);
      }
    }
  };

  function clipScript(script) {
    var code = String(script || '');
    if (code.length <= 12000) return code;
    return code.slice(0, 7200) + '\n/* … trecho do meio omitido … */\n' + code.slice(-4200);
  }

  // -------------------------------------------------------------------------
  // chat
  // -------------------------------------------------------------------------

  function scrollMessages(force) {
    var box = els.messages;
    if (!box) return;
    var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (!force && !nearBottom) return;
    if (scrollTimer) cancelAnimationFrame(scrollTimer);
    scrollTimer = requestAnimationFrame(function () {
      box.scrollTop = box.scrollHeight;
    });
  }

  function appendUser(text, images) {
    var wrap = document.createElement('div');
    wrap.className = 'msg user';
    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'você';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (text) bubble.innerHTML = renderMarkdown(text);
    if (images && images.length) bubble.appendChild(thumbs(images));
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    els.messages.appendChild(wrap);
    if (!restoring) {
      state.transcript.push({ role: 'user', text: text || '' });
      save();
    }
    scrollMessages();
  }

  function appendAssistant(text, isError) {
    var wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = isError ? '!' : 'IA';
    if (isError) avatar.style.background = 'var(--err)';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = isError ? '<p><strong>Não deu certo.</strong> ' + escapeHtml(text) + '</p>' : renderMarkdown(text);
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    els.messages.appendChild(wrap);
    if (!restoring) {
      state.transcript.push({ role: 'assistant', text: text || '', error: !!isError });
      save();
    }
    scrollMessages();
    return wrap;
  }

  var TOOL_LABEL = {
    run_geometry: 'script',
    capture_views: 'capturas',
    inspect_geometry: 'medidas',
    list_objects: 'memória',
    load_object: 'abrir objeto',
    plan_parts: 'plano de partes',
    search_reference: 'referência',
    save_object: 'salvar objeto',
    save_memory: 'lembrar'
  };

  function appendTool(data) {
    var item = document.createElement('div');
    item.className = 'tool-log';

    var line = document.createElement('div');
    line.className = 'tool-item' + (data.ok ? '' : ' bad');

    var icon = document.createElement('span');
    icon.className = 'ticon';
    icon.textContent = data.ok ? '✓' : '!';

    var body = document.createElement('div');
    body.style.minWidth = '0';
    body.style.flex = '1';

    var head = document.createElement('div');
    var name = document.createElement('span');
    name.className = 'tname';
    name.textContent = TOOL_LABEL[data.name] || data.name;
    var info = document.createElement('span');
    info.className = 'tinfo';
    info.textContent = ' · ' + firstLine(data.text).slice(0, 160);
    head.appendChild(name);
    head.appendChild(info);
    body.appendChild(head);

    if (data.stats && data.ok) {
      var stats = document.createElement('div');
      stats.className = 'tinfo';
      stats.textContent = fmtSize(data.stats.size) + ' · ' + fmtVolume(data.stats.volume) +
        ' · ' + fmtInt(data.stats.triangles) + ' triângulos';
      stats.style.fontSize = '10.5px';
      body.appendChild(stats);
    }

    if (data.args && typeof data.args.code === 'string' && data.args.code.trim()) {
      body.appendChild(scriptPreview(data.args.code, false));
    }

    if (data.text && data.text.length > 160) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = 'detalhes';
      var pre = document.createElement('pre');
      pre.textContent = data.text;
      details.appendChild(summary);
      details.appendChild(pre);
      body.appendChild(details);
    }

    if (data.images && data.images.length) {
      body.appendChild(thumbs(data.images));
    }

    if (data.report) {
      var block = document.createElement('div');
      block.className = 'inspector';
      block.textContent = data.report;
      body.appendChild(block);
    }

    line.appendChild(icon);
    line.appendChild(body);
    item.appendChild(line);
    els.messages.appendChild(item);
    if (!restoring) {
      state.transcript.push({
        role: 'tool',
        name: data.name,
        ok: data.ok !== false,
        text: data.text || '',
        report: data.report || null,
        stats: data.stats || null
      });
      save();
    }
    scrollMessages();
  }

  function firstLine(text) {
    return String(text || '').split('\n')[0] || '';
  }

  function thumbs(images) {
    var row = document.createElement('div');
    row.className = 'thumbs';
    images.slice(0, 5).forEach(function (image) {
      var img = document.createElement('img');
      img.src = image.preview || image.dataUrl;
      img.alt = image.view || 'captura';
      img.title = (AgentViewLabel(image.view) || '') + ' · clique para ampliar';
      img.addEventListener('click', function () {
        els.imageLarge.src = image.dataUrl || image.preview;
        els.imageCaption.textContent = image.view || '';
        if (typeof els.imageDialog.showModal === 'function') els.imageDialog.showModal();
      });
      row.appendChild(img);
    });
    if (images.length > 5) {
      var more = document.createElement('span');
      more.className = 'more';
      more.textContent = '+' + (images.length - 5);
      row.appendChild(more);
    }
    return row;
  }

  function AgentViewLabel(view) {
    return {
      perspective: 'perspectiva', top: 'topo', bottom: 'baixo',
      front: 'frente', back: 'trás', left: 'esquerda', right: 'direita'
    }[view] || view;
  }

  function setAgentState(label, kind) {
    els.agentState.textContent = label || 'pronto';
    els.agentDot.className = 'dot' + (kind ? ' ' + kind : '');
    if (kind === 'live') {
      els.agentDot.classList.add('live');
      els.stopAgent.hidden = false;
    } else {
      els.stopAgent.hidden = true;
    }
  }

  var activity = { active: false, started: 0, timer: null, steps: [], hideTimer: null };
  var live = null;
  var liveFrame = false;
  var pendingTool = null;

  function startActivity(label) {
    if (activity.hideTimer) {
      clearTimeout(activity.hideTimer);
      activity.hideTimer = null;
    }
    if (!activity.active) {
      activity.active = true;
      activity.started = Date.now();
      activity.steps = [];
      els.activity.hidden = false;
      els.activitySteps.textContent = '';
    }
    announce(label);
    if (!activity.timer) activity.timer = setInterval(updateActivityClock, 180);
    updateActivityClock();
  }

  function updateActivityClock() {
    if (!activity.active) return;
    var seconds = (Date.now() - activity.started) / 1000;
    els.activityTime.textContent = seconds.toFixed(1).replace('.', ',') + ' s';
  }

  /** Atualiza o selo do chat, a atividade e o selo sobre o 3D. */
  function announce(label, kind) {
    if (!label) return;
    setAgentState(label, kind || (state.busy ? 'live' : 'ok'));
    if (activity.active) {
      els.activityLabel.textContent = label;
      if (!activity.steps.length || activity.steps[activity.steps.length - 1] !== label) {
        activity.steps.push(label);
        renderActivitySteps();
      }
      updateActivityClock();
    }
    if (state.busy) {
      els.stageStatus.hidden = false;
      els.stageStatusText.textContent = label;
    }
  }

  function renderActivitySteps() {
    els.activitySteps.textContent = '';
    var steps = activity.steps.slice(-4);
    steps.forEach(function (step, index) {
      var span = document.createElement('span');
      span.textContent = step;
      span.className = index === steps.length - 1 ? 'now' : 'done';
      els.activitySteps.appendChild(span);
    });
  }

  function stopActivity() {
    if (!activity.active) return;
    if (activity.timer) {
      clearInterval(activity.timer);
      activity.timer = null;
    }
    updateActivityClock();
    els.activityLabel.textContent = 'pronto';
    els.activitySteps.querySelectorAll('span').forEach(function (span) { span.className = 'done'; });
    els.stageStatus.hidden = true;
    if (activity.hideTimer) clearTimeout(activity.hideTimer);
    activity.hideTimer = setTimeout(function () {
      if (!state.busy) {
        activity.active = false;
        els.activity.hidden = true;
        els.activitySteps.textContent = '';
      }
    }, 2400);
  }

  // --- bolha da resposta em streaming ---------------------------------------

  function startAssistantLive() {
    if (live) return;
    var wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'IA';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = '<span class="cursor"></span>';
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    els.messages.appendChild(wrap);
    live = { wrap: wrap, bubble: bubble, text: '' };
    scrollMessages(true);
  }

  function deltaAssistant(chunk) {
    if (!live) startAssistantLive();
    live.text += chunk;
    if (liveFrame) return;
    liveFrame = true;
    requestAnimationFrame(function () {
      liveFrame = false;
      if (!live) return;
      live.bubble.innerHTML = renderMarkdown(live.text) + '<span class="cursor"></span>';
      scrollMessages();
    });
  }

  function endAssistantLive(content) {
    if (!live) {
      if (content && content.trim()) appendAssistant(content);
      return;
    }
    var text = content || live.text;
    if (!text.trim()) live.wrap.remove();
    else live.bubble.innerHTML = renderMarkdown(text);
    live = null;
    if (!restoring && text.trim()) {
      state.transcript.push({ role: 'assistant', text: text });
      save();
    }
    scrollMessages();
  }

  // --- ferramenta em andamento ---------------------------------------------

  function removePendingTool() {
    if (pendingTool) {
      pendingTool.remove();
      pendingTool = null;
    }
  }

  function showPendingTool(data) {
    removePendingTool();
    var wrap = document.createElement('div');
    wrap.className = 'tool-log';
    var line = document.createElement('div');
    line.className = 'tool-item';
    var icon = document.createElement('span');
    icon.className = 'ticon';
    icon.innerHTML = '<span class="spin"></span>';
    var body = document.createElement('div');
    body.style.minWidth = '0';
    body.style.flex = '1';

    var head = document.createElement('div');
    var name = document.createElement('span');
    name.className = 'tname';
    name.textContent = TOOL_LABEL[data.name] || data.name;
    var info = document.createElement('span');
    info.className = 'tinfo';
    info.textContent = ' · ' + pendingText(data);
    head.appendChild(name);
    head.appendChild(info);
    body.appendChild(head);

    if (data.args && typeof data.args.code === 'string' && data.args.code.trim()) {
      body.appendChild(scriptPreview(data.args.code, false));
    }

    line.appendChild(icon);
    line.appendChild(body);
    wrap.appendChild(line);
    els.messages.appendChild(wrap);
    pendingTool = wrap;
    scrollMessages(true);
  }

  function pendingText(data) {
    if (data.name === 'run_geometry') {
      var lines = data.args && data.args.code ? data.args.code.split('\n').length : 0;
      return 'executando' + (lines ? ' ' + lines + ' linhas de script' : ' o script');
    }
    if (data.name === 'capture_views') return 'tirando capturas e chamando o inspetor';
    if (data.name === 'load_object') return 'carregando da biblioteca';
    return 'trabalhando…';
  }

  function scriptPreview(code, open) {
    var lines = code.split('\n');
    var details = document.createElement('details');
    if (open) details.open = true;
    var summary = document.createElement('summary');
    summary.textContent = 'script · ' + lines.length + ' linhas';
    var pre = document.createElement('pre');
    pre.textContent = lines.slice(0, 140).join('\n') +
      (lines.length > 140 ? '\n… ' + (lines.length - 140) + ' linhas no editor' : '');
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
  }

  function flashCard() {
    var card = els.paneObjects.querySelector('.object-card.active');
    if (!card) return;
    card.classList.remove('just-saved');
    void card.offsetWidth;
    card.classList.add('just-saved');
  }

  function setBusy(busy, label) {
    state.busy = busy;
    els.sendButton.disabled = busy;
    els.captureButton.disabled = busy;
    els.attachImage.disabled = busy;
    els.imageFile.disabled = busy;
    els.attachmentRemove.disabled = busy;
    els.prompt.readOnly = busy;
    if (busy) {
      startActivity(label || 'trabalhando');
      setAgentState(label || 'trabalhando', 'live');
    } else {
      stopActivity();
      setAgentState(visionConfigured() ? 'pronto' : 'inspetor desligado', 'ok');
    }
  }

  function ensureKey() {
    if (state.settings.apiKey) {
      els.setupBanner.hidden = true;
      return true;
    }
    els.setupBanner.hidden = false;
    openSettings();
    return false;
  }

  function isRetryable(message) {
    return /demorou|sem enviar dados|começou a responder|Failed to fetch|conexão|Tentar de novo|API/i.test(String(message || ''));
  }

  function appendRetryButton(wrap) {
    if (!wrap) return;
    var bubble = wrap.querySelector('.bubble');
    if (!bubble) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'retry-btn';
    button.textContent = 'Tentar de novo';
    button.addEventListener('click', function () { retryAgent(); });
    bubble.appendChild(button);
  }

  function handleAgentError(error) {
    endAssistantLive('');
    var message = error && error.message ? error.message : String(error);
    if (message === 'cancelado') {
      appendAssistant('Interrompido.', true);
      return;
    }
    var wrap = appendAssistant(message, true);
    if (isRetryable(message)) appendRetryButton(wrap);
    setAgentState('erro', 'err');
  }

  function runAgentRequest(kind, text, label) {
    state.busy = true;
    setBusy(true, label || 'pensando');
    var request = kind === 'retry' ? agent.retry() : agent.send(text);
    return request.then(function () {
      state.chat = agent.exportHistory();
      save();
      setAgentState('pronto', 'ok');
    }).catch(handleAgentError).finally(function () {
      state.busy = false;
      setBusy(false);
      state.chat = agent.exportHistory();
      save();
    });
  }

  function executeAgent(text, label) {
    return runAgentRequest('send', text, label);
  }

  function retryAgent() {
    if (state.busy) return;
    return runAgentRequest('retry', '', 'tentando de novo');
  }

  function sendPrompt() {
    if (state.busy) return;
    var text = els.prompt.value.trim();
    var image = state.pendingImage;
    if (!text && !image) return;
    if (!ensureKey()) return;

    if (image) {
      sendWithReference(text, image);
      return;
    }

    els.prompt.value = '';
    autosize();
    state.lastRequest = text;
    appendUser(text);
    executeAgent(text);
  }

  function showLocalCaptures(images, caption) {
    var wrap = document.createElement('div');
    wrap.className = 'tool-log';
    var line = document.createElement('div');
    line.className = 'tool-item';
    var icon = document.createElement('span');
    icon.className = 'ticon';
    icon.textContent = '◉';
    var body = document.createElement('div');
    var head = document.createElement('div');
    var name = document.createElement('span');
    name.className = 'tname';
    name.textContent = 'capturas';
    var info = document.createElement('span');
    info.className = 'tinfo';
    info.textContent = ' · ' + caption + ' (' + images.length + ')';
    head.appendChild(name);
    head.appendChild(info);
    body.appendChild(head);
    body.appendChild(thumbs(images));
    line.appendChild(icon);
    line.appendChild(body);
    wrap.appendChild(line);
    els.messages.appendChild(wrap);
    scrollMessages();
  }

  // -------------------------------------------------------------------------
  // markdown
  // -------------------------------------------------------------------------

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(text) {
    var blocks = [];
    var escaped = escapeHtml(text).replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, function (match, code) {
      blocks.push(code.replace(/\n$/, ''));
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });

    var chunks = escaped.split(/\n{2,}/);
    var html = chunks.map(function (chunk) {
      chunk = chunk.replace(/^\n+|\n+$/g, '');
      if (!chunk) return '';
      var placeholder = chunk.match(/^\u0000B(\d+)\u0000$/);
      if (placeholder) return '<pre><code>' + blocks[Number(placeholder[1])] + '</code></pre>';

      var heading = chunk.match(/^(#{1,4})\s+([\s\S]+)$/);
      if (heading) {
        return '<h4>' + inline(heading[2]) + '</h4>';
      }

      var lines = chunk.split('\n');
      var isList = lines.every(function (line) { return /^\s*[-*]\s+/.test(line); });
      var isNumbered = lines.every(function (line) { return /^\s*\d+[.)]\s+/.test(line); });
      if (isList) {
        return '<ul>' + lines.map(function (line) {
          return '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>';
        }).join('') + '</ul>';
      }
      if (isNumbered) {
        return '<ol>' + lines.map(function (line) {
          return '<li>' + inline(line.replace(/^\s*\d+[.)]\s+/, '')) + '</li>';
        }).join('') + '</ol>';
      }
      return '<p>' + inline(lines.join('\n')).replace(/\n/g, '<br>') + '</p>';
    }).join('');

    return html.replace(/\u0000B(\d+)\u0000/g, function (match, index) {
      var code = blocks[Number(index)];
      if (code === undefined) return '';
      // blocos inline que sobraram no meio de um parágrafo
      return '<pre><code>' + code + '</code></pre>';
    });
  }

  function inline(text) {
    return text
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  }

  // -------------------------------------------------------------------------
  // script e versões
  // -------------------------------------------------------------------------

  function updateVersionSelect() {
    var select = els.versionSelect;
    select.textContent = '';
    var obj = currentObject();
    var current = document.createElement('option');
    current.value = '-1';
    current.textContent = obj ? 'versão atual' : 'sem versões';
    select.appendChild(current);

    if (!obj) return;
    for (var i = obj.versions.length - 1; i >= 0; i--) {
      var version = obj.versions[i];
      var option = document.createElement('option');
      option.value = String(i);
      option.textContent = 'v' + (i + 1) + ' · ' + timeOf(version.at) + ' · ' + (version.note || '');
      select.appendChild(option);
    }
    select.value = '-1';
  }

  function timeOf(ms) {
    try {
      return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '--:--';
    }
  }

  function saveVersionManually() {
    var obj = currentObject();
    var code = els.scriptEditor.value;
    if (!obj) {
      if (!code.trim()) {
        els.scriptStatus.textContent = 'nada para salvar';
        els.scriptStatus.className = 'script-status err';
        return;
      }
      obj = ensureObject({});
    }
    obj.script = code;
    obj.draft = code;
    obj.updatedAt = Date.now();
    addVersion(obj, code, 'manual', state.stats);
    save();
    renderObjects();
    updateVersionSelect();
    els.scriptStatus.textContent = 'versão salva';
    els.scriptStatus.className = 'script-status ok';
  }

  function downloadScript() {
    var code = els.scriptEditor.value;
    if (!code.trim()) return;
    var obj = currentObject();
    download(code, safeFileName(obj ? obj.name : 'geometria') + '.js', 'text/javascript');
  }

  function download(buffer, filename, mime) {
    var blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function safeFileName(name) {
    return String(name || 'geometria').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'geometria';
  }

  function exportStl() {
    if (!state.model || !state.model.parts.length) {
      appendAssistant('Não há geometria para exportar ainda.', true);
      return;
    }
    var obj = currentObject();
    var name = safeFileName(obj ? obj.name : 'geometria');
    try {
      var buffer = IaKernel.stlBinary(state.model.parts.map(function (part) { return part.positions; }),
        obj ? obj.name : '');
      download(buffer, name + '.stl', 'model/stl');
      var triangles = Math.round((buffer.byteLength - 84) / 50);
      els.scriptStatus.textContent = 'STL: ' + fmtInt(triangles) + ' triângulos, ' +
        (buffer.byteLength / 1024).toFixed(0) + ' KB';
      els.scriptStatus.className = 'script-status ok';
    } catch (error) {
      appendAssistant('Falha ao exportar: ' + error.message, true);
    }
  }

  // -------------------------------------------------------------------------
  // ajustes
  // -------------------------------------------------------------------------

  function fillSelect(select, models, current) {
    select.textContent = '';
    models.forEach(function (model) {
      var option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label + (model.vision ? ' · 👁' : '');
      if (model.note) option.title = model.note;
      select.appendChild(option);
    });
    select.value = current;
    if (select.value !== current) {
      var custom = document.createElement('option');
      custom.value = current;
      custom.textContent = current;
      select.appendChild(custom);
      select.value = current;
    }
  }

  function updateVisionHint() {
    if (!state.busy) {
      setAgentState(visionConfigured() ? 'pronto' : 'inspetor desligado', 'ok');
    }
  }

  function openSettings() {
    els.apiKey.value = state.settings.apiKey;
    els.baseUrl.value = state.settings.baseUrl;
    fillSelect(els.settingsModel, IaApi.mainModels(), state.settings.model);
    fillSelect(els.visionModel, IaApi.visionModels(), state.settings.visionModel);
    els.maxSteps.value = String(state.settings.maxSteps);
    els.effort.value = state.settings.effort || 'low';
    els.settingsStatus.textContent = '';
    els.settingsStatus.className = 'status';
    if (typeof els.settingsDialog.showModal === 'function') els.settingsDialog.showModal();
    else els.settingsDialog.setAttribute('open', '');
  }

  function closeSettings() {
    if (typeof els.settingsDialog.close === 'function') els.settingsDialog.close();
    else els.settingsDialog.removeAttribute('open');
  }

  function saveSettings() {
    var key = els.apiKey.value.trim();
    var baseUrl = els.baseUrl.value.trim() || IaApi.DEFAULT_BASE;
    var steps = Math.max(1, Math.min(50, Math.round(Number(els.maxSteps.value) || 50)));
    state.settings.apiKey = key;
    state.settings.baseUrl = IaApi.normalizeBase(baseUrl);
    state.settings.model = els.settingsModel.value || IaApi.DEFAULT_MODEL;
    state.settings.visionModel = els.visionModel.value || IaApi.DEFAULT_VISION_MODEL;
    state.settings.maxSteps = steps;
    state.settings.effort = els.effort.value || 'low';
    fillSelect(els.modelSelect, IaApi.mainModels(), state.settings.model);
    els.setupBanner.hidden = !!key;
    save(true);
    updateVisionHint();
    closeSettings();
  }

  function testConnection() {
    var key = els.apiKey.value.trim();
    if (!key) {
      settingsStatus('cole a chave primeiro', 'err');
      return;
    }
    els.testApi.disabled = true;
    settingsStatus('testando...', '');
    IaApi.testConnection({
      apiKey: key,
      baseUrl: iaApiBase(els.baseUrl.value),
      model: els.settingsModel.value,
      sessionId: state.sessionId
    }).then(function (message) {
      settingsStatus('conexão ok · resposta: ' + (message.content || '(vazia)').slice(0, 40), 'ok');
    }).catch(function (error) {
      settingsStatus(error.message, 'err');
    }).finally(function () {
      els.testApi.disabled = false;
    });
  }

  function iaApiBase(value) {
    return IaApi.normalizeBase(value && value.trim() ? value : IaApi.DEFAULT_BASE);
  }

  function settingsStatus(text, kind) {
    els.settingsStatus.textContent = text;
    els.settingsStatus.className = 'status ' + (kind || '');
  }

  // -------------------------------------------------------------------------
  // início
  // -------------------------------------------------------------------------

  function autosize() {
    var el = els.prompt;
    el.style.height = 'auto';
    el.style.height = Math.min(160, Math.max(54, el.scrollHeight)) + 'px';
  }

  function bind() {
    els.sendButton.addEventListener('click', function () { sendPrompt(); });
    els.attachImage.addEventListener('click', function () {
      if (!state.busy) els.imageFile.click();
    });
    els.imageFile.addEventListener('change', function () {
      var file = els.imageFile.files && els.imageFile.files[0];
      attachFile(file);
      els.imageFile.value = '';
    });
    els.attachmentRemove.addEventListener('click', clearAttachment);

    els.openBenchmark.addEventListener('click', openBenchmark);
    els.bmGuardOpen.addEventListener('click', openBenchmark);
    els.bmClose.addEventListener('click', closeBenchmark);
    els.benchmarkDialog.addEventListener('cancel', function (event) {
      if (state.benchmark.running) {
        event.preventDefault();
        benchmarkSetStatus('benchmark em andamento · use Parar para interromper', '');
      }
    });
    els.bmUpload.addEventListener('click', function () {
      if (!state.benchmark.running) els.bmImageFile.click();
    });
    els.bmImageFile.addEventListener('change', function () {
      var file = els.bmImageFile.files && els.bmImageFile.files[0];
      benchmarkAttachFile(file);
      els.bmImageFile.value = '';
    });
    els.bmSearch.addEventListener('click', function () { benchmarkSearch(els.bmSearchQuery.value); });
    els.bmSearchQuery.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        benchmarkSearch(els.bmSearchQuery.value);
      }
    });
    els.bmUseCurrent.addEventListener('click', benchmarkUseCurrent);
    els.bmCheap.addEventListener('click', benchmarkSelectCheap);
    els.bmMid.addEventListener('click', benchmarkSelectMid);
    els.bmExpensive.addEventListener('click', benchmarkSelectExpensive);
    els.bmPrompt.addEventListener('input', function () {
      state.benchmark.prompt = els.bmPrompt.value;
      save();
    });
    els.bmRun.addEventListener('click', runBenchmark);
    els.bmStop.addEventListener('click', function () {
      if (benchmarkController) {
        benchmarkController.abort();
        benchmarkSetStatus('parando...', '');
        els.bmStop.disabled = true;
      }
    });
    els.bmResults.addEventListener('change', function (event) {
      var card = event.target.closest('[data-result]');
      if (!card) return;
      var result = benchmarkFindResult(card.dataset.result);
      if (!result) return;
      if (event.target.matches('[data-vote]')) {
        result.userScore = event.target.value ? Number(event.target.value) : null;
        save();
        renderBenchmarkRanking();
      } else if (event.target.matches('[data-comment]')) {
        result.userComment = event.target.value;
        save();
      }
    });
    els.bmResults.addEventListener('click', function (event) {
      var open = event.target.closest('button[data-open]');
      if (!open) return;
      if (state.benchmark.running) {
        benchmarkSetStatus('pare o benchmark antes de abrir um resultado', 'err');
        return;
      }
      closeBenchmark();
      openObject(open.dataset.open).catch(function (error) {
        appendAssistant(error.message, true);
      });
    });

    var composer = els.prompt.closest('.composer');
    function dropImage(event) {
      event.preventDefault();
      if (state.busy) return;
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) attachFile(files[0]);
    }
    if (composer) {
      composer.addEventListener('dragover', function (event) { event.preventDefault(); });
      composer.addEventListener('drop', dropImage);
    }
    els.prompt.addEventListener('paste', function (event) {
      var items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.kind === 'file' && /^image\//.test(item.type)) {
          event.preventDefault();
          attachFile(item.getAsFile());
          break;
        }
      }
    });

    els.captureButton.addEventListener('click', function () {
      if (!state.model) {
        appendAssistant('Ainda não há um modelo para capturar.', true);
        return;
      }
      var images = capture();
      showLocalCaptures(images, 'vistas do modelo atual');
    });
    els.exportStl.addEventListener('click', exportStl);

    els.prompt.addEventListener('input', autosize);
    els.prompt.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendPrompt();
      }
    });

    els.stopAgent.addEventListener('click', function () {
      if (scoutController) scoutController.abort();
      if (referenceController) referenceController.abort();
      agent.stop();
      setAgentState('parando…', 'live');
      setTimeout(function () {
        state.busy = false;
        setBusy(false);
        setAgentState('interrompido', 'err');
      }, 300);
    });

    els.newChat.addEventListener('click', newConversation);

    els.suggest.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-prompt]');
      if (!button) return;
      els.prompt.value = button.dataset.prompt;
      autosize();
      els.prompt.focus();
    });

    els.views.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-view]');
      if (!button) return;
      renderer.setView(button.dataset.view);
      markView(button.dataset.view);
      state.ui.view = button.dataset.view;
      save();
    });

    els.preview.addEventListener('pointerdown', function () {
      markView(null);
    });

    els.partsBar.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-focus]');
      if (!button || button.disabled) return;
      setFocus(button.dataset.focus || '');
    });

    els.runScript.addEventListener('click', runManual);
    els.saveVersion.addEventListener('click', saveVersionManually);
    els.downloadScript.addEventListener('click', downloadScript);
    els.scriptEditor.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        runManual();
      }
    });
    els.scriptEditor.addEventListener('input', function () {
      var obj = currentObject();
      if (!obj) return;
      obj.draft = els.scriptEditor.value;
      save();
      if (obj.script !== obj.draft) {
        els.scriptStatus.textContent = 'rascunho não executado';
        els.scriptStatus.className = 'script-status';
      }
    });

    els.versionSelect.addEventListener('change', function () {
      var obj = currentObject();
      var index = Number(els.versionSelect.value);
      if (!obj || index < 0 || !obj.versions[index]) return;
      els.scriptEditor.value = obj.versions[index].script;
      els.scriptStatus.textContent = 'versão de ' + timeOf(obj.versions[index].at) +
        ' carregada · clique Executar para aplicar';
      els.scriptStatus.className = 'script-status';
    });

    els.objectName.addEventListener('input', function () {
      var obj = currentObject();
      if (obj) {
        obj.name = els.objectName.value;
        if (els.chatObject) els.chatObject.textContent = obj.name || 'sem nome';
        save();
      } else {
        state.pendingName = els.objectName.value;
        save();
      }
    });
    els.objectName.addEventListener('change', function () {
      var obj = currentObject();
      if (obj) {
        obj.name = els.objectName.value.trim() || 'Sem nome';
        els.objectName.value = obj.name;
        save();
      }
      renderObjects();
    });

    els.openSettings.addEventListener('click', openSettings);
    els.setupOpen.addEventListener('click', openSettings);
    els.settingsClose.addEventListener('click', closeSettings);
    els.settingsSave.addEventListener('click', saveSettings);
    els.testApi.addEventListener('click', testConnection);
    els.settingsModel.addEventListener('change', function () {
      var model = IaApi.modelInfo(els.settingsModel.value);
      settingsStatus(model.note ? model.note : '', '');
    });
    els.visionModel.addEventListener('change', function () {
      var model = IaApi.modelInfo(els.visionModel.value);
      settingsStatus(model ? 'inspetor: ' + model.label : '', '');
    });
    els.clearWorkspace.addEventListener('click', function () {
      if (!confirm('Apagar todos os objetos, a memória e a conversa? Isso não pode ser desfeito.')) return;
      state.objects = [];
      state.memory = [];
      state.chat = [];
      state.transcript = [];
      state.currentId = null;
      state.script = '';
      state.stats = null;
      state.model = null;
      state.pendingName = '';
      state.lastRequest = '';
      state.plan = [];
      state.focus = '';
      state.reference = null;
      state.benchmark = emptyBenchmark();
      clearAttachment();
      els.scriptEditor.value = '';
      els.objectName.value = '';
      els.versionSelect.textContent = '';
      if (agent) agent.reset();
      applyModel(null, null);
      renderObjects();
      updateVersionSelect();
      syncObjectUI();
      renderChat([]);
      renderPartsBar();
      save(true);
      closeSettings();
    });

    els.modelSelect.addEventListener('change', function () {
      state.settings.model = els.modelSelect.value;
      save(true);
      updateVisionHint();
    });

    els.dock.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-dock]');
      if (!button) return;
      els.dock.classList.remove('collapsed');
      els.dockToggle.textContent = 'Recolher';
      selectDock(button.dataset.dock);
      state.ui.dock = button.dataset.dock;
      state.ui.collapsed = false;
      save();
    });
    els.dockToggle.addEventListener('click', function () {
      var collapsed = els.dock.classList.toggle('collapsed');
      els.dockToggle.textContent = collapsed ? 'Abrir' : 'Recolher';
      state.ui.collapsed = collapsed;
      save();
    });

    els.paneObjects.addEventListener('click', function (event) {
      // durante um turno, não troca nem apaga objeto: o agente ainda está
      // usando o objeto/conversa atual
      if (state.busy) return;
      var del = event.target.closest('button[data-del]');
      if (del) {
        event.stopPropagation();
        removeObject(del.dataset.del);
        return;
      }
      var card = event.target.closest('.object-card');
      if (!card) return;
      if (card.dataset.id === state.currentId) return;
      setAgentState('carregando objeto…', 'live');
      openObject(card.dataset.id).then(function () {
        setAgentState('objeto carregado', 'ok');
      }).catch(function (error) {
        setAgentState('erro ao carregar', 'err');
        appendAssistant(error.message, true);
      });
    });

    window.addEventListener('beforeunload', function () {
      if (state.busy) return;
      state.chat = agent.exportHistory();
      save(true);
    });

    window.addEventListener('blur', function () {
      if (!state.busy) save();
    });
  }

  function removeObject(id) {
    var obj = null;
    for (var i = 0; i < state.objects.length; i++) {
      if (state.objects[i].id === id) { obj = state.objects[i]; break; }
    }
    if (!obj) return;
    if (!confirm('Apagar "' + obj.name + '"? A conversa, o script e as versões deste objeto serão perdidos.')) return;
    state.objects = state.objects.filter(function (item) { return item.id !== id; });
    if (state.currentId === id) {
      persistChat();
      state.currentId = null;
      state.script = '';
      state.stats = null;
      state.model = null;
      state.chat = [];
      state.transcript = [];
      state.lastRequest = '';
      state.plan = [];
      state.focus = '';
      state.reference = null;
      clearAttachment();
      if (agent) agent.reset();
      els.scriptEditor.value = '';
      els.scriptStatus.textContent = '';
      applyModel(null, null);
      updateVersionSelect();
      syncObjectUI();
      renderChat([]);
      renderPartsBar();
    }
    save(true);
    renderObjects();
  }

  function selectDock(name) {
    var panes = { objects: els.paneObjects, script: els.paneScript };
    if (!panes[name]) name = 'objects';
    Object.keys(panes).forEach(function (key) {
      panes[key].hidden = key !== name;
    });
    els.dock.querySelectorAll('button[data-dock]').forEach(function (button) {
      var on = button.dataset.dock === name;
      button.classList.toggle('active', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function markView(view) {
    els.views.querySelectorAll('button[data-view]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.view === view);
    });
  }

  /** Começa um objeto novo com uma conversa nova. */
  function newConversation() {
    if (state.busy) return;
    if ((currentObject() || state.transcript.length) &&
      !confirm('Começar um objeto novo? A conversa atual fica salva no objeto dela.')) return;

    persistChat();
    state.currentId = null;
    state.script = '';
    state.stats = null;
    state.model = null;
    state.pendingName = '';
    state.lastRequest = '';
    state.chat = [];
    state.transcript = [];
    state.plan = [];
    state.focus = '';
    state.reference = null;
    clearAttachment();
    if (agent) agent.reset();

    els.scriptEditor.value = '';
    els.scriptStatus.textContent = '';
    els.scriptStatus.className = 'script-status';
    applyModel(null, null);
    renderObjects();
    updateVersionSelect();
    syncObjectUI();
    renderChat([]);
    renderPartsBar();
    save(true);
    setAgentState('novo objeto', 'ok');
  }

  function welcomeBlock() {
    var welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.innerHTML =
      '<span class="badge">cada conversa é um objeto</span>' +
      '<h2>Descreva a peça. Eu desenho, olho e corrijo.</h2>' +
      '<p>Eu escrevo o script paramétrico, gero a malha, tiro capturas em ' +
      '<b>perspectiva, topo, baixo, frente e lados</b>, peço um laudo ao inspetor de visão e ajusto ' +
      'até ficar como você pediu. <b>Esta conversa vira um objeto</b> com o script, as versões e o histórico.</p>';
    return welcome;
  }

  /** Desenha a conversa de um objeto (ou a nova conversa vazia). */
  function renderChat(items) {
    els.messages.textContent = '';
    els.messages.appendChild(welcomeBlock());
    els.messages.appendChild(els.setupBanner);
    els.setupBanner.hidden = !!state.settings.apiKey;

    restoring = true;
    (items || []).forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      if (item.role === 'user') {
        appendUser(item.text || '');
      } else if (item.role === 'assistant') {
        if (item.text && item.text.trim()) {
          var wrap = appendAssistant(item.text, !!item.error);
          if (item.error && isRetryable(item.text)) appendRetryButton(wrap);
        }
      } else if (item.role === 'tool') {
        appendTool({
          name: item.name || 'ferramenta',
          ok: item.ok !== false,
          text: item.text || '',
          report: item.report || null,
          stats: item.stats || null
        });
      } else if (item.role === 'reference') {
        showReference({ thumb: item.thumb, dataUrl: item.thumb }, item.report || '');
      }
    });
    restoring = false;
    scrollMessages(true);
  }

  function restoreChat() {
    var obj = currentObject();
    var items = obj ? obj.transcript : state.transcript;
    renderChat(items && items.length ? items : []);
    if (agent) agent.importHistory(obj ? (obj.chat || []) : state.chat);
  }

  function boot() {
    return storeGet(STORAGE_KEY).then(function (data) {
      restore(data);
      sanitizeSettings();
      fillSelect(els.modelSelect, IaApi.mainModels(), state.settings.model);
      els.baseUrl.value = state.settings.baseUrl;
      els.setupBanner.hidden = !!state.settings.apiKey;

      renderer = IaRender.create(els.preview);
      agent = IaAgent.create(host);

      bind();
      restoreChat();
      renderObjects();
      updateVisionHint();
      updateVersionSelect();
      syncObjectUI();
      renderPartsBar();

      els.dock.classList.toggle('collapsed', !!state.ui.collapsed);
      els.dockToggle.textContent = state.ui.collapsed ? 'Abrir' : 'Recolher';
      selectDock(state.ui.dock);
      renderer.setView(state.ui.view || 'perspective');
      markView(state.ui.view || 'perspective');

      var obj = currentObject();
      if (obj) {
        state.script = obj.script;
        els.scriptEditor.value = obj.draft || obj.script;
        if (obj.draft && obj.draft !== obj.script) {
          els.scriptStatus.textContent = 'rascunho não executado';
          els.scriptStatus.className = 'script-status';
        }
        if (obj.script.trim()) {
          setAgentState('reconstruindo objeto…', 'live');
          executor.run(obj.script, 60000).then(function (result) {
            if (!result.ok) {
              setAgentState('script salvo com erro', 'err');
              els.scriptStatus.textContent = result.error;
              els.scriptStatus.className = 'script-status err';
              return;
            }
            applyModel(result.model, result.stats);
            obj.stats = result.stats;
            obj.thumb = thumb();
            renderObjects();
            save();
            setAgentState('objeto pronto', 'ok');
          }).catch(function (error) {
            setAgentState('executor indisponível', 'err');
            els.scriptStatus.textContent = error.message;
            els.scriptStatus.className = 'script-status err';
          });
        }
      } else {
        els.scriptEditor.value = '';
      }

      setTimeout(function () { executor.init(); }, 200);
    });
  }

  // agent precisa existir para setBusy consultar isRunning
  boot().catch(function (error) {
    console.error('falha ao iniciar o estúdio', error);
    appendAssistant('Falha ao iniciar o estúdio: ' + (error && error.message ? error.message : error), true);
  });
})();
