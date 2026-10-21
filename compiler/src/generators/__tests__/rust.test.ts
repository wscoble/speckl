// src/generators/__tests__/rust.test.ts
//
// Rust backend tests: the generated source text. compiles-rust.test.ts
// type-checks the same output (every example plus the RustTranslation
// fixture) with cargo when a Rust toolchain is installed.

import { describe, it, expect, afterAll } from 'vitest';
import { parseSpeckFile } from '../../parser.js';
import { lower } from '../../ir/lower.js';
import { generateRust } from '../rust.js';
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const FIXTURES = resolve(__dirname, '..', '..', '__tests__', 'fixtures');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Generate the crate for a spec file; returns [lib.rs, Cargo.toml]. */
function rustFor(file: string): { lib: string; cargo: string } {
  const out = mkdtempSync(join(tmpdir(), 'speckl-rust-'));
  dirs.push(out);
  const ast = parseSpeckFile(file);
  generateRust(lower(ast, { filePath: file, resolveImports: false }), out, ast);
  const speck = ast.specks[0].name;
  return {
    lib: readFileSync(join(out, speck, 'src', 'lib.rs'), 'utf-8'),
    cargo: readFileSync(join(out, speck, 'Cargo.toml'), 'utf-8'),
  };
}

function rustFromString(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-rust-src-'));
  dirs.push(dir);
  const file = join(dir, 'spec.speckdl');
  writeFileSync(file, src);
  return rustFor(file).lib;
}

/** The body of one generated method. */
function method(lib: string, name: string): string {
  const start = lib.indexOf(`pub fn ${name}(`);
  expect(start, `method ${name}`).toBeGreaterThanOrEqual(0);
  const end = lib.indexOf('\n    }\n', start);
  return lib.slice(start, end);
}

describe('Rust target — ToggleSwitch', () => {
  const { lib, cargo } = rustFor(join(REPO_ROOT, 'examples', 'ToggleSwitch.speckdl'));

  it('emits a Cargo.toml named after the speck', () => {
    expect(cargo).toMatch(/name = "toggle_switch"/);
  });

  it('translates state variables to snake_case struct fields with Rust types', () => {
    expect(lib).toContain('pub struct ToggleSwitchMachine');
    expect(lib).toMatch(/pub is_on:\s*bool/);
  });

  it('emits action methods with guard checks returning Result', () => {
    expect(lib).toContain('pub fn turn_on(&mut self) -> Result<bool, String>');
    expect(lib).toContain('pub fn turn_off(&mut self) -> Result<bool, String>');
    expect(lib).toContain('return Err("Guard failed: !isOn".to_string());');
    expect(lib).toContain('self.is_on = true;');
    expect(lib).toContain('self.is_on = false;');
  });

  it('emits an initial-state constructor reflecting the init block', () => {
    expect(lib).toMatch(/is_on:\s*false/);
  });

  it('does not invent a state enum the spec does not declare', () => {
    expect(lib).not.toContain('pub enum ToggleSwitchState');
  });

  it('checks an invariant it cannot translate by failing closed', () => {
    expect(method(lib, 'check_switch_consistent')).toContain('speckl_untranslated("isOn in {true, false}")');
  });
});

