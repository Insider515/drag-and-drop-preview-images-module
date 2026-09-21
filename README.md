# drag-and-drop-preview-images-module

An image drop zone with previews: a front-end widget with no dependencies and a Node
upload handler with no framework.

Drop files on it, or pick them the ordinary way, and each one appears as a thumbnail with
its size and a button to take it out again. Pictures fill in one at a time as they decode,
so a large selection shows the first thumbnail immediately instead of a grid of empty
squares. Without a server endpoint the widget is still just a form field — the files ride
along with the form and the back end sees no difference. Give it an endpoint and it posts
them itself, with a progress bar and a working cancel button.

What it is careful about:

- **A file is what its bytes say it is.** The name and the type the browser reports are
  both the operating system guessing from an extension; renaming an executable to `.png`
  is enough to fool either. Both halves read the leading bytes instead. The client's check
  exists to give the user a reason; the server's is the one that counts, because anything
  reachable over HTTP can be sent with curl and no browser at all.
- **The server refuses names rather than repairing them.** Traversal in any spelling, NUL
  bytes, Windows device names, trailing dots — a name that has to be rewritten to become
  safe usually belongs to an attempt.
- **Nothing half-written is left behind.** Each upload goes to a temporary name and is
  renamed only once it is whole, and a request that dies part-way through is cleaned up
  rather than leaving a stray file on disk.
- **A cross-origin form cannot post into the endpoint.** `multipart/form-data` is not
  preflighted, so without an Origin check any page on any site could upload under the
  user's session cookie.

Size and shape: 13 KB of JS and 2 KB of CSS gzipped on the page, zero runtime
dependencies. The server half is a single `(req, res)` function that mounts in Express,
AdonisJS, Fastify, Nest or bare `node:http`, and its only dependency is a multipart
parser. Five languages ship with it — English (the default), Ukrainian, Spanish, German
and French — and light and dark themes, with colours, fonts and metrics all settable at
integration time.

> 🇺🇦 [Ця сторінка українською](README.uk.md)

---

## Status

Work in progress, and not published to npm yet. Until it is, install it from the
repository:

```bash
npm install github:Insider515/drag-and-drop-preview-images-module
```

Or clone it and try the demo:

```bash
git clone https://github.com/Insider515/drag-and-drop-preview-images-module.git
cd drag-and-drop-preview-images-module
npm install
npm start          # builds the demo and serves it on http://127.0.0.1:5173
```

---

## Quick start

### As a form field — no server changes at all

Leave `endpoint` unset and the widget stays what it replaced: an `<input type="file">`
with previews. The files ride along with the form, and your existing back end sees no
difference.

```html
<form action="/contact" method="post" enctype="multipart/form-data">
  <div id="images"></div>
  <button type="submit">Send</button>
</form>
```

```js
import { DropPreview } from 'drag-and-drop-preview-images-module';
import 'drag-and-drop-preview-images-module/style.css';

new DropPreview('#images', { name: 'images[]' });
```

### Uploading on its own

```js
const drop = new DropPreview('#images', {
  endpoint: '/api/upload',
  autoUpload: true,
});

drop.on('uploaded', ({ answer }) => console.log(answer.uploaded));
```

```js
// server
import express from 'express';
import { createUploadHandler } from 'drag-and-drop-preview-images-module/server';

const app = express();
app.use('/api/upload', createUploadHandler({ root: './uploads' }));
app.listen(3000);
```

---

## What it does

| | |
| --- | --- |
| Previews | Thumbnails drawn from the files themselves, with name and size |
| Selective removal | Each tile has its own remove button; "Remove all" clears the queue |
| Drag & drop | Onto the zone, with the highlight surviving the pointer crossing child elements |
| Identification | The type is read from the file's leading bytes, never from the extension |
| Limits | Per file, per queue, file count, and decoded pixels |
| Upload | Progress and cancellation, or none at all if you keep it a form field |
| Languages | Five shipped; your own is an object with a dictionary |
| Themes | Light and dark, following the system or forced; every colour a CSS variable |
| Two on one page | Nothing is registered globally, so instances do not interfere |

