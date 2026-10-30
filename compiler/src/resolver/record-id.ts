import { ResolverError } from './types.js';

/**
 * Record ids, after Unicode NFC normalization.
 *
 * Allowed: letters, numbers, and the path punctuation `.` `_` `~` `/` `+` `-`.
 * The `&` sigil is SpeckDL syntax, not part of the id. Whitespace, controls,
 * and format characters (zero-width, bidi marks, BOM) are rejected so two
 * ids cannot look alike and still be distinct keys. NFC and NFD spellings
 * of the same id are the same key.
 */
const ID_PATTERN = /^[\p{L}\p{N}._~/+-]+$/u;

/** Backend names are tokens. Slashes are for record ids, not for names. */
const NAME_PATTERN = /^[\p{L}\p{N}._~+-]+$/u;

/**
 * Return the canonical record id, or throw `malformed`.
 * `id` is checked at runtime because a backend or a YAML value may not be a string.
 */
export function assertRecordId(id: unknown, where: string): string {
  if (typeof id !== 'string') {
    throw new ResolverError(`${where}: record id must be a string`, { code: 'malformed' });
  }
  let normalized: string;
  try {
    normalized = id.normalize('NFC');
  } catch (err) {
    throw new ResolverError(`${where}: record id is not valid Unicode`, {
      code: 'malformed',
      cause: err,
    });
  }
  if (normalized.trim() === '') {
    throw new ResolverError(`${where}: record id must be a non-empty string`, {
      code: 'malformed',
    });
  }
  if (normalized.startsWith('&')) {
    throw new ResolverError(
      `${where}: record id "${normalized}" includes the & sigil; store the id without it`,
      { code: 'malformed', recordId: normalized },
    );
  }
  if (/\s/u.test(normalized)) {
    throw new ResolverError(
      `${where}: record id "${normalized}" must not contain whitespace`,
      { code: 'malformed', recordId: normalized },
    );
  }
  if (!ID_PATTERN.test(normalized)) {
    throw new ResolverError(
      `${where}: record id "${normalized}" contains a character the registry does not allow`,
      { code: 'malformed', recordId: normalized },
    );
  }
  return normalized;
}

/** Canonical backend name. Whitespace variants are `malformed`, not a second registration. */
export function assertBackendName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new ResolverError('resolver backend needs a string name', { code: 'malformed' });
  }
  let normalized: string;
  try {
    normalized = name.normalize('NFC');
  } catch (err) {
    throw new ResolverError('resolver backend name is not valid Unicode', {
      code: 'malformed',
      cause: err,
    });
  }
  if (normalized.trim() === '' || /\s/u.test(normalized) || !NAME_PATTERN.test(normalized)) {
    throw new ResolverError(
      `resolver backend name "${name}" must be a non-empty token with no whitespace`,
      { code: 'malformed' },
    );
  }
  return normalized;
}
