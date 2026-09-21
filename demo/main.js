// Imported by path, the way a host imports it. Relying on the entry point's own
// `import './styles.css'` is not enough: a bundler may treat it as a removable
// side effect and drop it, leaving the demo unstyled.
import '../src/styles.css';
import { DropPreview, LOCALES } from '../src/index.js';

const log = document.getElementById('log');

const bytes = (n) => (n < 1024 ? `${n} B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1024 ** 2).toFixed(1)} MB`);

// The log is this page's, not the widget's — nothing in the package renders it.
// The switch is here because seeing it turn off is quicker than being told.
let logging = true;
const say = (line) => {
  if (!logging) return;
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
};

let locale = 'en';
let scheme = 'auto';
let palette = false;
let allowSvg = false;
let quality = 'off';
let maxSize = 0;
let autoRetry = false;
let reorder = true;
let pasteMode = true;
let cameraMode = 'auto';
let drop = mount();

const BRAND = {
  font: "'Inter', system-ui, sans-serif",
  radius: '2px',
  tileSize: '140px',
  colors: { accent: '#7c3aed', accentHover: '#6d28d9' },
  light: { accentSoft: '#ede9fe' },
  dark: { accent: '#c4b5fd', accentSoft: '#2b2150' },
};

/**
 * The `compress` block the two selectors add up to, or null for "off".
 *
 * `lossless` is metadata only and never resizes, so a size chosen alongside it
 * would be quietly ignored — the selector says so rather than pretending.
 */
function compressOption() {
  if (quality === 'off' && !maxSize) return null;
  if (quality === 'lossless') return { quality: 'lossless' };
  return {
    ...(maxSize ? { maxWidth: maxSize, maxHeight: maxSize } : {}),
    quality: quality === 'off' ? 'auto' : (quality === 'auto' ? 'auto' : Number(quality)),
  };
}

function mount() {
  document.getElementById('host').innerHTML = '';
  const instance = new DropPreview('#host', {
    endpoint: '/api/upload',
    locale,
    colorScheme: scheme,
    allowSvg,
    theme: palette ? BRAND : null,
    compress: compressOption(),
    retry: autoRetry ? { attempts: 3, delay: 800 } : null,
    reorder,
    paste: pasteMode,
    camera: cameraMode,
    limits: { maxFiles: 12, maxFileSize: 8 * 1024 * 1024 },
  });

  instance.on('change', ({ files }) => {
    const total = files.reduce((n, f) => n + f.size, 0);
    const before = files.reduce((n, f) => n + f.originalSize, 0);
    const saved = before - total;
    say(`change: ${files.length} file(s), ${bytes(total)}`
      + (saved > 0 ? ` — was ${bytes(before)}, saved ${bytes(saved)} (${Math.round((saved / before) * 100)}%)` : ''));
    for (const file of files) {
      if (file.originalSize > file.size) {
        say(`  ${file.name}: ${bytes(file.originalSize)} -> ${bytes(file.size)}`);
      }
    }
  });
  instance.on('reorder', ({ from, to }) => say(`reorder: ${from} -> ${to}`));
  instance.on('warning', ({ code, error }) => say(`warning: ${code} — ${error?.message ?? ''}`));
  instance.on('retry', ({ attempt, of, delay, code }) =>
    say(`retry: ${code} — attempt ${attempt} of ${of}, in ${delay} ms`));
  instance.on('rejected', ({ rejected }) => {
    for (const item of rejected) {
      say(`rejected: ${item.file.name} — ${item.code} — ${instance.describeError(item.code, item.detail)}`);
    }
  });
  instance.on('uploaded', ({ answer }) =>
    say(`uploaded: ${answer.uploaded.length} ok, ${answer.failures.length} failed`));
  instance.on('error', ({ code, message }) => {
    say(`error: ${code} — ${message}`);
    // The batch-level code is the blunt one; each tile knows its own reason,
    // and that is what the person is actually looking at.
    for (const file of instance.files) {
      if (file.error) {
        say(`  ${file.name}: ${file.error.code} — ${instance.describeError(file.error.code, file.error.detail)}`);
      }
    }
  });
  return instance;
}

function remount() {
  drop.destroy();
  drop = mount();
}

const langSelect = document.getElementById('lang');
for (const [id, dictionary] of Object.entries(LOCALES)) {
  const option = document.createElement('option');
  option.value = id;
  option.textContent = `Language: ${dictionary.name}`;
  langSelect.append(option);
}
langSelect.value = locale;
langSelect.addEventListener('change', () => {
  locale = langSelect.value;
  remount();
});

