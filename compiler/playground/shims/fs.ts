// In-memory filesystem for the browser bundle. The compiler writes artifacts
// with Node's `fs`; this is that API, backed by memfs, for one page load.
import { Volume, createFsFromVolume } from 'memfs';

const volume = new Volume();
volume.mkdirSync('/tmp', { recursive: true });

const impl = createFsFromVolume(volume);

export function readFileSync(p: string, encoding?: unknown): string | Buffer {
  return impl.readFileSync(p, encoding as never) as string | Buffer;
}

export function writeFileSync(p: string, data: unknown, options?: unknown): void {
  impl.writeFileSync(p, data as never, options as never);
}

export function existsSync(p: string): boolean {
  return impl.existsSync(p);
}

export function mkdirSync(p: string, options?: unknown): void {
  impl.mkdirSync(p, options as never);
}

export function chmodSync(p: string, mode: number): void {
  impl.chmodSync(p, mode);
}

export function readdirSync(p: string): string[] {
  return impl.readdirSync(p).map(String);
}

export function statSync(p: string): { isDirectory(): boolean } {
  return impl.statSync(p);
}

export function rmSync(p: string, options?: unknown): void {
  impl.rmSync(p, options as never);
}

export function mkdtempSync(prefix: string): string {
  return String(impl.mkdtempSync(prefix));
}

const api = {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  readdirSync,
  statSync,
  rmSync,
  mkdtempSync,
};

export default api;
