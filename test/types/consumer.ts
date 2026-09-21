/**
 * Uses the API the way a consumer would, so `tsc --strict` checks the types
 * against real calls rather than against themselves.
 */
import http from 'node:http';

import {
  DropPreview,
  buildThemeCss,
  createDropPreview,
  inspectFile,
  sniffImage,
  DEFAULT_LIMITS,
  LOCALES,
  PLURAL_RULES,
  uk,
  type LocaleDictionary,
  type QueuedFile,
  type Theme,
} from 'drag-and-drop-preview-images-module';

import {
  UploadService,
  createUploadHandler,
  type UploadHandler,
  type UploadResult,
} from 'drag-and-drop-preview-images-module/server';

// --------------------------------------------------------------- the widget
const plain = new DropPreview('#host');
void plain;

const theme: Theme = {
  font: "'Inter', system-ui, sans-serif",
  fontSize: '15px',
  radius: '2px',
  tileSize: '140px',
  colors: { accent: '#7c3aed' },
  light: { bg: '#fffdf7' },
  dark: { bg: '#0b1020', accent: '#a78bfa' },
  '--ddp-gap': '16px',
};

const swedish: LocaleDictionary = {
  id: 'sv',
  name: 'Svenska',
  tag: 'sv',
  plural: PLURAL_RULES.default,
  strings: { 'drop.button': 'Välj filer', 'count.files': { one: '{n} fil', other: '{n} filer' } },
};

const drop = createDropPreview('#host', {
  endpoint: '/api/upload',
  name: 'photos[]',
  accept: ['image/jpeg', 'image/png'],
  allowSvg: false,
  limits: { maxFiles: 8, maxFileSize: 4 * 1024 * 1024 },
  autoUpload: true,
  locale: 'de',
  theme,
  colorScheme: 'dark',
  headers: () => ({ authorization: 'Bearer token' }),
  fields: { album: 'holiday' },
});

new DropPreview('#other', { locale: uk });
new DropPreview('#third', { locale: swedish });

const off = drop.on('change', ({ files }) => {
  const first: QueuedFile | undefined = files[0];
  void first?.type;
});
drop.on('rejected', ({ rejected }) => {
  for (const item of rejected) console.warn(item.code, drop.describeError(item.code, item.detail));
});
drop.on('uploaded', ({ answer }) => void answer);
drop.on('error', ({ code, message }) => console.error(code, message));
off();

const label: string = drop.t('common.upload');
const total: number = drop.totalBytes;
void label;
void total;

void drop.add([] as File[]);
drop.remove('id');
drop.clear();
void drop.upload();
drop.cancel();
drop.destroy();

const sheet: string = buildThemeCss('[data-ddp-theme="1"]', theme);
void sheet;
void Object.keys(LOCALES).length;
void sniffImage(new Uint8Array([0xff, 0xd8, 0xff]));
void DEFAULT_LIMITS.maxFiles;
void inspectFile(new File([], 'a.png'), {
  accept: [],
  allowSvg: false,
  limits: DEFAULT_LIMITS,
  queuedCount: 0,
  queuedBytes: 0,
  seen: new Set<string>(),
});

// --------------------------------------------------------------- the server
const files: UploadHandler = createUploadHandler({
  root: './uploads',
  basePath: '/api/upload',
  accept: ['image/jpeg', 'image/png'],
  onConflict: 'rename',
  limits: { maxFiles: 8 },
  rename: (name, meta) => `${Date.now()}-${name}-${meta.type.split('/')[1]}`,
  allowedOrigins: ['https://app.example'],
  authorize: (req) => req.headers['x-token'] === 'ok',
  onWarning: (message) => console.warn(message),
});

http.createServer(files);
declare const rawReq: http.IncomingMessage;
declare const rawRes: http.ServerResponse;
void files(rawReq, rawRes);
void files.paths();
void files.service.capabilities();

const service = new UploadService({ root: './uploads' });
void service.init();
void service.sweepTemp();

declare const result: UploadResult;
void result.uploaded[0]?.type;
void result.failures[0]?.code;