describe('Rust target — translation', () => {
  const { lib } = rustFor(join(FIXTURES, 'RustTranslation.speckdl'));

  it('declares enums, records, inline records, events and placeholders', () => {
    expect(lib).toContain('#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]\npub enum Phase {\n    #[default]\n    Draft,');
    expect(lib).toContain('#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]\npub struct Account {');
    expect(lib).toContain('pub struct MetaRecord {\n    pub created_by: String,\n    pub revision: u64,\n}');
    expect(lib).toContain('/// SPECKL-UNRESOLVED: type Ticket is not declared');
    expect(lib).toContain('pub struct Ticket(());');
    expect(lib).toContain('pub mod events {');
    expect(lib).toContain('    Moved(events::Moved),');
  });

  it('maps types, keywords and nullable fields', () => {
    expect(lib).toContain('pub owner: Option<String>,');
    expect(lib).toContain('pub r#type: u64,');
    expect(lib).toContain('pub balances: HashMap<u64, i64>,');
    expect(lib).toContain('pub decision_log: Vec<RustTranslationEvent>,');
  });

  it('builds new() from init, reading state only after the struct exists', () => {
    const ctor = method(lib, 'new');
    expect(ctor).toContain('delta: -1i64,');
    expect(ctor).toContain('owner: None,');
    expect(ctor).toContain('tags: Vec::<String>::new(),');
    expect(ctor).toContain('m.r#type = (m.count + 1u64);');
  });

  it('translates arithmetic with numeric coercions, strings, enums, emits and old()', () => {
    const adv = method(lib, 'advance');
    expect(adv).toContain('let old_state = self.clone();');
    expect(adv).toContain('if !(((step > 0u64) && (step <= 10u64))) {');
    expect(adv).toContain('self.delta = (self.delta - (step as i64));');
    expect(adv).toContain('(self.count as f64)');
    expect(adv).toContain('self.label = format!("{}{}", format!("{}{}", self.label, String::from("-")), self.count);');
    expect(adv).toContain('self.phase = Phase::Review;');
    expect(adv).toContain('self.decision_log.push(RustTranslationEvent::Moved(events::Moved { from: (self.count - step), to: self.count, note: self.label.clone() }));');
    expect(adv).toContain('if !((self.count >= old_state.count)) {');
  });

  it('translates map and list reads and writes, lets and Option assignment', () => {
    const credit = method(lib, 'credit');
    expect(credit).toContain('if !(self.accounts.contains_key(&who)) {');
    expect(credit).toContain('let mut a: Account = (*self.accounts.get(&who).unwrap_or_else(|| speckl_missing("accounts", &who))).clone();');
    expect(credit).toContain('self.balances.insert(self.count, amount);');
    expect(credit).toContain('self.seen = { let mut v = self.seen.clone(); v.push(self.count); v };');
    expect(credit).toContain('self.seen[(0u64) as usize] = self.count;');
    expect(credit).toContain('((amount <= 100i64) || ((-amount) > 5i64))');
    expect(credit).toContain('self.owner = Some(who.clone());');
  });

  it('types the return value and checks nil, membership and empties', () => {
    const check = method(lib, 'check');
    expect(check).toContain('pub fn check(&mut self, id: u64) -> Result<u64, String>');
    expect(check).toContain('(!self.balances.contains_key(&id))');
    expect(check).toContain('self.owner.is_some()');
    expect(check).toContain('(self.tags == Vec::<String>::new())');
    expect(check).toContain('let result: u64 = std::cmp::max(id, self.count);');
  });

  it('refuses an action with an untranslated statement before it touches state', () => {
    const u = method(lib, 'unsupported');
    const guard = u.indexOf('return Err("SPECKL-UNTRANSLATED: Unsupported: 2 untranslated statements, first: seen := seen union { id }".to_string());');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(u.indexOf('self.count'));
    expect(u).toContain('// SPECKL-UNTRANSLATED: if id > 100 { open := false }');
  });

  it('a fully translated action has no guard', () => {
    expect(method(lib, 'reset')).not.toContain('SPECKL-UNTRANSLATED');
  });

  it('emits invariants, constraints and temporal properties', () => {
    expect(method(lib, 'check_count_bounded')).toContain('((self.count <= 1000u64) && (self.r#type >= 0u64))');
    expect(method(lib, 'check_invariant_1')).toContain('((self.ratio >= 0f64) && (self.label != String::from("")))');
    expect(method(lib, 'verify_1')).toContain('self.check_count_bounded()');
    expect(method(lib, 'verify_2')).toContain('speckl_untranslated("eventually(count > 0)")');
  });
});