---

## Widget options

```js
new DropPreview(target, {
  endpoint: null,         // POST here; null keeps it a plain form field
  name: 'images[]',       // form field name
  fields: null,           // extra form fields sent with an upload
  headers: null,          // object or function — for authorisation tokens
  credentials: 'same-origin',

  accept: [],             // MIME types; empty means every image format known
  allowSvg: false,        // SVG is XML that can carry script; opt-in
  limits: null,           // see below

  autoUpload: false,      // upload as soon as files are chosen
  showUploadButton: true,
  showClearButton: true,

  locale: null,           // 'en' | 'uk' | 'es' | 'de' | 'fr' | your dictionary
  theme: null,            // colours, fonts, metrics
  colorScheme: 'auto',    // 'auto' | 'light' | 'dark'
});
```

`target` is an element or a CSS selector.

### Limits

```js
new DropPreview('#images', {
  limits: {
    maxFileSize: 10 * 1024 * 1024,   // bytes per file
    maxFiles: 20,                    // files in the queue
    maxTotalSize: 100 * 1024 * 1024, // bytes for the whole queue
    maxPixels: 50 * 1024 * 1024,     // pixels a preview may decode
  },
});
```

`maxPixels` is not about tidiness. A 30 KB PNG can declare 40000×40000 and cost several
gigabytes once decoded — the tab dies before anything is uploaded. The dimensions are only
knowable after the browser has parsed the header, so the check happens when the preview is
built, and a file past it is dropped with a reason.

### Methods and events

```js
await drop.add(fileList);        // same checks as picking them by hand
drop.remove(id);
drop.clear();
await drop.upload();
drop.cancel();
drop.destroy();

drop.files;                      // the queue, as plain objects
drop.totalBytes;
drop.busy;

drop.on('change',   ({ files }) => {});
drop.on('rejected', ({ rejected }) => {});   // [{ file, code, detail }]
drop.on('uploaded', ({ answer, files }) => {});
drop.on('error',    ({ error, code, message }) => {});
```

`on()` returns a function that unsubscribes.

A refusal carries a `code`, never a sentence, so you can branch on it. To show it to
someone, `drop.describeError(code, detail)` turns it into text in the active language.

---

## Language

```js
new DropPreview('#images', { locale: 'de' });
```

Accepts `'en'`, `'uk'`, `'es'`, `'de'`, `'fr'`, or a full tag whose base matches one of
them (`'de-AT'` gives German). Anything unrecognised gives English rather than an error.

Plurals follow the language's own rule — Ukrainian has three forms, the rest have two —
and size units become local (`1.5 Ko` in French). The widget's root gets a `lang`
attribute.

### Your own language

Partial dictionaries are fine: anything left out comes from English.

```js
import { DropPreview, PLURAL_RULES } from 'drag-and-drop-preview-images-module';

new DropPreview('#images', {
  locale: {
    id: 'sv',
    name: 'Svenska',
    tag: 'sv',
    plural: PLURAL_RULES.default,
    strings: {
      'drop.button': 'Välj filer',
      'drop.hint': 'eller dra dem hit',
      'count.files': { one: '{n} fil', other: '{n} filer' },
    },
  },
});
```

The shipped dictionaries are ordinary exports (`import { en, uk } from '…'`), and in the
repository they live in `src/locales/` — one plain object per language. A test keeps the
key sets identical across all five and refuses a translation that introduces a
placeholder English does not have.

---

## Appearance

Pass nothing and the widget looks the way the demo does.

```js
new DropPreview('#images', {
  colorScheme: 'auto',      // 'auto' follows the system; 'light'/'dark' force it
  theme: {
    font: "'Inter', system-ui, sans-serif",
    fontSize: '15px',
    radius: '2px',
    tileSize: '140px',
    gap: '16px',
    dropHeight: '160px',

    colors: { accent: '#7c3aed', accentHover: '#6d28d9' },
    light: { bg: '#fffdf7', text: '#2b2415' },
    dark: { bg: '#0b1020', accent: '#a78bfa' },
  },
});
```

