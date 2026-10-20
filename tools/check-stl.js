/**
 * Valida um arquivo STL binario: cabecalho, contagem de triangulos, tamanho
 * do arquivo e coerencia das normais.
 *
 *   node tools/check-stl.js <arquivo.stl>
 */
'use strict';

const fs = require('fs');

const file = process.argv[2];
const buf = fs.readFileSync(file);

const header = buf.slice(0, 80).toString('ascii').replace(/\0+$/, '');
const count = buf.readUInt32LE(80);
const expected = 84 + count * 50;

console.log('arquivo:      ' + file);
console.log('tamanho:      ' + buf.length + ' bytes');
console.log('cabecalho:    "' + header + '"');
console.log('triangulos:   ' + count);
console.log('84 + 50*n == tamanho: ' + (expected === buf.length) + ' (esperado ' + expected + ')');

let badNormals = 0;
let degenerate = 0;
let minY = Infinity, maxY = -Infinity, maxX = -Infinity, minX = Infinity;
const sample = [];

for (let i = 0; i < count; i++) {
  const o = 84 + i * 50;
  const n = [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
  const len = Math.hypot(n[0], n[1], n[2]);
  if (Math.abs(len - 1) > 1e-4) badNormals++;

  const v = [];
  for (let k = 0; k < 3; k++) {
    const x = buf.readFloatLE(o + 12 + k * 12);
    const y = buf.readFloatLE(o + 16 + k * 12);
    const z = buf.readFloatLE(o + 20 + k * 12);
    v.push([x, y, z]);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x > maxX) maxX = x;
    if (x < minX) minX = x;
  }

  // area do triangulo
  const [a, b, c] = v;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  if (area < 1e-9) degenerate++;

  if (i < 3) sample.push({ n, v, area });
}

console.log('normais fora de unidade: ' + badNormals);
console.log('triangulos degenerados:   ' + degenerate);
console.log('bounding box X: ' + minX.toFixed(4) + ' .. ' + maxX.toFixed(4) + ' | Y: ' + minY.toFixed(4) + ' .. ' + maxY.toFixed(4));
console.log('\nprimeiros facets:');
sample.forEach((f, i) => {
  console.log('  #' + i + ' normal=[' + f.n.map((x) => x.toFixed(4)).join(', ') + '] area=' + f.area.toFixed(6));
  f.v.forEach((v) => console.log('        vertex ' + v.map((x) => x.toFixed(6)).join(' ')));
});
