/**
 * Cliente CDP (Chrome DevTools Protocol) minimo, sem dependencias.
 *
 *   node tools/cdp.js list
 *   node tools/cdp.js eval <targetId> <arquivo.js>      -> imprime o resultado
 *   node tools/cdp.js watch <targetId> <segundos>      -> console logs em tempo real
 *
 * Fala com o endpoint http://127.0.0.1:9222 do Chrome iniciado com
 * --remote-debugging-port.
 */
'use strict';

const fs = require('fs');

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;

async function listTargets() {
  const res = await fetch(`${BASE}/json/list`);
  return res.json();
}

async function pickTarget(idOrFragment) {
  const targets = await listTargets();
  const matches = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!idOrFragment) return matches[0];
  const exact = matches.find((t) => t.id === idOrFragment);
  if (exact) return exact;
  const byUrl = matches.find((t) => t.url.includes(idOrFragment));
  if (byUrl) return byUrl;
  const byTitle = matches.find((t) => (t.title || '').includes(idOrFragment));
  return byTitle || matches[0];
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = [];

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push(msg);
        this.listeners.forEach((fn) => fn(msg));
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      userGesture: true
    });
    if (res.error) return { error: res.error };
    if (res.result && res.result.exceptionDetails) {
      return { error: res.result.exceptionDetails.text, detail: res.result.exceptionDetails.exception };
    }
    return { value: res.result && res.result.result ? res.result.result.value : undefined };
  }
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  return cdp;
}

function formatConsole(msg) {
  if (msg.method === 'Runtime.consoleAPICalled') {
    const type = msg.params.type;
    const text = msg.params.args
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
      .join(' ');
    return `[${type}] ${text}`;
  }
  if (msg.method === 'Log.entryAdded') {
    return `[${msg.params.entry.level}] ${msg.params.entry.text}`;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    return `[exception] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description || ''}`;
  }
  return null;
}

(async () => {
  const mode = process.argv[2] || 'list';

  if (mode === 'list') {
    const targets = await listTargets();
    targets
      .filter((t) => t.type === 'page')
      .forEach((t) => console.log(`${t.id}  ${(t.title || '').slice(0, 60).padEnd(62)} ${t.url.slice(0, 90)}`));
    return;
  }

  const target = await pickTarget(process.argv[3]);
  const cdp = await connect(target);

  if (mode === 'eval') {
    const file = process.argv[4];
    const expression = file.startsWith('@') ? fs.readFileSync(file.slice(1), 'utf8') : fs.readFileSync(file, 'utf8');
    const out = await cdp.evaluate(expression);
    if (out.error) {
      console.error('ERRO:', out.error, out.detail ? JSON.stringify(out.detail).slice(0, 500) : '');
      process.exit(1);
    }
    console.log(typeof out.value === 'string' ? out.value : JSON.stringify(out.value, null, 2));
    process.exit(0);
  }

  if (mode === 'watch') {
    const seconds = Number(process.argv[4] || 30);
    cdp.on((msg) => {
      const line = formatConsole(msg);
      if (line) console.log(line);
    });
    // replay what was already captured
    cdp.events.forEach((msg) => {
      const line = formatConsole(msg);
      if (line) console.log(line);
    });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    process.exit(0);
  }

  if (mode === 'navigate') {
    await cdp.send('Page.navigate', { url: process.argv[3] });
    console.log('navegando para ' + process.argv[3]);
    process.exit(0);
  }
})().catch((e) => {
  console.error('falha:', e);
  process.exit(1);
});
