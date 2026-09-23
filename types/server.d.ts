/**
 * Type definitions for `image-drop-upload/server`.
 *
 * The handler is described in terms of node's own request and response, not a
 * framework's: it mounts in Express, AdonisJS, Fastify, Nest or bare
 * `node:http`, and none of those types are needed to describe it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

/** A refusal the client is allowed to see. */
export declare class UploadError extends Error {
  constructor(status: number, code: string, message: string, params?: object | null);
  status: number;
  code: string;
  params: object | null;
}

export interface ServerLimits {
  /** Bytes per file. */
  maxFileSize: number;
  /** Files in one request. */
  maxFiles: number;
  /** Bytes for the whole request, all files together. */
  maxRequestSize: number;
  /** Refuse an upload when the disk has less than this free. */
  minFreeSpace: number;
  /**
   * Pixels a picture may declare. The client refuses these too, but the
   * client is not what an attacker uses. 0 turns the check off.
   */
  maxPixels: number;
  /**
   * Bytes a second one upload may take. 0, the default, is no limit.
   *
   * Per upload rather than per server: with `maxConcurrent` in flight the
   * total can reach that many times this figure.
   */
  maxBytesPerSecond: number;
  /**
   * What one client may upload over a stretch of time, counted across
   * requests. `maxFiles` and `maxRequestSize` are limits on one request,
   * which caps little once the widget sends a file per request.
   *
   * Kept in this process's memory: behind two instances the real ceiling
   * is this multiplied by however many are running.
   */
  perClient: {
    /** Files in the window. */
    files?: number;
    /** Bytes in the window. */
    bytes?: number;
    /** How long the window is. 60000 by default. */
    windowMs?: number;
  };
}

export declare const DEFAULT_LIMITS: ServerLimits;
export declare const TEMP_PREFIX: string;

export interface StoredFile {
  /** What it is called on disk, which may differ after a collision. */
  name: string;
  size: number;
  /** Read from the file's own bytes, not from what the client claimed. */
  type: string;
  /** Absolute path. Never sent to a client. */
  path: string;
}

export interface UploadServiceOptions {
  /** The one directory files may land in. */
  root: string;
  /** MIME types allowed; empty means every image format the sniffer knows. */
  accept?: string[];
  /** SVG can carry script; off by default. */
  allowSvg?: boolean;
  onConflict?: 'rename' | 'refuse' | 'overwrite';
  limits?: Partial<ServerLimits>;
  /** Choose the stored name yourself, e.g. a uuid instead of the user's name. */
  rename?: (name: string, meta: { type: string; identity: string | null }) => string;
  /** Off unless set; see {@link ScanOptions}. */
  scan?: ScanOptions;
}

/**
 * Writing uploaded images to a directory.
 *
 * Knows nothing about HTTP, so it can be used from a framework that parses the
 * multipart body itself.
 */
export declare class UploadService {
  constructor(options: UploadServiceOptions);
  readonly root: string | null;
  readonly limits: ServerLimits;
  init(): Promise<this>;
  capabilities(): { accept: string[]; allowSvg: boolean; limits: ServerLimits };
  store(rawName: string, stream: Readable): Promise<StoredFile>;
  /** Remove temp files left by an interrupted process. */
  sweepTemp(olderThanMs?: number): Promise<number>;
}

export interface UploadFailure {
  name: string;
  code: string;
  error: string;
  params: object | null;
}

export interface UploadResult {
  uploaded: Array<{
    name: string;
    original: string;
    size: number;
    type: string;
    /** Present only when `sessions` is configured: who it was filed under. */
    owner?: string;
  }>;
  failures: UploadFailure[];
  fields: Record<string, string>;
  /** Present only when `sessions` is configured. */
  owner?: string;
}

/** What a screening check may answer. Anything else counts as a failure. */
export type ScanVerdict = 'clean' | 'malicious' | 'unknown';

/**
 * Optional malware screening, before a file is given its real name.
 *
 * Leave the whole block out and nothing is screened, which is the default.
 *
 * The built-in service is a **hash lookup**: only a SHA-256 leaves the server,
 * never the file. That decides what it can do — it recognises malware somebody
 * has already reported, and a brand-new sample is unknown to it.
 */
export interface ScanOptions {
  /** The built-in lookup. Requires `apiKey`. */
  service?: 'virustotal';
  /** Your VirusTotal key. Never sent anywhere but to VirusTotal. */
  apiKey?: string;
  /** Any other scanner: ClamAV over a socket, an internal service, anything. */
  check?: (
    file: { sha256: string; name: string; type: string; size: number },
    signal: AbortSignal
  ) => Promise<{ verdict: ScanVerdict; detail?: object | null }>;
  /**
   * What to do with a file the database has never seen. `accept` by default:
   * almost nothing an ordinary person uploads has ever been reported.
   */
  onUnknown?: 'accept' | 'reject';
  /**
   * What to do when the check itself fails — down, rate-limited, timed out.
   * `reject` by default: accepting would mean believing you are protected
   * while you are not, and that failure is silent.
   */
  onError?: 'accept' | 'reject';
  /** How long one check may take. 5000 ms by default. */
  timeoutMs?: number;
}

/**
 * Filing uploads under whatever the host already uses to tell visitors apart.
 *
 * Leave the whole block out and the endpoint knows nothing about sessions,
 * which is how it behaves by default.
 */
