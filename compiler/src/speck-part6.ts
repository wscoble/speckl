import { InterfaceField, InterfaceNode, MemberNode, MethodSignature, OneofNode, OneofVariant, ServiceNode, TransitionField, TransitionNode, TypeExpr, VerifyNode, RpcMethod } from './speck-part0.js';
import { findBlockEnd, isExpressionComplete, maskCode } from './speck-part1.js';
import { parseInterface, parseOneof, parseTransition, parseTypeExpr, splitOnTopLevelCommas } from './speck-part3.js';
import { inlineActionBody } from './speck-part4.js';
import { parseConstraintAnyForm, parseConstraintColonBlock, parseVerifyAnyForm } from './speck-part7.js';
import { takeExpressionLines } from './speck-span.js';

export function parseInterfaceBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): InterfaceNode {
  const firstLine = lines[startIndex].trim();
  const header = parseInterface(firstLine);
  const inline = inlineActionBody(firstLine);
  const innerLines = inline !== null
    ? (inline.trim() ? [inline.trim()] : [])
    : lines.slice(startIndex + 1, findBlockEnd(lines, startIndex + 1, startBraceCount)).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

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
export function parseOneofBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): OneofNode {
  const firstLine = lines[startIndex].trim();
  const header = parseOneof(firstLine);
  const inline = inlineActionBody(firstLine);
  const innerLines = inline !== null
    ? (inline.trim() ? [inline.trim()] : [])
    : lines.slice(startIndex + 1, findBlockEnd(lines, startIndex + 1, startBraceCount)).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

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
export function parseTransitionBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): TransitionNode {
  const firstLine = lines[startIndex].trim();
  const header = parseTransition(firstLine);
  const inline = inlineActionBody(firstLine);
  const innerLines = inline !== null
    ? (inline.trim() ? [inline.trim()] : [])
    : lines.slice(startIndex + 1, findBlockEnd(lines, startIndex + 1, startBraceCount)).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

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

export function parseServiceBlockMultiline(lines: string[], startIndex: number, startBraceCount: number): ServiceNode {
  // service Name {
  const firstLine = lines[startIndex].trim();
  const match = firstLine.match(/^service\s+(\w+)\s*{?/);
  const name = match ? match[1] : 'UnnamedService';

  const inline = inlineActionBody(firstLine);
  const innerLines = inline !== null
    ? (inline.trim() ? [inline.trim()] : [])
    : lines.slice(startIndex + 1, findBlockEnd(lines, startIndex + 1, startBraceCount)).map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('/*'));

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
export function parseMultiLineConstraintVerify(lines: string[], startIndex: number): MemberNode | null {
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
export function parseVerifyColonBlock(lines: string[], startIndex: number): VerifyNode | null {
  const firstLine = lines[startIndex].trim();
  // Strip the `verify:` prefix.
  const head = firstLine.substring(firstLine.indexOf(':') + 1).trim();
  if (!head) return null;

  const taken = takeExpressionLines(lines, startIndex, head, 'space');
  const nameMatch = taken.text.match(/^(?:always|Always|eventually|Eventually)\s*\(\s*(\w+)\s*\)$/);
  return {
    type: 'verify',
    name: nameMatch ? nameMatch[1] : 'unnamed',
    temporalExpr: taken.text,
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
