/**
 * Build script - produces:
 *   dist/                          unpacked extension (Load unpacked)
 *   dist/3d-mesh-downloader-<ver>.zip   upload package for the Chrome Web Store
 *
 * Zero external dependencies: the zip is written by hand (deflate + central
 * directory) so the project builds with a bare Node install.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

// --- minimal zip writer ----------------------------------------------------

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function zipDirectory(sourceDir, outFile) {
  const files = [];
  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else files.push({ rel, full });
    }
  })(sourceDir, '');

  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.rel, 'utf8');
    const raw = fs.readFileSync(file.full);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (1996-01-01, stable)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outFile, Buffer.concat([...locals, centralBuf, end]));
  return { files: files.length, bytes: fs.statSync(outFile).size };
}

// --- build ------------------------------------------------------------------

function rimraf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

  const required = ['manifest_version', 'name', 'version'];
  for (const key of required) {
    if (manifest[key] === undefined) {
      console.error(`manifest.json invalido: falta "${key}"`);
      process.exit(1);
    }
  }
  if (manifest.manifest_version !== 3) {
    console.error('manifest.json invalido: esperado manifest_version 3');
    process.exit(1);
  }

  // Sanity check: every file referenced by the manifest must exist.
  const referenced = [];
  if (manifest.action) {
    if (manifest.action.default_popup) referenced.push(manifest.action.default_popup);
    Object.values(manifest.action.default_icon || {}).forEach((i) => referenced.push(i));
  }
  Object.values(manifest.icons || {}).forEach((i) => referenced.push(i));
  (manifest.content_scripts || []).forEach((cs) => (cs.js || []).forEach((j) => referenced.push(j)));

  const missing = referenced.filter((rel) => !fs.existsSync(path.join(SRC, rel)));
  if (missing.length) {
    console.error('manifest.json referencia arquivos inexistentes:', missing.join(', '));
    process.exit(1);
  }

  rimraf(DIST);
  copyTree(SRC, DIST);

  const zipPath = path.join(DIST, `3d-mesh-downloader-${manifest.version}.zip`);
  const info = zipDirectory(DIST, zipPath);
  fs.rmSync(zipPath);

  const outZip = path.join(ROOT, `release/3d-mesh-downloader-${manifest.version}.zip`);
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  const result = zipDirectory(DIST, outZip);

  console.log('Build ok');
  console.log('  dist/  ->', path.relative(ROOT, DIST));
  console.log('  zip    ->', path.relative(ROOT, outZip), `(${result.files} arquivos, ${result.bytes} bytes)`);
}

main();
