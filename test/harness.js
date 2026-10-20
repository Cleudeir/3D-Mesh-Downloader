/**
 * Test harness: runs the real src/injected.js inside a Node vm context with a
 * mocked DOM, then drives it the same way the extension does.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INJECTED = path.join(__dirname, '..', 'src', 'injected.js');

function createEnvironment(options) {
  options = options || {};

  const downloads = [];
  const alerts = [];
  const posted = [];
  const blobs = new Map();
  let blobCounter = 0;

  class FakeBlob {
    constructor(parts) {
      this.parts = parts;
      this.text = parts.join('');
    }
  }

  const body = {
    appendChild(node) {
      node._attached = true;
      return node;
    }
  };

  const document = {
    body: body,
    documentElement: body,
    createElement(tag) {
      if (tag !== 'a') throw new Error('unexpected tag: ' + tag);
      return {
        _href: '',
        _download: '',
        style: {},
        set href(v) { this._href = v; },
        get href() { return this._href; },
        set download(v) { this._download = v; },
        get download() { return this._download; },
        click() {
          downloads.push({ filename: this._download, content: blobs.get(this._href) || '' });
        },
        remove() { this._removed = true; }
      };
    }
  };

  const sandbox = {
    console: {
      log() {}, warn() {}, error() {}, debug() {}
    },
    alert: (m) => alerts.push(m),
    Blob: FakeBlob,
    EventTarget: class {
      constructor() { this._l = {}; }
      addEventListener(t, f) { (this._l[t] ||= []).push(f); }
      removeEventListener(t, f) {
        const list = this._l[t] || [];
        const i = list.indexOf(f);
        if (i !== -1) list.splice(i, 1);
      }
      dispatchEvent(e) {
        (this._l[e.type] || []).slice().forEach((f) => f(e));
        return true;
      }
    },
    document: document,
    location: { hostname: options.hostname || 'example.test' },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Date: Date,
    Math: Math,
    JSON: JSON,
    URL: {
      createObjectURL(blob) {
        const u = 'blob:fake' + (blobCounter++);
        blobs.set(u, blob.text);
        return u;
      },
      revokeObjectURL() {}
    }
  };

  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox._l = {};
  sandbox.addEventListener = (t, f) => { (sandbox._l[t] ||= []).push(f); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = (e) => { (sandbox._l[e.type] || []).slice().forEach((f) => f(e)); return true; };
  sandbox.postMessage = (msg) => posted.push(msg);

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(INJECTED, 'utf8'), sandbox, { filename: 'injected.js' });

  // The page's global object inside the vm (used as `event.source`).
  const pageWindow = vm.runInContext('globalThis', sandbox);

  return {
    sandbox,
    downloads,
    alerts,
    posted,
    /** Emulates `__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent('observe', {detail}))`. */
    observe(detail) {
      const target = vm.runInContext('window.__THREE_DEVTOOLS__', sandbox);
      target.dispatchEvent({ type: 'observe', detail: detail });
    },
    /** Emulates the content script forwarding a message to the page. */
    send(data) {
      sandbox.dispatchEvent({ type: 'message', source: pageWindow, data: data });
    },
    /** Calls the page-side handler and returns the reply it posted back. */
    request(data) {
      posted.length = 0;
      this.send(data);
      return posted.slice();
    }
  };
}

module.exports = { createEnvironment };
