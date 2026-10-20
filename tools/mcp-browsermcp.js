/**
 * Cliente MCP por stdio para o servidor do Browser MCP, com modo daemon.
 *
 * O servidor @browsermcp/mcp escuta um WebSocket na porta 9009 onde a extensao
 * do Chrome se conecta. Se o processo do servidor cair, a extensao fica sem
 * conexao - por isso o modo daemon mantem o servidor vivo enquanto os comandos
 * chegam por uma fila de arquivos.
 *
 *   node tools/mcp-browsermcp.js daemon <dirDaFila>
 *   node tools/mcp-browsermcp.js enqueue <dirDaFila> <tool> <arquivoDeArgs.json>
 *   node tools/mcp-browsermcp.js list
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CMD = process.env.MCP_CMD || 'npx';
const ARGS = (process.env.MCP_ARGS || '-y @browsermcp/mcp@0.1.3').split(' ');

function readJson(p) {
  // aceita "@caminho" ou "caminho"
  const file = p.startsWith('@') ? p.slice(1) : p;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// ---------------------------------------------------------------------------
// Sessão MCP
// ---------------------------------------------------------------------------

function createSession() {
  const child = spawn(CMD, ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    cwd: process.cwd()
  });

  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s && !/Failed to kill process on port/.test(s)) {
      process.stderr.write('[mcp stderr] ' + s.slice(0, 200) + '\n');
    }
  });

  function send(method, params, timeoutMs) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, params: params || {} };
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify(payload) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ error: { message: 'timeout em ' + method } });
        }
      }, timeoutMs || 180000);
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }

  async function init() {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'opencode-direct', version: '1.0.0' }
    });
    notify('notifications/initialized');
  }

  async function listTools() {
    const res = await send('tools/list', {});
    return (res.result && res.result.tools) || [];
  }

  async function call(name, args) {
    const res = await send('tools/call', { name, arguments: args || {} });
    const content = (res.result && res.result.content) || [];
    return content
      .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
  }

  return { child, init, listTools, call, kill: () => child.kill() };
}

// ---------------------------------------------------------------------------
// Modos
// ---------------------------------------------------------------------------

async function modeDaemon(queueDir) {
  fs.mkdirSync(queueDir, { recursive: true });
  fs.mkdirSync(path.join(queueDir, 'done'), { recursive: true });

  const session = createSession();
  await session.init();
  const tools = await session.listTools();
  fs.writeFileSync(path.join(queueDir, 'tools.json'), JSON.stringify(tools, null, 2));
  console.log('daemon pronto, ' + tools.length + ' ferramentas, fila em ' + queueDir);

  setInterval(async () => {
    const jobs = fs
      .readdirSync(queueDir)
      .filter((f) => f.endsWith('.job.json'))
      .sort();

    for (const job of jobs) {
      const jobPath = path.join(queueDir, job);
      let spec;
      try {
        spec = readJson(jobPath);
      } catch (e) {
        continue;
      }
      try {
        fs.unlinkSync(jobPath);
      } catch (e) {
        /* ignore */
      }
      const out = path.join(queueDir, 'done', job.replace('.job.json', '.txt'));
      let text;
      try {
        text = await session.call(spec.tool, spec.args || {});
      } catch (e) {
        text = 'ERRO: ' + String(e);
      }
      fs.writeFileSync(out, text);
      console.log('job ' + job + ' -> ' + out);
    }
  }, 250);

  process.on('SIGTERM', () => { session.kill(); process.exit(0); });
}

async function modeEnqueue(queueDir, tool, argsFile) {
  const args = argsFile ? readJson(argsFile) : {};
  const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, id + '.job.json'), JSON.stringify({ tool, args }));
  console.log('enfileirado: ' + id);
}

async function modeWait(queueDir, id) {
  const out = path.join(queueDir, 'done', id + '.txt');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (fs.existsSync(out)) {
      console.log(fs.readFileSync(out, 'utf8'));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('timeout aguardando o resultado');
  process.exit(1);
}

async function modeCallQueue(queueDir, tool, argsFile) {
  const args = argsFile ? readJson(argsFile) : {};
  const id = 'call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, id + '.job.json'), JSON.stringify({ tool, args }));

  const out = path.join(queueDir, 'done', id + '.txt');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (fs.existsSync(out)) {
      console.log(fs.readFileSync(out, 'utf8'));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error('timeout aguardando o resultado');
  process.exit(1);
}

(async () => {
  const mode = process.argv[2] || 'list';
  if (mode === 'daemon') {
    await modeDaemon(process.argv[3]);
    return;
  }
  if (mode === 'enqueue') {
    await modeEnqueue(process.argv[3], process.argv[4], process.argv[5]);
    return;
  }
  if (mode === 'callq') {
    await modeCallQueue(process.argv[3], process.argv[4], process.argv[5]);
    return;
  }
  if (mode === 'wait') {
    await modeWait(process.argv[3], process.argv[4]);
    return;
  }

  const session = createSession();
  await session.init();
  if (mode === 'list') {
    const tools = await session.listTools();
    console.log('ferramentas: ' + tools.length);
    tools.forEach((t) => console.log('  ' + t.name));
  } else if (mode === 'call') {
    const args = process.argv[4] ? readJson(process.argv[4]) : {};
    console.log(await session.call(process.argv[3], args));
  }
  session.kill();
  process.exit(0);
})().catch((e) => {
  console.error('falha:', e);
  process.exit(1);
});
