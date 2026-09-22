import { compressFile, normaliseCompress } from './core/compress.js';
import { createTranslator, resolveLocale } from './core/i18n.js';
import { delayBefore, isRetryable, normaliseRetry, worthTryingAgain } from './core/retry.js';
import { DEFAULT_LOCALE, LOCALES } from './locales/index.js';
import { buildThemeCss } from './core/theme.js';
import { formatBytes } from './core/format.js';
import { DEFAULT_LIMITS, fileKey, inspectFile } from './core/validate.js';
import { KNOWN_IMAGE_TYPES } from './core/files.js';
import { UploadError, uploadFiles } from './core/uploader.js';
import { clear, el } from './ui/dom.js';

/** Counter behind the per-instance theme scope and element ids. */
let instanceCounter = 0;

export const DEFAULTS = {
  /**
   * Where to POST the files. Left null, the widget stays a form field: the
   * files ride along with the form the way a plain `<input type="file">` does,
   * and your existing back end sees no difference.
   */
  endpoint: null,
  /** Form field name, used both for the hidden input and for the upload. */
  name: 'images[]',
  /** Extra form fields sent with an upload. */
  fields: null,
  /** An object or a function returning one — for authorisation tokens. */
  headers: null,
  credentials: 'same-origin',

  /**
   * MIME types to accept. Empty means every image format the sniffer knows.
   * The type is read from the file's own bytes, not from its extension.
   */
  accept: [],
  /**
   * SVG is XML that can carry script. It is refused unless asked for, which is
   * the opposite of how the other formats are treated, and deliberately so.
   */
  allowSvg: false,
  /** Ceilings; see DEFAULT_LIMITS. */
  limits: null,
  /**
   * Shrink pictures on the page before they are sent. Off unless set; see
   * src/core/compress.js for what each setting does.
   */
  compress: null,

  /**
   * Send a failed upload again by itself. Off unless set; only failures that
   * are about the connection rather than about the file are repeated.
   */
  retry: null,

  /**
   * How many files travel in one request.
   *
   * One each, by default, so that what has landed stays landed. Put fifty
   * photographs in a single request and a connection that drops on the
   * forty-ninth loses all fifty — and worse, the files the server had already
   * written stay there, so sending the batch again leaves duplicates of them.
   * Raise it to trade that safety for fewer round trips, or set 0 to put the
   * whole queue in one request the way earlier versions did.
   */
  filesPerRequest: 1,

  /** Upload as soon as files are chosen, rather than on a button. */
  autoUpload: false,
  /** Show the "Upload" button when an endpoint is set. */
  showUploadButton: true,
  /** Show the "Remove all" button. */
  showClearButton: true,

  /**
   * Let the person put the queue in the order they want.
   *
   * On, because the order files go up in is otherwise an accident of how the
   * operating system sorted a dialog, and for a gallery or a set of product
   * photographs that order is the whole point.
   */
  reorder: true,

  /**
   * Accept a picture pasted with Ctrl+V.
   *
   * `true` listens on the widget itself, so a paste goes to the widget the
   * person was last working in — which is the only thing that can be right
   * when a page has two of them. `'document'` listens on the whole page, for
   * a page that has one and wants Ctrl+V to work without clicking first.
   */
  paste: true,

  /**
   * Offer a "Take a photo" button that opens the camera.
   *
   * `'auto'` shows it where the pointer is coarse — a phone or a tablet —
   * because on a desktop it would open the same file dialog as the button
   * beside it. `true` always, `false` never.
   */
  camera: 'auto',

  /**
   * Which camera that button opens: `'environment'` is the one facing away,
   * for documents and objects; `'user'` is the one facing the person.
   */
  capture: 'environment',

  /** 'en' | 'uk' | 'es' | 'de' | 'fr' | your own dictionary. */
  locale: null,
  /** Colours, fonts and metrics; see src/core/theme.js. */
  theme: null,
  /** 'auto' | 'light' | 'dark'. */
  colorScheme: 'auto',
};

/**
 * An image drop zone with previews.
 *
 *   const drop = new DropPreview('#host', { endpoint: '/api/upload' });
 *   drop.on('change', ({ files }) => console.log(files.length));
 *
 * Every instance owns its own DOM, its own queue and its own object URLs.
 * Nothing is registered globally, so two of these on one page do not interfere
 * — which the version this replaces could not manage, because its buttons
 * called functions on `window` by name.
 */
export class DropPreview {
  #items = [];

  #listeners = new Map();

  #objectUrls = new Set();

  /** item id -> its tile, so a preview can land without redrawing the others. */
  #tiles = new Map();

  #controller = null;

  #destroyed = false;

  /** The batch still being decoded and shrunk, so an upload can wait for it. */
  #adding = null;

  #onPaste = null;

  #pasteTarget = null;

  #busy = false;

