export {
  COMPILE_TIMEOUT_MS,
  DEBOUNCE_MS,
  HISTORY_PUSH_MS,
  LONG_LINE_CHARS,
  MAX_SOURCE_BYTES,
  MIN_ACCEPTED_BYTES,
  SHARE_MAX_CHARS,
  formatBytes,
  looksBinary,
  shareAllowed,
  sourceByteLength,
} from './limits.js';

export { decodeBase64Url, decodeSpecHash, encodeBase64Url, encodeSpecHash } from './share.js';
export type { DecodeResult } from './share.js';

export {
  binaryDiagnostic,
  cleanErrorMessage,
  dedupeDiagnostics,
  emptyDiagnostic,
  fromIR,
  locateDiagnostic,
  longLineDiagnostic,
  noAgentDiagnostic,
  noSpeckDiagnostic,
  presentDiagnostic,
  sortDiagnostics,
  timeoutMessage,
  tooBigDiagnostic,
  uncheckedDiagnostics,
  workerCrashMessage,
  z3InfoDiagnostic,
} from './diagnostics.js';
export type { BrowserDiagnostic } from './diagnostics.js';

export {
  RequestGate,
  applyHash,
  cursorLineCol,
  hashForSource,
  historyMode,
  lineRange,
  orderOutputPaths,
  preferredOutput,
  shouldConfirmDiscard,
} from './session.js';
export type { ApplyHash, HistoryReason } from './session.js';

export { compileSource, normalizeTarget } from './compile-source.js';
export type { BrowserCompileResult, CompileSourceOptions, OutputFile } from './compile-source.js';
