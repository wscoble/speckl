/**
 * Deep copy that never assigns through `[[Set]]`.
 *
 * A normal `{...obj}` or `out[key] = value` turns a YAML `__proto__` key
 * into the object's prototype. `Object.create(null)` plus own-property
 * definition keeps `__proto__` as data.
 *
 * Each object is copied once. A cycle, a node seen again before its copy is
 * finished, throws. A later visit of an already-copied object reuses that
 * copy, so a DAG is not expanded and changing one branch of the copy is
 * visible on the other. YAML aliases are rejected before a Markdown record
 * is copied, so a record loaded from the filesystem does not share nodes.
 * The node budget stops a wide tree from exhausting the heap. Map and Set
 * values are copied as a plain object and an array. Symbol keys are
 * rejected rather than dropped.
 */

const IN_PROGRESS = Symbol('plain-copy-in-progress');

/**
 * Distinct objects plainCopy will walk before it throws. A record file is
 * also limited to 1 MiB. 100_000 nodes covers a long list without letting a
 * hostile tree exhaust the heap.
 */
export const MAX_COPY_NODES = 100_000;

export class CopyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopyLimitError';
  }
}

export function plainCopy(value: unknown): unknown {
  return copyValue(value, new Map<object, unknown>(), { nodes: 0 });
}

export function plainRecord(value: unknown): Record<string, unknown> {
  const copied = plainCopy(value);
  if (copied === null || typeof copied !== 'object' || Array.isArray(copied)) {
    throw new CopyLimitError('plainRecord expected a mapping');
  }
  return copied as Record<string, unknown>;
}

function copyValue(
  value: unknown,
  seen: Map<object, unknown>,
  budget: { nodes: number },
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());

  const prior = seen.get(value);
  if (prior === IN_PROGRESS) {
    throw new CopyLimitError('cyclic value');
  }
  if (prior !== undefined) return prior;

  budget.nodes += 1;
  if (budget.nodes > MAX_COPY_NODES) {
    throw new CopyLimitError(`value has more than ${MAX_COPY_NODES} nodes`);
  }
  seen.set(value, IN_PROGRESS);

  let out: unknown;
  if (value instanceof Map) {
    const record = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of value) {
      if (typeof key !== 'string' && typeof key !== 'number') {
        throw new CopyLimitError('map key must be a string or a number');
      }
      define(record, String(key), copyValue(child, seen, budget));
    }
    out = record;
  } else if (value instanceof Set) {
    const items: unknown[] = [];
    for (const child of value) items.push(copyValue(child, seen, budget));
    out = items;
  } else if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const child of value) items.push(copyValue(child, seen, budget));
    out = items;
  } else {
    const record = Object.create(null) as Record<string, unknown>;
    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(value);
    } catch (err) {
      throw err instanceof Error ? err : new CopyLimitError(String(err));
    }
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new CopyLimitError('symbol key');
      }
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[key];
      } catch (err) {
        throw err instanceof Error ? err : new CopyLimitError(String(err));
      }
      define(record, key, copyValue(child, seen, budget));
    }
    out = record;
  }
  seen.set(value, out);
  return out;
}

function define(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
