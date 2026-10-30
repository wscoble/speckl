/**
 * Deep copy that never assigns through `[[Set]]`.
 *
 * A normal `{...obj}` or `out[key] = value` turns a YAML `__proto__` key
 * into the object's prototype. `Object.create(null)` plus own-property
 * definition keeps `__proto__` as data. Nested objects and arrays are copied,
 * so a caller cannot mutate the stored record.
 */
export function plainCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((item) => plainCopy(item));
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    Object.defineProperty(out, key, {
      value: plainCopy((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function plainRecord(value: unknown): Record<string, unknown> {
  const copied = plainCopy(value);
  if (copied === null || typeof copied !== 'object' || Array.isArray(copied)) {
    throw new TypeError('plainRecord expected a mapping');
  }
  return copied as Record<string, unknown>;
}
