// src/ir/types.ts
//
// The IR (Intermediate Representation) is the named union of all Speckl
// facets. Generators consume the IR, not the AST. The IR is:
//   - Complete: every fact in the spec is in the IR, with a named facet.
//   - Lossless: expressions are captured as trees, not strings (this kills
//     the Z3 re-parse that the current compiler does on raw source).
//   - Resolved: cross-spec references (imports, type lookups) are resolved
//     at the IR level, not by each generator.
//   - Provenanced: every IR has a `provenance` facet; missing-source provenance
//     is synthesized from file metadata, not silently dropped.
//
// The IR is itself a Speckl spec (see compiler/specs/speckl-ir.speckdl).
// The compiler compiles that spec. The output is the IR types.
//
// See OB1 #3642 for the architecture rationale and the facet taxonomy.

// ─────────────────────────────────────────────────────────────────────
// Core IR types
// ─────────────────────────────────────────────────────────────────────

/** A single Speckl specification, fully resolved, with all facets populated. */
export interface IRSpeck {
  /** Name of the speck (e.g. "TigerBeetle"). */
  name: string;
  /** Source file path. Used for provenance and error messages. */
  sourcePath: string;
  /** Cross-spec imports resolved at lower time. Empty for self-contained specs. */
  imports: IRImport[];
  /** The named union of facets. Every facet is populated; some may be empty. */
  facets: IRFacets;
  /**
   * Speck-level metadata carried through from the parser. Used by
   * target-specific generators (k8s, protobuf) to derive group/version
   * and proto_package/go_package. Mirrors the SpeckNode fields.
   */
  protoPackage?: string;
  goPackage?: string;
  eventSuffix?: string;
  k8sGroup?: string;
  k8sVersion?: string;
  metadataVersion?: string;
  metadataAuthor?: string;
  metadataLicense?: string;
}

/** The eight named facets. Each is a separate concern; generators consume one or more. */
export interface IRFacets {
  /** What records, fields, types exist. Consumed by every generator. */
  typed_schema: TypedSchemaFacet;
  /** State, init, actions, events — the behavior of the system. */
  behavior: BehaviorFacet;
  /** Constraints, verifies — the formal spec. Expressions are trees, not strings. */
  formal_spec: FormalSpecFacet;
  /** How the spec is serialized (proto, json, msgpack, etc.). */
  wire_format: WireFormatFacet;
  /** Field-level validation rules (length, regex, range, required, etc.). */
  validation: ValidationFacet;
  /** K8s-style status subresource, conditions, finalizers, owner references. */
  resource_lifecycle: ResourceLifecycleFacet;
  /** Provenance: regulations, design decisions, sources, authors, reviews. */
  provenance: ProvenanceFacet;
  /** Package-level metadata: version, author, license. */
  metadata: MetadataFacet;
}

/** Resolved import. The IR pass has already loaded and merged the imported spec. */
export interface IRImport {
  /** Original path in the source (e.g. "../common.speckdl"). */
  path: string;
  /** Alias used in the source (e.g. "common"). */
  alias: string;
  /** Version pin from the import statement, if any. */
  version?: string;
  /** Content hash, if pinned. */
  hash?: string;
  /** The resolved imported speck. */
  resolved: IRSpeck;
}

/** The top-level IR: a file may declare multiple specks. */
export interface IR {
  specks: IRSpeck[];
  /** Global file-level metadata, shared across all specks in the file. */
  fileMetadata: FileMetadata;
  /** Diagnostics from the lower pass (errors, warnings, info). */
  diagnostics: IRDiagnostic[];
}

export interface FileMetadata {
  /** Absolute path to the source file. */
  filePath: string;
  /** File-level `version:`, `author:`, `license:` directives. */
  version?: string;
  author?: string;
  license?: string;
}

