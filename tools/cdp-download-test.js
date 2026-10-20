/**
 * Dispara uma exportacao no Chrome de depuracao e observa os eventos de
 * download do navegador.
 *
 *   node tools/cdp-download-test.js [filtroJSON]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const DOWNLOADS = 'D:\\Projetos\\3d-mesh-downloader\\.downloads';

const raw = process.argv[2];
const spec = raw
  ? (raw.startsWith('@')
      ? JSON.parse(fs.readFileSync(raw.slice(1), 'utf8').replace(/^\uFEFF/, ''))
      : JSON.parse(raw))
  : { text: 'skeleton' };

// aceita {filter: {...}} ou um filtro solto; o formato vem em "format"
const filterArg = spec.filter || spec;
const formatArg = spec.format || 'obj';

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const listeners = [];

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) listeners.forEach((fn) => fn(msg));
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const send = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: 'timeout' } }); } }, 30000);
  });

  return { ready, send, on: (fn) => listeners.push(fn) };
}

(async () => {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.readdirSync(DOWNLOADS).forEach((f) => fs.unlinkSync(path.join(DOWNLOADS, f)));

  const version = await (await fetch(`${BASE}/json/version`)).json();
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  const events = [];
  browser.on((msg) => {
    if (msg.method === 'Browser.downloadWillBegin') {
      events.push('BEGIN  ' + msg.params.suggestedFilename + '  (guid ' + msg.params.guid + ')');
    } else if (msg.method === 'Browser.downloadProgress') {
      events.push('STATUS ' + msg.params.state + '  ' + msg.params.receivedBytes + ' bytes' +
        (msg.params.totalBytes ? ' / ' + msg.params.totalBytes : '') +
        (msg.params.state === 'canceled' && msg.params.filePath ? '  -> ' + msg.params.filePath : ''));
    }
  });

  const dl = await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
    eventsEnabled: true
  });
  console.log('setDownloadBehavior:', dl.error ? JSON.stringify(dl.error) : 'ok -> ' + DOWNLOADS);

  // encontra a aba do Tripo (a aba do popup tambem tem "tripo3d.ai" na URL,
  // por isso o filtro exige o prefixo https://studio.tripo3d.ai)
  const targets = await (await fetch(`${BASE}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('https://studio.tripo3d.ai'));
  if (!page) { console.error('aba do Tripo nao encontrada'); process.exit(1); }

  const pageCdp = connect(page.webSocketDebuggerUrl);
  await pageCdp.ready;
  await pageCdp.send('Runtime.enable');

  const expression = `(async () => {
    const r = await new Promise((resolve) => {
      const h = (ev) => { if (ev.data && ev.data.type === 'MDL_RESULT') { window.removeEventListener('message', h); resolve(ev.data.result); } };
      window.addEventListener('message', h);
      window.postMessage({ type: 'MDL_DOWNLOAD', options: ${JSON.stringify({
        applyTransforms: true, normals: 'auto', uvs: 'on', expandInstances: true, materials: 'on', combine: true, format: formatArg, filter: filterArg
      })} }, '*');
      setTimeout(() => resolve({ timeout: true }), 240000);
    });
    return JSON.stringify(r);
  })()`;

  const res = await pageCdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  console.log('resultado:', JSON.stringify(res.result && res.result.result ? res.result.result.value : res).slice(0, 400));

  await new Promise((r) => setTimeout(r, 8000));

  console.log('\neventos de download:');
  events.forEach((e) => console.log('  ' + e));

  console.log('\npasta de downloads:');
  fs.readdirSync(DOWNLOADS).forEach((f) => {
    const s = fs.statSync(path.join(DOWNLOADS, f));
    console.log('  ' + f + '  ' + s.size + ' bytes');
  });

  process.exit(0);
})().catch((e) => { console.error('falha:', e); process.exit(1); });
