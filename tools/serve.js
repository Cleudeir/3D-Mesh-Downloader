/**
 * Servidor estatico local para o teste de integracao no navegador.
 *
 *   node tools/serve.js [porta]
 *
 * Depois abra:
 *   http://127.0.0.1:8731/test/browser-check.html?v=0.180.0
 *
 * A pagina carrega o three.js de verdade (CDN), injeta src/injected.js antes
 * dele - como a extensao faz - e intercepta os downloads para inspecionar o
 * OBJ gerado.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8731;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf'
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const rel = url === '/' ? '/test/browser-check.html' : url;
    const file = path.join(ROOT, rel);

    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('403');
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('404 ' + rel);
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`servidor em http://127.0.0.1:${PORT}/`);
    console.log(`teste:  http://127.0.0.1:${PORT}/test/browser-check.html?v=0.180.0`);
  });
