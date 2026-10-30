import { ResolverError } from './types.js';

/**
 * Canonical record ids.
 *
 * The stored form is NFKC and nothing else. NFC and NFD spellings of the
 * same id are one key, and the ligature ﬁ is `fi`, because NFKC does that.
 * Backends are queried with that NFKC string. There is no homoglyph fold:
 * Cyrillic `ах` is not Latin `ax`, and an all-Cyrillic id is stored unchanged.
 *
 * Each `/` segment must pass UTS #39's single-script test on
 * Script_Extensions, ignoring Common and Inherited. The augmented sets are
 * allowed: Japanese (Han, Hiragana, Katakana), Korean (Han, Hangul), and
 * Chinese (Han, Bopomofo). Han plus Latin in one segment is rejected on
 * purpose. That is stricter than UTS #39's highly restrictive level, which
 * would allow Latin beside those augmented sets.
 *
 * Which scripts exist depends on this process's ICU (the Node version).
 * A candidate name the engine does not know is ignored. A code point that
 * is a letter, mark, or number, is not Common or Inherited, and matches no
 * known Script_Extensions value is its own script. It does not mix with
 * anything else, including another code point of an unknown script. An
 * older ICU that has not assigned those letters rejects them as
 * non-letters, which is stricter, not looser.
 *
 * Decimal digits do not pick a script. Every decimal digit in a segment
 * must belong to one numbering system, so `2০26` is rejected and
 * `report१२` is kept. U+200C and U+200D are allowed only where IDNA
 * (RFC 5892) allows them, and not as the last character of a segment:
 * after a virama and before another character, or U+200C between joining
 * Arabic letters. The virama set is the ccc=9 / virama / invisible-stacker
 * points shipped below. A virama missing from that set fails closed: a
 * join control after it is rejected. A mark (`\p{M}`) is allowed only
 * immediately after a letter.
 *
 * A segment is not empty, `.`, or `..`, so `a//b`, `a/`, `/a`, `/`, `.`,
 * `..`, and `a/../b` are rejected. Ids are map keys, not paths. They are
 * case-sensitive.
 *
 * The `&` sigil is SpeckDL syntax, not part of the id. Whitespace, controls,
 * and any other character are rejected.
 */
/** Backend names are tokens. Slashes are for record ids, not for names. */
const NAME_PATTERN = /^[\p{L}\p{N}._~+-]+$/u;

const CONTROL = /[\u0000-\u001F\u007F]/;
const COMMON = /^\p{Script=Common}$/u;
const INHERITED = /^\p{Script=Inherited}$/u;

/**
 * Scripts a record id may use. A character that matches none of these and is
 * not Common or Inherited is its own script, so it cannot hide inside another.
 */
/** Every Unicode Script property value. Unknown names are dropped at startup. */
const SCRIPT_NAME_CANDIDATES = [
  'Adlam', 'Ahom', 'Anatolian_Hieroglyphs', 'Arabic', 'Armenian', 'Avestan',
  'Balinese', 'Bamum', 'Bassa_Vah', 'Batak', 'Bengali', 'Bhaiksuki', 'Bopomofo',
  'Brahmi', 'Braille', 'Buginese', 'Buhid', 'Canadian_Aboriginal', 'Carian',
  'Caucasian_Albanian', 'Chakma', 'Cham', 'Cherokee', 'Chorasmian', 'Common',
  'Coptic', 'Cuneiform', 'Cypriot', 'Cypro_Minoan', 'Cyrillic', 'Deseret',
  'Devanagari', 'Dives_Akuru', 'Dogra', 'Duployan', 'Egyptian_Hieroglyphs',
  'Elbasan', 'Elymaic', 'Ethiopic', 'Garay', 'Georgian', 'Glagolitic', 'Gothic',
  'Grantha', 'Greek', 'Gujarati', 'Gunjala_Gondi', 'Gurmukhi', 'Gurung_Khema',
  'Han', 'Hangul', 'Hanifi_Rohingya', 'Hanunoo', 'Hatran', 'Hebrew', 'Hiragana',
  'Imperial_Aramaic', 'Inherited', 'Inscriptional_Pahlavi', 'Inscriptional_Parthian',
  'Javanese', 'Kaithi', 'Kannada', 'Katakana', 'Kawi', 'Kayah_Li', 'Kharoshthi',
  'Khitan_Small_Script', 'Khmer', 'Khojki', 'Khudawadi', 'Kirat_Rai', 'Lao',
  'Latin', 'Lepcha', 'Limbu', 'Linear_A', 'Linear_B', 'Lisu', 'Lycian', 'Lydian',
  'Mahajani', 'Makasar', 'Malayalam', 'Mandaic', 'Manichaean', 'Marchen',
  'Masaram_Gondi', 'Medefaidrin', 'Meetei_Mayek', 'Mende_Kikakui',
  'Meroitic_Cursive', 'Meroitic_Hieroglyphs', 'Miao', 'Modi', 'Mongolian', 'Mro',
  'Multani', 'Myanmar', 'Nabataean', 'Nag_Mundari', 'Nandinagari', 'New_Tai_Lue',
  'Newa', 'Nko', 'Nushu', 'Nyiakeng_Puachue_Hmong', 'Ogham', 'Ol_Chiki', 'Ol_Onal',
  'Old_Hungarian', 'Old_Italic', 'Old_North_Arabian', 'Old_Permic', 'Old_Persian',
  'Old_Sogdian', 'Old_South_Arabian', 'Old_Turkic', 'Old_Uyghur', 'Oriya',
  'Osage', 'Osmanya', 'Pahawh_Hmong', 'Palmyrene', 'Pau_Cin_Hau', 'Phags_Pa',
  'Phoenician', 'Psalter_Pahlavi', 'Rejang', 'Runic', 'Samaritan', 'Saurashtra',
  'Sharada', 'Shavian', 'Siddham', 'SignWriting', 'Sinhala', 'Sogdian',
  'Sora_Sompeng', 'Soyombo', 'Sundanese', 'Sunuwar', 'Syloti_Nagri', 'Syriac',
  'Tagalog', 'Tagbanwa', 'Tai_Le', 'Tai_Tham', 'Tai_Viet', 'Takri', 'Tamil',
  'Tangsa', 'Tangut', 'Telugu', 'Thaana', 'Thai', 'Tibetan', 'Tifinagh',
  'Tirhuta', 'Todhri', 'Toto', 'Tulu_Tigalari', 'Ugaritic', 'Vai', 'Vithkuqi',
  'Wancho', 'Warang_Citi', 'Yezidi', 'Yi', 'Zanabazar_Square',
  'Sidetic', 'Tai_Yo', 'Tolong_Siki', 'Beria_Erfe',
] as const;