const schemeSelect = document.getElementById('scheme');
schemeSelect.addEventListener('change', () => {
  scheme = schemeSelect.value;
  remount();
});

const paletteButton = document.getElementById('palette');
paletteButton.addEventListener('click', () => {
  palette = !palette;
  paletteButton.textContent = `Custom palette: ${palette ? 'on' : 'off'}`;
  remount();
});

const svgButton = document.getElementById('svg');
svgButton.addEventListener('click', () => {
  allowSvg = !allowSvg;
  svgButton.textContent = `SVG: ${allowSvg ? 'allowed' : 'refused'}`;
  remount();
});

const qualitySelect = document.getElementById('quality');
const sizeSelect = document.getElementById('maxsize');

qualitySelect.addEventListener('change', () => {
  quality = qualitySelect.value;
  // Nothing is resized on the lossless path, so offering a size there would be
  // a control that does nothing.
  sizeSelect.disabled = quality === 'lossless';
  remount();
  say(`compression: ${JSON.stringify(compressOption())}`);
});

sizeSelect.addEventListener('change', () => {
  maxSize = Number(sizeSelect.value);
  remount();
  say(`compression: ${JSON.stringify(compressOption())}`);
});

// The screening switch is the one control here that changes the *server*: the
// dev server keeps two endpoints and this chooses between them. Nothing like
// this route exists in the package.
const scanButton = document.getElementById('scan');
let screening = false;
scanButton.addEventListener('click', async () => {
  screening = !screening;
  scanButton.disabled = true;
  try {
    const response = await fetch(`/api/demo/scan?on=${screening ? 1 : 0}`, { method: 'POST' });
    ({ screening } = await response.json());
    say(`malware check: ${screening ? 'on — a file named *virus* will be refused' : 'off'}`);
  } catch (err) {
    screening = false;
    say(`malware check: could not be switched — ${err.message}`);
  } finally {
    scanButton.textContent = `Malware check: ${screening ? 'on' : 'off'}`;
    scanButton.disabled = false;
  }
});

const retryButton = document.getElementById('retry');
retryButton.addEventListener('click', () => {
  autoRetry = !autoRetry;
  retryButton.textContent = `Auto retry: ${autoRetry ? 'on (3 attempts)' : 'off'}`;
  remount();
});

// Failing one upload on purpose, so a retry can be watched rather than
// described. The dev server answers the next upload with 503 and then forgets
// about it — which is a failure worth repeating, unlike a 404, which the
// widget deliberately does not repeat.
const breakButton = document.getElementById('breaknet');
breakButton.addEventListener('click', async () => {
  breakButton.disabled = true;
  try {
    const response = await fetch('/api/demo/fail?on=1', { method: 'POST' });
    const { failNext } = await response.json();
    breakButton.textContent = `Break the next upload: ${failNext ? 'armed (503)' : 'off'}`;
    say(`next upload will answer 503 once — ${autoRetry ? 'auto retry will pick it up' : 'use the Retry button'}`);
  } catch (err) {
    say(`could not arm the failure — ${err.message}`);
  } finally {
    breakButton.disabled = false;
  }
});

const reorderButton = document.getElementById('reorder');
reorderButton.addEventListener('click', () => {
  reorder = !reorder;
  reorderButton.textContent = `Reorder: ${reorder ? 'on' : 'off'}`;
  remount();
});

const pasteButton = document.getElementById('paste');
pasteButton.addEventListener('click', () => {
  pasteMode = pasteMode === true ? 'document' : (pasteMode === 'document' ? false : true);
  pasteButton.textContent = `Paste: ${pasteMode === true ? 'on' : pasteMode || 'off'}`;
  remount();
  say(`paste: ${pasteMode === 'document' ? 'anywhere on the page' : pasteMode ? 'inside the widget' : 'off'}`);
});

const cameraButton = document.getElementById('camera');
cameraButton.addEventListener('click', () => {
  cameraMode = cameraMode === 'auto' ? true : (cameraMode === true ? false : 'auto');
  cameraButton.textContent = `Camera button: ${cameraMode === true ? 'always' : cameraMode || 'never'}`;
  remount();
});

const logButton = document.getElementById('logtoggle');
logButton.addEventListener('click', () => {
  logging = !logging;
  logButton.textContent = `Upload history: ${logging ? 'shown' : 'hidden'}`;
  log.hidden = !logging;
  if (!logging) log.textContent = '';
});

// Proof that it is still an ordinary form field: with no endpoint the files
// would ride along with this submit exactly as a plain <input type="file"> does.
document.getElementById('form').addEventListener('submit', (event) => {
  event.preventDefault();
  say(`form submit would carry ${drop.files.length} file(s)`);
});