  constructor(target, options = {}) {
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error(`DropPreview: container not found (${target})`);

    this.options = { ...DEFAULTS, ...options };
    this.limits = { ...DEFAULT_LIMITS, ...(this.options.limits ?? {}) };
    // Validated here rather than at upload time, so a typo in the options is a
    // mistake the developer meets immediately.
    this.compress = normaliseCompress(this.options.compress);
    this.retryPolicy = normaliseRetry(this.options.retry);
    if (typeof this.options.reorder !== 'boolean') {
      throw new Error('reorder must be true or false');
    }
    if (![true, false, 'document'].includes(this.options.paste)) {
      throw new Error("paste must be true, false, or 'document'");
    }
    if (![true, false, 'auto'].includes(this.options.camera)) {
      throw new Error("camera must be true, false, or 'auto'");
    }
    if (!['environment', 'user'].includes(this.options.capture)) {
      throw new Error("capture must be 'environment' or 'user'");
    }
    const perRequest = this.options.filesPerRequest;
    if (!Number.isInteger(perRequest) || perRequest < 0) {
      throw new Error('filesPerRequest must be a whole number, 0 for all at once');
    }
    this.host = host;

    this.locale = resolveLocale(this.options.locale, LOCALES, DEFAULT_LOCALE);
    this.t = createTranslator(this.locale, DEFAULT_LOCALE);

    this.#build();
  }

  // ------------------------------------------------------------------ DOM

  #build() {
    const id = String((instanceCounter += 1));
    this.id = id;

    this.root = el('div.ddp', {
      lang: this.locale.tag ?? 'en',
      dataset: { ddpTheme: id },
      class: this.options.colorScheme === 'dark'
        ? 'ddp-dark'
        : this.options.colorScheme === 'light'
          ? 'ddp-light'
          : '',
    });

    // Emitted as a stylesheet rather than set inline: an inline custom property
    // beats every rule in the stylesheet, which would pin the colour and leave
    // the dark theme unable to change it.
    const css = buildThemeCss(`[data-ddp-theme="${id}"]`, this.options.theme);
    if (css) this.root.append(el('style', { text: css }));

    this.input = el('input.ddp-input', {
      type: 'file',
      name: this.options.name,
      id: `ddp-input-${id}`,
      multiple: true,
      // The picker's own filter is a convenience, not a check — the bytes are
      // what decide. It is set from `accept` so the dialog does not offer
      // files that will be refused a moment later.
      accept: (this.options.accept.length ? this.options.accept : KNOWN_IMAGE_TYPES).join(','),
      'aria-label': this.t('drop.inputLabel'),
      on: { change: () => this.#onPicked() },
    });

    // A second input, because one cannot be both. `capture` tells a phone to
    // open the camera, and a browser that honours it ignores `multiple` — a
    // camera returns one photograph. Putting it on the main input would mean
    // giving up choosing from the gallery, which is what most uploads are.
    this.cameraInput = el('input.ddp-input', {
      type: 'file',
      id: `ddp-camera-${id}`,
      accept: 'image/*',
      capture: this.options.capture,
      'aria-label': this.t('common.takePhoto'),
      on: { change: () => this.#onCaptured() },
    });

    this.button = el('span.ddp-fake-btn', { text: this.t('drop.button') });
    this.message = el('span.ddp-msg', { text: this.t('drop.hint') });

    this.zone = el('label.ddp-zone', { for: `ddp-input-${id}` }, [
      this.button,
      this.message,
      this.input,
    ]);

    this.previews = el('div.ddp-previews', {
      role: 'list',
      'aria-label': this.t('drop.listLabel'),
    });

    this.status = el('p.ddp-status', { role: 'status', 'aria-live': 'polite' });

    this.progressBar = el('div.ddp-progress-bar');
    this.progress = el('div.ddp-progress', {
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      hidden: true,
    }, [this.progressBar]);

    this.actions = el('div.ddp-actions');

    // Its own row, not the action row: that one is hidden while the queue is
    // empty, which is exactly when somebody wants to take a photograph. A
    // label rather than a button, because it has to open its own input, and
    // the drop zone is already a label wrapping the other one — nesting them
    // would make a click on either ambiguous.
    this.sources = el('div.ddp-sources');
    if (this.#wantsCamera()) {
      this.cameraButton = el('label.ddp-btn.ddp-camera', {
        for: `ddp-camera-${id}`,
        text: this.t('common.takePhoto'),
      }, [this.cameraInput]);
      this.sources.append(this.cameraButton);
    }

    this.root.append(
      this.zone, this.sources, this.status, this.progress, this.previews, this.actions
    );
    this.#buildActions();
    this.#wireDrag();
    this.#wirePaste();
    this.#wireReorder();

    this.host.append(this.root);
    this.#render();
  }

  #buildActions() {
    clear(this.actions);

    if (this.options.showClearButton) {
      this.clearButton = el('button.ddp-btn', {
        type: 'button',
        text: this.t('common.removeAll'),
        on: { click: () => this.clear() },
      });
      this.actions.append(this.clearButton);
    }

    if (this.options.endpoint && this.options.showUploadButton) {
      this.uploadButton = el('button.ddp-btn.ddp-btn-primary', {
        type: 'button',
        text: this.t('common.upload'),
        on: { click: () => this.upload() },
      });
      this.cancelButton = el('button.ddp-btn', {
        type: 'button',
        text: this.t('common.cancel'),
        hidden: true,
        on: { click: () => this.cancel() },
      });
      // Shown only when something failed for a reason worth repeating. A
      // button that is always there but usually pointless teaches people to
      // ignore it.
      this.retryButton = el('button.ddp-btn', {
        type: 'button',
        text: this.t('common.retry'),
        hidden: true,
        on: { click: () => this.retry() },
      });
      this.actions.append(this.uploadButton, this.retryButton, this.cancelButton);
    }
  }

