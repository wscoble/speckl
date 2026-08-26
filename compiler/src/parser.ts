import fs from 'fs';
import path from 'path';

// AST node types for SpeckDL
export interface SpeckNode {
  type: 'speck';
  name: string;
  members: MemberNode[];
  // Optional metadata from top-of-file directives (version:, author:, license:, proto_package:, go_package:).
  // Undefined when not specified in the source.
  version?: string;
  author?: string;
  license?: string;
  // Protobuf-specific overrides. If unset, generator uses sensible defaults.
  // proto_package: e.g. "federated_meetup.v1"
  // go_package: e.g. "github.com/sscoble/federated-meetup/proto/federated_meetup/v1;federatedmeetupv1"
  protoPackage?: string;
  goPackage?: string;
  // Cycle 61: optional event-name suffix. When set, the .proto generator
  // appends this string to every `event` block's message name (e.g. an
  // event CreateGroup with event_suffix: "Payload" emits
  // `message CreateGroupPayload { ... }`). Matches the federated-meetup
  // convention where every transition payload is named XxxPayload.
  eventSuffix?: string;
  // K8s CRD target metadata. If unset, the k8s target derives from
  // protoPackage. k8sGroup is the API group (e.g. "tef.scoble.me"),
  // k8sVersion is the API version (e.g. "v1alpha1").
  k8sGroup?: string;
  k8sVersion?: string;
}

export interface ImportNode {
  type: 'import';
  path: string;
  alias?: string;
  version?: string;
  hash?: string;
}

export interface InputNode {
  type: 'input';
  typeExpr: TypeExpr;
}

export interface OutputNode {
  type: 'output';
  typeExpr: TypeExpr;
}

export interface ConstraintNode {
  type: 'constraint';
  name?: string;
  expr: string;
}

export interface VerifyNode {
  type: 'verify';
  name: string;
  temporalExpr: string;
  depth?: number;
}

export interface InterfaceField {
  name: string;
  type: TypeExpr;
}

export interface RpcMethod {
  name: string;
  requestType: string;
  responseType: string;
  // Streaming flags for gRPC/ConnectRPC
  clientStreaming?: boolean;
  serverStreaming?: boolean;
}

export interface ServiceNode {
  type: 'service';
  name: string;
  rpcs: RpcMethod[];
}

export interface InterfaceNode {
  type: 'interface';
  name: string;
  // Discriminator: which form does this interface take?
  // 'enum'    → only methods[] populated with variant names (returnType: Void)
  // 'record'  → only fields[] populated with name: Type entries
  // 'service' → methods[] populated with method signatures (name(params) -> Type)
  // 'mixed'   → ambiguous; generators should inspect both
  kind: 'enum' | 'record' | 'service' | 'mixed';
  methods: MethodSignature[];
  fields: InterfaceField[];
}

export interface MethodSignature {
  name: string;
  params: { name: string; type: TypeExpr }[];
  returnType: TypeExpr;
}

export interface EventNode {
  type: 'event';
  name: string;
  fields: { name: string; type: TypeExpr }[];
}

// oneof: discriminated-union variant for proto wire-format compatibility.
// Cycle 57 — emits `oneof payload { TypeName field_name = N; ... }` when
// compiled to .proto. Variants reference top-level event/interface types;
// field_name is the snake_case wire name (lowerCamelCase convention from
// TypeScript).
export interface OneofNode {
  type: 'oneof';
  name: string;
  variants: OneofVariant[];
}

export interface OneofVariant {
  fieldName: string;     // wire name, e.g. "create_group"
  typeName: string;      // referenced type, e.g. "CreateGroup"
}

// Cycle 58: Transition envelope — a proto message that wraps a oneof payload
// along with metadata fields (prior_state, signatures, hlc, branch_id, etc).
// Distinct from `event` because:
//   - payload field references a OneofNode (not a regular message type)
//   - generator emits a `oneof payload { ... }` block inside the message body
//   - the discriminator field uses a proto enum (TransitionType)
// This is the shape federated-meetup needs for its `Transition` message.
export interface TransitionNode {
  type: 'transition';
  name: string;
  fields: TransitionField[];
  payloadOneof?: string;      // name of the OneofNode whose variants go inside the oneof payload block
  typeDiscriminator?: string; // name of the enum used to discriminate variants
}

export interface TransitionField {
  name: string;
  type: TypeExpr;
}

export interface ProvenanceNode {
  type: 'provenance';
  clauses: ProvenanceClause[];
}

export interface ProvenanceClause {
  type: 'regulation' | 'design_decision' | 'parent_spec' | 'external_doc';
  value: string;
  location?: string; // for external_doc
}

export interface ReviewNode {
  type: 'review';
  kind: 'manual' | 'auto' | 'hybrid';
}

export interface DerivesNode {
  type: 'derives';
  from: string;
  via?: string;
}

export interface SatisfiesNode {
  type: 'satisfies';
  requirement: string;
  clause?: string;
}

export interface AuthorNode {
  type: 'author';
  name: string;
  email?: string;
}

export interface SourceNode {
  type: 'source';
  kind: 'conversation' | 'meeting' | 'document' | 'regulation' | 
         'architecture_review' | 'threat_model' | 'compliance_audit';
  ref?: string;
}

export interface BOMNode {
  type: 'bom';
  compiler?: { name: string; version?: string };
  solver?: { name: string; version?: string };
  runtime?: { name: string; version?: string };
  license?: string;
  hash?: string;
}

// State machine extension (v0.3)
export interface StateNode {
  type: 'state';
  variables: StateVar[];
  // Cycle 59: optional message-name override. When set, the .proto
  // generator emits `message <messageName> { ... }` instead of
  // `message <SpeckName>State { ... }`. This matches the consumer's
  // expected binding name (e.g. StateSnapshot instead of
  // FederatedMeetupState), so the Speckl-generated proto is a drop-in
  // for the handwritten one. See:
  //   docs/
  //     speckl-federated-meetup-protobuf-migration.md
  messageName?: string;
}

export interface StateVar {
  name: string;
  typeExpr: TypeExpr;
  defaultInit?: string; // default initializer expression as raw string
}

export interface InitNode {
  type: 'init';
  assignments: { name: string; expr: string }[];
}

export interface ActionNode {
  type: 'action';
  name: string;
  params: { name: string; type: TypeExpr }[];
  statements: ActionStatement[];
}

export type ActionStatement =
  | { type: 'assign'; target: string; expr: string }
  | { type: 'let'; name: string; expr: string }
  | { type: 'require'; expr: string }
  | { type: 'precondition'; expr: string }
  | { type: 'postcondition'; expr: string }
  | { type: 'emit'; event: string; fields: { name: string; value: string }[] }
  | { type: 'return'; expr: string }
  | { type: 'ifblock'; raw: string };

export type MemberNode =
  | ImportNode
  | InputNode
  | OutputNode
  | ConstraintNode
  | VerifyNode
  | InterfaceNode
  | EventNode
  | OneofNode
  | TransitionNode
  | ProvenanceNode
  | ReviewNode
  | DerivesNode
  | SatisfiesNode
  | AuthorNode
  | SourceNode
  | BOMNode
  | StateNode
  | InitNode
  | ActionNode
  | ServiceNode;

export interface TypeExpr {
  type: 'primitive' | 'record' | 'list' | 'set' | 'map' | 'ident';
  name?: string;
  fields?: { name: string; type: TypeExpr }[];
  elementType?: TypeExpr;
  keyType?: TypeExpr;   // for Map<K, V>
  valueType?: TypeExpr;  // for Map<K, V>
  /**
   * True if the type allows null (`T | null` syntax). Set by the parser
   * and propagated to the IR. Generators should emit `nullable: true`
   * (OpenAPI) or `x-nullable: true` (older JSON Schema) accordingly.
   */
  nullable?: boolean;
}

export interface AST {
  specks: SpeckNode[];
}

/**
 * Parse a .speck file and return the AST
 */
export function parseSpeckFile(filePath: string): AST {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSpeckContent(content, filePath);
}

/**
 * Parse SpeckDL content and return the AST
 */
export function parseSpeckContent(content: string, filePath?: string): AST {
  const specks: SpeckNode[] = [];
  const lines = content.split('\n');
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    
    // Skip empty lines and comments
    if (!line || line.startsWith('//') || line.startsWith('/*')) {
      i++;
      continue;
    }
    
    // Handle import statements
    if (line.startsWith('import ')) {
      const importNode = parseImportStatement(line);
      // Import is a special case - it's not part of a speck
      // We'll handle it separately in a future update
      i++;
      continue;
    }
    
    // Handle speck definitions
    if (line.startsWith('speck ')) {
      const speck = parseSpeck(lines, i);
      if (speck) {
        specks.push(speck);
        // Move index past the speck we just parsed
        i++; // Increment by 1, the loop will continue from next line
      } else {
        i++;
      }
      continue;
    }
    
    i++;
  }
  
  return { specks };
}