const SCRIPT_EXTENSIONS: ReadonlyArray<readonly [string, RegExp]> = SCRIPT_NAME_CANDIDATES.flatMap(
  (name) => {
    if (name === 'Common' || name === 'Inherited') return [];
    try {
      return [[name, new RegExp(`\\p{Script_Extensions=${name}}`, 'u')] as const];
    } catch {
      return [];
    }
  },
);

/** UTS #39 augmented script sets. A segment's scripts may be any subset of one of these. */
const AUGMENTED: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['Han', 'Hiragana', 'Katakana']),
  new Set(['Han', 'Hangul']),
  new Set(['Han', 'Bopomofo']),
];

const ZWJ = 0x200d;
const ZWNJ = 0x200c;

/** First code point of each run of ten decimal digits. One run is one numbering system. */
const ND_BASES = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66,
  0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810,
  0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
  0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30,
  0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0,
  0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0,
  0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50, 0x16130, 0x16a60, 0x16ac0,
  0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6,
  0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

/** Indic and other viramas (Canonical_Combining_Class=Virama). JS has no CCC property. */
const VIRAMA = new Set<number>([
  0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d4d,
  0x0dca, 0x1039, 0x103a, 0x1714, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0xa806,
  0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f, 0x11046, 0x110b9, 0x11133,
  0x111c0, 0x11235, 0x112ea, 0x1134d, 0x11442, 0x114c2, 0x115bf, 0x1163f,
  0x116b6, 0x11839, 0x1193e, 0x119e0,   0x11a34, 0x11a47, 0x11a99, 0x11c3f,
  0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42,
  0x0e3a, 0x0eba, 0x0f84, 0x0d3b, 0x0d3c, 0x1baa, 0x1bab, 0x1bf2, 0x1bf3,
  0x1715, 0x2d7f, 0xa82c, 0x11070, 0x1107f, 0x11134, 0x1172b, 0x1193d,
]);

/** Arabic-script letters that join only to the right (Alef, Dal, Reh, Waw, and their kin). */
const RIGHT_JOINING = new Set<number>([
  0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062f, 0x0630, 0x0631,
  0x0632, 0x0648, 0x0671, 0x0672, 0x0673, 0x0675, 0x0676, 0x0677, 0x0688,
  0x0689, 0x068a, 0x068b, 0x068c, 0x068d, 0x068e, 0x068f, 0x0690, 0x0691,
  0x0692, 0x0693, 0x0694, 0x0695, 0x0696, 0x0697, 0x0698, 0x0699, 0x06c0,
  0x06c3, 0x06c4, 0x06c5, 0x06c6, 0x06c7, 0x06c8, 0x06c9, 0x06ca, 0x06cb,
  0x06cd, 0x06cf, 0x06d2, 0x06d3, 0x06ee, 0x06ef, 0x0710, 0x0715, 0x0716,
  0x0717, 0x0718, 0x0719, 0x071d, 0x071e, 0x0728, 0x072a, 0x072c, 0x072f,
  0x074d, 0x0759, 0x075a, 0x075b, 0x076b, 0x076c, 0x0771,
]);

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
    assertSegment(segment, id, where);
  }
}

