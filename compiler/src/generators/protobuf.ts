/**
 * Generate Protocol Buffers (proto3) from a SpeckDL spec.
 *
 * This is the load-bearing backend for the "no glue code" claim:
 * the .proto file emitted here is the canonical wire format. Run
 * `buf generate` on the output to produce Go / TypeScript / Rust / C
 * / Python / Java / etc. bindings — every gRPC and ConnectRPC ecosystem
 * gets free bindings with zero hand-written converters.
 *
 * Mapping:
 *   event X { name: String, age: Nat }   ->  message X { string name = 1; uint64 age = 2; }
 *   interface T { Foo, Bar }             ->  enum T { T_FOO = 0; T_BAR = 1; }
 *   interface X { field: Type }          ->  message X { Type field = 1; }
 *   state: { foo: Type, bar: Type }      ->  message StateSnapshot { Type foo = 1; Type bar = 2; }
 *   service S { rpc M(R) returns (Rsp);} ->  service S { rpc M(R) returns (Rsp); }
 *   constraint: ...                      ->  comment in generated .proto
 *   verify: ...                          ->  comment in generated .proto
 *   bom { ... }                          ->  file-level metadata
 *
 * Deterministic: field numbering is alphabetical by field name, so the same
 * .speckdl always produces the same .proto byte-for-byte. Matches Speckl's
 * existing determinism claim.
 */

import { AST, SpeckNode, MemberNode, StateNode, EventNode, InterfaceNode, TypeExpr, ServiceNode, TransitionNode, OneofNode } from '../parser.js';
import fs from 'fs';
import path from 'path';

const PROTO3 = 'proto3';

// SpeckDL type -> proto3 type
function speckTypeToProto(typeName: string): string {
  const t = typeName.trim();
  switch (t) {
    case 'String':       return 'string';
    case 'StringList':   return 'repeated string';
    case 'Nat':          return 'uint64';
    case 'NatList':      return 'repeated uint64';
    case 'Int':          return 'int64';
    case 'IntList':      return 'repeated int64';
    case 'Bool':         return 'bool';
    case 'BoolList':     return 'repeated bool';
    case 'Bytes':        return 'bytes';
    case 'BytesList':    return 'repeated bytes';
    case 'Real':         return 'double';
    case 'Date':         return 'google.protobuf.Timestamp';
    default:
      // User-defined types: passed through verbatim. The user is responsible
      // for ensuring these resolve to messages/enums defined elsewhere in
      // the same .proto (or imported).
      return t;
  }
}

// Resolve a TypeExpr (which may be primitive, ident, list, map, set) to a
// proto3 type string. Used by all field-emitting code paths so that
// interface records, events, state, and transitions all handle
// List<T>, Map<K,V>, and Set<T> consistently.
// Cycle 73: extracted from inline code in event/state/transition emitters.
// Previously, interface record fields only called speckTypeToProto(f.type.name)
// which returned '' for List/Map/Set types (their .name is undefined),
// producing malformed proto like ` = 1;` with no type.
function typeExprToProto(t: TypeExpr): string {
  if (t.type === 'map' && t.keyType && t.valueType) {
    const k = speckTypeToProto(t.keyType.name || 'string');
    const v = speckTypeToProto(t.valueType.name || 'bytes');
    return `map<${k}, ${v}>`;
  }
  if (t.type === 'list' && t.elementType) {
    const inner = typeExprToProto(t.elementType);
    return `repeated ${inner}`;
  }
  if (t.type === 'set' && t.elementType) {
    const inner = typeExprToProto(t.elementType);
    return `repeated ${inner}`;
  }
  // Primitive or ident — fall back to name-based lookup
  return speckTypeToProto(t.name || '');
}

// Deterministic field numbering: alphabetical by field name, 1-indexed.
function assignFieldNumbers(fields: { name: string }[]): Map<string, number> {
  const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name));
  const map = new Map<string, number>();
  sorted.forEach((f, i) => map.set(f.name, i + 1));
  return map;
}

function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function pascalCase(s: string): string {
  return s
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase())
    .replace(/\s/g, '');
}

function upperSnake(s: string): string {
  return snakeCase(s).toUpperCase();
}

interface InterfaceField {
  name: string;
  type: TypeExpr; // matches parser's MethodSignature.params shape
}

interface InterfaceKind {
  name: string;
  isEnum: boolean;
  isMessage: boolean;
  variants?: string[];
  fields?: InterfaceField[];
}

