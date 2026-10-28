import fs from 'fs';
import path from 'path';
import { parseGrammar } from './grammar.js';
import { parseHarnessMapLine, parseDurationToMs } from './agent-parse.js';

export { parseHarnessMapLine, parseDurationToMs };

// AST node types for SpeckDL
export interface SpeckNode {
  type: 'speck';
  name: string;
  members: MemberNode[];
  // 1-based source line span of the whole speck block (header through closing
  // brace). Attached by parseSpeck for editor tooling (folding, outlines).
  // Undefined for ASTs produced by older callers that bypass parseSpeck.
  startLine?: number;
  endLine?: number;
  // Optional metadata from top-of-file directives (version:, author:, license:, proto_package:, go_package:).
  // Undefined when not specified in the source.
  version?: string;
  author?: string;
  license?: string;
  // Protobuf-specific overrides. If unset, generator uses sensible defaults.
  // proto_package: e.g. "federated_meetup.v1"
  // go_package: e.g. "github.com/wscoble/federated-meetup/proto/federated_meetup/v1;federatedmeetupv1"
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

/** Source position of a node. Columns are 1-based. */
export interface SourceSpan {
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Source line span (1-based, inclusive) attached to nodes by the parser. */
export interface LineSpan {
  /** Stable id for this parse. Conservation checks this set. */
  id?: number;
  span?: SourceSpan;
  startLine?: number;
  endLine?: number;
}

export type MemberNode = (
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
  | ServiceNode
  | InvariantMemberNode
  | NextMemberNode
  | AgentMemberNode
) & LineSpan;

/**
 * `next:` transition relation: the disjunction of actions the system may
 * take at each step (`next: A | B | C`, optionally spanning lines with a
 * leading or trailing `|`). Parsed as a first-class member so every
 * backend sees the same action list — previously the Z3 backend scraped it
 * from raw source and could swallow trailing members into the last name.
 */
export interface NextMemberNode {
  type: 'next';
  /** Explicit alternatives; empty when `anyAction` is set. */
  actions: string[];
  /**
   * `next: { }` — an empty block means "any declared action may fire",
   * each constrained by its own guards. Consumers expand it to every action.
   */
  anyAction?: boolean;
}

/**
 * Invariant block parsed as a first-class member (v0.3.2). The body is a
 * single boolean expression in source form; downstream generators parse it
 * with the typed expression parser rather than scraping raw source.
 */
export interface InvariantMemberNode {
  type: 'invariant';
  name: string;
  expr: string;
}

/**
 * `agent { }` block: maps tools onto actions, declares wait-states that
 * await verified signals (HITL/HNTL), and optionally names Nat stage labels.
 * Humans are signals, not actions — the block never names a human action.
 */
export interface AgentMemberNode {
  type: 'agent';
  /** Optional `stages <var> { Name = n ... }` map for Nat-backed stage enums. */
  stages?: AgentStagesMap;
  tools: AgentToolBinding[];
  awaits: AgentAwaitSpec[];
  /** Optional `pending timeout <dur>`: an in-flight tool call older than this
   *  is cleared as failed (state not advanced). Runtime default: 10m. */
  pendingTimeout?: { durationMs: number; durationText: string };
  /** Optional `harness <name> { map ... }` blocks: how a real agent
   *  harness's tool calls (Claude Code, Cursor) map onto the spec's tools.
   *  Absent when the block declares none. Unmapped harness tools are denied. */
  harnesses?: AgentHarnessSpec[];
}

/** One `harness <name> { ... }` block inside `agent { }`. */
export interface AgentHarnessSpec {
  /** Harness id: `claude-code` or `cursor`. */
  name: string;
  rules: AgentHarnessRule[];
}

/**
 * `map <Tool>[|<Tool>...] [<field> ~ "<regex>"] -> <spec_tool> [{ param = field, ... }]`
 * First matching rule wins. The regex must match the whole field value.
 */
export interface AgentHarnessRule {
  /** Harness tool names exactly as the harness reports them (Bash, Edit, mcp__x__y, Shell, ...). */
  tools: string[];
  /** Optional tool_input field the pattern is tested against (e.g. `command`). */
  field?: string;
  /** Regex source (JavaScript syntax), anchored as ^(?:...)$ at runtime. */
  pattern?: string;
  /** Spec tool (declared with `tool`) this call becomes. */
  target: string;
  /** Explicit action-parameter ← tool_input-field renames. */
  params: { param: string; field: string }[];
}

export interface AgentStagesMap {
  /** State variable the labels apply to (usually `stage`). */
  variable: string;
  /** Label → Nat value. */
  labels: { name: string; value: number }[];
}

export interface AgentToolBinding {
  /** Tool name exposed to the agent runtime (e.g. run_tests). */
  name: string;
  /** SpeckDL action this tool fires (e.g. RunTests). */
  action: string;
  /** `act` = side-effecting (refused while awaiting in both modes);
   *  `observe` = read-only (allowed in `near` / HNTL while awaiting). */
  effect: 'act' | 'observe';
}

export interface AgentAwaitSpec {
  /** Stage label this wait applies to (resolved via stages map or enum). */
  state: string;
  /** Signal name a verifier must produce. */
  signal: string;
  /** `near` = HNTL (observe tools ok); `in` = HITL (nothing). */
  mode: 'near' | 'in';
  /** Allowed outcomes (e.g. approve, reject). */
  outcomes: string[];
  /** Outcomes marked reject with a trailing `!` in `require outcome in {...}`
   *  (e.g. `reject!`). Only these may be timeout targets. */
  rejects: string[];
  /** Claims the verifier must attest (name → type name). */
  claims: { name: string; typeName: string }[];
  /** outcome → target stage label. */
  on: { outcome: string; target: string }[];
  /** Optional timeout; may only resolve to a `!`-marked reject outcome. */
  timeout?: { durationMs: number; durationText: string; outcome: string };
  /**
   * Outcomes whose sign-off is call-bound: the signed drop must carry `call`,
   * the sha256 of one canonical tool call, and the hook allows that call once.
   * Empty means a stage-level sign-off (any later call `can()` allows).
   * Reject outcomes are never listed.
   */
  bindCall: string[];
}

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
 * Parse a .speckdl file and return the AST.
 * The only parse path is the token grammar.
 */
export function parseSpeckFile(filePath: string): AST {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSpeckContent(content, filePath);
}

/** Parse SpeckDL content and return the AST. */
export function parseSpeckContent(content: string, filePath?: string): AST {
  return parseGrammar(content, filePath);
}