function assertSegment(segment: string, id: string, where: string): void {
  const cps = [...segment].map((ch) => ch.codePointAt(0)!);
  let resolved: Set<string> | null = null;
  const present = new Set<string>();
  let numbering: number | null = null;
  let sawLetter = false;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    const ch = String.fromCodePoint(cp);
    if (cp === ZWJ || cp === ZWNJ) {
      if (i === cps.length - 1 || !contextJoiners(cps, i, cp)) {
        throw new ResolverError(
          `${where}: record id "${id}" has a join control outside the IDNA contexts`,
          { code: 'malformed', recordId: id },
        );
      }
      continue;
    }
    if (/^\p{Nd}$/u.test(ch)) {
      const system = numberingBase(cp);
      if (system === null) {
        throw new ResolverError(
          `${where}: record id "${id}" contains a character the registry does not allow`,
          { code: 'malformed', recordId: id },
        );
      }
      sawLetter = false;
      if (numbering === null) numbering = system;
      else if (numbering !== system) {
        throw new ResolverError(
          `${where}: record id "${id}" mixes numbering systems in a segment`,
          { code: 'malformed', recordId: id },
        );
      }
      continue;
    }
    if (/^\p{M}$/u.test(ch)) {
      if (!sawLetter) {
        throw new ResolverError(
          `${where}: record id "${id}" contains a character the registry does not allow`,
          { code: 'malformed', recordId: id },
        );
      }
    } else if (/^\p{L}$/u.test(ch) || /^[._~+-]$/u.test(ch)) {
      if (/^\p{L}$/u.test(ch)) sawLetter = true;
      else sawLetter = false;
    } else {
      throw new ResolverError(
        `${where}: record id "${id}" contains a character the registry does not allow`,
        { code: 'malformed', recordId: id },
      );
    }
    const scx = scriptExtensions(cp);
    if (scx.length === 0) continue;
    for (const script of scx) present.add(script);
    if (resolved === null) resolved = new Set(scx);
    else for (const script of [...resolved]) if (!scx.includes(script)) resolved.delete(script);
  }
  if (resolved !== null && resolved.size === 0 && !augmented(present)) {
    throw new ResolverError(
      `${where}: record id "${id}" mixes scripts in a segment`,
      { code: 'malformed', recordId: id },
    );
  }
}

function augmented(scripts: Set<string>): boolean {
  if (scripts.size === 0) return false;
  for (const allowed of AUGMENTED) {
    let fits = true;
    for (const script of scripts) {
      if (!allowed.has(script)) { fits = false; break; }
    }
    if (fits) return true;
  }
  return false;
}

const scriptCache = new Map<number, readonly string[]>();

function scriptExtensions(cp: number): readonly string[] {
  const cached = scriptCache.get(cp);
  if (cached !== undefined) return cached;
  const ch = String.fromCodePoint(cp);
  const found: string[] = [];
  for (const [name, pattern] of SCRIPT_EXTENSIONS) {
    if (pattern.test(ch)) found.push(name);
  }
  let result: readonly string[] = found;
  if (
    found.length === 0
    && !COMMON.test(ch)
    && !INHERITED.test(ch)
    && /^[\p{L}\p{M}\p{N}]$/u.test(ch)
  ) {
    // One code point, one script. Two unknown letters do not form a word.
    result = [`U+${cp.toString(16)}`];
  }
  scriptCache.set(cp, result);
  return result;
}

function numberingBase(cp: number): number | null {
  let lo = 0;
  let hi = ND_BASES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const base = ND_BASES[mid]!;
    if (cp < base) hi = mid - 1;
    else if (cp >= base + 10) lo = mid + 1;
    else return base;
  }
  return null;
}

function contextJoiners(cps: number[], index: number, cp: number): boolean {
  const previous = index > 0 ? cps[index - 1]! : -1;
  if (VIRAMA.has(previous)) return true;
  if (cp !== ZWNJ) return false;
  const before = nearestJoin(cps, index, -1);
  const after = nearestJoin(cps, index, 1);
  return (before === 'L' || before === 'D') && (after === 'R' || after === 'D');
}

function nearestJoin(cps: number[], index: number, step: -1 | 1): 'R' | 'L' | 'D' | 'U' | null {
  for (let i = index + step; i >= 0 && i < cps.length; i += step) {
    const kind = joiningType(cps[i]!);
    if (kind === 'T') continue;
    return kind;
  }
  return null;
}

function joiningType(cp: number): 'R' | 'L' | 'D' | 'T' | 'U' {
  if (cp === ZWJ || cp === ZWNJ) return 'U';
  if (/^\p{M}$/u.test(String.fromCodePoint(cp))) return 'T';
  if (RIGHT_JOINING.has(cp)) return 'R';
  const ch = String.fromCodePoint(cp);
  if (/^\p{Script=Arabic}$/u.test(ch) && /^\p{L}$/u.test(ch)) return 'D';
  return 'U';
}