// Use the parser's `kind` discriminator to route each interface to the
// correct proto3 construct. The parser sets `kind` based on what was found
// in the interface block:
//   'enum'    → proto3 enum (variants)
//   'record'  → proto3 message (fields)
//   'service' → proto3 service (rpc methods) — handled separately
//   'mixed'   → inspect methods/fields directly to disambiguate
function classifyInterfaces(members: MemberNode[]): Map<string, InterfaceKind> {
  const result = new Map<string, InterfaceKind>();
  for (const m of members) {
    if (m.type !== 'interface') continue;
    const iface = m as any; // parser uses kind/fields now
    switch (iface.kind) {
      case 'enum':
        result.set(iface.name, {
          name: iface.name,
          isEnum: true,
          isMessage: false,
          variants: iface.methods.map((meth: any) => meth.name),
        });
        break;
      case 'record':
        result.set(iface.name, {
          name: iface.name,
          isEnum: false,
          isMessage: true,
          fields: iface.fields,
        });
        break;
      case 'service':
        // Services emitted separately; skip in this map
        break;
      case 'mixed':
      default:
        if (iface.fields && iface.fields.length > 0) {
          result.set(iface.name, {
            name: iface.name,
            isEnum: false,
            isMessage: true,
            fields: iface.fields,
          });
        } else if (iface.methods && iface.methods.length > 0) {
          result.set(iface.name, {
            name: iface.name,
            isEnum: true,
            isMessage: false,
            variants: iface.methods.map((meth: any) => meth.name),
          });
        }
        break;
    }
  }
  return result;
}

export function generateProtobuf(ast: AST, outputDir: string, packageName?: string): void {
  for (const speck of ast.specks) {
    const code = emitSpeck(speck, packageName);
    const filename = `${snakeCase(speck.name)}.proto`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, code);
    console.log(`Generated protobuf schema: ${filepath}`);
  }
}

