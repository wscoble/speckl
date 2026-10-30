import { plainCopy } from './plain.js';
import { assertBackendName, assertRecordId } from './record-id.js';
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
    const name = assertBackendName(backend.name);
    if (typeof backend.exists !== 'function' || typeof backend.lookup !== 'function') {
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
    const value = this.call(name, recordId, (backend) => backend.exists(recordId));
    if (typeof value !== 'boolean') {
      this.refuseForeign(value, name, recordId, 'exists() must return a boolean');
    }
    return value;
  }

  lookup(backendName: string, id: string): RecordShape | null {
    const name = assertBackendName(backendName);
    const recordId = assertRecordId(id, 'query');
    const value = this.call(name, recordId, (backend) => backend.lookup(recordId));
    if (value === null) return null;
    if (isThenable(value) || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
      this.refuseForeign(value, name, recordId, 'lookup() must return a record shape or null');
    }
    const shape = value as RecordShape;
    if (shape.id !== recordId) {
      throw new ResolverError(
        `resolver backend ${name} returned id "${String(shape.id)}" for "${recordId}"`,
        { code: 'backend_error', backendName: name, recordId },
      );
    }
    if (typeof shape.measurementClass !== 'string' || shape.measurementClass.trim() === '') {
      throw new ResolverError(
        `resolver backend ${name} returned an empty measurement class for "${recordId}"`,
        { code: 'backend_error', backendName: name, recordId },
      );
    }
    const attributes = shape.attributes === undefined ? {} : shape.attributes;
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
      throw new ResolverError(
        `resolver backend ${name} returned attributes that are not a mapping for "${recordId}"`,
        { code: 'backend_error', backendName: name, recordId },
      );
    }
    return {
      id: recordId,
      measurementClass: shape.measurementClass.trim(),
      attributes: plainCopy(attributes) as Record<string, unknown>,
    };
  }

  private refuseForeign(value: unknown, backendName: string, recordId: string, why: string): never {
    if (isThenable(value)) settleQuietly(value);
    throw new ResolverError(
      `resolver backend ${backendName} failed for "${recordId}": ${why}`,
      { code: 'backend_error', backendName, recordId },
    );
  }

  private call<T>(backendName: string, id: string, fn: (backend: ResolverBackend) => T): T {
    const backend = this.byName.get(backendName);
    if (!backend) {
      throw new ResolverError(`no resolver backend registered: ${backendName}`, {
        code: 'unknown_backend',
        backendName,
        recordId: id,
      });
    }
    try {
      return fn(backend);
    } catch (err) {
      throw this.wrap(err, backendName, id);
    }
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
