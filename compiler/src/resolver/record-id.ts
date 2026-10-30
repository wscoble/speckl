import { ResolverError } from './types.js';

/**
 * Canonical record ids.
 *
 * The form is NFKC, then a fold of the Cyrillic and Greek letters that use
 * a Latin glyph and that NFKC does not already fold (а/е/о/р/с/у/х/і and
 * the capitals, plus the Greek lookalikes below). Two ids that fold to the
 * same string are the same key. NFC and NFD spellings fold together because
 * NFKC composes them. The ligature ﬁ folds to fi. This is not the whole
 * Unicode confusables table.
 *
 * A slash separates segments. A segment is not empty, `.`, or `..`, so
 * `a//b`, `a/`, `/a`, `/`, `.`, `..`, and `a/../b` are rejected. Ids are
 * map keys, not paths. The segment rule is what keeps those spellings from
 * being two keys.
 *
 * A segment is letters, numbers, and `.` `_` `~` `+` `-`. A mark (`\p{M}`)
 * is allowed only immediately after a letter, so a Devanagari vowel sign is
 * legal and a mark cannot stand alone. Ids are case-sensitive.
 *
 * The `&` sigil is SpeckDL syntax, not part of the id. Whitespace, controls,
 * and any other character are rejected.
 */
const SEGMENT = /^(?:(?:\p{L}\p{M}*)|\p{N}|[._~+-])+$/u;

/** Backend names are tokens. Slashes are for record ids, not for names. */
const NAME_PATTERN = /^[\p{L}\p{N}._~+-]+$/u;

const CONTROL = /[\u0000-\u001F\u007F]/;

/**
 * Cyrillic and Greek letters that share a Latin glyph. NFKC does not fold
 * these. The value is the Latin letter stored in the canonical id.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  '\u0430': 'a', '\u0410': 'A',
  '\u0435': 'e', '\u0415': 'E',
  '\u043e': 'o', '\u041e': 'O',
  '\u0440': 'p', '\u0420': 'P',
  '\u0441': 'c', '\u0421': 'C',
  '\u0443': 'y', '\u0423': 'Y',
  '\u0445': 'x', '\u0425': 'X',
  '\u0456': 'i', '\u0406': 'I',
  '\u0458': 'j', '\u0408': 'J',
  '\u0455': 's', '\u0405': 'S',
  '\u041d': 'H', '\u041a': 'K', '\u041c': 'M', '\u0412': 'B', '\u0422': 'T',
  '\u03b1': 'a', '\u0391': 'A',
  '\u03bf': 'o', '\u039f': 'O',
  '\u03b5': 'e', '\u0395': 'E',
  '\u03b9': 'i', '\u0399': 'I',
  '\u03ba': 'k', '\u039a': 'K',
  '\u03c1': 'p', '\u03a1': 'P',
  '\u03c4': 't', '\u03a4': 'T',
  '\u03c5': 'u', '\u03a5': 'Y',
  '\u03c7': 'x', '\u03a7': 'X',
};

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
    normalized = foldId(id.normalize('NFKC'));
  } catch (err) {
    if (err instanceof ResolverError) throw err;
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
  if (/\s/u.test(normalized) || CONTROL.test(normalized)) {
    throw new ResolverError(
      `${where}: record id "${normalized}" must not contain whitespace or control characters`,
      { code: 'malformed', recordId: normalized },
    );
  }
  assertSegments(normalized, where);
  return normalized;
}

/** A measurement class is a non-empty string with no control characters. */
export function assertMeasurementClass(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResolverError(`${where}: measurement class must be a non-empty string`, {
      code: 'malformed',
    });
  }
  const trimmed = value.trim();
  if (CONTROL.test(trimmed)) {
    throw new ResolverError(
      `${where}: measurement class must not contain control characters`,
      { code: 'malformed' },
    );
  }
  return trimmed;
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

function foldId(id: string): string {
  let out = '';
  for (const ch of id) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

function assertSegments(id: string, where: string): void {
  if (id.startsWith('/') || id.endsWith('/') || id.includes('//')) {
    throw new ResolverError(
      `${where}: record id "${id}" has an empty path segment`,
      { code: 'malformed', recordId: id },
    );
  }
  for (const segment of id.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new ResolverError(
        `${where}: record id "${id}" has a "." or ".." segment`,
        { code: 'malformed', recordId: id },
      );
    }
    if (!SEGMENT.test(segment)) {
      throw new ResolverError(
        `${where}: record id "${id}" contains a character the registry does not allow`,
        { code: 'malformed', recordId: id },
      );
    }
  }
}
