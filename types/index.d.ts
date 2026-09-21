/**
 * Type definitions for `drag-and-drop-preview-images-module`.
 *
 * Hand-written rather than generated: the options are the API, and they
 * deserve prose a generator cannot produce.
 */

/** The languages that ship with the widget. */
export type LocaleId = 'en' | 'uk' | 'es' | 'de' | 'fr';

/** Which plural form a count takes in a given language. */
export type PluralForm = 'one' | 'few' | 'many' | 'other';

/** One string, or a set of forms chosen by the count in `{n}`. */
export type LocaleString = string | Partial<Record<PluralForm, string>>;

/**
 * A language.
 *
 * May be partial: anything it leaves out comes from English, so translating a
 * dozen strings and leaving the rest gives a working widget.
 */
export interface LocaleDictionary {
  id?: string;
  name?: string;
  /** BCP-47 tag, used for the `lang` attribute. */
  tag?: string;
  plural?: (count: number) => PluralForm;
  strings: Record<string, LocaleString>;
}

export declare const PLURAL_RULES: {
  /** English, Spanish, German, French: one, other. */
  default: (count: number) => PluralForm;
  /** Ukrainian and its relatives: one, few, many. */
  slavic: (count: number) => PluralForm;
};

export declare const LOCALES: Record<LocaleId, LocaleDictionary>;
export declare const DEFAULT_LOCALE: LocaleDictionary;
export declare const en: LocaleDictionary;
export declare const uk: LocaleDictionary;
export declare const es: LocaleDictionary;
export declare const de: LocaleDictionary;
export declare const fr: LocaleDictionary;

export declare function createTranslator(
  dictionary: LocaleDictionary,
  fallback: LocaleDictionary
): (key: string, params?: Record<string, unknown>) => string;

export declare function resolveLocale(
  locale: LocaleId | string | LocaleDictionary | null | undefined,
  available: Record<string, LocaleDictionary>,
  fallback: LocaleDictionary
): LocaleDictionary;

/** A CSS value: a colour, a length, a font stack. */
export type ThemeValue = string;

/** Any custom property, for a variable the named list has not caught up with. */
export type ThemeEscapeHatch = { [property: `--${string}`]: ThemeValue };

/** One palette. Give it under `colors`, `light` or `dark`. */
export interface ThemeColors extends ThemeEscapeHatch {
  bg?: ThemeValue;
  bgSubtle?: ThemeValue;
  bgSunken?: ThemeValue;
  border?: ThemeValue;
  borderStrong?: ThemeValue;
  text?: ThemeValue;
  textMuted?: ThemeValue;
  accent?: ThemeValue;
  accentHover?: ThemeValue;
  accentSoft?: ThemeValue;
  /** Text drawn on top of the accent colour. */
  accentContrast?: ThemeValue;
  danger?: ThemeValue;
  dangerHover?: ThemeValue;
  success?: ThemeValue;
  warning?: ThemeValue;
  shadow?: ThemeValue;
  /** The scrim behind the remove button on a thumbnail. */
  overlay?: ThemeValue;
}

/**
 * Colours, fonts and metrics.
 *
 * Omit it and the widget keeps its built-in palette. Fonts and metrics have one
 * value each; colours may be given once for both schemes (`colors`) or per
 * scheme (`light`, `dark`). An unknown key throws rather than being ignored.
 */
export interface Theme extends ThemeEscapeHatch {
  font?: ThemeValue;
  fontSize?: ThemeValue;
  radius?: ThemeValue;
  radiusLarge?: ThemeValue;
  /** Minimum width of a preview tile; the grid fits as many as will go. */
  tileSize?: ThemeValue;
  gap?: ThemeValue;
  dropHeight?: ThemeValue;

  /** Applies to both schemes. */
  colors?: ThemeColors;
  /** Narrows `colors` for the light scheme. */
  light?: ThemeColors;
  /** Narrows `colors` for the dark scheme. */
  dark?: ThemeColors;
}

export declare function buildThemeCss(scope: string, theme: Theme | null | undefined): string;
export declare const METRIC_PROPERTIES: Record<string, string>;
export declare const COLOR_PROPERTIES: Record<string, string>;

/** Why a file was not accepted. */
export type RejectionCode =
  | 'EMPTY'
  | 'TOO_LARGE'
  | 'TOO_MANY'
  | 'TOTAL_TOO_LARGE'
  | 'NOT_AN_IMAGE'
  | 'TYPE_NOT_ALLOWED'
  | 'SVG_REFUSED'
  | 'DUPLICATE'
  | 'TOO_MANY_PIXELS'
  | 'DECODE_FAILED';

export interface Limits {
  /** Bytes per file. */
  maxFileSize: number;
  /** Files in the queue at once. */
  maxFiles: number;
  /** Bytes for the whole queue. */
  maxTotalSize: number;
  /** Pixels a preview may decode — a guard against decompression bombs. */
  maxPixels: number;
}

export declare const DEFAULT_LIMITS: Limits;

/** A file in the queue, as a host sees it. */
export interface QueuedFile {
  id: string;
  file: File;
  name: string;
  size: number;
  /** Read from the file's own bytes, not from its extension. */
  type: string;
  width: number;
  height: number;
  status: 'ready' | 'uploading' | 'done' | 'error';
  error: { code: string; detail: Record<string, unknown> | null } | null;
}

export interface Rejection {
  file: File;
  code: RejectionCode;
  detail: Record<string, unknown> | null;
}

/**
 * Shrinking pictures in the browser, before they are uploaded.
 *
 * Leave the whole block out and nothing is touched, which is the default.
 */
