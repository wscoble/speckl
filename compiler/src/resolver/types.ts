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
   * Callers receive a deep copy. Nested values are not shared with the store.
   */
  attributes: Record<string, unknown>;
}

/**
 * One record store. `name` is the key the registry uses.
 *
 * `exists` and `lookup` are synchronous. They must not throw for an unknown
 * id. They return `false` and `null`. A Promise is not a result: the
 * registry rejects it with `backend_error` so a truthy Promise cannot pass
 * an existence check. A non-boolean `exists` result, or a `lookup` shape
 * whose id or measurement class does not match the query, is also
 * `backend_error`.
 *
 * Throw `ResolverError` with code `malformed` when the store itself is
 * unreadable. The registry lets that through when it names this backend or
 * names none. Any other error, including a forged `unknown_backend`, is
 * wrapped as `backend_error` attributed to this backend.
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
