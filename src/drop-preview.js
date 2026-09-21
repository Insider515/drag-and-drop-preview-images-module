import { compressFile, normaliseCompress } from './core/compress.js';
import { createTranslator, resolveLocale } from './core/i18n.js';
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

  /** Upload as soon as files are chosen, rather than on a button. */
  autoUpload: false,
  /** Show the "Upload" button when an endpoint is set. */
  showUploadButton: true,
  /** Show the "Remove all" button. */
  showClearButton: true,

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

  #busy = false;

  constructor(target, options = {}) {
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error(`DropPreview: container not found (${target})`);

    this.options = { ...DEFAULTS, ...options };
    this.limits = { ...DEFAULT_LIMITS, ...(this.options.limits ?? {}) };
    // Validated here rather than at upload time, so a typo in the options is a
    // mistake the developer meets immediately.
    this.compress = normaliseCompress(this.options.compress);
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
    this.root.append(this.zone, this.status, this.progress, this.previews, this.actions);
    this.#buildActions();
    this.#wireDrag();

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
      this.actions.append(this.uploadButton, this.cancelButton);
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

    const sending = this.#items.filter((item) => item.status !== 'error');
    if (sending.length === 0) {
      // Every file in the queue already failed. Posting an empty body would
      // come back as "no files were sent", which is true and useless — the
      // reason is on the tiles, and it is not the server's.
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
    for (const item of sending) item.status = 'uploading';
    this.#render();

    try {
      const answer = await uploadFiles({
        endpoint: this.options.endpoint,
        items: sending,
        field: this.options.name,
        headers: this.options.headers,
        credentials: this.options.credentials,
        fields: this.options.fields,
        signal: this.#controller.signal,
        onProgress: (sent, total) => this.#setProgress(sent, total),
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
      }
      this.#render();
      this.emit('uploaded', { answer, files: this.files });
      return answer;
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
        item.error = cancelled
          ? null
          : own
            ? { code: own.code ?? code, detail: own.params ?? null }
            : { code, detail: err instanceof UploadError ? err.params : null };
      }
      this.#render();
      this.emit('error', { error: err, code, message: this.describeError(code, err) });
      return null;
    } finally {
      this.#busy = false;
      this.#controller = null;
      this.#setUploading(false);
      this.#setProgress(0, 0);
    }
  }

  /** Stop an upload in flight. */
  cancel() {
    this.#controller?.abort();
  }

  #setUploading(active) {
    this.root.classList.toggle('is-uploading', active);
    if (this.uploadButton) this.uploadButton.hidden = active;
    if (this.cancelButton) this.cancelButton.hidden = !active;
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
    }, [
      el('div.ddp-thumb-wrap', {}, [thumb, remove]),
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
  #paintTile(item) {
    const tile = this.#tiles.get(item.id);
    if (!tile) return;

    tile.dataset.status = item.status;

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
    status: item.status,
    error: item.error,
  };
}

export default DropPreview;
