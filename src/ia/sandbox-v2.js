/**
 * Ponte de execução do Estúdio IA.
 *
 * Esta página é declarada em `sandbox.pages` no manifest, então roda com uma
 * CSP própria que permite `new Function` — a página normal da extensão não
 * permite eval. O script do agente não roda aqui: montamos um blob worker com
 * field.js + font.js + kernel.js + runner.js e executamos lá, em outra thread,
 * sem DOM e sem acesso à chave da API. O worker pode ser encerrado a qualquer
 * momento se o script travar.
 */
'use strict';

(function () {
  var CHANNEL = 'ia-geometry';
  var LIB_FILES = ['../nomes/field.js', '../nomes/font.js', 'kernel.js', 'runner.js'];
  var FONT_FILE = '../fonts/Chewy-Regular.ttf';
  var VERSION = new URLSearchParams(location.search).get('v') || String(Date.now());

  function versioned(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(VERSION);
  }

  var worker = null;
  var workerUrl = null;
  var ready = false;
  var building = false;
  var nextId = 1;

  function send(payload) {
    if (parent && parent !== window) {
      parent.postMessage(Object.assign({ channel: CHANNEL }, payload), '*');
    }
  }

  function loadText(url) {
    return fetch(versioned(url), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' em ' + url);
      return response.text();
    });
  }

  function loadFont() {
    return fetch(versioned(FONT_FILE), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' na fonte');
      return response.arrayBuffer();
    });
  }

  function boot() {
    if (building) return;
    building = true;
    ready = false;

    if (worker) {
      worker.terminate();
      worker = null;
    }

    Promise.all(LIB_FILES.map(loadText).concat([loadFont()]))
      .then(function (assets) {
        var font = assets.pop();
        var sources = assets;
        var blob = new Blob([sources.join('\n;\n')], { type: 'text/javascript' });
        if (workerUrl) URL.revokeObjectURL(workerUrl);
        workerUrl = URL.createObjectURL(blob);
        worker = new Worker(workerUrl);

        worker.onmessage = function (event) {
          var data = event.data || {};
          if (data.type === 'ready') {
            ready = true;
            send({ type: 'ready', glyphs: data.glyphs, warning: data.warning });
            return;
          }
          if (data.type === 'fatal') {
            send({ type: 'fatal', error: data.error });
            return;
          }
          if (data.type === 'result') {
            send({
              type: 'result',
              id: data.id,
              ok: data.ok,
              model: data.model,
              stats: data.stats,
              logs: data.logs,
              ms: data.ms,
              error: data.error,
              stack: data.stack
            });
          }
        };

        worker.onerror = function (event) {
          ready = false;
          send({
            type: 'fatal',
            error: event.message || 'erro interno no worker de geometria',
            stack: event.filename ? event.filename + ':' + event.lineno : ''
          });
        };

        worker.postMessage({ type: 'init', font: font }, [font]);
      })
      .catch(function (error) {
        send({
          type: 'fatal',
          error: 'não foi possível preparar o executor: ' + (error && error.message ? error.message : error)
        });
      })
      .then(function () {
        building = false;
      });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};
    if (data.channel !== CHANNEL) return;

    if (data.type === 'run') {
      if (!worker || !ready) {
        send({ type: 'result', id: data.id, ok: false, error: 'o executor está reiniciando; tente de novo' });
        return;
      }
      worker.postMessage({ type: 'run', id: data.id || nextId++, code: data.code });
      return;
    }

    if (data.type === 'kill') {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      ready = false;
      send({ type: 'killed' });
      boot();
      return;
    }

    if (data.type === 'ping') send({ type: 'pong' });
  });

  boot();
})();