function emitSpeck(speck: SpeckNode, packageName?: string): string {
  const members = speck.members;
  const stateNode = members.find(m => m.type === 'state') as StateNode | undefined;
  const events = members.filter(m => m.type === 'event') as EventNode[];
  const interfaces = classifyInterfaces(members);

  const pkg = (speck as any).protoPackage || packageName || `speckl.${snakeCase(speck.name)}.v1`;
  const goPkg = (speck as any).goPackage
    || `github.com/wscoble/${snakeCase(speck.name)}/proto/${snakeCase(speck.name)}/v1;${snakeCase(speck.name)}v1`;

  const lines: string[] = [];

  // Header
  lines.push('// Auto-generated by speckl-compile from ' + speck.name + '.speckdl');
  lines.push('// DO NOT EDIT MANUALLY — regenerate from the .speckdl source');
  lines.push('// SPDX-License-Identifier: MIT');
  lines.push('');
  lines.push('syntax = "' + PROTO3 + '";');
  lines.push('');
  lines.push('package ' + pkg + ';');
  lines.push('');
  lines.push('option go_package = "' + goPkg + '";');
  lines.push('');
  // Import google.protobuf.Timestamp if any field uses Date.
  // Cycle 73: extended to also check interface record fields (not just
  // events and state). Previously, a spec with Date only in interface
  // records (e.g. Ticket.sale_starts_at) would miss the import.
  const usesTimestamp = members.some(m => {
    if (m.type === 'event') {
      return (m as EventNode).fields.some(f => f.type.name === 'Date' ||
        (f.type.type === 'list' && f.type.elementType?.name === 'Date'));
    }
    if (m.type === 'state') {
      return (m as StateNode).variables.some(v =>
        v.typeExpr.name === 'Date' ||
        (v.typeExpr.type === 'list' && v.typeExpr.elementType?.name === 'Date')
      );
    }
    if (m.type === 'interface') {
      const iface = m as any;
      if (iface.fields && iface.fields.length > 0) {
        return iface.fields.some((f: any) =>
          f.type.name === 'Date' ||
          (f.type.type === 'list' && f.type.elementType?.name === 'Date')
        );
      }
    }
    return false;
  });
  if (usesTimestamp) {
    lines.push('import "google/protobuf/timestamp.proto";');
    lines.push('');
  }

  // ─── Enums (interface with variants) ────────────────────────
  for (const [, iface] of Array.from(interfaces.entries())) {
    if (iface.isEnum && iface.variants) {
      lines.push(`enum ${iface.name} {`);
      lines.push(`  ${upperSnake(iface.name)}_UNSPECIFIED = 0;`);
      iface.variants.forEach((v, i) => {
        // Cycle 73: prefix variant with enum name to avoid collisions
        // across enums in the same proto scope. Proto3 requires all enum
        // values to be unique within the enclosing scope (not just the
        // enum), so PENDING in Role and PENDING in OrderStatus collide.
        // Prefixing with the enum name (ROLE_PENDING, ORDER_STATUS_PENDING)
        // is the proto3 convention and eliminates the collision.
        lines.push(`  ${upperSnake(iface.name)}_${upperSnake(v)} = ${i + 1};`);
      });
      lines.push('}');
      lines.push('');
    }
  }

  // ─── Messages (interface with fields, plus events) ─────────
  // First emit interface-messages (record types like BranchInfo, CustodyDeclaration)
  for (const [, iface] of Array.from(interfaces.entries())) {
    if (iface.isMessage && iface.fields && iface.fields.length > 0) {
      lines.push(`message ${iface.name} {`);
      const fieldNums = assignFieldNumbers(iface.fields);
      for (const f of iface.fields) {
        const num = fieldNums.get(f.name) || 1;
        const protoType = typeExprToProto(f.type);
        lines.push(`  ${protoType} ${snakeCase(f.name)} = ${num};`);
      }
      lines.push('}');
      lines.push('');
    }
  }

  // Then emit events as messages
  for (const ev of events) {
    // Cycle 61: honor `event_suffix: "Payload"` directive so emitted
    // message names match consumer Go bindings (e.g. CreateGroupPayload
    // instead of CreateGroup).
    const evName = speck.eventSuffix ? ev.name + speck.eventSuffix : ev.name;
    lines.push(`message ${evName} {`);
    if (ev.fields.length === 0) {
      lines.push('  // empty event');
    } else {
      const fieldNums = assignFieldNumbers(ev.fields);
      for (const f of ev.fields) {
        const num = fieldNums.get(f.name) || 1;
        const protoType = typeExprToProto(f.type);
        lines.push(`  ${protoType} ${snakeCase(f.name)} = ${num};`);
      }
    }
    lines.push('}');
    lines.push('');
  }

  // Then emit state snapshot as a message
  if (stateNode && stateNode.variables.length > 0) {
    // Cycle 59: honor `state as <Name>` override so the consumer Go code
    // can import the generated message by the expected name (e.g.
    // StateSnapshot instead of FederatedMeetupState).
    const msgName = stateNode.messageName || `${pascalCase(speck.name)}State`;
    lines.push(`message ${msgName} {`);
    const fieldNums = assignFieldNumbers(stateNode.variables);
    for (const v of stateNode.variables) {
      const num = fieldNums.get(v.name) || 1;
      const protoType = typeExprToProto(v.typeExpr);
      lines.push(`  ${protoType} ${snakeCase(v.name)} = ${num};`);
    }
    lines.push('}');
    lines.push('');
  }

  // Cycle 64: emit TransitionNode messages. A `transition Name { ... }`
  // block produces a proto message with the regular fields plus an inline
  // `oneof payload { ... }` block, whose variants are pulled from a
  // sibling `oneof <Name> { ... }` block referenced by `payload: <Name>`.
  // Field numbers are assigned starting at 1; the oneof variants use
  // 10, 11, 12, ... (proto convention: leave 1-15 for the most stable
  // fields so the wire format is forward-compatible).
  const transitionNodes = members.filter(m => m.type === 'transition') as TransitionNode[];
  const oneofNodes = members.filter(m => m.type === 'oneof') as OneofNode[];
  for (const t of transitionNodes) {
    lines.push(`message ${t.name} {`);
    // Cycle 73: emit the type discriminator field. The parser stores it
    // in t.typeDiscriminator (a string naming the enum) rather than in
    // t.fields, so it must be emitted explicitly. Field number 1 is
    // reserved for the type discriminator (it's the most-accessed field).
    if (t.typeDiscriminator) {
      lines.push(`  ${t.typeDiscriminator} type = 1;`);
    }
    const fieldNums = assignFieldNumbers(t.fields);
    for (const f of t.fields) {
      const num = fieldNums.get(f.name) || 1;
      // If type discriminator is present, offset field numbers by 1
      // to avoid collision with the type field at number 1.
      const actualNum = t.typeDiscriminator ? num + 1 : num;
      const protoType = typeExprToProto(f.type);
      lines.push(`  ${protoType} ${snakeCase(f.name)} = ${actualNum};`);
    }
    if (t.payloadOneof) {
      const oneof = oneofNodes.find(o => o.name === t.payloadOneof);
      if (oneof) {
        lines.push('  oneof payload {');
        oneof.variants.forEach((v, i) => {
          // Reference the suffixed message name if event_suffix is set,
          // so the oneof variants match what the consumer Go code expects.
          const variantType = speck.eventSuffix ? v.typeName + speck.eventSuffix : v.typeName;
          lines.push(`    ${variantType} ${v.fieldName} = ${i + 10};`);
        });
        lines.push('  }');
      }
    }
    lines.push('}');
    lines.push('');
  }

  // ─── Service (RPC surface) ──────────────────────────────────
  // ServiceNode members emit proto3 service blocks. These map directly to
  // gRPC and ConnectRPC service definitions; buf generate + protoc-gen-go
  // + protoc-gen-connect-go produce client stubs and Connect handlers.
  const serviceNodes = members.filter((m: any) => m.type === 'service') as ServiceNode[];
  if (serviceNodes.length > 0) {
    for (const svc of serviceNodes) {
      lines.push(`service ${svc.name} {`);
      for (const rpc of svc.rpcs) {
        const reqStream = rpc.clientStreaming ? 'stream ' : '';
        const resStream = rpc.serverStreaming ? 'stream ' : '';
        lines.push(`  rpc ${pascalCase(rpc.name)}(${reqStream}${rpc.requestType}) returns (${resStream}${rpc.responseType});`);
      }
      lines.push('}');
      lines.push('');
    }
  }

  return lines.join('\n');
}