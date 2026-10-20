/**
 * Instala a extensao descompactada no perfil do Chrome de depuracao usando o
 * comando CDP Extensions.loadUnpacked (Chrome 126+, exige
 * --enable-unsafe-extension-debugging).
 *
 *   node tools/cdp-load-extension.js <caminhoDoDist>
 */
'use strict';

const fs = require('fs');

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const extPath = process.argv[2] || 'D:\\Projetos\\3d-mesh-downloader\\dist';

(async () => {
  const version = await (await fetch(`${BASE}/json/version`)).json();
  console.log('browser:', version.Browser);

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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ error: { message: 'timeout' } }); }
    }, 20000);
  });

  const res = await send('Extensions.loadUnpacked', { path: extPath });
  if (res.error) {
    console.error('ERRO:', JSON.stringify(res.error));
    process.exit(1);
  }
  console.log('extensao carregada:', JSON.stringify(res.result));

  // confirma nas extensoes do perfil
  const list = await send('Extensions.getStorageItems', { id: res.result.id, storageArea: 'local' }).catch(() => null);
  process.exit(0);
})().catch((e) => {
  console.error('falha:', e);
  process.exit(1);
});
