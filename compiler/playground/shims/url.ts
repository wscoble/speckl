export function fileURLToPath(url: string | URL): string {
  const s = String(url);
  if (!s.startsWith('file://')) return s;
  return decodeURIComponent(s.slice('file://'.length));
}

export function pathToFileURL(p: string): URL {
  return new URL('file://' + p);
}

export default { fileURLToPath, pathToFileURL };
