/**
 * A DOM small enough to read, for testing the widget without a browser.
 *
 * Only what the widget actually touches is implemented. Anything it reaches
 * for that is missing throws, which is the point: the fake cannot quietly
 * absorb a mistake the way a permissive mock would.
 */

const listeners = new WeakMap();

class FakeClassList {
  constructor(node) { this.node = node; this.set = new Set(); }
  add(...names) { for (const n of names) if (n) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  toggle(name, on) { if (on) this.set.add(name); else this.set.delete(name); return Boolean(on); }
  contains(name) { return this.set.has(name); }
  get value() { return [...this.set].join(' '); }
}

export class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList(this);
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.files = null;
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      const node = typeof n === 'object' ? n
        : Object.assign(new FakeNode('#text'), { textContent: String(n) });
      node.parentNode = this;
      this.children.push(node);
    }
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i !== -1) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  get firstChild() { return this.children[0] ?? null; }
  removeChild(node) { node.remove(); return node; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }

  addEventListener(type, handler) {
    if (!listeners.has(this)) listeners.set(this, new Map());
    const map = listeners.get(this);
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const all = listeners.get(this)?.get(type);
    if (!all) return;
    const i = all.indexOf(handler);
    if (i !== -1) all.splice(i, 1);
  }
  /** Deliver an event the way a user's click or drop would. */
  fire(type, event = {}) {
    for (const handler of [...(listeners.get(this)?.get(type) ?? [])]) handler(event);
  }

  *walk() {
    for (const child of this.children) {
      yield child;
      if (child.walk) yield* child.walk();
    }
  }
  matches(selector) {
    const name = selector.replace(/^\./, '');
    return selector.startsWith('.') ? this.classList.contains(name)
      : this.tagName === selector.toUpperCase();
  }
  querySelector(selector) {
    for (const node of this.walk()) if (node.matches?.(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    return [...this.walk()].filter((node) => node.matches?.(selector));
  }
}

/** A stand-in for XMLHttpRequest whose responses the test decides. */
export class FakeXHR {
  static last = null;

  constructor() {
    this.headers = {};
    this.withCredentials = false;
    this.status = 0;
    this.responseText = '';
    this.responseHeaders = { 'content-type': 'application/json' };
    this.aborted = false;
    this.sent = null;
    this.listeners = new Map();
    this.upload = {
      listeners: new Map(),
      addEventListener: (type, handler) => {
        if (!this.upload.listeners.has(type)) this.upload.listeners.set(type, []);
        this.upload.listeners.get(type).push(handler);
      },
      fire: (type, event) => {
        for (const h of this.upload.listeners.get(type) ?? []) h(event);
      },
    };
    FakeXHR.last = this;
  }

  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getResponseHeader(name) { return this.responseHeaders[name.toLowerCase()] ?? null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  fire(type) { for (const h of [...(this.listeners.get(type) ?? [])]) h({}); }
  send(body) { this.sent = body; }
  abort() { this.aborted = true; this.fire('abort'); }

  /** Report how much of the body has gone out. */
  progress(loaded, total) {
    this.upload.fire('progress', { lengthComputable: true, loaded, total });
  }

  /** Answer the request. */
  respond(status, payload, contentType = 'application/json') {
    this.status = status;
    this.responseHeaders['content-type'] = contentType;
    this.responseText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.fire('load');
  }
}

class FakeFormData {
  constructor() { this.entries = []; }
  append(...args) { this.entries.push(args); }
}

/**
 * Install the fake globals. Returns the host element to mount on, plus the
 * knobs the tests turn.
 */
export function installDom() {
  const root = new FakeNode('div');

  // A canvas that encodes plausibly rather than really: the size it reports is
  // a function of the pixels it was given and the quality it was asked for, so
  // a test can tell a resize from a re-encode from a no-op.
  const canvas = {
    calls: [],
    /** Bytes per pixel at quality 1, per type. */
    weights: { 'image/jpeg': 3, 'image/png': 8, 'image/webp': 2 },
    /** Types this "browser" cannot produce. */
    unsupported: new Set(),
    reset() {
      canvas.calls.length = 0;
      canvas.unsupported.clear();
    },
  };

  const makeCanvas = (node) => {
    node.width = 0;
    node.height = 0;
    node.drawn = [];
    node.getContext = (kind) => (kind === '2d' ? {
      fillStyle: '',
      fillRect: (...args) => node.drawn.push(['fillRect', ...args]),
      drawImage: (...args) => node.drawn.push(['drawImage', ...args.slice(1)]),
    } : null);
    node.toBlob = (callback, type = 'image/png', quality) => {
      canvas.calls.push({ width: node.width, height: node.height, type, quality });
      if (canvas.unsupported.has(type)) {
        // What a browser does for a type it cannot encode: hand back a PNG.
        const fallback = canvas.weights['image/png'] * node.width * node.height;
        queueMicrotask(() => callback(new Blob([new Uint8Array(Math.max(1, Math.round(fallback)))], { type: 'image/png' })));
        return;
      }
      const perPixel = canvas.weights[type] ?? 3;
      const factor = quality === undefined ? 1 : quality;
      const bytes = Math.max(1, Math.round(node.width * node.height * perPixel * factor));
      queueMicrotask(() => callback(new Blob([new Uint8Array(bytes)], { type })));
    };
    return node;
  };

  globalThis.Node = FakeNode; // `el()` asks `child instanceof Node`
  globalThis.document = {
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas'
      ? makeCanvas(new FakeNode(tag))
      : new FakeNode(tag)),
    createTextNode: (text) =>
      Object.assign(new FakeNode('#text'), { textContent: String(text) }),
    querySelector: () => root,
  };
  globalThis.DataTransfer = class {
    constructor() { this.items = { list: [], add(file) { this.list.push(file); } }; }
    get files() { return this.items.list; }
  };

  const urls = new Set();
  globalThis.URL = {
    ...globalThis.URL,
    createObjectURL: (file) => {
      const u = `blob:fake/${file.name}/${Math.random().toString(36).slice(2)}`;
      urls.add(u);
      return u;
    },
    revokeObjectURL: (u) => urls.delete(u),
  };

  // Every image decodes to 4x4 unless a test says otherwise. In `manual` mode
  // nothing decodes until the test releases it by hand — timing-based versions
  // of these cases pass for the wrong reason often enough to be worthless.
  const decode = { width: 4, height: 4, fail: false, delayMs: 0, manual: false, pending: [] };
  globalThis.Image = class {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; }
    addEventListener(type, handler) { this[`on_${type}`] = handler; }
    set src(value) {
      const settle = () => {
        if (decode.fail) { this.on_error?.(); return; }
        this.naturalWidth = decode.width;
        this.naturalHeight = decode.height;
        this.on_load?.();
      };
      if (decode.manual) decode.pending.push(settle);
      else if (decode.delayMs) setTimeout(settle, decode.delayMs);
      else queueMicrotask(settle);
    }
  };

  globalThis.XMLHttpRequest = FakeXHR;
  globalThis.FormData = FakeFormData;

  const state = {
    root,
    urls,
    decode,
    canvas,
    /** Put every knob back the way a fresh test expects it. */
    reset() {
      urls.clear();
      canvas.reset();
      FakeXHR.last = null;
      Object.assign(decode, { width: 4, height: 4, fail: false, delayMs: 0, manual: false });
      decode.pending.length = 0;
      root.children.length = 0;
    },
  };
  return state;
}

export function uninstallDom() {
  for (const name of ['Node', 'document', 'DataTransfer', 'Image', 'XMLHttpRequest', 'FormData']) {
    delete globalThis[name];
  }
}

/** Let every queued microtask and zero-delay timer run. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A file that sniffs as a real PNG. */
export const image = (name, size = 512) =>
  new File([Buffer.concat([PNG, Buffer.alloc(Math.max(0, size - PNG.length), 0x41)])], name,
    { type: 'image/png', lastModified: 1 });