function parseSpeck(lines: string[], startIndex: number): SpeckNode | null {
  const headerMatch = lines[startIndex].match(/^speck\s+([\w-]+)\s*{/);
  if (!headerMatch) return null;

  const name = headerMatch[1];
  const members: MemberNode[] = [];

  // Cycle 73: refactored from static-field hack to local-object pattern.
  // Previously, proto_package / go_package / event_suffix were stored
  // on (parseSpeck as any)._protoPackage etc — static function fields
  // that leaked between parse calls. Now collected in a local metadata
  // object and spread into the return value. No reset needed because
  // the object is local to this invocation.
  const metadata: {
    protoPackage?: string;
    goPackage?: string;
    eventSuffix?: string;
    version?: string;
    author?: string;
    license?: string;
    k8sGroup?: string;
    k8sVersion?: string;
  } = {};

  let i = startIndex + 1;
  let braceCount = 1;

  while (i < lines.length && braceCount > 0) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line || line.startsWith('//') || line.startsWith('/*')) {
      i++;
      continue;
    }

    // ── Top-of-file protobuf metadata directives ────────────────
    // These attach to the SpeckNode and are NOT emitted as members.
    // Format: `key: value` (string values may be quoted or bare).
    // `author:`, `version:`, `license:` continue to be parsed as members
    // (AuthorNode, etc.) for backward compatibility with the existing
    // PROV-O / CycloneDX generators.
    // ── Top-of-file speck metadata directives ─────────────────────
  // `version:`, `author:`, `license:` attach to the SpeckNode directly.
  // (proto_package/go_package/event_suffix also go here, handled below.)
  // Format: `key: value` (string values may be quoted or bare).
  // We parse these as SpeckNode fields, not as members. The lower pass
  // also reads them via the `bom` block's compiler/license as fallback.
  // Speck-level metadata directives. These attach to the SpeckNode and
  // are NOT emitted as members. Format: `key: value` (string values may
  // be quoted or bare).
  //
  // Two regexes:
  //   1. simple form: `version: "0.1.2"`, `k8s_group: "x.y.z"`, etc.
  //      The value must not contain `<` (signature form) or `{` (block
  //      form), so the existing author/block parsers handle those.
  //   2. protobuf metadata: `proto_package`, `go_package`, `event_suffix`
  //      — also simple form, but historically tracked separately.
  //
  // The simple form is parsed first; the protobuf form below is a
  // subset of the same family but uses different field names.
  const speckMetaMatch = line.match(/^(version|author|license|k8s_group|k8s_version)\s*:\s*([^{<]+)$/);
  if (speckMetaMatch) {
    const value = speckMetaMatch[2].trim().replace(/^['"]|['"]$/g, '');
    const key = speckMetaMatch[1];
    if (key === 'version') metadata.version = value;
    else if (key === 'author') metadata.author = value;
    else if (key === 'license') metadata.license = value;
    else if (key === 'k8s_group') metadata.k8sGroup = value;
    else if (key === 'k8s_version') metadata.k8sVersion = value;
    i++;
    continue;
  }

  const metaMatch = line.match(/^(proto_package|go_package|event_suffix)\s*:\s*(.+)$/);
    if (metaMatch) {
      // Strip surrounding quotes if present
      const value = metaMatch[2].trim().replace(/^['"]|['"]$/g, '');
      if (metaMatch[1] === 'proto_package') {
        metadata.protoPackage = value;
      } else if (metaMatch[1] === 'go_package') {
        metadata.goPackage = value;
      } else if (metaMatch[1] === 'event_suffix') {
        metadata.eventSuffix = value;
      }
      i++;
      continue;
    }

    // Count braces on this line first
    const openCount = (rawLine.match(/{/g) || []).length;
    const closeCount = (rawLine.match(/}/g) || []).length;

    // Check for block-opening members (those that open braces on the same line)
    const blockStarters = ['state:', 'init:', 'action ', 'event ', 'provenance ', 'bom ', 'interface ',
      'state {', 'init {', 'verify ', 'constraint ', 'input:', 'output:', 'service ', 'oneof ', 'transition ',
      'state as ', 'type '];
    const isBlockStarter = blockStarters.some(s => line.startsWith(s));

    // Handle single-line metadata members that aren't block-starters:
    //   `conditions: ["Ready", "ItemsLoaded"]`
    //   `finalizers: []`
    //   `ownerReferences: true`
    //   `status: { ... }` (K8s-style status subresource)
    // These are part of the resource_lifecycle facet.
    const lifecycleLine = line.match(/^(conditions|finalizers|ownerReferences|status)\s*:/);
    if (lifecycleLine) {
      const key = lifecycleLine[1];
      const valueMatch = line.match(/^(conditions|finalizers|ownerReferences|status)\s*:\s*(.+)$/);
      if (valueMatch) {
        const value = valueMatch[2].trim();
        let parsed: any = value;
        if (value.startsWith('[') && value.endsWith(']')) {
          // String list: ["a", "b"]
          parsed = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        } else if (value === 'true') {
          parsed = true;
        } else if (value === 'false') {
          parsed = false;
        }
        members.push({ type: 'lifecycle_metadata', key, value: parsed } as any);
        i++;
        continue;
      }
    }

    if (isBlockStarter && openCount > 0) {
      // Multi-line block: parse it and skip to its end
      const member = parseMemberBlock(lines, i);
      if (member) {
        members.push(member);
      }
      // Skip past this block if it spans multiple lines
      if (closeCount < openCount) {
        const endIdx = findBlockEnd(lines, i + 1, braceCount + openCount);
        i = endIdx + 1;
      } else {
        i++;
      }
      continue;
    }

    // Handle constraint/verify blocks that may span multiple lines without braces
    // (e.g. constraint Name: forall r in [0..4]:, verify: always(implies(\n  ...\n)))
    if (line.startsWith('constraint ') || line.startsWith('verify ') || line.startsWith('verify:') || line.startsWith('constraint:')) {
      const member = parseMultiLineConstraintVerify(lines, i);
      if (member) {
        members.push(member);
        // Skip past the consumed continuation lines
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (!nextLine || nextLine.startsWith('//') || nextLine.startsWith('/*') ||
              nextLine.startsWith('constraint ') || nextLine.startsWith('verify ') ||
              nextLine.startsWith('constraint:') || nextLine.startsWith('verify:') ||
              nextLine.startsWith('state') || nextLine.startsWith('init') ||
              nextLine.startsWith('action ') || nextLine.startsWith('event ') ||
              nextLine.startsWith('interface ') || nextLine.startsWith('provenance ') ||
              nextLine.startsWith('service ') || nextLine.startsWith('bom ') ||
              nextLine.startsWith('}') ||
              nextLine.startsWith('next:') || nextLine.startsWith('invariant ')) {
            break;
          }
          i++;
        }
      }
      i++;
      continue;
    }

    // Single-line: update brace count, then parse if still inside
    braceCount += openCount - closeCount;
    if (braceCount <= 0) {
      i++;
      break;
    }

    const member = parseMember(line);
    if (member) {
      members.push(member);
    }
    i++;
  }

  return { type: 'speck', name, members,
           protoPackage: metadata.protoPackage,
           goPackage: metadata.goPackage,
           eventSuffix: metadata.eventSuffix,
           version: metadata.version,
           author: metadata.author,
           license: metadata.license,
           k8sGroup: metadata.k8sGroup,
           k8sVersion: metadata.k8sVersion };
}

function findBlockEnd(lines: string[], startIndex: number, startBraceCount: number): number {
  let braceCount = startBraceCount;
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') braceCount++;
      if (ch === '}') {
        braceCount--;
        if (braceCount < startBraceCount) {
          return i;
        }
      }
    }
    i++;
  }
  return i;
}

// Check if an expression has balanced braces, parens, and brackets
function isExpressionComplete(expr: string): boolean {
  let braces = 0, parens = 0, brackets = 0;
  for (const char of expr) {
    if (char === '{') braces++;
    else if (char === '}') braces--;
    else if (char === '(') parens++;
    else if (char === ')') parens--;
    else if (char === '[') brackets++;
    else if (char === ']') brackets--;
  }
  return braces === 0 && parens === 0 && brackets === 0;
}

function parseMemberBlock(lines: string[], startIndex: number): MemberNode | null {
  const firstLine = lines[startIndex].trim();
  const startBraceCount = (firstLine.match(/{/g) || []).length;
  
  if (firstLine.startsWith('state:')) {
    return parseStateBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('state {') || firstLine === 'state') {
    return parseStateBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('state as ')) {
    // Cycle 63: `state as <MessageName> { ... }` form must dispatch
    // through the same state-block parser so the `as` override on the
    // first line is captured.
    return parseStateBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('init:')) {
    return parseInitBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('init {') || firstLine === 'init') {
    return parseInitBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('action ')) {
    return parseActionBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('event ')) {
    return parseEventBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('interface ')) {
    return parseInterfaceBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('type ')) {
    // `type X = { ... }` is a record type alias. We synthesize a header
    // of the form `interface X { ... }` so the existing interface parser
    // handles it. The '=' sign and surrounding whitespace are stripped.
    // This is a pre-existing gap: the existing parser only recognizes
    // `interface X { ... }`, not `type X = { ... }`, but the OAuth example
    // and other specs use the latter. We bridge the gap here.
    const eqMatch = firstLine.match(/^type\s+(\w+)\s*=\s*(.*)$/);
    if (eqMatch) {
      const aliasName = eqMatch[1];
      const rest = eqMatch[2].trim();
      // Replace the line with the interface form so parseInterfaceBlockMultiline
      // can do its job. The `rest` may be empty (block starts on next line) or
      // contain the opening brace.
      const syntheticLine = rest
        ? `interface ${aliasName} ${rest}`
        : `interface ${aliasName} {`;
      const synthetic = [...lines];
      synthetic[startIndex] = syntheticLine;
      return parseInterfaceBlockMultiline(synthetic, startIndex, startBraceCount);
    }
  }
  if (firstLine.startsWith('oneof ')) {
    return parseOneofBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('transition ')) {
    return parseTransitionBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('service ')) {
    return parseServiceBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('provenance ')) {
    // Parse the provenance block body. Each clause is one of:
    //   `regulation "name" :: "note"`
    //   `design_decision "name" :: "note"`
    //   `parent_spec "name"`
    //   `external_doc "name" :: "url"`
    // The block may also be empty (clauses: []).
    const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
    const innerLines = lines.slice(startIndex + 1, endIdx)
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('//') && l !== '}');
    const clauses: ProvenanceClause[] = [];
    for (const line of innerLines) {
      const m = line.match(/^(regulation|design_decision|parent_spec|external_doc)\s+"([^"]+)"\s*(?:::)?\s*(?:"([^"]*)")?/);
      if (m) {
        const clause: ProvenanceClause = {
          type: m[1] as 'regulation' | 'design_decision' | 'parent_spec' | 'external_doc',
          value: m[2],
        };
        if (m[3]) clause.location = m[3];
        clauses.push(clause);
      }
    }
    return { type: 'provenance', clauses };
  }
  if (firstLine.startsWith('bom ')) {
    // Parse the bom block body. The body has a mix of:
    //   `compiler { name: "x", version: "y" }`  (braced form)
    //   `compiler: "x" version "y"`              (colon-quote form, used by RetryHandler.speck)
    //   `solver { name: "x", version: "y" }`
    //   `runtime { name: "x", version: "y" }`
    //   `license: "MIT"`
    const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
    const innerText = lines.slice(startIndex + 1, endIdx)
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith('//') && l !== '}')
      .join(' ');
    const bom: BOMNode = { type: 'bom' };
    // Try braced form first: compiler { name: "x", version: "y" }
    const compMatch = innerText.match(/compiler\s*\{\s*name:\s*"([^"]+)"(?:\s*,\s*version:\s*"([^"]*)")?\s*\}/);
    if (compMatch) bom.compiler = { name: compMatch[1], version: compMatch[2] };
    else {
      // Try colon-quote form: compiler: "x" version "y"
      const compMatch2 = innerText.match(/compiler:\s*"([^"]+)"(?:\s+version\s+"([^"]*)")?/);
      if (compMatch2) bom.compiler = { name: compMatch2[1], version: compMatch2[2] };
    }
    // Try braced form for solver
    const solvMatch = innerText.match(/solver\s*\{\s*name:\s*"([^"]+)"(?:\s*,\s*version:\s*"([^"]*)")?\s*\}/);
    if (solvMatch) bom.solver = { name: solvMatch[1], version: solvMatch[2] };
    else {
      // Try colon-quote form: solver: "x" version "y"
      const solvMatch2 = innerText.match(/solver:\s*"([^"]+)"(?:\s+version\s+"([^"]*)")?/);
      if (solvMatch2) bom.solver = { name: solvMatch2[1], version: solvMatch2[2] };
    }
    // Try braced form for runtime
    const runMatch = innerText.match(/runtime\s*\{\s*name:\s*"([^"]+)"(?:\s*,\s*version:\s*"([^"]*)")?\s*\}/);
    if (runMatch) bom.runtime = { name: runMatch[1], version: runMatch[2] };
    else {
      // Try colon-quote form: runtime: "x" version "y"
      const runMatch2 = innerText.match(/runtime:\s*"([^"]+)"(?:\s+version\s+"([^"]*)")?/);
      if (runMatch2) bom.runtime = { name: runMatch2[1], version: runMatch2[2] };
    }
    const licMatch = innerText.match(/license:\s*"([^"]+)"/);
    if (licMatch) bom.license = licMatch[1];
    const hashMatch = innerText.match(/hash:\s*"([^"]+)"/);
    if (hashMatch) bom.hash = hashMatch[1];
    return bom;
  }
  if (firstLine.startsWith('verify ')) {
    return parseVerifyBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('constraint ')) {
    return parseConstraintBlockMultiline(lines, startIndex, startBraceCount);
  }
  if (firstLine.startsWith('input:') || firstLine.startsWith('output:')) {
    return parseInputOutputBlock(lines, startIndex, startBraceCount);
  }

  return null;
}

