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
    if (typeof backend.name !== 'string' || backend.name.trim() === '') {
      throw new ResolverError('resolver backend needs a non-empty name', { code: 'malformed' });
    }
    if (typeof backend.exists !== 'function' || typeof backend.lookup !== 'function') {
      throw new ResolverError(
        `resolver backend ${backend.name} must implement exists and lookup`,
        { code: 'malformed', backendName: backend.name },
      );
    }
    if (this.byName.has(backend.name)) {
      throw new ResolverError(`resolver backend already registered: ${backend.name}`, {
        code: 'duplicate_backend',
        backendName: backend.name,
      });
    }
    this.byName.set(backend.name, backend);
  }

  backends(): readonly string[] {
    return [...this.byName.keys()].sort();
  }

  exists(backendName: string, id: string): boolean {
    return this.call(backendName, id, (backend) => backend.exists(id));
  }

  lookup(backendName: string, id: string): RecordShape | null {
    return this.call(backendName, id, (backend) => backend.lookup(id));
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
      if (err instanceof ResolverError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new ResolverError(
        `resolver backend ${backendName} failed for "${id}": ${detail}`,
        { code: 'backend_error', backendName, recordId: id, cause: err },
      );
    }
  }
}

/** Empty registry. Backends are added with `register`. Nothing is loaded. */
export function createResolverRegistry(): ResolverRegistry {
  return new Registry();
}
