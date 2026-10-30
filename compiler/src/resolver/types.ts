/**
 * Resolver SPI.
 *
 * A backend answers two queries about record ids:
 *
 * - `exists` is the compile-time check. An unknown id returns false.
 * - `lookup` is the runtime shape query. An unknown id returns null.
 *
 * The SpeckDL `&` sigil is syntax. `evidence &backup/exampleco/2026-09-19`
 * resolves the id `backup/exampleco/2026-09-19`.
 *
 * This module does not talk to the network. An out-of-tree backend, including
 * a Greybeard Core adapter, implements `ResolverBackend` and is passed to
 * `ResolverRegistry.register`. See `index.ts` for the plug-in point.
 */

export type ResolverErrorCode =
  | 'malformed'
  | 'unknown_backend'
  | 'duplicate_backend'
  | 'backend_error';

export class ResolverError extends Error {
  readonly code: ResolverErrorCode;
  readonly backendName?: string;
  readonly recordId?: string;

  constructor(
    message: string,
    options: {
      code: ResolverErrorCode;
      backendName?: string;
      recordId?: string;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ResolverError';
    this.code = options.code;
    this.backendName = options.backendName;
    this.recordId = options.recordId;
  }
}

/** Shape returned by a runtime lookup. */
export interface RecordShape {
  /** Registry key, with no leading `&`. */
  id: string;
  /** Measurement class this record belongs to. */
  measurementClass: string;
  /**
   * Other fields the backend knows. Static manifests have none.
   * Callers receive a shallow copy.
   */
  attributes: Record<string, unknown>;
}

/**
 * One record store. `name` is the key the registry uses.
 *
 * `exists` and `lookup` must not throw for an unknown id. They return
 * `false` and `null`. Throw `ResolverError` with code `malformed` when the
 * store itself is unreadable, or any other error when the store fails.
 * The registry wraps a foreign error as `backend_error` and rethrows a
 * `ResolverError` unchanged.
 */
export interface ResolverBackend {
  readonly name: string;
  exists(id: string): boolean;
  lookup(id: string): RecordShape | null;
}

/** In-process registry of backends. Construction does not load any backend. */
export interface ResolverRegistry {
  register(backend: ResolverBackend): void;
  /** Registered names, sorted. */
  backends(): readonly string[];
  exists(backendName: string, id: string): boolean;
  lookup(backendName: string, id: string): RecordShape | null;
}
