/**
 * Prepara a instancia de depuracao do Chrome:
 *   1. permite downloads automaticos (sem o prompt de "varios downloads")
 *      e aponta o destino para uma pasta local
 *   2. carrega a extensao descompactada do projeto
 *
 *   node tools/cdp-setup.js [caminhoDoDist] [pastaDeDownload]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const extPath = process.argv[2] || 'D:\\Projetos\\3d-mesh-downloader\\dist';
const downloadPath = process.argv[3] || 'D:\\Projetos\\3d-mesh-downloader\\.downloads';

fs.mkdirSync(downloadPath, { recursive: true });

(async () => {
  const version = await (await fetch(`${BASE}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Browser.downloadWillBegin') {
      console.log('download:', msg.params.suggestedFilename, '->', msg.params.url.slice(0, 40));
    } else if (msg.method === 'Browser.downloadProgress') {
      console.log('progresso:', msg.params.state, msg.params.receivedBytes, 'bytes');
    }
  });

  const send = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: 'timeout' } }); } }, 20000);
  });

  const dl = await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath,
    eventsEnabled: true
  });
  console.log(dl.error ? 'ERRO no download behavior: ' + JSON.stringify(dl.error) : 'downloads -> ' + downloadPath);

  const ext = await send('Extensions.loadUnpacked', { path: extPath });
  console.log(ext.error ? 'ERRO ao carregar a extensao: ' + JSON.stringify(ext.error) : 'extensao: ' + ext.result.id);

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('falha:', e); process.exit(1); });