describe('Rust target — names, types and fail-closed edges', () => {
  it('handles keywords, colliding names, aliases, nested records and unparsable types', () => {
    const lib = rustFromString(`
speck Edge {
  type Amount = Int
  type Note = {
    body: String,
    weight: Real
  }
  state {
    self: Nat
    continue: Int
    cost: Amount
    total: Real
    note: Note
    sample: Sample
    grid: Map(Map(String, Nat), Nat)
    owner: Option(String)
    parts: { head: { depth: Nat } }
    names: List(String)
    rates: List(Real)
  }
  init {
    self := 1
    continue := 2
    total := missing + 1
  }
  type Sample = {
    weight: Real
  }
  event Note {
    text: String
  }
  action Go(m: Nat, result: Int, n: Nat) {
    let v := m + 2
    let w := 3 * 4
    continue := result - m
    self := result
    total := total + 1.5
    owner := owner
    names := append(names, names)
    rates := append(rates, 2)
    m := v
    require length(owner) >= 0
    require grid[note] == 1
    require note == note
    require min(total, 2.5) <= max(n, 2)
    require max(1, 2) > 0
    require "a" < "b"
    require -m < 0
    require now() > 0
    require contains("abc", "b")
    require owner == "x"
    require names[0] + 1 == names[0] + "1"
    emit Note { text: "hi" }
    return
  }
  action Half(x: Nat) {
    return x
    self := 2
  }
  action Mixed(x: Int) {
    require x > 0
  }
  next: Go | Half | Mixed
}
`);
    // Keywords: raw identifiers, or a suffix where raw is not allowed.
    expect(lib).toContain('pub self_: u64,');
    expect(lib).toContain('pub r#continue: i64,');
    // The parser drops scalar aliases (type Amount = Int), so Amount is a
    // placeholder; an inline record nests.
    expect(lib).toContain('/// SPECKL-UNRESOLVED: type Amount is not declared in this spec (or is an alias the parser dropped).');
    expect(lib).toContain('pub cost: Amount,');
    expect(lib).toContain('pub struct PartsRecord {\n    pub head: PartsRecordHeadRecord,\n}');
    expect(lib).toContain('pub struct PartsRecordHeadRecord {\n    pub depth: u64,\n}');
    // An event lives in mod events, so it may share a type's name.
    expect(lib).toContain('    pub struct Note {\n        pub text: String,');
    expect(lib).toContain('    Note(events::Note),');
    // f64 field: no Eq/Hash; a map keyed by a map: no PartialEq anywhere.
    expect(lib).toContain('#[derive(Debug, Clone, Default, PartialEq)]\npub struct Sample {');
    expect(lib).toContain('pub grid: HashMap<HashMap<String, u64>, u64>,');
    expect(lib).toContain('#[derive(Debug, Clone)]\npub struct EdgeMachine {');
    // Init that cannot be translated panics in new().
    expect(method(lib, 'new')).toContain('speckl_untranslated("Edge init: 1 untranslated assignment, first: init total := missing + 1");');
    const go = method(lib, 'go');
    expect(go).toContain('pub fn go(&mut self, mut m_: u64, result_: i64, n: u64) -> Result<(), String>');
    expect(go).toContain('let mut v_: u64 = (m_ + 2u64);');
    expect(go).toContain('let mut w: i64 = (((3 * 4)) as i64);');
    expect(go).toContain('self.r#continue = (result_ - (m_ as i64));');
    expect(go).toContain('self.self_ = u64::try_from(result_).expect("negative value for a Nat");');
    expect(go).toContain('self.total = (self.total + 1.5_f64);');
    expect(go).toContain('self.owner = self.owner.clone();');
    expect(go).toContain('self.names = { let mut v = self.names.clone(); v.extend(self.names.clone()); v };');
    expect(go).toContain('self.rates = { let mut v = self.rates.clone(); v.push(2f64); v };');
    expect(go).toContain('m_ = v_;');
    expect(go).toContain('(self.total.min(2.5_f64) <= (std::cmp::max(n, 2u64) as f64))');
    expect(go).toContain('(String::from("a") < String::from("b"))');
    expect(go).toContain('((-(m_ as i64)) < 0i64)');
    expect(go).toContain('(speckl_now() > 0u64)');
    expect(go).toContain('String::from("abc").contains(String::from("b").as_str())');
    expect(go).toContain('(self.owner == Some(String::from("x")))');
    expect(go).toContain('(format!("{}{}", self.names[(0u64) as usize], 1) == format!("{}{}", self.names[(0u64) as usize], String::from("1")))');
    // Lookups into a map keyed by a non-hashable type, length of an
    // Option, and min/max of two untyped literals fail closed.
    expect(go).toContain('// SPECKL-UNTRANSLATED: require length(owner) >= 0');
    expect(go).toContain('// SPECKL-UNTRANSLATED: require grid[note] == 1');
    expect(go).toContain('// SPECKL-UNTRANSLATED: require max(1, 2) > 0');
    expect(go).toContain('(self.note == self.note)');
    // The IR keeps a bare `return` as raw text.
    expect(go).toContain('// SPECKL-UNTRANSLATED: return');
    const half = method(lib, 'half');
    expect(half).toContain('-> Result<u64, String>');
    expect(half).not.toContain('self.self_ = 2');
    expect(method(lib, 'mixed')).toContain('Ok(())');
  });

  it('fails closed on returns of mixed types, missing returns, unknown events and bad emits', () => {
    const lib = rustFromString(`
speck Ret {
  interface Color {
    Red
    Green
  }
  interface Light {
    Red
    Off
  }
  state {
    n: Nat
    c: Color
    tags: Set(String)
    flag: Bool
  }
  event Ping {
    count: Nat
  }
  action A(x: Nat) {
    require x > 0
    return x
  }
  action B(s: String) {
    require s == "a"
    n := n + 1
  }
  action C() {
    emit Pong { count: 1 }
    emit Ping { count: "x" }
    emit Ping { other: 1 }
    emit Ping { }
  }
  action D() {
    c := Red
    require c != Green
    require c == Off
    require Red == c
    n := emptyMap()
    tags := emptyList()
    flag := Red
    flag := !n
    flag := n and flag
    flag := implies(n, flag)
    flag := n implies flag
    flag := unknownFn(n)
    flag := len(n) > 0
    flag := has(n, 1)
    flag := contains(n, 1)
    flag := min(flag, n) > 0
    flag := append(n, 1) == n
    flag := n == "x"
    flag := nil == n
    flag := 9007199254740993 > 0
    n := -1
  }
  next: A | B | C | D
}
`);
    expect(method(lib, 'a')).toContain('-> Result<u64, String>');
    const b = method(lib, 'b');
    expect(b).toContain('Ok(())');
    const c = method(lib, 'c');
    expect(c).toContain('SPECKL-UNTRANSLATED: C: 4 untranslated statements, first: emit Pong(count: 1)');
    const d = method(lib, 'd');
    expect(d).toContain('self.c = Color::Red;');
    expect(d).toContain('(self.c != Color::Green)');
    expect(d).toContain('(Color::Red == self.c)');
    for (const src of [
      'require c == Off', 'n := emptyMap()', 'flag := Red', 'flag := !n', 'flag := n && flag',
      'flag := implies(n, flag)', 'flag := unknownFn(n)', 'flag := len(n) > 0',
      'flag := has(n, 1)', 'flag := contains(n, 1)', 'flag := min(flag, n) > 0', 'flag := append(n, 1) == n',
      'flag := n == "x"', 'flag := nil == n', 'flag := 9007199254740992 > 0', 'n := -1',
    ]) {
      expect(d, src).toContain(`// SPECKL-UNTRANSLATED: ${src}`);
    }
  });
});
