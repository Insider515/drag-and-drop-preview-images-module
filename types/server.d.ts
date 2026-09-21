/**
 * Type definitions for `drag-and-drop-preview-images-module/server`.
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
  rename?: (name: string, meta: { type: string }) => string;
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
  uploaded: Array<{ name: string; original: string; size: number; type: string }>;
  failures: UploadFailure[];
  fields: Record<string, string>;
}

/** The request as the routes see it. */
export interface UploadRequest extends IncomingMessage {
  path: string;
  query: Record<string, string | string[]>;
  body: any;
}

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
export declare function assertValidName(raw: string): string;
export declare function resolveInside(root: string, name: string): string;
export declare function withSuffix(name: string, n: number): string;

export declare function createRouter(options?: {
  basePath?: string;
  jsonLimit?: (req: UploadRequest) => number;
}): UploadHandler;
export declare function parseSize(value: string | number, fallback?: number): number;
export declare function parseQuery(params: URLSearchParams): Record<string, string | string[]>;

export default createUploadHandler;