  /**
   * Drag and drop.
   *
   * The dragover handler must call preventDefault or the browser navigates to
   * the dropped file instead of handing it over. The counter is there because
   * dragenter and dragleave fire for every child element the pointer crosses,
   * so a single flag flickers the highlight on and off as the cursor moves
   * across the zone's own text.
   */
  #wireDrag() {
    let depth = 0;
    const setActive = (active) => this.zone.classList.toggle('is-active', active);

    this.zone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      depth += 1;
      setActive(true);
    });
    this.zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    this.zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    });
    this.zone.addEventListener('drop', (event) => {
      event.preventDefault();
      depth = 0;
      setActive(false);
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (dropped.length) this.add(dropped);
    });
    this.input.addEventListener('focus', () => setActive(true));
    this.input.addEventListener('blur', () => setActive(false));
  }

  // --------------------------------------------------------------- queue

  /**
   * Whether to offer the camera at all.
   *
   * On a desktop the button would open the same file dialog as the one beside
   * it, so `'auto'` asks the browser whether the pointer is coarse — which is
   * the closest thing to "this is a phone" that does not involve guessing from
   * the user agent string.
   */
  #wantsCamera() {
    if (this.options.camera === false) return false;
    if (this.options.camera === true) return true;
    try {
      return Boolean(globalThis.matchMedia?.('(pointer: coarse)')?.matches);
    } catch {
      return false;
    }
  }

  /**
   * Pasting a picture.
   *
   * Listening on the widget rather than the page is deliberate: two of these
   * on one screen would otherwise both take the same paste, and the module
   * registers nothing globally by design. `paste: 'document'` opts into the
   * other behaviour for a page that has one widget.
   */
  #wirePaste() {
    if (!this.options.paste) return;
    const target = this.options.paste === 'document' ? document : this.root;

    this.#onPaste = (event) => {
      if (this.#destroyed) return;
      // Somebody typing into a field is pasting into that field, not here.
      const into = event.target;
      const tag = into?.tagName;
      if (into?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA') {
        if (into !== this.input && into !== this.cameraInput) return;
      }
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      this.add(files);
    };
    target.addEventListener('paste', this.#onPaste);
    this.#pasteTarget = target;
  }

  /** A photograph straight from the camera. */
  #onCaptured() {
    const taken = [...(this.cameraInput.files ?? [])];
    if (taken.length) this.add(taken);
    // Cleared so the same photograph can be taken twice without the browser
    // deciding nothing changed.
    this.cameraInput.value = '';
  }

  #onPicked() {
    const picked = [...(this.input.files ?? [])];
    if (picked.length) this.add(picked);
  }

  /**
   * Add files to the queue, checking each one.
   *
   * @param {File[]|FileList} files
   * @returns {Promise<{accepted: object[], rejected: object[]}>}
   */
  async add(files) {
    // Held so `upload()` can wait: a file is queued before its preview has
    // decoded and before it has been shrunk, and pressing Upload in that
    // window would send the original bytes rather than the smaller ones.
    const batch = this.#addBatch(files);
    const previous = this.#adding;
    this.#adding = previous ? previous.then(() => batch, () => batch) : batch;
    try {
      return await batch;
    } finally {
      if (this.#adding === batch) this.#adding = null;
    }
  }

  async #addBatch(files) {
    const accepted = [];
    const rejected = [];
    const seen = new Set(this.#items.map((item) => item.key));

    for (const file of [...files]) {
      const verdict = await inspectFile(file, {
        accept: this.options.accept,
        allowSvg: this.options.allowSvg,
        limits: this.limits,
        queuedCount: this.#items.length + accepted.length,
        queuedBytes: this.totalBytes + accepted.reduce((sum, item) => sum + item.file.size, 0),
        seen,
      });

      if (!verdict.ok) {
        rejected.push({ file, code: verdict.code, detail: verdict.detail ?? null });
        continue;
      }
      const item = {
        id: `${this.id}-${this.#items.length + accepted.length}-${Date.now()}`,
        key: fileKey(file),
        file,
        type: verdict.type,
        url: null,
        width: 0,
        height: 0,
        status: 'ready',
        error: null,
      };
      seen.add(item.key);
      accepted.push(item);
    }

    this.#items.push(...accepted);
    // The input is cleared either way: leaving the browser's own selection in
    // place would double every file the next time the picker is used, and the
    // queue — not the input — is what this widget considers true.
    this.#syncInput();
    this.#render();

    // One at a time, and each tile is filled the moment its own image is
    // decoded. Rendering once at the end left the user looking at a grid of
    // empty squares until the last file in the batch had finished — with a
    // large selection that is the whole wait, spent showing nothing.
    for (const item of accepted) {
      await this.#loadPreview(item);
      await this.#shrink(item);
      this.#paintTile(item);
    }

    if (rejected.length) this.emit('rejected', { rejected });
    if (accepted.length) this.emit('change', { files: this.files });
    if (accepted.length && this.options.autoUpload && this.options.endpoint) {
      await this.#send();
    }
    return { accepted: accepted.map(publicItem), rejected };
  }

  /**
   * Decode the image for its preview, and refuse one that is too big.
   *
   * A 30 KB PNG can declare 40000×40000 and cost gigabytes once decoded. The
   * dimensions are only knowable after the browser has parsed the header, so
   * the check happens here rather than in the byte sniffer.
   */
  async #loadPreview(item) {
    const url = URL.createObjectURL(item.file);
    this.#objectUrls.add(url);

    try {
      const size = await new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener('load', () =>
          // The decoded picture is handed on: compression redraws exactly this,
          // so nothing is decoded a second time.
          resolve({ width: image.naturalWidth, height: image.naturalHeight, image }));
        image.addEventListener('error', () => reject(new Error('decode failed')));
        image.src = url;
      });

      if (size.width * size.height > this.limits.maxPixels) {
        this.#releaseUrl(url);
        item.status = 'error';
        item.error = { code: 'TOO_MANY_PIXELS', detail: { limit: this.limits.maxPixels } };
        return;
      }
      item.url = url;
      item.width = size.width;
      item.height = size.height;
      item.image = size.image;
    } catch {
      this.#releaseUrl(url);
      item.status = 'error';
      item.error = { code: 'DECODE_FAILED', detail: null };
    }
  }

  /**
   * Replace a file with a smaller version of itself, when one is worth having.
   *
   * Shrinking is an optimisation, so every way it can go wrong ends with the
   * original file being sent. Losing somebody's photograph because a canvas
   * refused to encode it would be a far worse outcome than sending a few more
   * kilobytes.
   */
  async #shrink(item) {
    if (!this.compress || item.status === 'error' || !item.image) {
      if (item) item.image = null;
      return;
    }
    try {
      const { file, changed } = await compressFile(item.file, {
        image: item.image,
        type: item.type,
        width: item.width,
        height: item.height,
      }, this.compress);

      if (changed) {
        item.originalSize = item.file.size;
        item.file = file;
        // The hidden input is what a plain form submit carries, so it has to
        // hold the smaller file too.
        this.#syncInput();
      }
    } catch (err) {
      this.emit('warning', { code: 'COMPRESS_FAILED', error: err, file: item.file });
    } finally {
      // The decoded picture is the largest thing here — several times the file
      // on a big photograph. It has done its work.
      item.image = null;
    }
  }

  /**
   * Dragging a tile to somewhere else in the queue.
   *
   * Pointer events rather than HTML5 drag-and-drop, because that one does not
   * exist on a touch screen — and a phone is where a queue most often needs
   * putting in order, since that is where the pictures were taken.
   *
   * The pointer is captured on the list rather than on the tile: reordering
   * redraws the tiles, and a capture on an element that has just been replaced
   * stops delivering events halfway through the gesture.
   */
  #wireReorder() {
    if (!this.options.reorder) return;

    let dragging = null;   // the id being moved
    let startX = 0;
    let startY = 0;
    let armed = null;      // a candidate, before the gesture has said it is one
    let holdTimer = null;

    const TOUCH_HOLD = 300;   // ms before a finger means "move this"
    const THRESHOLD = 6;      // px before a mouse does

    const stop = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      armed = null;
      if (dragging) {
        this.#tiles.get(dragging)?.classList.remove('is-dragging');
        this.previews.classList.remove('is-reordering');
        dragging = null;
      }
    };

    const begin = (id) => {
      dragging = id;
      armed = null;
      this.#tiles.get(id)?.classList.add('is-dragging');
      this.previews.classList.add('is-reordering');
    };

    this.previews.addEventListener('pointerdown', (event) => {
      if (this.#busy || event.button > 0) return;
      // The remove button is a button; a press on it is not a drag.
      const tile = this.#tileFromEvent(event);
      if (!tile) return;

      armed = tile.id;
      startX = event.clientX ?? 0;
      startY = event.clientY ?? 0;
      this.previews.setPointerCapture?.(event.pointerId);

      // A finger that stays put means "pick this up"; one that moves straight
      // away means "scroll the page", and taking that over would make the
      // queue impossible to scroll past.
      if (event.pointerType === 'touch') {
        holdTimer = setTimeout(() => {
          if (armed) begin(armed);
        }, TOUCH_HOLD);
      }
    });

    this.previews.addEventListener('pointermove', (event) => {
      if (armed && !dragging && event.pointerType !== 'touch') {
        const far = Math.abs((event.clientX ?? 0) - startX) + Math.abs((event.clientY ?? 0) - startY);
        if (far > THRESHOLD) begin(armed);
      }
      if (!dragging) {
        // Moving before the hold has finished means this was a scroll.
        if (armed && holdTimer) {
          const far = Math.abs((event.clientX ?? 0) - startX) + Math.abs((event.clientY ?? 0) - startY);
          if (far > THRESHOLD) stop();
        }
        return;
      }

      event.preventDefault?.();
      const over = this.#tileFromPoint(event.clientX, event.clientY);
      if (!over || over.id === dragging) return;
      const to = this.#items.findIndex((item) => item.id === over.id);
      if (to !== -1) {
        const id = dragging;
        this.move(id, to);
        // The redraw replaced the element, so the class goes on the new one.
        this.#tiles.get(id)?.classList.add('is-dragging');
        this.previews.classList.add('is-reordering');
      }
    });

    for (const kind of ['pointerup', 'pointercancel', 'pointerleave']) {
      this.previews.addEventListener(kind, stop);
    }
  }

  /** The tile a pointer event started on, if it was not on a control. */
  #tileFromEvent(event) {
    let node = event.target;
    let onGrip = false;
    while (node && node !== this.previews) {
      if (node.classList?.contains('ddp-remove')) return null;
      if (node.classList?.contains('ddp-grip')) onGrip = true;
      if (node.classList?.contains('ddp-tile')) {
        // A mouse can start anywhere on the tile: there is nothing to scroll
        // away from. A finger has to start on the grip, or the queue could
        // not be scrolled at all.
        if (event.pointerType === 'touch' && !onGrip) return null;
        const id = [...this.#tiles].find(([, tile]) => tile === node)?.[0];
        return id ? { id, tile: node } : null;
      }
      node = node.parentNode;
    }
    return null;
  }

  /** The tile under a point on the screen. */
  #tileFromPoint(x, y) {
    let node = document.elementFromPoint?.(x, y);
    while (node && node !== this.previews) {
      if (node.classList?.contains('ddp-tile')) {
        const id = [...this.#tiles].find(([, tile]) => tile === node)?.[0];
        return id ? { id, tile: node } : null;
      }
      node = node.parentNode;
    }
    return null;
  }

  /**
   * Moving a tile without a pointer at all.
   *
   * Alt and an arrow, rather than a bare arrow: a bare one on a focused item
   * is expected to move the focus, not the thing under it.
   */
  #onTileKey(event, id) {
    if (!this.options.reorder || this.#busy) return;
    if (!event.altKey) return;
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (!back && !forward) return;

    const at = this.#items.findIndex((item) => item.id === id);
    if (at === -1) return;
    event.preventDefault?.();
    if (this.move(id, at + (back ? -1 : 1))) {
      // Focus follows the tile, or the next key press would move a different
      // one — which is how a person loses their place entirely.
      this.#tiles.get(id)?.focus?.();
    }
  }

  #releaseUrl(url) {
    if (!url) return;
    URL.revokeObjectURL(url);
    this.#objectUrls.delete(url);
  }

  /** Remove one file by its id. */
  remove(id) {
    const index = this.#items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    const [item] = this.#items.splice(index, 1);
    this.#tiles.delete(item.id);
    this.#releaseUrl(item.url);
    this.#syncInput();
    this.#render();
    this.emit('change', { files: this.files });
    return true;
  }

  /**
   * Put one file somewhere else in the queue.
   *
   * The index is where the file ends up, counted in the queue as it will be
   * afterwards — which is what "move this to third place" means to a person,
   * and avoids the off-by-one that counting in the old queue produces when
   * moving something forwards.
   *
   * @param {string} id the file to move
   * @param {number} to its new position, from 0
   * @returns {boolean} false when there was nothing to do
   */
  move(id, to) {
    // The same answer the drag and the keyboard give while an upload is
    // running. Allowing it here would let the order on screen drift away from
    // the order the files are actually going out in, for no gain: what is in
    // flight is in flight either way.
    if (this.#busy) return false;

    const from = this.#items.findIndex((item) => item.id === id);
    if (from === -1) return false;

    const target = Math.max(0, Math.min(this.#items.length - 1, Math.trunc(to)));
    if (target === from) return false;

    const [moved] = this.#items.splice(from, 1);
    this.#items.splice(target, 0, moved);

    // The hidden input is what a plain form submit carries, so the order has
    // to reach it too — otherwise the page shows one order and sends another.
    this.#syncInput();
    this.#render();
    this.emit('reorder', { id, from, to: target, files: this.files });
    this.emit('change', { files: this.files });
    return true;
  }

  /** Empty the queue. */
  clear() {
    if (this.#items.length === 0) return;
    for (const item of this.#items) this.#releaseUrl(item.url);
    this.#items = [];
    this.#tiles.clear();
    this.#syncInput();
    this.#render();
    this.emit('change', { files: this.files });
  }

  /**
   * Keep the hidden input's FileList equal to the queue.
   *
   * This is what lets the widget stay a plain form field: a form submitted the
   * ordinary way carries exactly the files still on screen. `DataTransfer` is
   * the only way to build a `FileList`, which is otherwise read-only.
   */
  #syncInput() {
    const transfer = new DataTransfer();
    for (const item of this.#items) transfer.items.add(item.file);
    this.input.files = transfer.files;
  }

  // -------------------------------------------------------------- upload

  /**
   * Send the queue to `endpoint`.
   *
   * @returns {Promise<object|null>} the server's answer, or null when there was
   *   nothing to send or no endpoint configured
   */
  async upload() {
    if (!this.options.endpoint || this.#busy) return null;
    // Whatever is still being decoded or shrunk belongs to this upload: a file
    // is queued before its preview has decoded and before it has been shrunk,
    // and sending it in that window would send the original bytes.
    while (this.#adding) await this.#adding.catch(() => {});
    if (this.#destroyed) return null;
    return this.#send();
  }

  /**
   * Send the queue. Called once nothing is still being prepared — directly by
   * `autoUpload`, which runs at the end of a batch and would otherwise be
   * waiting for the batch it is part of.
   */
  async #send() {
    if (this.#items.length === 0 || this.#busy) return null;

    this.#busy = true;
    this.#controller = new AbortController();
    this.#setUploading(true);

    // A file that has already landed is never sent again. That is the whole
    // point of sending them in separate requests: an interruption costs the
    // batch that was in flight, not the ones already on the server.
    const pending = this.#items.filter((item) => item.status !== 'error' && item.status !== 'done');
    if (pending.length === 0) {
      // Everything in the queue has either failed or already arrived. Posting
      // an empty body would come back as "no files were sent", which is true
      // and useless — the reason is on the tiles, and it is not the server's.
      this.#busy = false;
      this.#controller = null;
      this.#setUploading(false);
      this.emit('error', {
        error: null,
        code: 'NOTHING_TO_UPLOAD',
        message: this.describeError('NOTHING_TO_UPLOAD', null),
      });
      return null;
    }

    const perRequest = this.options.filesPerRequest || pending.length;
    const groups = [];
    for (let at = 0; at < pending.length; at += perRequest) {
      groups.push(pending.slice(at, at + perRequest));
    }

    const uploaded = [];
    const failures = [];
    const totalBytes = pending.reduce((sum, item) => sum + item.file.size, 0);
    let sentBytes = 0;
    let stopped = null;
    let lastError = null;

    try {
      for (const group of groups) {
        if (this.#controller?.signal.aborted) break;
        const outcome = await this.#sendGroup(
          group, sentBytes, totalBytes, uploaded.length + failures.length, pending.length
        );
        sentBytes += group.reduce((sum, item) => sum + item.file.size, 0);
        this.#setProgress(sentBytes, totalBytes);

        if (outcome.answer) {
          uploaded.push(...(outcome.answer.uploaded ?? []));
          failures.push(...(outcome.answer.failures ?? []));
          continue;
        }

        failures.push(...group.map((item) => ({
          name: item.file.name,
          code: item.error?.code ?? 'INTERNAL',
          params: item.error?.detail ?? null,
        })));
        lastError = outcome.error;
        // A refusal of these particular files says nothing about the next
        // ones, so the walk goes on. A connection that has dropped says
        // everything about them, and carrying on would only waste the
        // person's time failing the same way another forty times.
        if (outcome.cancelled || isRetryable(outcome.code, outcome.status)) {
          stopped = outcome.error;
          break;
        }
      }

      const answer = { uploaded, failures };
      // Cut short, or nothing arrived at all: either way this was a failure,
      // not a partial success worth announcing as one.
      const failure = stopped ?? (uploaded.length === 0 && failures.length ? lastError : null);
      if (failure) {
        const code = failure instanceof UploadError ? failure.code : 'INTERNAL';
        this.emit('error', { error: failure, code, message: this.describeError(code, failure) });
        return null;
      }
      this.emit('uploaded', { answer, files: this.files });
      return answer;
    } finally {
      // Reached however the walk ends — answered, refused, or cancelled.
      this.#busy = false;
      this.#controller = null;
      this.#setUploading(false);
      this.#setProgress(0, 0);
      this.#render();
    }
  }

  /** "Uploading 3 of 20", while there is more than one request to make. */
  #showProgressText(done, total) {
    if (total > 1) {
      this.status.textContent = this.t('status.uploading', { done: done + 1, total });
    }
  }

  /**
   * One group of files, with whatever retries the host asked for.
   *
   * @returns {Promise<{answer: object|null, error: unknown, code: string, status: number, cancelled: boolean}>}
   */
  async #sendGroup(group, sentBefore, totalBytes, doneSoFar, queued) {
    for (const item of group) {
      item.status = 'uploading';
      item.error = null;
    }
    this.#render();
    // After the render, which writes the queue summary over whatever the
    // status line was saying.
    this.#showProgressText(doneSoFar, queued);

    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.#attempt(group, attempt, sentBefore, totalBytes);
      if (outcome.done) return outcome;
      for (const item of group) {
        item.status = 'uploading';
        item.error = null;
        item.progress = 0;
      }
      this.#render();
    }
  }

  /**
   * One attempt at sending the batch.
   *
   * @returns {Promise<{done: boolean, answer: object|null}>} `done` is false
   *   only when the failure is worth repeating and there are attempts left.
   */
  async #attempt(sending, attempt, sentBefore = 0, totalBytes = 0) {
    const groupBytes = sending.reduce((sum, item) => sum + item.file.size, 0);
    try {
      const answer = await uploadFiles({
        endpoint: this.options.endpoint,
        items: sending,
        field: this.options.name,
        headers: this.options.headers,
        credentials: this.options.credentials,
        fields: this.options.fields,
        signal: this.#controller.signal,
        // The bar measures the whole queue, not the request in flight: with a
        // file per request it would otherwise jump back to nothing on each one.
        onProgress: (sent, total) => {
          const fraction = total ? sent / total : 0;
          this.#spreadProgress(sending, fraction);
          if (totalBytes) this.#setProgress(sentBefore + fraction * groupBytes, totalBytes);
          else this.#setProgress(sent, total);
        },
      });

      // The server decides what actually landed; a file it refused is marked
      // here rather than quietly counted as sent.
      const failures = new Map(
        (answer.failures ?? []).map((failure) => [failure.name, failure])
      );
      for (const item of sending) {
        const failure = failures.get(item.file.name);
        item.status = failure ? 'error' : 'done';
        item.error = failure ? { code: failure.code ?? 'INTERNAL', detail: failure.params ?? null } : null;
        item.progress = failure ? 0 : 1;
      }
      this.#render();
      return { done: true, answer, error: null, code: null, status: 0, cancelled: false };
    } catch (err) {
      const code = err instanceof UploadError ? err.code : 'INTERNAL';
      // Cancelling is the user's own decision, not something wrong with the
      // files. Marking them failed left the queue unsendable: every item was
      // in error, so the next press of Upload found nothing to send and the
      // button appeared dead.
      const cancelled = code === 'ABORTED';
      // When the server refused the whole batch it still named each file and
      // its reason; those are better than one message repeated on every tile.
      const named = new Map(
        (err?.failures ?? []).map((failure) => [failure.name, failure])
      );
      for (const item of sending) {
        const own = named.get(item.file.name);
        item.status = cancelled ? 'ready' : 'error';
        // Whatever went out is not coming back; the next attempt starts the
        // file again, so showing it part-done would be a lie.
        item.progress = 0;
        item.error = cancelled
          ? null
          : own
            ? { code: own.code ?? code, detail: own.params ?? null }
            : { code, detail: err instanceof UploadError ? err.params : null };
      }
      this.#render();

      const status = err instanceof UploadError ? err.status : 0;
      const again = !cancelled
        && this.retryPolicy
        && attempt < this.retryPolicy.attempts
        && isRetryable(code, status);

      if (again) {
        const delay = delayBefore(this.retryPolicy, attempt + 1);
        this.emit('retry', { attempt: attempt + 1, of: this.retryPolicy.attempts, delay, code });
        this.status.textContent = this.t('status.retrying', {
          attempt: attempt + 1,
          total: this.retryPolicy.attempts,
        });
        // Cancelling during the wait has to cut it short, or the button looks
        // ignored for as long as the backoff lasts.
        if (await this.#wait(delay)) {
          return { done: false, answer: null, error: err, code, status, cancelled };
        }
      }

      return { done: true, answer: null, error: err, code, status, cancelled };
    }
  }

  /**
   * Wait, unless the upload is cancelled first.
   *
   * @returns {Promise<boolean>} true when the wait finished on its own
   */
  #wait(ms) {
    return new Promise((resolve) => {
      const signal = this.#controller?.signal;
      if (signal?.aborted) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', stop);
        resolve(true);
      }, ms);
      const stop = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal?.addEventListener('abort', stop, { once: true });
    });
  }

  /**
   * Send again what failed for a reason worth repeating.
   *
   * Files refused for what they are — too large, not an image, reported as
   * malware — are left alone: another attempt produces the same answer.
   *
   * @returns {Promise<object|null>} the server's answer, or null
   */
  async retry() {
    const again = this.#items.filter(
      (item) => item.status === 'error' && worthTryingAgain(item.error?.code, item.error?.status ?? 0)
    );
    if (again.length === 0 || this.#busy) return null;

    for (const item of again) {
      item.status = 'ready';
      item.error = null;
    }
    this.#render();
    return this.upload();
  }

  /** Whether anything in the queue failed for a reason worth repeating. */
  get retryable() {
    return this.#items.some(
      (item) => item.status === 'error' && worthTryingAgain(item.error?.code, item.error?.status ?? 0)
    );
  }

  /** Stop an upload in flight. */
  cancel() {
    this.#controller?.abort();
  }

  #setUploading(active) {
    this.root.classList.toggle('is-uploading', active);
    if (this.uploadButton) this.uploadButton.hidden = active;
    if (this.cancelButton) this.cancelButton.hidden = !active;
    // Decided here as well as in #render, because the render that follows a
    // failure runs while the upload is still marked busy — and would hide the
    // button at exactly the moment it becomes useful.
    if (this.retryButton) this.retryButton.hidden = active || !this.retryable;
    if (this.clearButton) this.clearButton.disabled = active;
    this.input.disabled = active;
    this.progress.hidden = !active;
  }

  #setProgress(sent, total) {
    const fraction = total > 0 ? Math.min(1, sent / total) : 0;
    this.progressBar.style.width = `${Math.round(fraction * 100)}%`;
    this.progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }

  // -------------------------------------------------------------- render

  #render() {
    if (this.#destroyed) return;
    clear(this.previews);
    this.#tiles.clear();

    for (const item of this.#items) {
      this.previews.append(this.#tile(item));
    }

    const count = this.#items.length;
    this.message.textContent = count === 0
      ? this.t('drop.hint')
      : this.t('count.selected', { n: count });

    this.status.textContent = count === 0
      ? ''
      : this.t('status.queue', {
          files: this.t('count.files', { n: count }),
          size: formatBytes(this.totalBytes, this.t),
        });

    if (this.clearButton) this.clearButton.disabled = count === 0 || this.#busy;
    if (this.uploadButton) this.uploadButton.disabled = count === 0;
    if (this.retryButton) this.retryButton.hidden = this.#busy || !this.retryable;
    this.root.classList.toggle('is-empty', count === 0);
  }

  #tile(item) {
    const thumb = el('div.ddp-thumb', {
      class: item.status === 'error' ? 'is-error' : '',
      // A background image, not an <img>: the file name never reaches an
      // attribute the browser would parse, and a failed decode leaves an empty
      // box rather than a broken-image glyph.
      style: item.url ? { backgroundImage: `url("${item.url}")` } : {},
    });

    const remove = el('button.ddp-remove', {
      type: 'button',
      // The file name goes in through textContent/attribute assignment, never
      // through markup, so a name like `<img onerror=…>.png` is just a name.
      'aria-label': this.t('drop.removeOne', { name: item.file.name }),
      title: this.t('common.remove'),
      text: '×',
      disabled: this.#busy,
      on: { click: () => this.remove(item.id) },
    });

    const caption = item.error
      ? this.describeError(item.error.code, item.error.detail)
      : formatBytes(item.file.size, this.t);

    const tile = el('div.ddp-tile', {
      role: 'listitem',
      dataset: { status: item.status },
      title: item.file.name,
      ...(this.options.reorder
        ? {
            tabindex: '0',
            'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
            on: { keydown: (event) => this.#onTileKey(event, item.id) },
          }
        : {}),
    }, [
      // Its own bar, over the thumbnail. The one below the zone measures the
      // whole queue; this says how far this particular file has got, which is
      // the question a person asks when one photograph is much larger than
      // the rest of them.
      el('div.ddp-thumb-wrap', {}, [
        thumb,
        remove,
        // A finger needs somewhere to press that is not also somewhere to
        // scroll from. Until a drag has begun the browser treats a moving
        // touch as a scroll and cancels the pointer, so the grip is the one
        // spot with `touch-action: none` — small enough that the rest of the
        // queue can still be scrolled past.
        this.options.reorder
          ? el('span.ddp-grip', { 'aria-hidden': 'true', text: '\u283F' })
          : null,
        el('div.ddp-tile-progress', {}, [
          el('div.ddp-tile-progress-bar', { style: { width: `${Math.round((item.progress ?? 0) * 100)}%` } }),
        ]),
      ]),
      el('span.ddp-name', { text: item.file.name }),
      el('span.ddp-size', { class: item.error ? 'is-error' : '', text: caption }),
    ]);
    this.#tiles.set(item.id, tile);
    return tile;
  }

  /**
   * Bring one tile up to date.
   *
   * Everything a preview can change lives in this tile: the thumbnail, the
   * caption, the status. Redrawing the whole list for each of them would be
   * quadratic in the size of the queue, and for a long queue that cost lands
   * exactly when the queue is longest.
   */
  /**
   * Move one tile's bar, and nothing else.
   *
   * Separate from #paintTile because progress arrives many times a second and
   * rewriting a caption and re-deciding a class each time is work for nothing.
   */
  #paintProgress(item) {
    const bar = this.#tiles.get(item.id)?.querySelector('.ddp-tile-progress-bar');
    if (bar) bar.style.width = `${Math.round((item.progress ?? 0) * 100)}%`;
  }

  /**
   * Share one request's progress out among the files it is carrying.
   *
   * A multipart body sends its parts in order, so the bytes that have gone
   * out belong to the files in order too. With one file per request — the
   * default — this is exact; with several it is the closest thing to the
   * truth available without the browser telling us which part it is on.
   */
  #spreadProgress(group, fraction) {
    let left = fraction * group.reduce((sum, item) => sum + item.file.size, 0);
    for (const item of group) {
      const size = item.file.size || 1;
      item.progress = Math.max(0, Math.min(1, left / size));
      left -= size;
      this.#paintProgress(item);
    }
  }

  #paintTile(item) {
    const tile = this.#tiles.get(item.id);
    if (!tile) return;

    tile.dataset.status = item.status;
    this.#paintProgress(item);

    const thumb = tile.querySelector('.ddp-thumb');
    if (item.url) thumb.style.backgroundImage = `url("${item.url}")`;
    thumb.classList.toggle('is-error', item.status === 'error');

    const caption = tile.querySelector('.ddp-size');
    caption.textContent = item.error
      ? this.describeError(item.error.code, item.error.detail)
      : formatBytes(item.file.size, this.t);
    caption.classList.toggle('is-error', Boolean(item.error));
  }

  /**
   * Turn a refusal code into a sentence in the active language.
   *
   * A code with no translation falls back to the English message the server
   * sent, and then to the code itself — visible and searchable, rather than a
   * blank where an explanation belonged.
   */
  describeError(code, detail) {
    const params = { ...(detail ?? {}) };
    if (params.limit !== undefined) params.limit = formatBytes(params.limit, this.t);
    for (const key of [`error.${code}`, `srv.${code}`]) {
      const text = this.t(key, params);
      if (text !== key) return text;
    }
    return detail?.message ?? code;
  }

  // ---------------------------------------------------------------- API

  /** The queue, as plain objects. */
  get files() {
    return this.#items.map(publicItem);
  }

  get totalBytes() {
    return this.#items.reduce((sum, item) => sum + item.file.size, 0);
  }

  get busy() {
    return this.#busy;
  }

  /** @returns {() => void} a function that unsubscribes */
  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.#listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.#listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (err) {
        // A listener that throws is the host's bug, and it must not take the
        // widget's own rendering down with it.
        console.error('DropPreview: listener for', event, 'threw', err);
      }
    }
  }

  /** Remove the widget and everything it holds. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.cancel();
    for (const url of this.#objectUrls) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
    this.#items = [];
    this.#tiles.clear();
    this.#listeners.clear();
    // A page-level paste listener would otherwise outlive the widget it was
    // feeding, and go on adding files to a queue nobody can see.
    if (this.#onPaste && this.#pasteTarget) {
      this.#pasteTarget.removeEventListener('paste', this.#onPaste);
      this.#onPaste = null;
    }
    this.root.remove();
  }
}

/** What a host sees: no object URLs, no internal ids to depend on. */
function publicItem(item) {
  return {
    id: item.id,
    file: item.file,
    name: item.file.name,
    size: item.file.size,
    type: item.type,
    width: item.width,
    height: item.height,
    /** What it weighed before it was shrunk, when it was. */
    originalSize: item.originalSize ?? item.file.size,
    /** How much of this file has gone out, 0 to 1. */
    progress: item.progress ?? 0,
    status: item.status,
    error: item.error,
  };
}

export default DropPreview;
