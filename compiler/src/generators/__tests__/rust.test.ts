// src/generators/__tests__/rust.test.ts
//
// Rust backend tests. These validate the *generated Rust source text* —
// structural correctness (state struct, snake_case fields, guard checking,
// Result-returning action methods, state enum). Compiling the emitted crate
// with cargo requires a Rust toolchain and is left to CI environments that
// have one installed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseSpeckFile } from '../../parser.js';
import { generateRust } from '../rust.js';
import { readFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'speckl-rust-'));
  const ast = parseSpeckFile(join(REPO_ROOT, 'examples', 'ToggleSwitch.speckdl'));
  generateRust(ast, outDir);
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function libRs(): string {
  return readFileSync(join(outDir, 'ToggleSwitch', 'src', 'lib.rs'), 'utf-8');
}

function cargoName(): string {
  const cargo = readFileSync(join(outDir, 'ToggleSwitch', 'Cargo.toml'), 'utf-8');
  const m = cargo.match(/name\s*=\s*"([^"]+)"/);
  return m ? m[1] : '';
}

describe('Rust target', () => {
  it('emits a Cargo.toml and src/lib.rs per speck', () => {
    // Crate name is the snake_case form of the speck name.
    expect(cargoName()).toBe('toggle_switch');
    const lib = libRs();
    expect(lib.length).toBeGreaterThan(0);
  });

  it('translates state variables to snake_case struct fields with Rust types', () => {
    const lib = libRs();
    expect(lib).toContain('pub struct ToggleSwitchMachine');
    expect(lib).toMatch(/pub is_on:\s*bool/);
  });

  it('emits action methods with guard checks returning Result', () => {
    const lib = libRs();
    expect(lib).toContain('pub fn turn_on(&mut self) -> Result<bool, String>');
    expect(lib).toContain('pub fn turn_off(&mut self) -> Result<bool, String>');
    // Guard failure path present for both actions
    expect(lib).toContain('Guard failed');
    // Assignment translated
    expect(lib).toContain('self.is_on = true;');
    expect(lib).toContain('self.is_on = false;');
  });

  it('emits an initial-state constructor reflecting the init block', () => {
    // init { isOn == false } → new() sets is_on: false
    expect(libRs()).toMatch(/is_on:\s*false/);
  });

  it('emits a state enum derived from the state machine states', () => {
    expect(libRs()).toContain('pub enum ToggleSwitchState');
  });
});