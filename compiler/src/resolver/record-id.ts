import { ResolverError } from './types.js';

/**
 * Canonical record ids.
 *
 * The stored form is NFKC and nothing else. NFC and NFD spellings of the
 * same id are one key, and the ligature ﬁ is `fi`, because NFKC does that.
 * Backends are queried with that NFKC string. There is no homoglyph fold:
 * Cyrillic `ах` is not Latin `ax`, and an all-Cyrillic id is stored unchanged.
 *
 * Each `/` segment must be a single script, the UTS #39 rule. Common and
 * Inherited characters (digits, the punctuation below, combining marks that
 * are Inherited) do not count as a script. A segment that mixes scripts,
 * such as Cyrillic `с` plus Latin `op`, is rejected. A mark (`\p{M}`) is
 * allowed only immediately after a letter.
 *
 * A segment is not empty, `.`, or `..`, so `a//b`, `a/`, `/a`, `/`, `.`,
 * `..`, and `a/../b` are rejected. Ids are map keys, not paths. They are
 * case-sensitive.
 *
 * The `&` sigil is SpeckDL syntax, not part of the id. Whitespace, controls,
 * and any other character are rejected.
 */
const SEGMENT = /^(?:(?:\p{L}\p{M}*)|\p{N}|[._~+-])+$/u;

/** Backend names are tokens. Slashes are for record ids, not for names. */
const NAME_PATTERN = /^[\p{L}\p{N}._~+-]+$/u;

const CONTROL = /[\u0000-\u001F\u007F]/;

const COMMON = /^\p{Script=Common}$/u;
const INHERITED = /^\p{Script=Inherited}$/u;

/**
 * Scripts a record id may use. A character that matches none of these and is
 * not Common or Inherited is its own script, so it cannot hide inside another.
 */
const SCRIPT_NAMES = [
  'Latin', 'Cyrillic', 'Greek', 'Hebrew', 'Arabic', 'Devanagari', 'Bengali',
  'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam',
  'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Georgian', 'Hangul', 'Ethiopic',
  'Cherokee', 'Canadian_Aboriginal', 'Ogham', 'Runic', 'Khmer', 'Mongolian',
  'Hiragana', 'Katakana', 'Bopomofo', 'Han', 'Yi', 'Armenian', 'Coptic',
  'Gothic', 'Sinhala', 'Thaana', 'Syriac', 'Tagalog', 'Tai_Le', 'Tai_Tham',
  'Tai_Viet', 'Tifinagh', 'Vai', 'Limbu', 'Buginese', 'Balinese', 'Sundanese',
  'Batak', 'Lepcha', 'Ol_Chiki', 'Cham', 'Meetei_Mayek', 'Javanese',
] as const;

const SCRIPT_PATTERNS = new Map<string, RegExp>(
  SCRIPT_NAMES.map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')]),
);

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
    normalized = id.normalize('NFKC');
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
    if (scriptsIn(segment).size > 1) {
      throw new ResolverError(
        `${where}: record id "${id}" mixes scripts in a segment`,
        { code: 'malformed', recordId: id },
      );
    }
  }
}

function scriptsIn(segment: string): Set<string> {
  const scripts = new Set<string>();
  for (const ch of segment) {
    const script = scriptOf(ch);
    if (script !== null) scripts.add(script);
  }
  return scripts;
}

function scriptOf(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp <= 0x7f) {
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'Latin';
    return null;
  }
  if (COMMON.test(ch) || INHERITED.test(ch)) return null;
  for (const [name, pattern] of SCRIPT_PATTERNS) {
    if (pattern.test(ch)) return name;
  }
  return `U+${cp.toString(16)}`;
}