/**
 * Parse a multi-line `input: { ... }` or `output: { ... }` block.
 *
 * The first line opens with `input: {` or `output: {` and the matching `}`
 * may be many lines later (with field declarations on intermediate lines).
 * We collect all lines up to the matching `}` (brace-counted) and join the
 * inner content into a single record string that `parseTypeExpr` already
 * knows how to handle.
 */
function parseInputOutputBlock(
  lines: string[],
  startIndex: number,
  startBraceCount: number,
): MemberNode | null {
  const header = lines[startIndex].trim();
  const isInput = header.startsWith('input:');
  const kind: 'input' | 'output' = isInput ? 'input' : 'output';

  // Collect inner content lines, brace-counting across the block.
  // startBraceCount is the brace count on the header line (1 for `input: {`).
  // We need to find the line where braceCount returns to 0 (i.e. the closing `}`).
  const innerLines: string[] = [];
  let braceCount = 0;
  let i = startIndex;
  // First pass: extract inner content from header line (everything after the first `{`).
  const headerLine = lines[startIndex].trim();
  const headerNoComment = headerLine.replace(/\/\/.*$/, '').trim();
  const openIdx = headerNoComment.indexOf('{');
  if (openIdx >= 0) {
    const after = headerNoComment.substring(openIdx + 1).trim();
    if (after) innerLines.push(after);
  }
  braceCount = 1; // we're inside one `{` from the header
  i = startIndex + 1;
  while (i < lines.length && braceCount > 0) {
    const raw = lines[i];
    const stripped = raw.trim();
    // Strip line comments (//...) — they cannot be inside a type expression.
    const noComment = stripped.replace(/\/\/.*$/, '').trim();
    for (const ch of noComment) {
      if (ch === '{') braceCount++;
      else if (ch === '}') braceCount--;
    }
    if (braceCount > 0 && noComment) {
      // Inside the block — keep content (skip the closing `}` line itself).
      innerLines.push(noComment);
    }
    i++;
  }

  // Join inner content with newlines; `parseTypeExpr`'s record branch
  // splits on commas and matches `name: type` pairs.
  const recordExpr = '{ ' + innerLines.join(' ') + ' }';
  const typeExpr = parseTypeExpr(recordExpr);
  return { type: kind, typeExpr };
}

function parseMember(line: string): MemberNode | null {
  // input:
  if (line.startsWith('input:')) {
    const typeExpr = parseTypeExpr(line.substring(6).trim());
    return { type: 'input', typeExpr };
  }
  
  // output:
  if (line.startsWith('output:')) {
    const typeExpr = parseTypeExpr(line.substring(7).trim());
    return { type: 'output', typeExpr };
  }
  
  // constraint Name: expr  (single-line named constraint)
  if (line.startsWith('constraint ')) {
    const match = line.match(/^constraint\s+(\w+):\s*(.+)$/);
    if (match) {
      return { type: 'constraint', name: match[1], expr: match[2].trim() };
    }
    return null; // multi-line constraint block (handled by parseMemberBlock)
  }
  
  // constraint: expr  (unnamed, single-line)
  if (line.startsWith('constraint:')) {
    return { type: 'constraint', expr: line.substring(11).trim() };
  }
  
  // verify Always(Name) { depth N } or verify Always(Name) (single-line forms)
  if (line.startsWith('verify ')) {
    return parseVerifySingleLine(line);
  }
  
  // verify: expr  (old unnamed single-line)
  if (line.startsWith('verify:')) {
    return { type: 'verify', name: 'unnamed', temporalExpr: line.substring(7).trim() };
  }
  
  // interface:
  if (line.startsWith('interface ')) {
    return parseInterface(line);
  }
  
  // event:
  if (line.startsWith('event ')) {
    return parseEvent(line);
  }

  // oneof:
  if (line.startsWith('oneof ')) {
    return parseOneof(line);
  }

  // transition:
  if (line.startsWith('transition ')) {
    return parseTransition(line);
  }
  
  // provenance {
  if (line.startsWith('provenance ')) {
    return { type: 'provenance', clauses: [] };
  }
  
  // review:
  if (line.startsWith('review:')) {
    const kind = line.substring(7).trim() as 'manual' | 'auto' | 'hybrid';
    return { type: 'review', kind };
  }
  
  // derives from:
  if (line.startsWith('derives from ')) {
    return parseDerives(line);
  }
  
  // satisfies:
  if (line.startsWith('satisfies ')) {
    return parseSatisfies(line);
  }
  
  // author:
  if (line.startsWith('author:')) {
    return parseAuthor(line);
  }
  
  // source:
  if (line.startsWith('source:')) {
    return parseSource(line);
  }
  
  // state: or state {
  if (line.startsWith('state:')) {
    const varsStr = line.substring(6).trim();
    // state: { ... } - single-line form
    if (varsStr.startsWith('{') && varsStr.endsWith('}')) {
      const inner = varsStr.slice(1, -1).trim();
      return parseStateBlock(inner);
    }
    // state: { - multi-line opening (handled by parseStateMultiline)
    return { type: 'state', variables: [] };
  }
  if (line.startsWith('state {') || line === 'state') {
    // state { ... } inline or state { on its own line (handled by parseMemberBlock)
    if (line.startsWith('state {')) {
      const inner = line.substring(6).trim();
      const content = inner.startsWith('{') ? inner.slice(1).trim() : inner;
      if (content.endsWith('}')) {
        return parseStateBlock(content.slice(0, -1).trim());
      }
    }
    return { type: 'state', variables: [] };
  }

  // init: or init {
  if (line.startsWith('init:')) {
    const initStr = line.substring(5).trim();
    if (initStr.startsWith('{') && initStr.endsWith('}')) {
      const inner = initStr.slice(1, -1).trim();
      return parseInitBlock(inner);
    }
    return { type: 'init', assignments: [] };
  }
  if (line.startsWith('init {') || line === 'init') {
    // init { ... } inline
    if (line.startsWith('init {')) {
      const inner = line.substring(5).trim();
      const content = inner.startsWith('{') ? inner.slice(1).trim() : inner;
      if (content.endsWith('}')) {
        return parseInitBlock(content.slice(0, -1).trim());
      }
    }
    return { type: 'init', assignments: [] };
  }

  // action keyword
  if (line.startsWith('action ')) {
    return parseActionHeader(line);
  }

  // bom {
  if (line.startsWith('bom ')) {
    // Simplified - full BOM block parsing would need multi-line context
    return {
      type: 'bom',
    };
  }
  
  return null;
}