`colors` applies to both schemes; `light` and `dark` narrow it. Theme only the light
scheme and the dark one keeps its built-in colours — a white background will not appear at
night.

**Colours:** `bg`, `bgSubtle`, `bgSunken`, `border`, `borderStrong`, `text`, `textMuted`,
`accent`, `accentHover`, `accentSoft`, `accentContrast`, `danger`, `dangerHover`,
`success`, `warning`, `shadow`, `overlay`.

**Fonts and metrics:** `font`, `fontSize`, `radius`, `radiusLarge`, `tileSize`, `gap`,
`dropHeight`.

An unknown key throws rather than being ignored. A key starting with `--` passes straight
through, for a variable the named list has not caught up with. Values are checked:
anything that could close the rule and open one of its own (`;`, `}`, `url(`, comments) is
refused — which matters if your colours come from your own users.

A theme applies to one widget, so two on a page can look different.

---

## Where you can mount the server

`createUploadHandler()` returns a plain `(req, res)` function over node's own objects.
`basePath` is the prefix to strip when the host does not rewrite `req.url` itself —
Express does, Adonis and `node:http` do not.

```js
// Express
app.use('/api/upload', createUploadHandler({ root: './uploads' }))

// AdonisJS
const files = createUploadHandler({ root: app.makePath('uploads'), basePath: '/api/upload' })
router.any('/api/upload/*', ({ request, response }) => files(request.request, response.response))

// Fastify
fastify.all('/api/upload/*', (req, reply) => files(req.raw, reply.raw))

// bare node:http
http.createServer(files).listen(3000)
```

### Handler options

```js
createUploadHandler({
  root: './uploads',        // required; the one directory files may land in
  basePath: '',             // prefix to strip from the URL
  field: 'images[]',        // form field to read — the widget's default

  accept: [],               // MIME types; empty means every image format known
  allowSvg: false,
  onConflict: 'rename',     // 'rename' | 'refuse' | 'overwrite'
  rename: null,             // (name, { type }) => string — choose the stored name

  limits: {
    maxFileSize: 10 * 1024 * 1024,
    maxFiles: 20,
    maxRequestSize: 100 * 1024 * 1024,
    minFreeSpace: 64 * 1024 * 1024,
  },
  maxConcurrent: 8,         // uploads in flight; beyond that, 503

  allowedOrigins: undefined, // same-origin only by default; false disables the check
  authorize: (req, ctx) => true,
  onWarning: (message, detail) => {},
});
```

### What comes back

```json
{
  "uploaded": [{ "name": "photo.png", "original": "photo.png", "size": 1024, "type": "image/png" }],
  "failures": [{ "name": "evil.png", "code": "NOT_AN_IMAGE", "error": "…", "params": null }],
  "fields": { "album": "holiday" }
}
```

One bad file does not fail the batch. The client is told which ones did not make it and
why, and keeps the rest.

### Just the storing half

`UploadService` does the filesystem work and knows nothing about HTTP, for a framework
that parses the multipart body itself:

```js
import { UploadService } from 'drag-and-drop-preview-images-module/server';

const service = new UploadService({ root: './uploads' });
const stored = await service.store(filename, readableStream);
```

---

## Security

The theme throughout: **the file's own bytes decide, and the server decides again.**

**Identification.** `File.type` comes from the operating system's extension mapping, so
renaming `payload.exe` to `photo.png` is enough to make a browser call it `image/png`.
Both sides read the leading bytes instead. The client's copy is there to give the user a
reason; the server's is the one that counts, because anything reachable over HTTP can be
sent with curl and no browser at all.

**SVG is opt-in.** It is the one image format that is XML and can carry script. Every
other format is accepted by default; this one has to be asked for.