export interface SessionOptions {
  /** The id, read from a request the host's own middleware has prepared. */
  identify: (req: UploadRequest) => string | null | Promise<string | null>;
  /**
   * `directory` (the default) gives each session its own subdirectory of
   * `root`, so two visitors uploading `photo.png` do not meet. The id has to be
   * a usable folder name; one that is not is refused rather than repaired.
   *
   * `label` keeps one flat directory and only reports who uploaded what, for a
   * host that records ownership itself. Any id will do there.
   */
  scope?: 'directory' | 'label';
  /** `true` by default: a request with no session is refused with 403. */
  required?: boolean;
}

/** The request as the routes see it. */
export interface UploadRequest extends IncomingMessage {
  path: string;
  query: Record<string, string | string[]>;
  body: any;
}

/**
 * Where finished files go.
 *
 * Leave it out and they stay on local disk under `root`, which is what every
 * version before this one did. A backend is handed a file that has already
 * been read, checked and screened — none of those questions can be asked
 * about bytes that have already left.
 */
export interface UploadStorage {
  /**
   * Send one finished file. Returns what it is called and where it can be read.
   *
   * Unless `about.overwrite`, a name that is taken must be refused by throwing
   * an `UploadError(409, 'EXISTS', …)`: the next name is then tried. Deciding
   * from `exists()` alone cannot hold, since another upload fits between the
   * question and the answer.
   */
  put(
    name: string,
    path: string,
    about: { type: string; size: number; sha256: string; overwrite?: boolean }
  ): Promise<{ key?: string; url?: string; etag?: string | null }>;
  /** A look ahead that saves sending a body which would be refused. Optional. */
  exists?(name: string): Promise<boolean>;
}

export interface S3StorageOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary credentials. */
  sessionToken?: string;
  /** For anything S3-compatible: R2, MinIO, Spaces. */
  endpoint?: string;
  /** A folder inside the bucket. */
  prefix?: string;
  /** e.g. 'public-read'. Left out, the bucket's own policy decides. */
  acl?: string;
  /** How to build the URL handed back, for a bucket served through a CDN. */
  publicUrl?: (key: string) => string;
  /**
   * Claim a key atomically with `If-None-Match: *`, so two uploads of one name
   * cannot write over each other. True by default; turn it off only for a
   * service that rejects the header, and know that the race returns with it.
   */
  conditionalWrites?: boolean;
}

/** An S3 backend that signs its own requests; no SDK is involved. */
export declare function createQuota(
  config: { files: number; bytes: number; windowMs: number },
  now?: () => number
): {
  spent(key: string): { files: number; bytes: number };
  allows(key: string, bytes: number): boolean;
  take(key: string, bytes: number): void;
  sweep(): number;
  readonly size: number;
};
export declare function clientKey(req: UploadRequest, identity: string | null): string;

export declare function createS3Storage(options: S3StorageOptions): UploadStorage;

export interface UploadHandlerOptions extends UploadServiceOptions {
  /**
   * Prefix to strip from the URL when the host does not rewrite `req.url` —
   * AdonisJS, Fastify and bare `node:http` do not. Express does.
   */
  basePath?: string;
  /** Form field to read; `images[]` by default — what the widget posts under. */
  field?: string;
  /** Uploads in flight at once; beyond that, 503. */
  maxConcurrent?: number;
  /**
   * Origins allowed to post. Defaults to same-origin only. `false` disables the
   * check — only when the host has its own CSRF defence.
   */
  allowedOrigins?: string[] | ((origin: string, req: UploadRequest) => boolean) | false;
  /** Called before the body is read; return false to reject with 403. */
  authorize?: (
    req: UploadRequest,
    context: { route: string }
  ) => boolean | Promise<boolean>;
  /** Off unless set; see {@link SessionOptions}. */
  sessions?: SessionOptions;
  /** Off unless set; see {@link UploadStorage}. */
  storage?: UploadStorage;
  onWarning?: (message: string, detail?: unknown) => void;
}

/**
 * A mounted upload endpoint.
 *
 * The `(req, res, next)` shape is what Express accepts as middleware and what
 * any Node framework can hand its raw objects to.
 */
export interface UploadHandler {
  (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): Promise<boolean>;
  /** The service backing this handler. */
  service: UploadService;
  paths(): Array<{ method: string; path: string }>;
}

export declare function createUploadHandler(options: UploadHandlerOptions): UploadHandler;

/** What a file actually is, decided from its leading bytes. */
export declare const KNOWN_IMAGE_TYPES: string[];
export declare const SNIFF_BYTES: number;
export declare const IMAGE_SIGNATURES: ReadonlyArray<{
  type: string;
  ext: string;
  offset: number;
  bytes?: number[];
  ascii?: string;
}>;
export declare function sniffImage(head: Buffer | Uint8Array): { type: string; ext: string } | null;
export declare function looksLikeSvg(head: Buffer | Uint8Array): boolean;

/** Turning a name the browser sent into a name on disk. */
export declare function baseName(raw: string): string;
export declare const DIMENSION_BYTES: number;
/** What a file says its size is, read from its header. Null when unreadable. */
export declare function readDimensions(
  head: Uint8Array,
  type: string
): { width: number; height: number } | null;
export declare function readDimensionsWithSeek(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  type: string
): Promise<{ width: number; height: number } | null>;

export declare function assertValidName(raw: string): string;
export declare function resolveInside(root: string, name: string): string;
export declare function withSuffix(name: string, n: number): string;

export type { ScanOptions, ScanVerdict, SessionOptions };
export declare function createRouter(options?: {
  basePath?: string;
  jsonLimit?: (req: UploadRequest) => number;
}): UploadHandler;
export declare function parseSize(value: string | number, fallback?: number): number;
export declare function parseQuery(params: URLSearchParams): Record<string, string | string[]>;

export default createUploadHandler;
