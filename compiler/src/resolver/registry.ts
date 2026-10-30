import { plainCopy } from './plain.js';
import { assertBackendName, assertMeasurementClass, assertRecordId } from './record-id.js';
import {
  ResolverError,
  type RecordShape,
  type ResolverBackend,
  type ResolverRegistry,
} from './types.js';

class Registry implements ResolverRegistry {
  private readonly byName = new Map<string, ResolverBackend>();

  register(backend: ResolverBackend): void {
    if (backend === null || typeof backend !== 'object') {
      throw new ResolverError('resolver backend must be an object', { code: 'malformed' });
    }
    let name: string;
    let exists: unknown;
    let lookup: unknown;
    try {
      name = assertBackendName(backend.name);
      exists = backend.exists;
      lookup = backend.lookup;
    } catch (err) {
      if (err instanceof ResolverError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new ResolverError(`resolver backend registration failed: ${detail}`, {
        code: 'malformed',
        cause: err,
      });
    }
    if (typeof exists !== 'function' || typeof lookup !== 'function') {
      throw new ResolverError(
        `resolver backend ${name} must implement exists and lookup`,
        { code: 'malformed', backendName: name },
      );
    }
    if (this.byName.has(name)) {
      throw new ResolverError(`resolver backend already registered: ${name}`, {
        code: 'duplicate_backend',
        backendName: name,
      });
    }
    this.byName.set(name, backend);
  }

  backends(): readonly string[] {
    return [...this.byName.keys()].sort();
  }

  exists(backendName: string, id: string): boolean {
    const name = assertBackendName(backendName);
    const recordId = assertRecordId(id, 'query');
    const backend = this.backend(name, recordId);
    try {
      const value = backend.exists(recordId);
      if (isThenable(value)) {
        settleQuietly(value);
        throw new Error('exists() returned a Promise; the SPI is synchronous');
      }
      if (typeof value !== 'boolean') {
        throw new Error('exists() must return a boolean');
      }
      return value;
    } catch (err) {
      throw this.wrap(err, name, recordId);
    }
  }

  lookup(backendName: string, id: string): RecordShape | null {
    const name = assertBackendName(backendName);
    const recordId = assertRecordId(id, 'query');
    const backend = this.backend(name, recordId);
    try {
      const value = backend.lookup(recordId);
      return this.shapeOf(value, recordId);
    } catch (err) {
      throw this.wrap(err, name, recordId);
    }
  }

  private backend(backendName: string, id: string): ResolverBackend {
    const backend = this.byName.get(backendName);
    if (!backend) {
      throw new ResolverError(`no resolver backend registered: ${backendName}`, {
        code: 'unknown_backend',
        backendName,
        recordId: id,
      });
    }
    return backend;
  }

  private shapeOf(value: unknown, recordId: string): RecordShape | null {
    if (isThenable(value)) {
      settleQuietly(value);
      throw new Error('lookup() returned a Promise; the SPI is synchronous');
    }
    if (value === null) return null;
    if (value === undefined || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('lookup() must return a record shape or null');
    }
    const shape = value;
    if (!Object.hasOwn(shape, 'id') || !Object.hasOwn(shape, 'measurementClass')) {
      throw new Error('lookup() must return own id and measurementClass properties');
    }
    const id = (shape as { id: unknown }).id;
    const measurementClass = (shape as { measurementClass: unknown }).measurementClass;
    if (id !== recordId) {
      throw new Error(`lookup() returned id "${String(id)}" for "${recordId}"`);
    }
    let measurement: string;
    try {
      measurement = assertMeasurementClass(measurementClass, 'lookup');
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    const attributes = Object.hasOwn(shape, 'attributes')
      ? (shape as { attributes: unknown }).attributes
      : {};
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw new Error(`lookup() returned attributes that are not a mapping for "${recordId}"`);
    }
    return {
      id: recordId,
      measurementClass: measurement,
      attributes: plainCopy(attributes) as Record<string, unknown>,
    };
  }

  /**
   * A backend may throw `malformed` for its own store. It may not emit
   * registry codes, and it may not name a different backend. Those throws
   * become `backend_error` attributed to the backend that was called.
   */
  private wrap(err: unknown, backendName: string, id: string): ResolverError {
    if (
      err instanceof ResolverError
      && err.code === 'malformed'
      && (err.backendName === undefined || err.backendName === backendName)
    ) {
      return err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    return new ResolverError(
      `resolver backend ${backendName} failed for "${id}": ${detail}`,
      { code: 'backend_error', backendName, recordId: id, cause: err },
    );
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

function settleQuietly(value: PromiseLike<unknown>): void {
  try {
    Promise.resolve(value).then(() => undefined, () => undefined);
  } catch {
    // A then() that throws synchronously has already failed the call.
  }
}

/** Empty registry. Backends are added with `register`. Nothing is loaded. */
export function createResolverRegistry(): ResolverRegistry {
  return new Registry();
}