function parseStateBlock(inner: string): StateNode {
  const variables: StateVar[] = [];
  if (!inner.trim()) return { type: 'state', variables };

  const varStrs = inner.split(/;|\n/).map(s => s.trim()).filter(Boolean);

  for (const vStr of varStrs) {
    const withDefault = vStr.match(/^(\w+)\s*:\s*(.+?)\s*:=\s*(.+)$/);
    if (withDefault) {
      // Strip trailing comments from type expression
      let typeStr = withDefault[2].trim();
      const commentIdx = typeStr.indexOf('//');
      if (commentIdx >= 0) typeStr = typeStr.substring(0, commentIdx).trim();
      variables.push({
        name: withDefault[1],
        typeExpr: parseTypeExpr(typeStr),
        defaultInit: withDefault[3].trim(),
      });
      continue;
    }
    const withoutDefault = vStr.match(/^(\w+)\s*:\s*(.+)$/);
    if (withoutDefault) {
      // Strip trailing comments from type expression
      let typeStr = withoutDefault[2].trim();
      const commentIdx = typeStr.indexOf('//');
      if (commentIdx >= 0) typeStr = typeStr.substring(0, commentIdx).trim();
      variables.push({
        name: withoutDefault[1],
        typeExpr: parseTypeExpr(typeStr),
      });
    }
  }

  return { type: 'state', variables };
}

function parseInitBlock(inner: string): InitNode {
  const assignments: { name: string; expr: string }[] = [];
  if (!inner.trim()) return { type: 'init', assignments };

  const assignStrs = inner.split(/;|\n/).map(s => s.trim()).filter(Boolean);

  for (const aStr of assignStrs) {
    const match = aStr.match(/^(\w+)\s*:=\s*(.+)$/);
    if (match) {
      assignments.push({ name: match[1], expr: match[2].trim() });
    }
  }

  return { type: 'init', assignments };
}

function parseActionHeader(line: string): ActionNode | null {
  const match = line.match(/^action\s+(\w+)\s*(?:\(([^)]*)\))?\s*\{/);
  if (!match) return null;

  const name = match[1];
  const paramsStr = match[2] || '';
  const params: { name: string; type: TypeExpr }[] = [];

  if (paramsStr.trim()) {
    const paramPairs = paramsStr.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of paramPairs) {
      const pMatch = p.match(/^(\w+)\s*:\s*(.+)$/);
      if (pMatch) {
        params.push({ name: pMatch[1], type: parseTypeExpr(pMatch[2].trim()) });
      }
    }
  }

  return { type: 'action', name, params, statements: [] };
}

function parseImportStatement(line: string): ImportNode {
  const match = line.match(/^import\s+(['"])(.+?)\1(?:\s+as\s+(\w+))?(?:\s+version\s+(['"])(.+?)\4)?(?:\s+hash\s+(['"])(.+?)\6)?/);
  if (!match) {
    throw new Error(`Failed to parse import statement: ${line}`);
  }
  
  const [, , path, , alias, , version, , hash] = match;
  
  return {
    type: 'import',
    path,
    alias,
    version: version || undefined,
    hash: hash || undefined,
  };
}

/**
 * Split a string on commas at bracket depth 0 (respecting <>, {}, () nesting).
 * Used by the interface parser to handle type expressions like Map<String, Nat>
 * whose internal commas should not be split.
 */
function splitOnTopLevelCommas(s: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<' || s[i] === '{' || s[i] === '(') depth++;
    else if (s[i] === '>' || s[i] === '}' || s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      tokens.push(s.substring(start, i).trim());
      start = i + 1;
    }
  }
  tokens.push(s.substring(start).trim());
  return tokens.filter(Boolean);
}

function parseTypeExpr(expr: string): TypeExpr {
  expr = expr.trim();
  
  // Primitive types
  const primitives = ['Nat', 'Int', 'Real', 'Bool', 'String', 'Bytes'];
  if (primitives.includes(expr)) {
    return { type: 'primitive', name: expr };
  }
  
  // List<T>
  if (expr.startsWith('List<') && expr.endsWith('>')) {
    const inner = expr.substring(5, expr.length - 1).trim();
    return { type: 'list', elementType: parseTypeExpr(inner) };
  }

  // Set<T>
  if (expr.startsWith('Set<') && expr.endsWith('>')) {
    const inner = expr.substring(4, expr.length - 1).trim();
    return { type: 'set', elementType: parseTypeExpr(inner) };
  }

  // Map<K, V>
  if (expr.startsWith('Map<') && expr.endsWith('>')) {
    const inner = expr.substring(4, expr.length - 1);
    // Find the first-level comma (not inside nested generics or record literals)
    let depth = 0;
    let braceDepth = 0;
    let commaIdx = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '<' || inner[i] === '(') depth++;
      else if (inner[i] === '>' || inner[i] === ')') depth--;
      else if (inner[i] === '{') braceDepth++;
      else if (inner[i] === '}') braceDepth--;
      else if (inner[i] === ',' && depth === 0 && braceDepth === 0) {
        commaIdx = i;
        break;
      }
    }
    if (commaIdx !== -1) {
      const keyStr = inner.substring(0, commaIdx).trim();
      const valStr = inner.substring(commaIdx + 1).trim();
      return { type: 'map', keyType: parseTypeExpr(keyStr), valueType: parseTypeExpr(valStr) };
    }
    // Fallback: treat as ident if malformed
    return { type: 'ident', name: expr };
  }

  // List(T) — parenthetical syntax (SpeckDL canonical form)
  if (expr.startsWith('List(') && expr.endsWith(')')) {
    const inner = expr.substring(5, expr.length - 1).trim();
    return { type: 'list', elementType: parseTypeExpr(inner) };
  }

  // Set(T) — parenthetical syntax (SpeckDL canonical form)
  if (expr.startsWith('Set(') && expr.endsWith(')')) {
    const inner = expr.substring(4, expr.length - 1).trim();
    return { type: 'set', elementType: parseTypeExpr(inner) };
  }

  // Map(K, V) — parenthetical syntax (SpeckDL canonical form)
  if (expr.startsWith('Map(') && expr.endsWith(')')) {
    const inner = expr.substring(4, expr.length - 1);
    let depth = 0;
    let braceDepth = 0;
    let commaIdx = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '(' || inner[i] === '<') depth++;
      else if (inner[i] === ')' || inner[i] === '>') depth--;
      else if (inner[i] === '{') braceDepth++;
      else if (inner[i] === '}') braceDepth--;
      else if (inner[i] === ',' && depth === 0 && braceDepth === 0) {
        commaIdx = i;
        break;
      }
    }
    if (commaIdx !== -1) {
      const keyStr = inner.substring(0, commaIdx).trim();
      const valStr = inner.substring(commaIdx + 1).trim();
      return { type: 'map', keyType: parseTypeExpr(keyStr), valueType: parseTypeExpr(valStr) };
    }
    // Fallback: treat as ident if malformed
    return { type: 'ident', name: expr };
  }
  
  // List type: [T]
  if (expr.startsWith('[') && expr.endsWith(']')) {
    const elementType = parseTypeExpr(expr.substring(1, expr.length - 1));
    return { type: 'list', elementType };
  }
  
  // Record type: { ... }
  if (expr.startsWith('{') && expr.endsWith('}')) {
    const content = expr.substring(1, expr.length - 1).trim();
    const fields: { name: string; type: TypeExpr }[] = [];
    
    if (content) {
      // Split by comma and parse each field
      const fieldStrs = content.split(',').map(s => s.trim());
      for (const fieldStr of fieldStrs) {
        const fieldMatch = fieldStr.match(/^(\w+)\s*:\s*(.+)$/);
        if (fieldMatch) {
          const [, name, typeStr] = fieldMatch;
          fields.push({ name, type: parseTypeExpr(typeStr.trim()) });
        }
      }
    }
    
    return { type: 'record', fields };
  }
  
  // Nullable type: T | null — must be checked before the ident fallback.
  // Detects a top-level `| null` (with optional surrounding whitespace)
  // and recurses on the left side. Sets the `nullable` flag on the result.
  //   "String | null"          → { type: 'primitive', name: 'String', nullable: true }
  //   "List<String> | null"    → { type: 'list', elementType: {...}, nullable: true }
  //   "CustomerStatus | null"  → { type: 'ident', name: 'CustomerStatus', nullable: true }
  if (expr.includes('|')) {
    // Find the first top-level `|`. Don't split inside `<...>`, `(...)`,
    // `{...}` since those may be generic/record/parenthetical forms.
    let depth = 0;
    let braceDepth = 0;
    let pipeIdx = -1;
    for (let i = 0; i < expr.length; i++) {
      const c = expr[i];
      if (c === '<' || c === '(') depth++;
      else if (c === '>' || c === ')') depth--;
      else if (c === '{') braceDepth++;
      else if (c === '}') braceDepth--;
      else if (c === '|' && depth === 0 && braceDepth === 0) {
        pipeIdx = i;
        break;
      }
    }
    if (pipeIdx !== -1) {
      const left = expr.substring(0, pipeIdx).trim();
      const right = expr.substring(pipeIdx + 1).trim();
      if (right === 'null') {
        const inner = parseTypeExpr(left);
        inner.nullable = true;
        return inner;
      }
    }
  }

  // Identifier (for interface references, etc.)
  return { type: 'ident', name: expr };
}