export interface IRDiagnostic {
  level: 'error' | 'warning' | 'info';
  message: string;
  /** Source location if known: 1-indexed line and column. */
  line?: number;
  column?: number;
  /** Speck name, if the diagnostic is scoped to one speck. */
  speck?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Facet 1: typed_schema
// ─────────────────────────────────────────────────────────────────────

/** The shape of the data: records, fields, types, services. */
export interface TypedSchemaFacet {
  /** Top-level type definitions, indexed by name. */
  types: Map<string, IRType>;
  /** Service definitions (RPC-style: methods with request/response types). */
  services: IRService[];
}

export type IRType =
  | IRRecordType
  | IREnumType
  | IRAliasType;

export interface IRRecordType {
  kind: 'record';
  name: string;
  fields: IRFieldDef[];
  /** Doc comment from the source, if any. Used for provenance. */
  doc?: string;
}

export interface IREnumType {
  kind: 'enum';
  name: string;
  variants: string[];
  doc?: string;
}

export interface IRAliasType {
  kind: 'alias';
  name: string;
  target: IRTypeRef;
  doc?: string;
}

export interface IRFieldDef {
  name: string;
  type: IRTypeRef;
  /** Field-level validation, lifted into the validation facet. */
  validation?: ValidationRule[];
  /** Optional flag — when true, the field may be unset. */
  optional: boolean;
  doc?: string;
}

/** A type reference. May be a primitive, a list, a map, or a named type. */
export interface IRTypeRef {
  kind: 'primitive' | 'list' | 'set' | 'map' | 'ident';
  /** Primitive name (String, Nat, Int, Bool, Real, Bytes, Date). */
  primitive?: string;
  /** Named type reference. */
  name?: string;
  /** Element type for list/set. */
  elementType?: IRTypeRef;
  /** Key/value types for map. */
  keyType?: IRTypeRef;
  valueType?: IRTypeRef;
  /** Field-set for inline record types. */
  fields?: IRFieldDef[];
  /**
   * True if the type allows null. Set by the lower pass when the source
   * uses `T | null` syntax. Generators should emit `nullable: true` (OpenAPI)
   * or `x-nullable: true` (older JSON Schema) accordingly.
   */
  nullable?: boolean;
}

export interface IRService {
  name: string;
  methods: IRServiceMethod[];
  doc?: string;
}

export interface IRServiceMethod {
  name: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  doc?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Facet 2: behavior
// ─────────────────────────────────────────────────────────────────────

/** State, init, actions, events. The behavior of the system. */
export interface BehaviorFacet {
  /** State variable declarations. */
  stateVars: IRStateVar[];
  /** Initialization assignments (init block). */
  init: IRAssign[];
  /** Action (transition) definitions. */
  actions: IRAction[];
  /** Event definitions — what can be emitted. */
  events: IREvent[];
}

export interface IRStateVar {
  name: string;
  type: IRTypeRef;
  /** Default initializer expression, if any. */
  defaultInit?: IRExpr;
  doc?: string;
}

export interface IRAssign {
  target: string;
  expr: IRExpr;
}

export interface IRAction {
  name: string;
  params: IRParam[];
  statements: IRStmt[];
  doc?: string;
}

export interface IRParam {
  name: string;
  type: IRTypeRef;
}

export interface IRStmt {
  kind: 'assign' | 'let' | 'require' | 'precondition' | 'postcondition' | 'emit' | 'return' | 'if';
  // For 'assign'
  target?: string;
  // For 'let'
  letName?: string;
  // For 'emit'
  event?: string;
  // For 'return' and 'if'
  expr?: IRExpr;
  // For 'assign', 'let', 'require', 'precondition', 'postcondition'
  value?: IRExpr;
  // For 'emit' field values
  fields?: { name: string; value: IRExpr }[];
  // For 'if'
  thenBlock?: IRStmt[];
  elseBlock?: IRStmt[];
}

export interface IREvent {
  name: string;
  fields: IRFieldDef[];
  doc?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Facet 3: formal_spec
// ─────────────────────────────────────────────────────────────────────

/** Constraints, verifies. Expressions are trees, not strings. */
export interface FormalSpecFacet {
  /** Named constraints — what must always hold. */
  constraints: IRConstraint[];
  /** Temporal verifies — what must eventually hold, with bounded depth. */
  verifies: IRVerify[];
  /**
   * Declared inputs (v0.2 declarative `input:` blocks). These are the free
   * variables of the formal contract — declarative specs have no state
   * block, so verification checks constraints over these constants.
   * Record-typed inputs are flattened to named fields; non-record inputs
   * are skipped (with a diagnostic).
   */
  inputs: IRFieldDef[];
  /** Declared outputs — same treatment as inputs. */
  outputs: IRFieldDef[];
}

export interface IRConstraint {
  name?: string;
  /** The constraint expression, as a tree. */
  expr: IRExpr;
  doc?: string;
}

export interface IRVerify {
  name: string;
  /** The temporal expression. The IR captures the AST shape; the Z3 generator lowers it. */
  temporalExpr: IRExpr;
  depth?: number;
  doc?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Expression trees (the lossy-string fix)
// ─────────────────────────────────────────────────────────────────────

/**
 * The expression tree. Every expression in the source is parsed into one
 * of these node types. The Z3 generator walks this tree directly; no
 * raw-source re-parse.
 *
 * This is a deliberately small set — covers what Speckl currently expresses
 * (boolean, arithmetic, comparison, call, identifier, literal). New node
 * kinds are added as the language grows.
 */
export type IRExpr =
  | IRBoolLit
  | IRIntLit
  | IRFloatLit
  | IRStringLit
  | IRIdent
  | IRBinOp
  | IRUnOp
  | IRCall
  | IRFieldAccess
  | IRIndexExpr;

export interface IRBoolLit { kind: 'bool_lit'; value: boolean; /** True when this node is a placeholder for an expression that failed to parse. */ parseFailed?: boolean }
export interface IRIntLit { kind: 'int_lit'; value: number }
export interface IRFloatLit { kind: 'float_lit'; value: number }
export interface IRStringLit { kind: 'string_lit'; value: string }
export interface IRIdent { kind: 'ident'; name: string }
export interface IRFieldAccess { kind: 'field'; target: IRExpr; field: string }
export interface IRIndexExpr { kind: 'index'; target: IRExpr; index: IRExpr }

export interface IRBinOp {
  kind: 'binop';
  op: string;  // '+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=', '&&', '||', 'in'
  left: IRExpr;
  right: IRExpr;
}

export interface IRUnOp {
  kind: 'unop';
  op: string;  // '!', '-'
  operand: IRExpr;
}

export interface IRCall {
  kind: 'call';
  fn: string;
  args: IRExpr[];
}

// ─────────────────────────────────────────────────────────────────────
// Facet 4: wire_format
// ─────────────────────────────────────────────────────────────────────

/** How the spec is serialized: protobuf, json, msgpack, custom. */
export interface WireFormatFacet {
  /** Protobuf-specific: package override. */
  protoPackage?: string;
  /** Protobuf-specific: Go package path (with optional ;alias). */
  goPackage?: string;
  /** Per-event name suffix (e.g. "Payload"). */
  eventSuffix?: string;
  /** Per-state message-name override (e.g. StateSnapshot instead of FederatedMeetupState). */
  stateMessageName?: string;
  /** Default wire format if no generator-specific override is given. */
  defaultFormat: 'protobuf' | 'json' | 'msgpack';
}

// ─────────────────────────────────────────────────────────────────────
// Facet 5: validation
// ─────────────────────────────────────────────────────────────────────

/** Field-level validation: length, regex, range, required, etc. */
export interface ValidationFacet {
  /** Map from type-name → list of validation rules. */
  rules: Map<string, ValidationRule[]>;
}

export type ValidationRule =
  | LengthRule
  | RegexRule
  | RangeRule
  | RequiredRule
  | EnumRule
  | CustomRule;

export interface LengthRule {
  kind: 'length';
  min?: number;
  max?: number;
  /** Target field name within the parent record. */
  field: string;
}

export interface RegexRule {
  kind: 'regex';
  pattern: string;
  field: string;
}

export interface RangeRule {
  kind: 'range';
  min?: number;
  max?: number;
  field: string;
}

export interface RequiredRule {
  kind: 'required';
  field: string;
}

export interface EnumRule {
  kind: 'enum';
  values: string[];
  field: string;
}

export interface CustomRule {
  kind: 'custom';
  /** Expression tree, evaluated against the field's value. */
  expr: IRExpr;
  field: string;
}

// ─────────────────────────────────────────────────────────────────────
// Facet 6: resource_lifecycle
// ─────────────────────────────────────────────────────────────────────

/** K8s-style status subresource, conditions, finalizers, owner references. */
export interface ResourceLifecycleFacet {
  /** Status subresource shape (e.g. {ready: Bool, conditions: List<Condition>}). */
  status?: IRRecordType;
  /** Condition types this resource can emit (e.g. ["Ready", "Reconciled"]). */
  conditions: string[];
  /** Finalizers required for safe deletion. */
  finalizers: string[];
  /** Owner references for GC cascade. */
  ownerReferences: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Facet 7: provenance
// ─────────────────────────────────────────────────────────────────────

/**
 * Provenance is non-optional. Every IR has this facet. If the source
 * didn't declare one, the lower pass synthesizes it from file metadata.
 */
export interface ProvenanceFacet {
  /** Provenance clauses: regulations, design decisions, parent specs, external docs. */
  clauses: ProvenanceClause[];
  /** Review policy: manual, auto, or hybrid. */
  review: 'manual' | 'auto' | 'hybrid';
  /** Authors (name, optional email). */
  authors: Author[];
  /** Sources: where the spec came from. */
  sources: Source[];
  /** Derives from: a parent spec this one extends. */
  derives?: { from: string; via?: string };
  /** Satisfies: a requirement this spec is the implementation of. */
  satisfies?: { requirement: string; clause?: string };
  /** Bill of materials metadata: compiler, solver, runtime, license, hash. */
  bom?: BOMMetadata;
  /** True if this provenance was synthesized from file metadata, not declared. */
  synthesized: boolean;
}

export type ProvenanceClause =
  | { kind: 'regulation'; value: string }
  | { kind: 'design_decision'; value: string }
  | { kind: 'parent_spec'; value: string }
  | { kind: 'external_doc'; value: string; location?: string };

export interface Author {
  name: string;
  email?: string;
}

export type SourceKind =
  | 'conversation'
  | 'meeting'
  | 'document'
  | 'regulation'
  | 'architecture_review'
  | 'threat_model'
  | 'compliance_audit';

export interface Source {
  kind: SourceKind;
  ref?: string;
}

export interface BOMMetadata {
  compiler?: { name: string; version?: string };
  solver?: { name: string; version?: string };
  runtime?: { name: string; version?: string };
  license?: string;
  hash?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Facet 8: metadata
// ─────────────────────────────────────────────────────────────────────

/** Package-level metadata: version, author, license. */
export interface MetadataFacet {
  version?: string;
  author?: string;
  license?: string;
}
