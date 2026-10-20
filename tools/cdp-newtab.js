/**
 * Abre uma nova aba no Chrome de depuracao.
 *
 *   node tools/cdp-newtab.js <url>
 */
'use strict';

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const url = process.argv[2];

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
  });

  const send = (method, params) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ error: { message: 'timeout' } }); } }, 20000);
  });

  const res = await send('Target.createTarget', { url: url || 'about:blank' });
  console.log(res.error ? 'ERRO: ' + JSON.stringify(res.error) : 'nova aba: ' + res.result.targetId);
  process.exit(0);
})().catch((e) => { console.error('falha:', e); process.exit(1); });