function parseInterface(line: string): InterfaceNode {
  // interface Name {
  const match = line.match(/^interface\s+(\w+)\s*{/);
  if (!match) {
    throw new Error(`Failed to parse interface: ${line}`);
  }

  const name = match[1];

  // Header-only; parseInterfaceBlockMultiline fills in methods/fields/kind
  // by scanning the lines inside the { ... } block.
  return {
    type: 'interface',
    name,
    kind: 'mixed',
    methods: [],
    fields: [],
  };
}

function parseEvent(line: string): EventNode {
  // event Name {
  const match = line.match(/^event\s+(\w+)\s*{/);
  if (!match) {
    throw new Error(`Failed to parse event: ${line}`);
  }

  const name = match[1];

  return {
    type: 'event',
    name,
    fields: [],
  };
}

// Cycle 57: parse `oneof Name {` (header only; parseOneofBlockMultiline fills variants).
function parseOneof(line: string): OneofNode {
  // oneof Name {
  const match = line.match(/^oneof\s+(\w+)\s*{/);
  if (!match) {
    throw new Error(`Failed to parse oneof: ${line}`);
  }
  return {
    type: 'oneof',
    name: match[1],
    variants: [],
  };
}

// Cycle 58: parse `transition Name {` (header only; parseTransitionBlockMultiline fills fields + payload-oneof).
function parseTransition(line: string): TransitionNode {
  // transition Name {
  const match = line.match(/^transition\s+(\w+)\s*{/);
  if (!match) {
    throw new Error(`Failed to parse transition: ${line}`);
  }
  return {
    type: 'transition',
    name: match[1],
    fields: [],
  };
}

function parseProvenanceBlock(lines: string[], line: string): ProvenanceNode {
  // This is a simplified parser - in a real implementation, we'd parse the full block
  return {
    type: 'provenance',
    clauses: [],
  };
}

function parseDerives(line: string): DerivesNode {
  // derives from Name via "rationale"
  const match = line.match(/^derives\s+from\s+(\w+(?:-\w+)*)(?:\s+via\s+(['"])(.+?)\2)?/);
  if (!match) {
    console.warn(`Failed to parse derives statement: ${line}`);
    return { type: 'derives', from: 'unknown' };
  }
  
  const [, from, , via] = match;
  
  return {
    type: 'derives',
    from,
    via: via || undefined,
  };
}

function parseSatisfies(line: string): SatisfiesNode {
  // satisfies Name [clause "X.Y.Z"]
  // e.g., satisfies RESILIENCE-REQ-01 clause "3.1.2"
  // e.g., satisfies RESILIENCE-REQ-02
  const match = line.match(/^satisfies\s+([\w-]+(?:-[\w]+)*)(?:\s+clause\s+(['"])(.+?)\2)?/);
  if (!match) {
    console.warn(`Failed to parse satisfies statement: ${line}`);
    return { type: 'satisfies', requirement: 'unknown' };
  }
  
  const [, requirement, , clause] = match;
  
  return {
    type: 'satisfies',
    requirement,
    clause: clause || undefined,
  };
}

function parseAuthor(line: string): AuthorNode {
  // author: "Name" <"email">
  // e.g., author: "Scott Scoble" <"scott@scoble.me">
  const match = line.match(/^author:\s+(['"])(.+?)\1(?:\s+<(['"])(.+?)\3>)?/);
  if (!match) {
    // Try without angle brackets or with different format
    console.warn(`Failed to parse author statement: ${line}`);
    return { type: 'author', name: 'unknown' };
  }
  
  const [, , name, , email] = match;
  
  return {
    type: 'author',
    name,
    email: email || undefined,
  };
}

function parseSource(line: string): SourceNode {
  // source: kind ref "identifier"
  // e.g., source: architecture_review ref "AR-2024-0215"
  const match = line.match(/^source:\s+(\w+)(?:\s+ref\s+(['"])(.+?)\2)?/);
  if (!match) {
    console.warn(`Failed to parse source statement: ${line}`);
    return { type: 'source', kind: 'document' };
  }
  
  const [, kind, , ref] = match;
  const validKinds = [
    'conversation', 'meeting', 'document', 'regulation',
    'architecture_review', 'threat_model', 'compliance_audit'
  ];
  
  if (!validKinds.includes(kind)) {
    console.warn(`Invalid source kind: ${kind}, defaulting to document`);
    return { type: 'source', kind: 'document', ref: ref || undefined };
  }
  
  return {
    type: 'source',
    kind: kind as any,
    ref: ref || undefined,
  };
}

function parseStateBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): StateNode {
  // Cycle 59: support `state as <MessageName> { ... }` to override the
  // generated .proto message name. Default (no `as`) keeps the existing
  // `message <SpeckName>State { ... }` convention.
  const headerLine = lines[startIndex].trim();
  const asMatch = headerLine.match(/^state\s+as\s+(\w+)\s*{/);
  const messageName = asMatch ? asMatch[1] : undefined;

  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  // State blocks separate fields with commas or newlines/semicolons.
  // Strip trailing commas (they are field separators, not continuations)
  // then join with semicolons between complete variable declarations.
  const cleanedLines = innerLines.map(l => l.replace(/,+\s*$/, ''));
  const inner = cleanedLines.reduce((acc, line, i) => {
    if (i === 0) return line;
    const prevLine = cleanedLines[i - 1];
    // Check if this line starts a new variable declaration (name: type)
    const isNewVar = /^\w+\s*:/.test(line);
    // Check if prev line ends with a continuation character (brace or paren, NOT comma)
    const prevIsContinuation = /[{(]\s*$/.test(prevLine);
    if (isNewVar && !prevIsContinuation) {
      return acc + '; ' + line;
    }
    return acc + ' ' + line;
  }, '');
  const result = parseStateBlock(inner);
  if (messageName !== undefined) result.messageName = messageName;
  return result;
}

function parseInitBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): InitNode {
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  // Init blocks separate fields with commas or newlines/semicolons.
  // Strip trailing commas and join with semicolons.
  const cleanedLines = innerLines.map(l => l.replace(/,+\s*$/, ''));
  const inner = cleanedLines.reduce((acc, line, i) => {
    if (i === 0) return line;
    const prevLine = cleanedLines[i - 1];
    const isNewVar = /^\w+\s*:/.test(line);
    const prevIsContinuation = /[{(]\s*$/.test(prevLine);
    if (isNewVar && !prevIsContinuation) {
      return acc + '; ' + line;
    }
    return acc + ' ' + line;
  }, '');
  return parseInitBlock(inner);
}

function parseActionBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): ActionNode | null {
  const firstLine = lines[startIndex].trim();
  const header = parseActionHeader(firstLine);
  if (!header) return null;

  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  // Keep blank lines as null to separate statements, filter only comments
  const bodyLinesRaw = lines.slice(startIndex + 1, endIndex).map(l => {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) return null;
    return trimmed;
  });
  // Collapse consecutive nulls and strip trailing nulls
  const bodyLines: (string | null)[] = [];
  for (const line of bodyLinesRaw) {
    if (line !== null || (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] !== null)) {
      bodyLines.push(line);
    }
  }
  // Remove trailing nulls
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === null) {
    bodyLines.pop();
  }

  const statements: ActionStatement[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const stmtOrNull = bodyLines[i];
    // Skip blank line separators
    if (stmtOrNull === null) continue;
    const stmt = stmtOrNull;
    // precondition: expr
    if (stmt.startsWith('precondition:')) {
      let expr = stmt.substring(13).trim();
      // support 'or' continuation lines
      while (i + 1 < bodyLines.length) {
        const nextLine = bodyLines[i + 1];
        if (nextLine === null || !nextLine.startsWith('or ')) break;
        i++;
        expr += ' || ' + nextLine.substring(3).trim();
      }
      statements.push({ type: 'precondition', expr });
      continue;
    }
    // postcondition: expr
    if (stmt.startsWith('postcondition:')) {
      let expr = stmt.substring(14).trim();
      // support 'or' continuation lines
      while (i + 1 < bodyLines.length) {
        const nextLine = bodyLines[i + 1];
        if (nextLine === null || !nextLine.startsWith('or ')) break;
        i++;
        expr += ' || ' + nextLine.substring(3).trim();
      }
      statements.push({ type: 'postcondition', expr });
      continue;
    }
    // require expr
    if (stmt.startsWith('require ')) {
      let expr = stmt.substring(8).trim();
      // support multi-line continuation (forall, or, etc.)
      while (i + 1 < bodyLines.length) {
        const nextLine = bodyLines[i + 1];
        if (nextLine === null) break;
        // Stop if next line starts a new statement keyword
        if (nextLine.startsWith('precondition:') || nextLine.startsWith('postcondition:') ||
            nextLine.startsWith('require ') || nextLine.startsWith('return ') ||
            nextLine.startsWith('emit ') || nextLine.startsWith('let ') ||
            nextLine.includes(':=')) {
          break;
        }
        i++;
        expr += ' ' + nextLine;
      }
      statements.push({ type: 'require', expr });
      continue;
    }
    // return expr
    if (stmt.startsWith('return ')) {
      statements.push({ type: 'return', expr: stmt.substring(7).trim() });
      continue;
    }
    // emit Event { fields }
    const emitMatch = stmt.match(/^emit\s+(\w+)\s*\{\s*(.*)\s*\}$/);
    if (emitMatch) {
      const eventName = emitMatch[1];
      const fieldsStr = emitMatch[2];
      const fields: { name: string; value: string }[] = [];
      if (fieldsStr) {
        const fieldPairs = splitFields(fieldsStr);
        for (const fp of fieldPairs) {
          const colonIdx = fp.indexOf(':');
          if (colonIdx > 0) {
            fields.push({
              name: fp.substring(0, colonIdx).trim(),
              value: fp.substring(colonIdx + 1).trim(),
            });
          }
        }
      }
      statements.push({ type: 'emit', event: eventName, fields });
      continue;
    }
    // if condition { ... } else if condition { ... } else { ... }
    // SpeckDL conditional blocks - parse as a special statement type
    if (stmt.startsWith('if ')) {
      // Find matching } for this if block (may span multiple bodyLines entries)
      let braceDepth = 0;
      let j = i;
      const blockLines: string[] = [];
      while (j < bodyLines.length) {
        const line = bodyLines[j];
        if (line === null) { j++; continue; }
        blockLines.push(line);
        for (const ch of line) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        j++;
        if (braceDepth === 0) break;
      }
      // For now, treat as a raw 'ifblock' statement that the generator can handle
      statements.push({ type: 'ifblock', raw: blockLines.join(' ') });
      i = j - 1; // skip to end of if block
      continue;
    }
    // let name := expr
    const letMatch = stmt.match(/^let\s+(\w+)\s*:=\s*(.+)$/);
    if (letMatch) {
      statements.push({ type: 'let', name: letMatch[1], expr: letMatch[2].trim() });
      continue;
    }
    // assignment: target := expr (may span multiple lines)
    const assignMatch = stmt.match(/^(\w+(?:\[.*?\])?)\s*:=\s*(.+)$/);
    if (assignMatch) {
      let target = assignMatch[1];
      let expr = assignMatch[2].trim();
      // Handle multiline expressions: join subsequent lines until braces/parens are balanced
      while (i + 1 < bodyLines.length && !isExpressionComplete(expr)) {
        i++;
        expr += ' ' + bodyLines[i];
      }
      statements.push({ type: 'assign', target, expr });
    }
  }

  return { ...header, statements };
}

function parseEventBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): EventNode {
  const firstLine = lines[startIndex].trim();
  const header = parseEvent(firstLine);
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

  const fields: { name: string; type: TypeExpr }[] = [];
  for (const line of innerLines) {
    // Cycle 62: strip inline `//` line-comments from the type expression
    // before parsing. Without this, an event field like
    //   mesh_ip: Bytes   // 4 bytes (IPv4 overlay)
    // produces a TypeExpr whose name includes the comment text, which
    // the .proto generator emits verbatim:
    //   bytes  // 4 bytes (IPv4 overlay) mesh_ip = 2;
    // (broken syntax — comment is in the type position).
    const noComment = line.replace(/\/\/.*$/, '').trim();
    // Cycle 65: strip default-value suffix `= <expr>` from the type
    // expression. The federated-meetup speckdl has fields like
    //   initial_mesh_peers: List<InitialMeshPeer> = []
    // where the default is meaningful in Speckl semantics (a state-
    // machine init) but the .proto wire format doesn't carry a
    // default — it's a generator concern. Without this, the type
    // expression was emitted as `List<InitialMeshPeer> = []` and
    // protoc rejects the resulting syntax.
    const noDefault = noComment.replace(/\s*=\s*[^,]+$/, '').trim();
    const match = noDefault.match(/^(\w+)\s*:\s*(.+?),?$/);
    if (match) {
      fields.push({ name: match[1], type: parseTypeExpr(match[2].replace(/,$/, '').trim()) });
    }
  }

  return { ...header, fields };
}

function parseInterfaceBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): InterfaceNode {
  const firstLine = lines[startIndex].trim();
  const header = parseInterface(firstLine);
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

  const methods: MethodSignature[] = [];
  const fields: InterfaceField[] = [];

  for (const line of innerLines) {
    // Cycle 62: strip inline `//` line-comments from each line before
    // token-splitting. Without this, a field like
    //   mesh_ip: Bytes   // 4 bytes (IPv4 overlay)
    // has its comment text bleed into the parsed type expression,
    // which the .proto generator emits verbatim — broken syntax.
    const noComment = line.replace(/\/\/.*$/, '').trim();
    if (!noComment) continue;
    // Split on commas at depth 0 (respecting <>, {}, () nesting) so that
    // type expressions like Map<String, Nat> don't get split at the
    // internal comma. Previously, a naive split(',') would break
    // Map<String, Nat> into "Map<String" and "Nat>", producing a
    // malformed TypeExpr with type='ident' name='Map<String'.
    const tokens = splitOnTopLevelCommas(noComment);
    for (const token of tokens) {
      // Check 1: method signature form: name(params) -> returnType
      const methodMatch = token.match(/^(\w+)\s*\(([^)]*)\)\s*->\s*(.+?),?$/);
      if (methodMatch) {
        const name = methodMatch[1];
        const paramsStr = methodMatch[2];
        const returnTypeStr = methodMatch[3].replace(/,$/, '').trim();
        const params: { name: string; type: TypeExpr }[] = [];
        if (paramsStr.trim()) {
          const paramPairs = paramsStr.split(',').map(s => s.trim()).filter(Boolean);
          for (const p of paramPairs) {
            const pMatch = p.match(/^(\w+)\s*:\s*(.+)$/);
            if (pMatch) {
              params.push({ name: pMatch[1], type: parseTypeExpr(pMatch[2].trim()) });
            }
          }
        }
        methods.push({ name, params, returnType: parseTypeExpr(returnTypeStr) });
        continue;
      }

      // Check 2: field declaration form: field_name: TypeName
      // Lowercase-starting identifier followed by ':' — record-style interface
      const fieldMatch = token.match(/^(\w+)\s*:\s*(.+)$/);
      if (fieldMatch && /^[a-z_]/.test(fieldMatch[1])) {
        fields.push({ name: fieldMatch[1], type: parseTypeExpr(fieldMatch[2].trim()) });
        continue;
      }

      // Check 3: bare identifier (enum variant) — name only, no params
      if (/^\w+$/.test(token)) {
        methods.push({ name: token, params: [], returnType: parseTypeExpr('Void') });
      }
    }
  }

  // Determine the kind based on what we collected
  let kind: 'enum' | 'record' | 'service' | 'mixed' = 'mixed';
  if (fields.length > 0 && methods.length === 0) {
    kind = 'record';
  } else if (methods.length > 0 && fields.length === 0) {
    // Distinguish enum (all methods have empty params and Void return) from service
    const allEnumLike = methods.every(m => m.params.length === 0 && m.returnType.name === 'Void');
    kind = allEnumLike ? 'enum' : 'service';
  }

  return { ...header, kind, methods, fields };
}

// Cycle 57: parse a `oneof Name { ... }` block. Each non-empty, non-comment
// inner line is `field_name: TypeName`. The wire field_name follows
// lowerCamelCase convention (TypeScript/Connect) and is emitted to .proto
// as snake_case by the generator.
function parseOneofBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): OneofNode {
  const firstLine = lines[startIndex].trim();
  const header = parseOneof(firstLine);
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

  const variants: OneofVariant[] = [];
  for (const line of innerLines) {
    // Strip trailing comma or semicolon (proto-style "create_group: CreateGroup," is valid).
    const trimmed = line.replace(/[,;]\s*$/, '');
    const m = trimmed.match(/^(\w+)\s*:\s*(\w+)\s*$/);
    if (m) {
      variants.push({ fieldName: m[1], typeName: m[2] });
    }
  }

  return { ...header, variants };
}

// Cycle 58: parse a `transition Name { ... }` block. Each non-empty,
// non-comment inner line is `field_name: TypeName`. Two field names
// have special meaning:
//   - `payload: <OneofName>` — references a sibling `oneof` block;
//     the proto generator will emit the variants inline as
//     `oneof payload { ... }` inside the message body
//   - `type: <EnumName>` — the discriminator enum for the variants
//   Other fields are emitted as ordinary proto message fields.
function parseTransitionBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): TransitionNode {
  const firstLine = lines[startIndex].trim();
  const header = parseTransition(firstLine);
  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

  const fields: TransitionField[] = [];
  let payloadOneof: string | undefined;
  let typeDiscriminator: string | undefined;

  for (const line of innerLines) {
    const trimmed = line.replace(/[,;]\s*$/, '');
    const m = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) continue;
    const fieldName = m[1];
    const typeStr = m[2].trim();

    if (fieldName === 'payload') {
      // The type is the name of a sibling oneof block.
      payloadOneof = typeStr;
      // Don't add a regular field for payload — it becomes the oneof.
      continue;
    }
    if (fieldName === 'type') {
      // The type is the name of a discriminator enum.
      typeDiscriminator = typeStr;
      // Don't add a regular field for type — it's a special discriminator.
      continue;
    }
    fields.push({ name: fieldName, type: parseTypeExpr(typeStr) });
  }

  const result: TransitionNode = { ...header, fields };
  if (payloadOneof !== undefined) result.payloadOneof = payloadOneof;
  if (typeDiscriminator !== undefined) result.typeDiscriminator = typeDiscriminator;
  return result;
}

function parseServiceBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): ServiceNode {
  // service Name {
  const firstLine = lines[startIndex].trim();
  const match = firstLine.match(/^service\s+(\w+)\s*{?/);
  const name = match ? match[1] : 'UnnamedService';

  const endIndex = findBlockEnd(lines, startIndex + 1, startBraceCount);
  const innerLines = lines.slice(startIndex + 1, endIndex).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

  const rpcs: RpcMethod[] = [];
  for (const line of innerLines) {
    // rpc MethodName(RequestType) returns (ResponseType);
    // Also support streaming: rpc M(stream R) returns (S); or rpc M(R) returns (stream S);
    const rpcMatch = line.match(/^rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)\s*;?$/);
    if (rpcMatch) {
      const methodName = rpcMatch[1];
      const clientStream = !!rpcMatch[2];
      const requestType = rpcMatch[3];
      const serverStream = !!rpcMatch[4];
      const responseType = rpcMatch[5];
      rpcs.push({
        name: methodName,
        requestType,
        responseType,
        clientStreaming: clientStream,
        serverStreaming: serverStream,
      });
    } else {
      // Cycle 73: error on unrecognized lines inside service blocks.
      // Previously, a typo like `rc_purchase_ticket(...)` (missing the `p`
      // in `rpc`) was silently swallowed — the line didn't match the
      // rpc regex, so it was skipped without error. Silent data loss in
      // a spec compiler is unacceptable; the whole point is that the
      // spec is the source of truth.
      throw new Error(
        `Parse error in service block: unrecognized line "${line}". ` +
        `Expected: rpc MethodName(RequestType) returns (ResponseType);`
      );
    }
  }

  return { type: 'service', name, rpcs };
}

// --- Multi-line constraint/verify parsing (no braces needed) ---

/**
 * Parse a constraint or verify that may span multiple lines without braces.
 * Used for forall-style constraints like:
 *   constraint Name: forall r in [0..4]:
 *       (expr)
 *
 * and verify blocks like:
 *   verify Always(Name)
 *   verify Always(Name) { depth N }
 */
function parseMultiLineConstraintVerify(lines: string[], startIndex: number): MemberNode | null {
  const line = lines[startIndex].trim();

  if (line.startsWith('verify ')) {
    return parseVerifyAnyForm(lines, startIndex);
  }

  // Multi-line `verify:` form: verify: always(implies(\n  ...\n))
  // The body opens parens that span multiple lines; collect continuation
  // lines until parens balance to zero, then return the joined string as
  // the temporalExpr. speckl#54.
  if (line.startsWith('verify:')) {
    return parseVerifyColonBlock(lines, startIndex);
  }

  if (line.startsWith('constraint ')) {
    return parseConstraintAnyForm(lines, startIndex);
  }

  // Multi-line `constraint:` form: constraint: forall p1 in ...:
  //   forall p2 in ...:
  //     implies(...)
  // The body may span multiple lines; collect continuation lines until
  // the expression is complete (balanced parens/brackets/braces).
  if (line.startsWith('constraint:')) {
    return parseConstraintColonBlock(lines, startIndex);
  }

  return null;
}

/**
 * Parse the `verify: <expr>` form (speckl#54) where the body can span
 * multiple lines:
 *
 *   verify: always(implies(
 *     cond1,
 *     cond2
 *   ))
 *
 * The whole expression (the part after `verify:`) is collected by
 * appending subsequent non-empty, non-keyword-starting lines until
 * parens/brackets/braces balance to zero. The joined string is stored
 * in `temporalExpr` so the downstream LTL translator (typescript-state-machine
 * verifyN()) sees a well-formed formula.
 *
 * The `name` is derived from the LTL operator's argument when it matches
 * `always(Name)` / `eventually(Name)`. When the body is a richer expression
 * (e.g. `always(implies(...))`) we fall back to `unnamed` — the generator
 * still emits a working verifyN() that uses the full expression.
 */
function parseVerifyColonBlock(lines: string[], startIndex: number): VerifyNode | null {
  const firstLine = lines[startIndex].trim();
  // Strip the `verify:` prefix.
  const head = firstLine.substring(firstLine.indexOf(':') + 1).trim();
  if (!head) return null;

  // If the head is already balanced on its own (single-line verify: expr),
  // just return it directly — no continuation needed.
  if (isExpressionComplete(head)) {
    const nameMatch = head.match(/^(?:always|Always|eventually|Eventually)\s*\(\s*(\w+)\s*\)$/);
    return {
      type: 'verify',
      name: nameMatch ? nameMatch[1] : 'unnamed',
      temporalExpr: head,
    };
  }

  // Multi-line: collect continuation lines until parens balance. The same
  // break-condition list used in the parseSpeck skip-loop applies (don't
  // swallow the next member's keyword). We additionally stop at any
  // standalone `}` so a verify inside a brace-block still terminates.
  const parts: string[] = [head];
  let parens = 0, brackets = 0, braces = 0;
  for (const ch of head) {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
  }

  let lastConsumed = startIndex;
  for (let j = startIndex + 1; j < lines.length; j++) {
    const raw = lines[j];
    const nl = raw.trim();
    if (!nl) {
      // Empty line still updates counters (none) and advances lastConsumed
      lastConsumed = j;
      continue;
    }
    if (nl.startsWith('//') || nl.startsWith('/*')) {
      // Skip standalone comments but treat them as part of the block
      // (the LTL translator doesn't care about comments in temporalExpr).
      lastConsumed = j;
      continue;
    }
    // Stop at a new top-level member keyword — that's the next member.
    if (
      nl.startsWith('constraint ') || nl.startsWith('verify ') ||
      nl.startsWith('constraint:') || nl.startsWith('verify:') ||
      nl.startsWith('state') || nl.startsWith('init') ||
      nl.startsWith('action ') || nl.startsWith('event ') ||
      nl.startsWith('interface ') || nl.startsWith('provenance ') ||
      nl.startsWith('bom ') || nl === '}' ||
      nl.startsWith('next:') || nl.startsWith('invariant ')
    ) {
      break;
    }
    // Update depth counters.
    for (const ch of raw) {
      if (ch === '(') parens++;
      else if (ch === ')') parens--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
      else if (ch === '{') braces++;
      else if (ch === '}') braces--;
    }
    parts.push(nl);
    lastConsumed = j;
    if (parens === 0 && brackets === 0 && braces === 0) {
      break;
    }
  }

  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  const nameMatch = joined.match(/^(?:always|Always|eventually|Eventually)\s*\(\s*(\w+)\s*\)$/);
  return {
    type: 'verify',
    name: nameMatch ? nameMatch[1] : 'unnamed',
    temporalExpr: joined,
  };
}

/**
 * Parse the `constraint: <expr>` form where the body can span
 * multiple lines (e.g. nested forall with indented body):
 *
 *   constraint: forall p1 in initial_mesh_peers:
 *     forall p2 in initial_mesh_peers:
 *       implies(p1 != p2, ...)
 *
 * The whole expression (the part after `constraint:`) is collected by
 * appending subsequent non-empty, non-keyword-starting lines until
 * parens/brackets/braces balance to zero.
 */
function parseConstraintColonBlock(lines: string[], startIndex: number): ConstraintNode | null {
  const firstLine = lines[startIndex].trim();
  // Strip the `constraint:` prefix.
  const head = firstLine.substring(firstLine.indexOf(':') + 1).trim();
  if (!head) return null;

  // If the head is already balanced on its own (single-line constraint: expr),
  // just return it directly — no continuation needed.
  if (isExpressionComplete(head)) {
    return { type: 'constraint', expr: head };
  }

  // Multi-line: collect continuation lines until parens balance.
  const parts: string[] = [head];
  let parens = 0, brackets = 0, braces = 0;
  for (const ch of head) {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
  }

  let lastConsumed = startIndex;
  for (let j = startIndex + 1; j < lines.length; j++) {
    const raw = lines[j];
    const nl = raw.trim();
    if (!nl) {
      lastConsumed = j;
      continue;
    }
    if (nl.startsWith('//') || nl.startsWith('/*')) {
      lastConsumed = j;
      continue;
    }
    // Stop at a new top-level member keyword.
    if (
      nl.startsWith('constraint ') || nl.startsWith('verify ') ||
      nl.startsWith('constraint:') || nl.startsWith('verify:') ||
      nl.startsWith('state') || nl.startsWith('init') ||
      nl.startsWith('action ') || nl.startsWith('event ') ||
      nl.startsWith('interface ') || nl.startsWith('provenance ') ||
      nl.startsWith('bom ') || nl === '}' ||
      nl.startsWith('next:') || nl.startsWith('invariant ')
    ) {
      break;
    }
    // Update depth counters.
    for (const ch of raw) {
      if (ch === '(') parens++;
      else if (ch === ')') parens--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
      else if (ch === '{') braces++;
      else if (ch === '}') braces--;
    }
    parts.push(nl);
    lastConsumed = j;
    if (parens === 0 && brackets === 0 && braces === 0) {
      break;
    }
  }

  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return { type: 'constraint', expr: joined };
}

function parseConstraintAnyForm(lines: string[], startIndex: number): ConstraintNode | null {
  const line = lines[startIndex].trim();

  // Form 1: `constraint Name: <expr>` — bare-word name with colon.
  const namedMatch = line.match(/^constraint\s+(\w+):(.*)$/);
  // Form 2: `constraint "name with spaces" { <expr> }` — quoted name with brace.
  // Form 3: `constraint "name" : <expr>` — quoted name with colon.
  const quotedMatch = line.match(/^constraint\s+"([^"]+)"\s*(\{|:)(.*)$/);

  let name: string;
  let expr: string;
  let exprFollows: 'colon' | 'brace';

  if (namedMatch) {
    name = namedMatch[1];
    expr = namedMatch[2].trim();
    exprFollows = 'colon';
  } else if (quotedMatch) {
    name = quotedMatch[1];
    exprFollows = quotedMatch[2] === '{' ? 'brace' : 'colon';
    expr = (exprFollows === 'colon' ? quotedMatch[3] : quotedMatch[3].trim());
  } else {
    return null;
  }
  
  // If opens a brace, treat as block
  if (exprFollows === 'brace' || expr.startsWith('{')) {
    // Strip the leading '{' from expr if it was passed in via the colon form
    if (expr.startsWith('{')) expr = expr.substring(1).trim();
    const openCount = (line.match(/{/g) || []).length;
    const endIdx = findBlockEnd(lines, startIndex + 1, openCount);
    const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && l !== '}');
    const inner = innerLines.join(' ');
    expr = (expr + ' ' + inner).trim();
  } else {
    // No braces — but might span multiple lines (forall continuation)
    const continuationLines: string[] = [];
    for (let j = startIndex + 1; j < lines.length; j++) {
      const nl = lines[j].trim();
      if (!nl || nl.startsWith('//') || nl.startsWith('/*') ||
          nl.startsWith('constraint ') || nl.startsWith('verify ') ||
          nl.startsWith('constraint:') || nl.startsWith('verify:') ||
          nl.startsWith('state') || nl.startsWith('init') ||
          nl.startsWith('action ') || nl.startsWith('event ') ||
          nl.startsWith('interface ') || nl.startsWith('provenance ') ||
          nl.startsWith('bom ') || nl.startsWith('}') ||
          nl.startsWith('next:') || nl.startsWith('invariant ')) {
        break;
      }
      continuationLines.push(nl);
    }
    if (continuationLines.length > 0) {
      expr = expr + ' ' + continuationLines.join(' ');
    }
  }
  
  return { type: 'constraint', name, expr: expr.trim() };
}

function parseVerifyAnyForm(lines: string[], startIndex: number): VerifyNode | null {
  const line = lines[startIndex].trim();
  
  // Single-line: verify Always(Name) { depth N }
  const fullMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*\{\s*depth\s+(\d+)\s*\}/);
  if (fullMatch) {
    return {
      type: 'verify',
      name: fullMatch[2],
      temporalExpr: fullMatch[1].trim(),
      depth: parseInt(fullMatch[3], 10),
    };
  }
  
  // Multi-line: verify Always(Name) { ... }
  if (line.includes('{')) {
    const headerMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*\{/);
    if (headerMatch) {
      const temporalExpr = headerMatch[1].trim();
      const name = headerMatch[2];
      
      const openCount = (line.match(/{/g) || []).length;
      const endIdx = findBlockEnd(lines, startIndex + 1, openCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
      const inner = innerLines.join(' ');
      
      const afterBrace = line.substring(line.indexOf('{') + 1).trim();
      const combined = (afterBrace + ' ' + inner).trim();
      const depthMatch = combined.match(/\bdepth\s+(\d+)\b/);
      const depth = depthMatch ? parseInt(depthMatch[1], 10) : undefined;
      
      return { type: 'verify', name, temporalExpr, depth };
    }
  }
  
  // Simple: verify Always(Name)
  const simpleMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*$/);
  if (simpleMatch) {
    return {
      type: 'verify',
      name: simpleMatch[2],
      temporalExpr: simpleMatch[1].trim(),
    };
  }
  
  return null;
}

// --- Verify/Constraint block parsing ---

/**
 * Parse a verify block opened with `verify Always(Name) { ... }` or similar.
 * The first line already contains the header; we need to parse the body inside { }.
 */
function parseVerifyBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): VerifyNode | null {
  const firstLine = lines[startIndex].trim();
  
  // Form 1: verify "quoted name" [depth N] { body }
  // The quoted name can contain spaces. depth is optional. Body is inside { }.
  const quotedHeaderMatch = firstLine.match(/^verify\s+"([^"]+)"\s*(?:depth\s+(\d+)\s*)?\{/);
  if (quotedHeaderMatch) {
    const name = quotedHeaderMatch[1];
    const depth = quotedHeaderMatch[2] ? parseInt(quotedHeaderMatch[2], 10) : undefined;
    
    // Check if the brace closes on the same line (single-line form)
    const openBraceCount = (firstLine.match(/{/g) || []).length;
    const closeBraceCount = (firstLine.match(/}/g) || []).length;
    
    if (closeBraceCount >= openBraceCount) {
      // Single-line: body is between first { and last }
      const openIdx = firstLine.indexOf('{');
      const closeIdx = firstLine.lastIndexOf('}');
      let body = firstLine.substring(openIdx + 1, closeIdx).trim();
      // Body may contain "depth N" at the start if depth was not before the brace
      // But in our regex we already captured depth before the brace, so body is just the expression.
      // However, if depth was inside braces like: verify "name" { depth 2, expr }
      // check for that pattern:
      const depthInBody = body.match(/^\s*depth\s+(\d+)\s*,?\s*/);
      let actualDepth = depth;
      if (!actualDepth && depthInBody) {
        actualDepth = parseInt(depthInBody[1], 10);
        body = body.substring(depthInBody[0].length);
      }
      return { type: 'verify', name, temporalExpr: body, depth: actualDepth };
    }
    
    // Multi-line: collect body from subsequent lines
    const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
    const afterBrace = firstLine.substring(firstLine.indexOf('{') + 1).trim();
    const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
    let body = (afterBrace + ' ' + innerLines.join(' ')).trim();
    
    // Check for "depth N" inside body
    const depthInBody = body.match(/^\s*depth\s+(\d+)\s*,?\s*/);
    let actualDepth = depth;
    if (!actualDepth && depthInBody) {
      actualDepth = parseInt(depthInBody[1], 10);
      body = body.substring(depthInBody[0].length);
    }
    
    return { type: 'verify', name, temporalExpr: body, depth: actualDepth };
  }
  
  // Form 2: verify Always(Name) { depth N } or verify Always(Name) {
  const headerMatch = firstLine.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*\{/);
  if (!headerMatch) return null;
  
  const temporalExpr = headerMatch[1].trim();
  const name = headerMatch[2];
  
  // Check if the brace closes on the same line (single-line form)
  const openBraceCount = (firstLine.match(/{/g) || []).length;
  const closeBraceCount = (firstLine.match(/}/g) || []).length;
  
  if (closeBraceCount >= openBraceCount) {
    // Single-line: parse depth from same line
    const afterBrace = firstLine.substring(firstLine.indexOf('{') + 1);
    const beforeClose = afterBrace.substring(0, afterBrace.lastIndexOf('}')).trim();
    const depthMatch = beforeClose.match(/\bdepth\s+(\d+)\b/);
    const depth = depthMatch ? parseInt(depthMatch[1], 10) : undefined;
    return { type: 'verify', name, temporalExpr, depth };
  }
  
  // Multi-line block
  let depth: number | undefined;
  const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
  
  const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
  const inner = innerLines.join(' ');
  
  const afterBrace = firstLine.substring(firstLine.indexOf('{') + 1).trim();
  
  const depthMatch = (afterBrace + ' ' + inner).match(/\bdepth\s+(\d+)\b/);
  if (depthMatch) {
    depth = parseInt(depthMatch[1], 10);
  }
  
  return { type: 'verify', name, temporalExpr, depth };
}

/**
 * Parse a single-line verify statement: verify Always(Name) { depth N }
 */
function parseVerifySingleLine(line: string): VerifyNode | null {
  // Form: verify "quoted name" depth N { expr } (single-line)
  const quotedMatch = line.match(/^verify\s+"([^"]+)"\s*(?:depth\s+(\d+)\s*)?\{\s*(.*)\}\s*$/);
  if (quotedMatch) {
    const name = quotedMatch[1];
    const depth = quotedMatch[2] ? parseInt(quotedMatch[2], 10) : undefined;
    let body = quotedMatch[3].trim();
    // If depth wasn't before the brace, check inside body
    const depthInBody = body.match(/^\s*depth\s+(\d+)\s*,?\s*/);
    let actualDepth = depth;
    if (!actualDepth && depthInBody) {
      actualDepth = parseInt(depthInBody[1], 10);
      body = body.substring(depthInBody[0].length);
    }
    return { type: 'verify', name, temporalExpr: body, depth: actualDepth };
  }

  // verify Always(Name) { depth N }
  const fullMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*\{\s*depth\s+(\d+)\s*\}/);
  if (fullMatch) {
    return {
      type: 'verify',
      name: fullMatch[2],
      temporalExpr: fullMatch[1].trim(),
      depth: parseInt(fullMatch[3], 10),
    };
  }
  
  // verify Always(Name) (no depth, no braces — just a statement)
  const simpleMatch = line.match(/^verify\s+((?:Always|always|Eventually|eventually)\s*\(\s*(\w+)\s*\))\s*$/);
  if (simpleMatch) {
    return {
      type: 'verify',
      name: simpleMatch[2],
      temporalExpr: simpleMatch[1].trim(),
    };
  }
  
  return null;
}

/**
 * Parse a constraint block opened with `constraint Name: ...` which may
 * be multi-line (e.g. forall spanning multiple lines).
 */
function parseConstraintBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): ConstraintNode | null {
  const firstLine = lines[startIndex].trim();

  // Match: constraint Name: expr (possibly opening a {} block, or just a forall on next line)
  // For the SQLiteWAL style: constraint Name: expr  (single line, no braces needed)
  // Also accept `constraint "name with spaces" { ... }` and `constraint "name" : expr`
  const namedMatch = firstLine.match(/^constraint\s+(\w+):(.*)$/);
  const quotedMatch = firstLine.match(/^constraint\s+"([^"]+)"\s*(\{|:)(.*)$/);
  if (namedMatch) {
    const name = namedMatch[1];
    let expr = namedMatch[2].trim();
    
    // If the expression opens a brace, collect the block
    if (expr.startsWith('{')) {
      const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
      const inner = innerLines.join(' ');
      // Combine: content after { on first line + content from inner lines
      const afterBrace = expr.substring(1).trim();
      expr = (afterBrace + ' ' + inner).trim();
    } else {
      // No braces, but might still be multiline (forall spanning multiple lines)
      // Check if next line(s) continue the expression
      const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));
      if (innerLines.length > 0) {
        expr = expr + ' ' + innerLines.join(' ');
      }
    }

    return { type: 'constraint', name, expr: expr.trim() };
  }

  // Quoted-name form: `constraint "name" { ... }` or `constraint "name" : expr`
  if (quotedMatch) {
    const name = quotedMatch[1];
    const followsBrace = quotedMatch[2] === '{';
    let expr = quotedMatch[3].trim();
    if (followsBrace) {
      if (expr.startsWith('{')) expr = expr.substring(1).trim();
      const endIdx = findBlockEnd(lines, startIndex + 1, startBraceCount);
      const innerLines = lines.slice(startIndex + 1, endIdx).map(l => l.trim()).filter(l => l && !l.startsWith('//') && l !== '}');
      const inner = innerLines.join(' ');
      expr = (expr + ' ' + inner).trim();
    }
    return { type: 'constraint', name, expr: expr.trim() };
  }

  return null;
}

/** Split on commas while respecting parenthesized groups and quoted strings */
function splitFields(s: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (inDouble || inSingle) continue;
    if (ch === '(' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === '}') { depth--; continue; }
    if (ch === ',' && depth === 0) {
      result.push(s.substring(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.substring(start).trim();
  if (last) result.push(last);
  return result;
}
