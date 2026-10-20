/**
 * Abre o popup da extensao como pagina (chrome-extension://.../popup.html)
 * dentro do Chrome de depuracao, com deep link para a aba do Tripo, e:
 *
 *   1. recarrega a extensao a partir do dist/ (pega o build atual)
 *   2. espera as malhas chegarem pelo content script
 *   3. troca de aba (Modelos / Exclusao / Exportar) e tira um screenshot de cada
 *   4. confere o estado das abas (aria-selected, paineis, badges)
 *   5. adiciona um padrao de exclusao e confere a aba Exclusao
 *
 *   node tools/cdp-popup-test.js
 *
 * Os PNGs vao para tools/out/.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = 'D:\\Projetos\\3d-mesh-downloader\\dist';
const OUT = 'D:\\Projetos\\3d-mesh-downloader\\tools\\out';
const TRIPO = 'https://studio.tripo3d.ai/';

fs.mkdirSync(OUT, { recursive: true });

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

  return { ready, send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.error) throw new Error('evaluate: ' + JSON.stringify(res.error));
  const r = res.result && res.result.result;
  if (r && r.subtype === 'error') throw new Error('avaliacao falhou: ' + r.description);
  return r ? r.value : undefined;
}

async function shot(cdp, name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (res.error) throw new Error('screenshot: ' + JSON.stringify(res.error));
  const file = path.join(OUT, name + '.png');
  fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
  console.log('  screenshot -> ' + file);
  return file;
}

(async () => {
  const version = await (await fetch(`${BASE}/json/version`)).json();
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;

  // 1. recarrega a extensao (mesmo caminho = recarrega o build atual)
  const load = await browser.send('Extensions.loadUnpacked', { path: DIST });
  const extId = load.result && load.result.id;
  console.log('extensao recarregada: ' + (extId || JSON.stringify(load.error)));
  if (!extId) process.exit(1);

  // 2. localiza a aba do Tripo
  const targets = await (await fetch(`${BASE}/json/list`)).json();
  const tripo = targets.find((t) => t.type === 'page' && t.url.startsWith(TRIPO));
  console.log('aba do Tripo: ' + (tripo ? 'encontrada' : 'AUSENTE'));

  // Recarregar a extensao orfana o content script das abas ja abertas: a aba
  // alvo precisa ser recarregada para a extensao injetar de novo.
  if (tripo) {
    const page = connect(tripo.webSocketDebuggerUrl);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Page.reload', { ignoreCache: false });
    page.close();
    console.log('aba do Tripo recarregada (reinjecao do content script)');
    await sleep(3000);
  }

  // 3. abre o popup em uma aba propria, apontando para a aba alvo
  const popupUrl = `chrome-extension://${extId}/popup.html` +
    (tripo ? `?url=${encodeURIComponent(tripo.url.split('#')[0])}` : '');
  const created = await browser.send('Target.createTarget', { url: popupUrl });
  const popupId = created.result && created.result.targetId;
  await sleep(1200);

  const list2 = await (await fetch(`${BASE}/json/list`)).json();
  const target = list2.find((t) => t.id === popupId);
  const popup = connect(target.webSocketDebuggerUrl);
  await popup.ready;
  await popup.send('Page.enable');
  await popup.send('Runtime.enable');
  await popup.send('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 620, deviceScaleFactor: 2, mobile: false
  });

  // 4. espera as malhas chegarem (a pagina do Tripo monta a cena em ~20 s)
  let count = '-';
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    count = await evaluate(popup, `document.getElementById('meshCount').textContent`);
    if (count && count !== '-' && Number(count) > 0) break;
  }
  console.log('malhas: ' + count);
  await sleep(400);

  const state = async () => evaluate(popup, `(() => ({
    abas: Array.from(document.querySelectorAll('.tab')).map(b => ({
      nome: b.dataset.tab, ativa: b.getAttribute('aria-selected'),
      badge: b.querySelector('.tbadge') && !b.querySelector('.tbadge').hidden
             ? b.querySelector('.tbadge').textContent : '-'
    })),
    painelVisivel: Array.from(document.querySelectorAll('.panel'))
      .filter(p => !p.hidden).map(p => p.id),
    modelos: document.querySelectorAll('#modelList label').length,
    altura: document.body.scrollHeight
  }))()`);

  console.log('\n[1] aba Modelos');
  await evaluate(popup, `document.getElementById('tab-modelos').click()`);
  await sleep(250);
  console.log('  ' + JSON.stringify(await state()));
  await shot(popup, 'popup-1-modelos');

  console.log('\n[2] aba Exclusao');
  await evaluate(popup, `document.getElementById('tab-exclusao').click()`);
  await sleep(300);
  console.log('  ' + JSON.stringify(await state()));
  await shot(popup, 'popup-2-exclusao');

  console.log('\n[3] aba Exportar');
  await evaluate(popup, `document.getElementById('tab-exportar').click()`);
  await sleep(300);
  console.log('  ' + JSON.stringify(await state()));
  await shot(popup, 'popup-3-exportar');

  console.log('\n[4] padrao de exclusao pela aba Exclusao');
  await evaluate(popup, `document.getElementById('tab-exclusao').click()`);
  await sleep(200);
  await evaluate(popup, `(() => {
    const input = document.getElementById('excludeInput');
    input.value = 'skeleton-*';
    document.getElementById('addExclude').click();
    return true;
  })()`);
  await sleep(1500);
  console.log('  ' + JSON.stringify(await state()));
  console.log('  excluidas na pagina: ' +
    JSON.stringify(await evaluate(popup, `Array.from(document.querySelectorAll('#excludePreview .hit'))
      .map(h => h.querySelector('.mname').textContent)`)));
  await shot(popup, 'popup-4-exclusao-com-padrao');

  console.log('\n[5] volta para Modelos (badge e lista riscada)');
  await evaluate(popup, `document.getElementById('tab-modelos').click()`);
  await sleep(400);
  console.log('  ' + JSON.stringify(await state()));
  console.log('  riscados: ' + await evaluate(popup,
    `document.querySelectorAll('#modelList label.excluded').length`));
  await shot(popup, 'popup-5-modelos-excluindo');

  console.log('\n[6] teclado: Ctrl+3 / setas');  await evaluate(popup, `(() => {
    const t = document.getElementById('tab-modelos');
    t.focus();
    t.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
    return document.getElementById('tab-exportar').getAttribute('aria-selected');
  })()`);
  const afterKey = await evaluate(popup,
    `Array.from(document.querySelectorAll('.tab')).map(b => b.dataset.tab + ':' + b.getAttribute('aria-selected')).join(' ')`);
  console.log('  apos tecla 3: ' + afterKey);
  const persisted = await evaluate(popup, `(() => new Promise(res =>
    chrome.storage.local.get('popupTab', (i) => res(JSON.stringify(i)))))()`);
  console.log('  aba persistida no storage: ' + persisted);

  console.log('\n[7] tema claro');
  await popup.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  });
  await evaluate(popup, `document.getElementById('tab-modelos').click()`);
  await sleep(400);
  await shot(popup, 'popup-6-modelos-claro');
  await evaluate(popup, `document.getElementById('tab-exclusao').click()`);
  await sleep(300);
  await shot(popup, 'popup-7-exclusao-claro');

  console.log('\n[8] download a partir do popup (filtro: mesh_1)');
  await popup.send('Emulation.setEmulatedMedia', { features: [] });
  await evaluate(popup, `document.getElementById('tab-modelos').click()`);
  await evaluate(popup, `(() => {
    const input = document.getElementById('filterText');
    input.value = 'mesh_1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);
  console.log('  visiveis: ' + await evaluate(popup, `document.querySelectorAll('#modelList label').length`));
  console.log('  botao: ' + await evaluate(popup, `document.getElementById('downloadBtn').textContent`));

  const DOWNLOADS = 'D:\\Projetos\\3d-mesh-downloader\\.downloads';
  const dl = await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true
  });
  console.log('  destino dos downloads: ' + (dl.error ? JSON.stringify(dl.error) : DOWNLOADS));
  fs.readdirSync(DOWNLOADS).forEach((f) => { try { fs.unlinkSync(path.join(DOWNLOADS, f)); } catch (e) {} });
  await evaluate(popup, `document.getElementById('downloadBtn').click()`);

  let files = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    files = fs.readdirSync(DOWNLOADS);
    if (files.length) break;
  }
  await sleep(1500);
  files = fs.readdirSync(DOWNLOADS);
  console.log('  arquivos: ' + JSON.stringify(files.map((f) => f + ' (' + fs.statSync(path.join(DOWNLOADS, f)).size + ' B)')));
  console.log('  status no popup: ' + await evaluate(popup, `document.getElementById('status').textContent`));
  await shot(popup, 'popup-8-download');

  console.log('\nfim');
  popup.close();
  browser.close();
  process.exit(0);
})().catch((e) => { console.error('falha:', e); process.exit(1); });