**Names.** Refuse, do not repair. Traversal in any spelling, NUL bytes, characters no
filesystem agrees on, trailing dots and spaces, and Windows device names are all refused
rather than rewritten — a name that has to be rewritten to become safe usually belongs to
an attempt. A directory upload's path is trimmed to its last segment before any of that.

**Containment.** Where a file lands is checked twice: lexically, and against the resolved
root. Neither is enough alone — the second is what catches a symlink planted in the upload
directory pointing at `/etc`.

**Writing.** Each file goes to a temporary name and is renamed only on success, so an
interrupted upload leaves no truncated file under a real name. The final name is claimed
with `O_EXCL`, so "is it free" and "take it" are one operation — otherwise two requests
uploading the same name would both pass the check and one would be lost.

**Cross-origin.** `multipart/form-data` is a *simple* request: it is not preflighted, so a
plain `<form>` on any site could post into this endpoint under the user's session cookie.
The Origin check closes that. A request with no browser headers at all — curl, a
server-to-server call — is allowed.

**Limits** are counted from bytes actually received, not from `Content-Length`, which is
the sender's claim and absent entirely from a chunked request.

**In the DOM.** Nothing is built by concatenating strings into `innerHTML`; the helper
this widget uses has no such escape hatch. A file called `<img src=x onerror=alert(1)>.png`
is rendered as that text and nothing else.

### What it does not do

- No authentication and no rate limiting — both belong in front of it.
- No virus scanning. "It is a real image" is not "it is a safe image".
- No image processing: nothing is re-encoded, resized or stripped of metadata. EXIF,
  including GPS coordinates, is stored as it arrived.
- `server/standalone.js` is a development server with no authentication. It is not part of
  the npm package.

---

## Development

```bash
npm install
npm run dev          # API + Vite with hot reload -> http://localhost:5173
npm test             # 116 tests
npm run build        # library -> dist/
npm run build:demo   # demo page -> demo-dist/
npm start            # build the demo and serve it without Vite
```

Dev server options: `--port`, `--host`, `--root`, `--svg`, `--vite`.

### Layout

```
src/                the widget
  drop-preview.js     the class: queue, previews, upload
  core/
    files.js            magic-number identification
    validate.js         limits and the accept/refuse decision
    uploader.js         XHR upload with progress and cancellation
    i18n.js             dictionary lookup, plural rules, fallback
    theme.js            host colours, fonts and metrics
    format.js           byte formatting
  locales/            en, uk, es, de, fr — one plain object each
  ui/dom.js           element building with no innerHTML escape hatch
server/             the back end
  handler.js          the routes and the multipart reading
  upload-service.js   storing: sniffing, limits, temp file, atomic rename
  safe-name.js        names and containment
  sniff.js            the same identification, server side
  http.js             the small router it runs on; no framework
types/              hand-written .d.ts, checked by `npm run typecheck`
demo/               the demonstration page
test/               tests
```

---

## Limitations

- Images only. The identification table knows ten image formats; anything else is refused
  by design.
- Previews are `background-image` on a div, so an animated GIF or WebP animates in the
  tile as the browser sees fit — there is no frame extraction.
- No image processing at all: no resizing, no re-encoding, no EXIF stripping.
- `maxPixels` guards the preview, not the server: a host that wants a dimension limit
  server-side has to decode there too, which needs an image library this package does not
  depend on.
- The queue is kept in a hidden input via `DataTransfer`, which every current browser
  supports but which has no fallback — a browser without it cannot carry the files through
  a plain form submit.
- HEIC and AVIF are identified and uploaded, but a browser that cannot decode them shows
  an empty tile; there is no server-side conversion.
- Uploads are one request for the whole queue. There is no chunking, so a very large
  queue on a poor connection is all-or-nothing.
- The widget uses container queries and `:has()` — a 2023 browser or newer.
- Node 18+.

## Licence

MIT © Mykhailo Kravtsov.
