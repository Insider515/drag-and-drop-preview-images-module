// Imported by path, the way a host imports it. Relying on the entry point's own
// `import './styles.css'` is not enough: a bundler may treat it as a removable
// side effect and drop it, leaving the demo unstyled.
import '../src/styles.css';
import { DropPreview, LOCALES } from '../src/index.js';

const log = document.getElementById('log');

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
let drop = mount();

const BRAND = {
  font: "'Inter', system-ui, sans-serif",
  radius: '2px',
  tileSize: '140px',
  colors: { accent: '#7c3aed', accentHover: '#6d28d9' },
  light: { accentSoft: '#ede9fe' },
  dark: { accent: '#c4b5fd', accentSoft: '#2b2150' },
};

function mount() {
  document.getElementById('host').innerHTML = '';
  const instance = new DropPreview('#host', {
    endpoint: '/api/upload',
    name: 'files[]',
    locale,
    colorScheme: scheme,
    allowSvg,
    theme: palette ? BRAND : null,
    limits: { maxFiles: 12, maxFileSize: 8 * 1024 * 1024 },
  });

  instance.on('change', ({ files }) =>
    say(`change: ${files.length} file(s), ${files.reduce((n, f) => n + f.size, 0)} bytes`));
  instance.on('rejected', ({ rejected }) => {
    for (const item of rejected) {
      say(`rejected: ${item.file.name} — ${item.code} — ${instance.describeError(item.code, item.detail)}`);
    }
  });
  instance.on('uploaded', ({ answer }) =>
    say(`uploaded: ${answer.uploaded.length} ok, ${answer.failures.length} failed`));
  instance.on('error', ({ code, message }) => say(`error: ${code} — ${message}`));
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

const logButton = document.getElementById('logtoggle');
logButton.addEventListener('click', () => {
  logging = !logging;
  logButton.textContent = `Event log: ${logging ? 'on' : 'off'}`;
  log.hidden = !logging;
  if (!logging) log.textContent = '';
});

// Proof that it is still an ordinary form field: with no endpoint the files
// would ride along with this submit exactly as a plain <input type="file"> does.
document.getElementById('form').addEventListener('submit', (event) => {
  event.preventDefault();
  say(`form submit would carry ${drop.files.length} file(s)`);
});