export interface CompressOptions {
  /** Fit the picture inside this many pixels across. */
  maxWidth?: number;
  /** Fit the picture inside this many pixels down. */
  maxHeight?: number;
  /** `contain` fits inside the box (the default); `cover` fills it. */
  fit?: 'contain' | 'cover';
  /**
   * `'auto'` (the default) encodes at 0.85 — fifteen percent off the top of
   * the scale. A number sets the encoder's dial yourself. `'lossless'` never
   * re-encodes and only drops metadata.
   *
   * It has no effect on PNG, which has no quality dial: to make one smaller,
   * resize it or set `format`.
   */
  quality?: 'auto' | 'lossless' | number;
  /** `'auto'` keeps the format it came in as. */
  format?: 'auto' | 'image/jpeg' | 'image/png' | 'image/webp';
  /** Drop EXIF, XMP and comments. On by default. */
  stripMetadata?: boolean;
  /** Keep the original when the new file is not actually smaller. On by default. */
  skipIfLarger?: boolean;
}

/** Fifteen percent below the top of the scale: 0.85. */
export declare const AUTO_QUALITY: number;

export declare function normaliseCompress(raw: CompressOptions | null | undefined): object | null;
export declare function targetSize(
  width: number,
  height: number,
  config: object
): { width: number; height: number } | null;
export declare function compressFile(
  file: File,
  decoded: { image: unknown; type: string; width: number; height: number },
  config: object
): Promise<{ file: File; changed: boolean }>;

/** Drop metadata without touching a pixel. Null when there was nothing to drop. */
export declare function stripMetadata(
  buffer: ArrayBuffer | Uint8Array,
  type: string
): Uint8Array | null;
export declare function readExifOrientation(
  view: Uint8Array,
  start: number,
  end: number
): number;

export interface DropPreviewOptions {
  /**
   * Where to POST the files. Left null, the widget stays a form field: the
   * files ride along with the form, and your back end sees no difference.
   */
  endpoint?: string | null;
  /** Form field name, used for the hidden input and for the upload. */
  name?: string;
  /** Extra form fields sent with an upload. */
  fields?: Record<string, string> | null;
  headers?: Record<string, string> | (() => Record<string, string>) | null;
  credentials?: 'same-origin' | 'include' | 'omit';

  /** MIME types to accept. Empty means every image format the sniffer knows. */
  accept?: string[];
  /** SVG is XML that can carry script; it is refused unless asked for. */
  allowSvg?: boolean;
  limits?: Partial<Limits> | null;
  /** Off unless set; see {@link CompressOptions}. */
  compress?: CompressOptions;

  autoUpload?: boolean;
  showUploadButton?: boolean;
  showClearButton?: boolean;

  locale?: LocaleId | string | LocaleDictionary | null;
  theme?: Theme | null;
  colorScheme?: 'auto' | 'light' | 'dark';
}

export interface DropPreviewEvents {
  change: { files: QueuedFile[] };
  rejected: { rejected: Rejection[] };
  uploaded: { answer: unknown; files: QueuedFile[] };
  error: { error: unknown; code: string; message: string };
}

export declare class DropPreview {
  constructor(target: HTMLElement | string, options?: DropPreviewOptions);

  readonly root: HTMLElement;
  readonly host: HTMLElement;
  readonly input: HTMLInputElement;
  readonly options: Required<DropPreviewOptions>;
  readonly locale: LocaleDictionary;
  readonly limits: Limits;
  readonly files: QueuedFile[];
  readonly totalBytes: number;
  readonly busy: boolean;

  /** Translate a key in the widget's language. */
  t(key: string, params?: Record<string, unknown>): string;

  add(files: File[] | FileList): Promise<{ accepted: QueuedFile[]; rejected: Rejection[] }>;
  remove(id: string): boolean;
  clear(): void;
  upload(): Promise<unknown | null>;
  cancel(): void;
  describeError(code: string, detail?: Record<string, unknown> | null): string;

  on<K extends keyof DropPreviewEvents>(
    event: K,
    handler: (payload: DropPreviewEvents[K]) => void
  ): () => void;
  emit<K extends keyof DropPreviewEvents>(event: K, payload: DropPreviewEvents[K]): void;

  destroy(): void;
}

export declare const DEFAULTS: Required<DropPreviewOptions>;

export declare function createDropPreview(
  target: HTMLElement | string,
  options?: DropPreviewOptions
): DropPreview;

/** The checks, for a host that wants to run them somewhere else. */
export declare const KNOWN_IMAGE_TYPES: string[];
export declare const SNIFF_BYTES: number;
export declare function sniffImage(head: Uint8Array): { type: string; ext: string } | null;
export declare function looksLikeSvg(head: Uint8Array): boolean;
export declare function readHead(file: Blob, length?: number): Promise<Uint8Array>;
export declare function fileKey(file: File): string;
export declare function inspectFile(
  file: File,
  context: {
    accept: string[];
    allowSvg: boolean;
    limits: Limits;
    queuedCount: number;
    queuedBytes: number;
    seen: Set<string>;
  }
): Promise<{ ok: true; type: string } | { ok: false; code: RejectionCode; detail?: object }>;

export declare class UploadError extends Error {
  constructor(code: string, message: string, status?: number, params?: object | null);
  code: string;
  status: number;
  params: object | null;
}

export declare function uploadFiles(config: {
  endpoint: string;
  items: Array<{ file: File }>;
  field?: string;
  headers?: Record<string, string> | (() => Record<string, string>);
  credentials?: string;
  fields?: Record<string, string>;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<unknown>;

export declare function formatBytes(
  bytes: number | null | undefined,
  t?: (key: string) => string
): string;

export default DropPreview;
