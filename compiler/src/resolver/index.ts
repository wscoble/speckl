/**
 * Resolver plug-in point.
 *
 * Import this module and register a backend. The compiler does not scan
 * packages, read a config file, or open a network connection to find one.
 * A Greybeard Core adapter, if any, lives outside this repository and
 * registers the same way as the sample below. Nothing in the parser or the
 * IR imports this module. Task 2 is what will call it during compilation.
 *
 * In this repository:
 *
 * ```ts
 * import {
 *   createResolverRegistry,
 *   staticManifestBackend,
 *   filesystemBackend,
 *   type ResolverBackend,
 * } from './resolver/index.js';
 * ```
 *
 * Speckl is not published to the npm registry. The export name
 * `speckl/resolver` is for an install from a checkout or a packed tarball:
 *
 * ```ts
 * import {
 *   createResolverRegistry,
 *   staticManifestBackend,
 *   type ResolverBackend,
 *   type RecordShape,
 * } from 'speckl/resolver';
 *
 * const external: ResolverBackend = {
 *   name: 'exampleco-records',
 *   exists(id) {
 *     return id === 'backup/exampleco/2026-09-19';
 *   },
 *   lookup(id) {
 *     if (id !== 'backup/exampleco/2026-09-19') return null;
 *     const shape: RecordShape = {
 *       id,
 *       measurementClass: 'backup.restore_probe',
 *       attributes: {},
 *     };
 *     return shape;
 *   },
 * };
 *
 * const registry = createResolverRegistry();
 * registry.register(external);
 * registry.register(staticManifestBackend('{ "incident/exampleco-mirror-404": "sync.upstream" }'));
 * ```
 *
 * `exists(id)` is the compile-time query and returns a boolean.
 * `lookup(id)` is the runtime query and returns a `RecordShape` or null.
 * Both are synchronous. An unknown but well-formed id is `false` / `null`.
 * A malformed id, including a leading `&` or a non-string, is `malformed`.
 * A Promise, a non-boolean `exists`, or a `lookup` shape that does not
 * match the query is `backend_error`. A foreign throw is `backend_error`
 * with the original error as `cause`. A backend may throw `malformed` for
 * its own store. It cannot forge `unknown_backend` in another backend's name.
 *
 * Reference backends in this package:
 *
 * - `staticManifestBackend` — JSON object, record id to measurement class.
 *   Tests and offline compiles should use this one.
 * - `filesystemBackend` — a directory of Markdown files with YAML frontmatter
 *   (`id`, `measurement_class` or `measurementClass`).
 *
 * Record ids do not include the `&` sigil.
 */

export { assertRecordId } from './record-id.js';
export { createResolverRegistry } from './registry.js';
export { filesystemBackend } from './filesystem.js';
export type { FilesystemBackendOptions } from './filesystem.js';
export {
  staticManifestBackend,
  staticManifestBackendFromFile,
} from './static-manifest.js';
export type { StaticManifestOptions } from './static-manifest.js';
export { ResolverError } from './types.js';
export type {
  RecordShape,
  ResolverBackend,
  ResolverErrorCode,
  ResolverRegistry,
} from './types.js';
