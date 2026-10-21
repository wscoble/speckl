// camel.ts — Apache Camel (camel-quarkus) target.
//
// Consumes the IR's typed_schema + behavior + wire_format + provenance
// facets to emit Java source for a camel-quarkus application:
//
//   - Model classes (POJOs) for each type
//   - Java enums for each interface-as-enum
//   - Event classes for each event
//   - State holder bean
//   - A RouteBuilder with one route per action (timer-triggered or
//     HTTP-triggered via platform-http)
//   - A Processor for each action that encodes the state transition
//   - A pom.xml with camel-quarkus dependencies
//
// Output: <outputDir>/camel/<speck>/src/main/java/...
//
// The generated code is intentionally straightforward Java — no
// lambda tricks, no fluent chains beyond standard Camel DSL.
// Each route is a separate from().routeId().process() block so that
// the mapping from spec action → route is 1:1 and auditable.
//
// Every generated file must compile (javac 21 against Camel 4.8; see
// `npm run test:compile`). Processors read and write state only through
// the injected state bean. Expressions are translated with their types;
// anything the translator cannot type or has no Java form for becomes a
// call to SpecklRuntime.untranslated("<source>"), which throws
// UnsupportedOperationException when the action runs. That fails closed
// at runtime instead of skipping the check or emitting invalid Java.
//
// See OB1 #3642 for the architecture rationale.

import { irStmtsWrite } from './writes.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  IR,
  IRSpeck,
  IRRecordType,
  IREnumType,
  IRTypeRef,
  IRAction,
  IRStmt,
  IRExpr,
  IRStateVar,
  IREvent,
  IRType,
} from '../ir/types.js';

export interface CamelOptions {
  /** Output directory. */
  outputDir: string;
  /** Override the Java package name. Default: derived from protoPackage or speck name. */
  packageName?: string;
  /** Override the Maven artifactId. Default: kebab-case of speck name. */
  artifactId?: string;
  /** Override the Maven groupId. Default: com.speckl. */
  groupId?: string;
  /** Override the Maven version. Default: from spec metadata or 0.1.0. */
  version?: string;
}

/**
 * Generate Camel (camel-quarkus) Java sources for every speck in the IR.
 */
export function generateCamel(ir: IR, options: CamelOptions): void {
  const outputDir = options.outputDir;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const camelDir = path.join(outputDir, 'camel');
  if (!fs.existsSync(camelDir)) {
    fs.mkdirSync(camelDir, { recursive: true });
  }

  for (const speck of ir.specks) {
    const pkg = options.packageName || derivePackageName(speck);
    const artifactId = options.artifactId || kebabCase(speck.name);
    const groupId = options.groupId || 'com.speckl';
    const version = options.version || speck.facets.metadata.version || '0.1.0';

    generateForSpeck(speck, camelDir, pkg, artifactId, groupId, version);
  }
}

function generateForSpeck(
  speck: IRSpeck,
  camelDir: string,
  pkg: string,
  artifactId: string,
  groupId: string,
  version: string,
): void {
  const speckDir = path.join(camelDir, artifactId);
  const javaDir = path.join(speckDir, 'src', 'main', 'java');
  const pkgPath = pkg.replace(/\./g, '/');

  // Ensure directories exist
  fs.mkdirSync(path.join(javaDir, pkgPath, 'model'), { recursive: true });
  fs.mkdirSync(path.join(javaDir, pkgPath, 'event'), { recursive: true });
  fs.mkdirSync(path.join(javaDir, pkgPath, 'processor'), { recursive: true });

  const ctx = new SpeckContext(speck, pkg);
  const types = speck.facets.typed_schema.types;
  const behavior = speck.facets.behavior;

  // 1. Model classes (records/enums)
  for (const [name, type] of types.entries()) {
    if (type.kind === 'record') {
      const code = emitModelClass(ctx, type as IRRecordType);
      fs.writeFileSync(path.join(javaDir, pkgPath, 'model', `${name}.java`), code);
      console.log(`Generated Camel model: ${name}.java`);
    } else if (type.kind === 'enum') {
      const code = emitEnumClass(type as IREnumType, pkg);
      fs.writeFileSync(path.join(javaDir, pkgPath, 'model', `${name}.java`), code);
      console.log(`Generated Camel enum: ${name}.java`);
    }
  }

  // 2. Event classes
  for (const ev of behavior.events) {
    const code = emitEventClass(ctx, ev);
    fs.writeFileSync(path.join(javaDir, pkgPath, 'event', `${ev.name}.java`), code);
    console.log(`Generated Camel event: ${ev.name}.java`);
  }

  // 3. State holder bean and the fail-closed runtime helper
  const stateCode = emitStateBean(ctx, behavior.stateVars, behavior.init);
  fs.writeFileSync(path.join(javaDir, pkgPath, `${speck.name}State.java`), stateCode);
  console.log(`Generated Camel state bean: ${speck.name}State.java`);
  fs.writeFileSync(path.join(javaDir, pkgPath, 'SpecklRuntime.java'), emitRuntime(pkg));

  // 4. Processor classes — one per action
  for (const action of behavior.actions) {
    const code = emitProcessor(ctx, action);
    const fileName = `${action.name}Processor.java`;
    fs.writeFileSync(path.join(javaDir, pkgPath, 'processor', fileName), code);
    console.log(`Generated Camel processor: ${fileName}`);
  }

  // 5. RouteBuilder
  const routeCode = emitRouteBuilder(speck, behavior.actions, pkg);
  fs.writeFileSync(path.join(javaDir, pkgPath, `${speck.name}Routes.java`), routeCode);
  console.log(`Generated Camel RouteBuilder: ${speck.name}Routes.java`);

  // 6. application.properties
  const props = emitApplicationProperties(speck);
  const resDir = path.join(speckDir, 'src', 'main', 'resources');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'application.properties'), props);

  // 7. pom.xml
  const pom = emitPom(speck, artifactId, groupId, version);
  fs.writeFileSync(path.join(speckDir, 'pom.xml'), pom);
  console.log(`Generated pom.xml: ${path.join(speckDir, 'pom.xml')}`);
}

// ─────────────────────────────────────────────────────────────────────
// Java types
// ─────────────────────────────────────────────────────────────────────

/** A resolved Java-side type. `nullable` scalars are boxed. */
type JT = (
  | { k: 'bool' }
  | { k: 'long' }
  | { k: 'double' }
  | { k: 'string' }
  | { k: 'bytes' }
  | { k: 'instant' }
  | { k: 'record'; name: string }
  | { k: 'enum'; name: string }
  | { k: 'list'; elem: JT }
  | { k: 'set'; elem: JT }
  | { k: 'map'; key: JT; val: JT }
  | { k: 'object' }
) & { nullable?: boolean };

const OBJECT: JT = { k: 'object' };
const BOOL: JT = { k: 'bool' };
const LONG: JT = { k: 'long' };
const DOUBLE: JT = { k: 'double' };
const STRING: JT = { k: 'string' };

const PRIMITIVE_NAMES: Record<string, JT> = {
  Bool: BOOL, Boolean: BOOL,
  Nat: LONG, Int: LONG, Integer: LONG, Long: LONG,
  Real: DOUBLE, Float: DOUBLE, Double: DOUBLE,
  String: STRING, Str: STRING,
  Bytes: { k: 'bytes' },
  Date: { k: 'instant' }, Timestamp: { k: 'instant' },
};

const isNumeric = (t: JT) => t.k === 'long' || t.k === 'double';

/** Per-speck naming and type information shared by every emitter. */
class SpeckContext {
  readonly stateBean: string;
  readonly stateBeanVar: string;
  readonly types: Map<string, IRType>;
  readonly stateVars = new Map<string, JT>();
  /** Enum variant → enum names that declare it. */
  readonly variants = new Map<string, string[]>();

  constructor(readonly speck: IRSpeck, readonly pkg: string) {
    this.stateBean = `${speck.name}State`;
    this.stateBeanVar = lcFirst(speck.name) + 'State';
    this.types = speck.facets.typed_schema.types;
    for (const t of this.types.values()) {
      if (t.kind !== 'enum') continue;
      for (const v of t.variants) this.variants.set(v, [...(this.variants.get(v) ?? []), t.name]);
    }
    for (const sv of speck.facets.behavior.stateVars) this.stateVars.set(sv.name, this.resolve(sv.type));
  }

  resolve(ref: IRTypeRef | undefined, seen: Set<string> = new Set()): JT {
    if (!ref || !ref.kind) return OBJECT;
    const n = ref.nullable ? { nullable: true } : {};
    switch (ref.kind) {
      case 'primitive': {
        const p = PRIMITIVE_NAMES[ref.primitive ?? ''];
        return p ? { ...p, ...n } : OBJECT;
      }
      case 'list':
        return { k: 'list', elem: this.resolve(ref.elementType, seen), ...n };
      case 'set':
        return { k: 'set', elem: this.resolve(ref.elementType, seen), ...n };
      case 'map':
        // A map without key/value types is an inline record the IR keeps
        // as raw fields; there is no Java class for it.
        if (!ref.keyType || !ref.valueType) return OBJECT;
        return { k: 'map', key: this.resolve(ref.keyType, seen), val: this.resolve(ref.valueType, seen), ...n };
      case 'ident': {
        const name = ref.name ?? '';
        const t = this.types.get(name);
        if (t?.kind === 'record') return { k: 'record', name, ...n };
        if (t?.kind === 'enum') return { k: 'enum', name, ...n };
        if (t?.kind === 'alias' && !seen.has(name)) {
          const r = this.resolve(t.target, new Set([...seen, name]));
          return ref.nullable ? { ...r, nullable: true } : r;
        }
        const p = PRIMITIVE_NAMES[name];
        return p ? { ...p, ...n } : OBJECT;
      }
    }
    return OBJECT;
  }

  /** Java source for a type. `box` forces the reference form (generics, nullable). */
  java(t: JT, box = false): string {
    const b = box || !!t.nullable;
    switch (t.k) {
      case 'bool': return b ? 'Boolean' : 'boolean';
      case 'long': return b ? 'Long' : 'long';
      case 'double': return b ? 'Double' : 'double';
      case 'string': return 'String';
      case 'bytes': return 'byte[]';
      case 'instant': return 'java.time.Instant';
      case 'record':
      case 'enum': return `${this.pkg}.model.${t.name}`;
      case 'list': return `java.util.List<${this.java(t.elem, true)}>`;
      case 'set': return `java.util.Set<${this.java(t.elem, true)}>`;
      case 'map': return `java.util.Map<${this.java(t.key, true)}, ${this.java(t.val, true)}>`;
      case 'object': return 'Object';
    }
  }

  /** A fresh empty collection of type t, or undefined for non-collections. */
  emptyOf(t: JT): string | undefined {
    if (t.k === 'list') return `new java.util.ArrayList<${this.java(t.elem, true)}>()`;
    if (t.k === 'set') return `new java.util.LinkedHashSet<${this.java(t.elem, true)}>()`;
    if (t.k === 'map') return `new java.util.LinkedHashMap<${this.java(t.key, true)}, ${this.java(t.val, true)}>()`;
    return undefined;
  }

  recordField(record: string, field: string): JT | undefined {
    const t = this.types.get(record);
    if (t?.kind !== 'record') return undefined;
    const f = t.fields.find((x) => x.name === field);
    return f ? this.resolve(f.type) : undefined;
  }
}

/** Can a value of type `from` be stored where `to` is expected? */
function assignable(from: JT, to: JT): boolean {
  if (to.k === 'object') return true;
  if (from.k === 'object') return false;
  if (from.k === 'long' && to.k === 'double') return !from.nullable;
  if (from.k !== to.k) return false;
  switch (to.k) {
    case 'record':
    case 'enum':
      return (from as { name: string }).name === to.name;
    case 'list':
    case 'set':
      return sameType((from as { elem: JT }).elem, to.elem);
    case 'map':
      return sameType((from as { key: JT }).key, to.key) && sameType((from as { val: JT }).val, to.val);
    default:
      return true;
  }
}

/** Exact equality, as Java generics need (List<Long> is not List<Object>). */
function sameType(a: JT, b: JT): boolean {
  return assignable(a, b) && assignable(b, a) && a.k === b.k;
}

// ─────────────────────────────────────────────────────────────────────
// Model classes
// ─────────────────────────────────────────────────────────────────────

function emitModelClass(ctx: SpeckContext, record: IRRecordType): string {
  const className = record.name;
  const fields = record.fields.map((f) => ({ name: javaIdent(f.name), type: ctx.java(ctx.resolve(f.type)), nullable: !!f.type?.nullable }));

  const fieldDecls = fields.map((f) => `    private ${f.type} ${f.name}${f.nullable ? ' = null' : ''};`).join('\n');
  const gettersSetters = fields.map((f) => {
    const capped = cap(f.name);
    return `    public ${f.type} get${capped}() { return ${f.name}; }
    public void set${capped}(${f.type} ${f.name}) { this.${f.name} = ${f.name}; }`;
  }).join('\n\n');

  const doc = record.doc ? `/**\n * ${javaCommentText(record.doc)}\n */\n` : '';

  return `package ${ctx.pkg}.model;

${doc}public class ${className} {

${fieldDecls}

    public ${className}() {}

${gettersSetters}
}
`;
}

function emitEnumClass(enumType: IREnumType, pkg: string): string {
  const variants = enumType.variants.map((v) => `    ${javaIdent(v)}`).join(',\n');
  const doc = enumType.doc ? `/**\n * ${javaCommentText(enumType.doc)}\n */\n` : '';

  return `package ${pkg}.model;

${doc}public enum ${enumType.name} {
${variants}
}
`;
}

// ─────────────────────────────────────────────────────────────────────
// Event classes
// ─────────────────────────────────────────────────────────────────────

function emitEventClass(ctx: SpeckContext, ev: IREvent): string {
  const fields = ev.fields.map((f) => ({ name: javaIdent(f.name), type: ctx.java(ctx.resolve(f.type)) }));
  const fieldDecls = fields.map((f) => `    private ${f.type} ${f.name};`).join('\n');
  const ctorParams = fields.map((f) => `${f.type} ${f.name}`).join(', ');
  const ctorAssigns = fields.map((f) => `        this.${f.name} = ${f.name};`).join('\n');
  const getters = fields.map((f) => `    public ${f.type} get${cap(f.name)}() { return ${f.name}; }`).join('\n');
  // With no fields the all-arguments constructor would duplicate the no-arg one.
  const fullCtor = fields.length > 0 ? `\n    public ${ev.name}(${ctorParams}) {\n${ctorAssigns}\n    }\n` : '';

  const doc = ev.doc ? `/**\n * ${javaCommentText(ev.doc)}\n */\n` : '';

  return `package ${ctx.pkg}.event;

${doc}public class ${ev.name} {

${fieldDecls}

    public ${ev.name}() {}
${fullCtor}
${getters}
}
`;
}

// ─────────────────────────────────────────────────────────────────────
// State holder bean and runtime helper
// ─────────────────────────────────────────────────────────────────────

function emitStateBean(
  ctx: SpeckContext,
  stateVars: IRStateVar[],
  init: { target: string; expr: IRExpr }[],
): string {
  const className = ctx.stateBean;

  const fieldDecls = stateVars.map((sv) => {
    const t = ctx.stateVars.get(sv.name)!;
    const empty = ctx.emptyOf(t);
    return `    private ${ctx.java(t)} ${javaIdent(sv.name)}${empty ? ` = ${empty}` : ''};`;
  }).join('\n');

  const env = new Env(ctx, 'this');
  const initLines = init.map((a) => {
    const t = ctx.stateVars.get(a.target);
    const src = `${a.target} := ${exprSource(a.expr)}`;
    if (!t) return untranslatedStmt(ctx, `init ${src}`, '        ');
    const v = translate(a.expr, env, t);
    if (!v || !assignable(v.t, t)) return untranslatedStmt(ctx, `init ${src}`, '        ');
    return `        this.${javaIdent(a.target)} = ${v.code};`;
  }).join('\n');

  const gettersSetters = stateVars.map((sv) => {
    const javaType = ctx.java(ctx.stateVars.get(sv.name)!);
    const name = javaIdent(sv.name);
    const capped = cap(name);
    return `    public ${javaType} get${capped}() { return ${name}; }
    public void set${capped}(${javaType} ${name}) { this.${name} = ${name}; }`;
  }).join('\n\n');

  return `package ${ctx.pkg};

import jakarta.enterprise.context.ApplicationScoped;

/**
 * State holder for the ${ctx.speck.name} speck.
 * This bean holds the in-memory state that processors read and mutate.
 * In a production deployment, state may be backed by a database
 * (the spec declares which state is persistent).
 */
@ApplicationScoped
public class ${className} {

${fieldDecls}

    public ${className}() {
${initLines}
    }

${gettersSetters}
}
`;
}

function emitRuntime(pkg: string): string {
  return `package ${pkg};

/**
 * Runtime support for generated processors.
 */
public final class SpecklRuntime {

    private SpecklRuntime() {}

    /**
     * Marks spec source the Camel target could not translate. Running it
     * throws, so the action fails closed instead of skipping a check or
     * an effect.
     */
    public static void untranslated(String source) {
        throw new UnsupportedOperationException("SPECKL-UNTRANSLATED: " + source);
    }

    /**
     * Reads map[key]. A key the map does not hold throws, naming the map
     * and the key; nothing is defaulted (SPEC.md 2.5).
     */
    public static <K, V> V mustGet(java.util.Map<K, V> map, K key, String name) {
        if (!map.containsKey(key)) {
            throw new java.util.NoSuchElementException("SPECKL-MISSING-KEY: " + name + "[" + key + "] is not set");
        }
        return map.get(key);
    }

    /** Records an emitted event on the exchange (property "SpecklEvents"). */
    @SuppressWarnings("unchecked")
    public static void emit(org.apache.camel.Exchange exchange, Object event) {
        java.util.List<Object> events = exchange.getProperty("SpecklEvents", java.util.List.class);
        if (events == null) {
            events = new java.util.ArrayList<>();
            exchange.setProperty("SpecklEvents", events);
        }
        events.add(event);
    }

    /** append(list, x): a new list with x at the end. */
    public static <T> java.util.List<T> append(java.util.List<T> list, T item) {
        java.util.List<T> out = new java.util.ArrayList<>(list);
        out.add(item);
        return out;
    }

    /** append(list, items): a new list with items at the end. */
    public static <T> java.util.List<T> appendAll(java.util.List<T> list, java.util.List<T> items) {
        java.util.List<T> out = new java.util.ArrayList<>(list);
        out.addAll(items);
        return out;
    }
}
`;
}

// ─────────────────────────────────────────────────────────────────────
// Processor classes
// ─────────────────────────────────────────────────────────────────────

function emitProcessor(ctx: SpeckContext, action: IRAction): string {
  const className = `${action.name}Processor`;
  const env = new Env(ctx, ctx.stateBeanVar);

  // Parameters arrive as message headers named after the spec parameter.
  const paramExtracts = action.params.map((p) => {
    const t = ctx.resolve(p.type);
    const javaName = env.declare(p.name, t);
    const javaType = ctx.java(t);
    if (t.k === 'list' || t.k === 'set' || t.k === 'map') {
      const raw = t.k === 'list' ? 'java.util.List' : t.k === 'set' ? 'java.util.Set' : 'java.util.Map';
      return `        @SuppressWarnings("unchecked")\n        ${javaType} ${javaName} = (${javaType}) exchange.getIn().getHeader("${escapeString(p.name)}", ${raw}.class);`;
    }
    const cls = ctx.java(t, true).replace(/<.*$/, '');
    return `        ${javaType} ${javaName} = exchange.getIn().getHeader("${escapeString(p.name)}", ${cls}.class);`;
  });

  // Postconditions describe the state after the action, so they are checked
  // after the statements (and before any return).
  const posts = action.statements.filter((s) => s.kind === 'postcondition');
  const body = action.statements.filter((s) => s.kind !== 'postcondition');
  env.postconditions = posts;
  let bodyLines = stmtsToJava(body, env, '        ', true);
  // A writing action (same rule as the TypeScript target) saves the state
  // fields its body reads or writes and puts them back if the body throws
  // (a failed guard, a missing map key), so a failed action leaves no
  // partial write. Writes in this target are whole-field sets and map/list
  // put/set (a field of a stored record cannot be assigned), so a copy of
  // each collection is enough.
  if (env.failures.length === 0 && irStmtsWrite(action.statements)) {
    const text = bodyLines.join('\n');
    const saved = [...ctx.stateVars.entries()].filter(([name]) => text.includes(`${ctx.stateBeanVar}.get${cap(javaIdent(name))}()`));
    if (saved.length > 0) {
      const decl = saved.map(([name, t]) => {
        const get = `${ctx.stateBeanVar}.get${cap(javaIdent(name))}()`;
        const copy = t.k === 'map' ? 'java.util.LinkedHashMap' : t.k === 'list' ? 'java.util.ArrayList' : t.k === 'set' ? 'java.util.LinkedHashSet' : null;
        const v = copy ? `${get} == null ? null : new ${copy}<>(${get})` : get;
        return `        final ${ctx.java(t)} __saved${cap(javaIdent(name))} = ${v};`;
      });
      bodyLines = [
        ...decl,
        '        try {',
        ...bodyLines.map((l) => l.split('\n').map((x) => (x ? '    ' + x : x)).join('\n')),
        '        } catch (RuntimeException e) {',
        ...saved.map(([name]) => `            ${ctx.stateBeanVar}.set${cap(javaIdent(name))}(__saved${cap(javaIdent(name))});`),
        '            throw e;',
        '        }',
      ];
    }
  }
  const lines = [...paramExtracts, ...bodyLines];
  // If any part of the action has no translation, refuse the whole action
  // before it reads or writes state, rather than applying part of it.
  if (env.failures.length > 0) {
    const n = env.failures.length;
    const msg = `${action.name}: ${n} untranslated statement${n === 1 ? '' : 's'}, first: ${env.failures[0]}`;
    lines.unshift(
      `        // This action cannot run until every statement below is translated.`,
      `        SpecklRuntime.untranslated("${escapeString(msg)}");`,
    );
  }

  const doc = action.doc ? `/**\n * ${javaCommentText(action.doc)}\n */\n` : `/**\n * Processor for the ${action.name} action.\n */\n`;

  return `package ${ctx.pkg}.processor;

import org.apache.camel.Exchange;
import org.apache.camel.Processor;
import ${ctx.pkg}.${ctx.stateBean};
import ${ctx.pkg}.SpecklRuntime;
import jakarta.inject.Inject;
import jakarta.inject.Named;
import jakarta.enterprise.context.ApplicationScoped;

${doc}@ApplicationScoped
@Named("${className}")
public class ${className} implements Processor {

    @Inject
    ${ctx.stateBean} ${ctx.stateBeanVar};

    @Override
    public void process(Exchange exchange) throws Exception {
${lines.join('\n')}
    }
}
`;
}

// ─────────────────────────────────────────────────────────────────────
// RouteBuilder
// ─────────────────────────────────────────────────────────────────────

function emitRouteBuilder(speck: IRSpeck, actions: IRAction[], pkg: string): string {
  const className = `${speck.name}Routes`;
  const routes = actions.map((a, idx) => {
    return emitRouteEntry(a, idx);
  }).join('\n\n');

  return `package ${pkg};

import org.apache.camel.builder.RouteBuilder;
import jakarta.enterprise.context.ApplicationScoped;

/**
 * Camel RouteBuilder for the ${speck.name} speck.
 *
 * Each action in the spec becomes a Camel route. Timer-triggered
 * actions use a timer endpoint; service RPC actions use platform-http
 * endpoints. Each route delegates to a dedicated Processor that
 * encodes the state transition.
 *
 * Generated by speckl-compile from ${javaCommentText(speck.sourcePath)}.
 */
@ApplicationScoped
public class ${className} extends RouteBuilder {

    @Override
    public void configure() throws Exception {

${routes}
    }
}
`;
}

function emitRouteEntry(action: IRAction, index: number): string {
  const processorName = `${action.name}Processor`;
  // Heuristic: actions named with "Timer", "Boot", "Poll", "Check",
  // "Flush", "Digest", or that have zero parameters are timer-triggered.
  // Actions with parameters are HTTP-triggered.
  const isTimer = action.params.length === 0 ||
    /Timer|Boot|Poll|Check|Flush|Digest|Sync/i.test(action.name);

  if (isTimer) {
    // Timer-triggered route. Use a 5-minute default (spec constraints
    // define the exact interval; this is a placeholder).
    const period = /Digest|Daily/i.test(action.name) ? '86400000' : '300000';
    return `        // ${action.name} — timer-triggered
        from("timer:${action.name}?period=${period}")
            .routeId("${action.name}")
            .process("${processorName}");`;
  } else {
    // HTTP-triggered route via platform-http
    return `        // ${action.name} — HTTP-triggered
        from("platform-http:/${lcFirst(action.name)}")
            .routeId("${action.name}")
            .process("${processorName}");`;
  }
}

// ─────────────────────────────────────────────────────────────────────
// application.properties
// ─────────────────────────────────────────────────────────────────────

function emitApplicationProperties(speck: IRSpeck): string {
  return `# ${speck.name} — generated by speckl-compile
# Apache Camel Quarkus application properties

# HTTP port for platform-http endpoints
quarkus.http.port=8080

# Camel
camel.context.name=${speck.name}

# Logging
quarkus.log.level=INFO
quarkus.log.category."org.apache.camel".level=INFO
`;
}

// ─────────────────────────────────────────────────────────────────────
// pom.xml
// ─────────────────────────────────────────────────────────────────────

function emitPom(speck: IRSpeck, artifactId: string, groupId: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>${groupId}</groupId>
    <artifactId>${artifactId}</artifactId>
    <version>${version}</version>
    <packaging>jar</packaging>

    <description>Generated by speckl-compile from ${speck.sourcePath}</description>

    <properties>
        <maven.compiler.source>21</maven.compiler.source>
        <maven.compiler.target>21</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
        <quarkus.platform.version>3.15.1</quarkus.platform.version>
        <camel.quarkus.platform.version>3.15.0</camel.quarkus.platform.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>io.quarkus.platform</groupId>
                <artifactId>quarkus-bom</artifactId>
                <version>\${quarkus.platform.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
            <dependency>
                <groupId>io.quarkus.platform</groupId>
                <artifactId>quarkus-camel-bom</artifactId>
                <version>\${camel.quarkus.platform.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <dependencies>
        <dependency>
            <groupId>org.apache.camel.quarkus</groupId>
            <artifactId>camel-quarkus-platform-http</artifactId>
        </dependency>
        <dependency>
            <groupId>org.apache.camel.quarkus</groupId>
            <artifactId>camel-quarkus-timer</artifactId>
        </dependency>
        <dependency>
            <groupId>org.apache.camel.quarkus</groupId>
            <artifactId>camel-quarkus-log</artifactId>
        </dependency>
        <dependency>
            <groupId>io.quarkus</groupId>
            <artifactId>quarkus-arc</artifactId>
        </dependency>
        <dependency>
            <groupId>io.quarkus</groupId>
            <artifactId>quarkus-jackson</artifactId>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>io.quarkus</groupId>
                <artifactId>quarkus-maven-plugin</artifactId>
                <version>\${quarkus.platform.version}</version>
                <executions>
                    <execution>
                        <goals><goal>build</goal></goals>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>
</project>
`;
}

// ─────────────────────────────────────────────────────────────────────
// Statement → Java translation
// ─────────────────────────────────────────────────────────────────────

/** Lexical scope for one processor body (or the state bean constructor). */
class Env {
  locals = new Map<string, { java: string; t: JT }>();
  /** Java names already declared anywhere in the method (Java forbids shadowing). */
  used: Set<string>;
  postconditions: IRStmt[] = [];
  /** Source of every untranslated statement in the method, in order. */
  failures: string[];

  constructor(readonly ctx: SpeckContext, readonly stateRef: string, parent?: Env) {
    this.used = parent ? parent.used : new Set(['exchange', ctx.stateBeanVar]);
    this.failures = parent ? parent.failures : [];
    if (parent) {
      this.locals = new Map(parent.locals);
      this.postconditions = parent.postconditions;
    }
  }

  child(): Env {
    return new Env(this.ctx, this.stateRef, this);
  }

  /** Declare a local; returns its (unique, keyword-safe) Java name. */
  declare(name: string, t: JT): string {
    let java = javaIdent(name);
    if (this.used.has(java)) {
      let i = 2;
      while (this.used.has(`${java}_${i}`)) i++;
      java = `${java}_${i}`;
    }
    this.used.add(java);
    this.locals.set(name, { java, t });
    return java;
  }
}

/** Source-like rendering of an IR expression, for messages and comments. */
function exprSource(expr: IRExpr | undefined): string {
  if (!expr || typeof expr !== 'object' || !expr.kind) return '<unknown expression>';
  switch (expr.kind) {
    case 'bool_lit':
      if (expr.parseFailed || expr.value === undefined) return expr.source ?? '<unknown expression>';
      return String(expr.value);
    case 'int_lit':
    case 'float_lit':
      return String(expr.value);
    case 'string_lit':
      return JSON.stringify(expr.value);
    case 'ident':
      return expr.name;
    case 'field':
      return `${exprSource(expr.target)}.${expr.field}`;
    case 'index':
      return `${exprSource(expr.target)}[${exprSource(expr.index)}]`;
    case 'binop':
      return `${exprSource(expr.left)} ${expr.op} ${exprSource(expr.right)}`;
    case 'unop':
      return `${expr.op}${exprSource(expr.operand)}`;
    case 'call':
      return `${expr.fn}(${expr.args.map(exprSource).join(', ')})`;
  }
  return '<unknown expression>';
}

function stmtSource(stmt: IRStmt): string {
  if (stmt.raw) return stmt.raw;
  const v = stmt.value ?? stmt.expr;
  switch (stmt.kind) {
    case 'assign': {
      const target = stmt.targetIndex && stmt.target?.endsWith('[...]')
        ? `${stmt.target.slice(0, -5)}[${exprSource(stmt.targetIndex)}]`
        : stmt.target;
      return `${target} := ${exprSource(v)}`;
    }
    case 'let':
      return `let ${stmt.letName} := ${exprSource(v)}`;
    case 'emit':
      return `emit ${stmt.event}(${(stmt.fields ?? []).map((f) => `${f.name}: ${exprSource(f.value)}`).join(', ')})`;
    case 'return':
      return v ? `return ${exprSource(v)}` : 'return';
    case 'if':
      return `if ${exprSource(v)} { ... }`;
    default:
      return `${stmt.kind} ${exprSource(v)}`;
  }
}

/** A statement that fails closed at runtime, carrying the spec source. */
function untranslatedStmt(ctx: SpeckContext, source: string, indent: string, env?: Env): string {
  const text = source.replace(/\s+/g, ' ').trim();
  env?.failures.push(text);
  return `${indent}// SPECKL-UNTRANSLATED: ${javaCommentText(text)}\n` +
    `${indent}${ctx.pkg}.SpecklRuntime.untranslated("${escapeString(text)}");`;
}

function stmtsToJava(stmts: IRStmt[], env: Env, indent: string, topLevel = false): string[] {
  const out: string[] = [];
  let returned = false;
  for (const stmt of stmts) {
    const r = stmtToJava(stmt, env, indent);
    out.push(r.code);
    // Anything after a return in the same block is unreachable (in the spec
    // as in Java, where it would not compile), so it is not emitted.
    if (r.returns) { returned = true; break; }
  }
  if (topLevel && !returned) out.push(...postconditionsToJava(env, indent));
  return out;
}

function postconditionsToJava(env: Env, indent: string): string[] {
  return env.postconditions.map((s) => {
    const src = `postcondition: ${exprSource(s.value)}`;
    const c = s.value ? translate(s.value, env, BOOL) : null;
    if (!c || c.t.k !== 'bool') return untranslatedStmt(env.ctx, src, indent, env);
    return `${indent}// postcondition: ${javaCommentText(exprSource(s.value))}\n` +
      `${indent}if (!(${c.code})) {\n${indent}    throw new IllegalStateException("Postcondition failed: ${escapeString(exprSource(s.value))}");\n${indent}}`;
  });
}

function stmtToJava(stmt: IRStmt, env: Env, indent: string): { code: string; returns?: boolean } {
  const ctx = env.ctx;
  const fail = () => ({ code: untranslatedStmt(ctx, stmtSource(stmt), indent, env) });
  const value = stmt.value ?? stmt.expr;

  switch (stmt.kind) {
    case 'assign': {
      if (!value || !stmt.target) return fail();
      if (stmt.target.endsWith('[...]')) {
        const base = lookupName(stmt.target.slice(0, -5), env);
        if (!base || !stmt.targetIndex) return fail();
        if (base.t.k === 'map') {
          const k = translate(stmt.targetIndex, env, base.t.key);
          const v = translate(value, env, base.t.val);
          if (!k || !v || !assignable(k.t, base.t.key) || !assignable(v.t, base.t.val)) return fail();
          return { code: `${indent}${base.code}.put(${boxed(k, base.t.key, ctx)}, ${boxed(v, base.t.val, ctx)});` };
        }
        if (base.t.k === 'list') {
          const i = translate(stmt.targetIndex, env, LONG);
          const v = translate(value, env, base.t.elem);
          if (!i || i.t.k !== 'long' || !v || !assignable(v.t, base.t.elem)) return fail();
          return { code: `${indent}${base.code}.set((int) (${i.code}), ${boxed(v, base.t.elem, ctx)});` };
        }
        return fail();
      }
      const local = env.locals.get(stmt.target);
      const stateT = local ? undefined : ctx.stateVars.get(stmt.target);
      const t = local?.t ?? stateT;
      if (!t) return fail();
      const v = translate(value, env, t);
      if (!v || !assignable(v.t, t)) return fail();
      if (local) return { code: `${indent}${local.java} = ${v.code};` };
      return { code: `${indent}${env.stateRef}.set${cap(javaIdent(stmt.target))}(${v.code});` };
    }
    case 'let': {
      if (!value || !stmt.letName) return fail();
      const v = translate(value, env);
      if (!v || v.t.k === 'object') return fail();
      const java = env.declare(stmt.letName, v.t);
      return { code: `${indent}${ctx.java(v.t)} ${java} = ${v.code};` };
    }
    case 'require':
    case 'precondition': {
      const c = value ? translate(value, env, BOOL) : null;
      if (!c || c.t.k !== 'bool') return fail();
      const src = exprSource(value);
      return {
        code: `${indent}// ${stmt.kind}: ${javaCommentText(src)}\n` +
          `${indent}if (!(${c.code})) {\n${indent}    throw new IllegalStateException("Precondition failed: ${escapeString(src)}");\n${indent}}`,
      };
    }
    case 'emit': {
      const ev = ctx.speck.facets.behavior.events.find((e) => e.name === stmt.event);
      if (!ev) return fail();
      const given = new Map((stmt.fields ?? []).map((f) => [f.name, f.value]));
      if ([...given.keys()].some((k) => !ev.fields.some((f) => f.name === k))) return fail();
      const args: string[] = [];
      for (const f of ev.fields) {
        const ft = ctx.resolve(f.type);
        const g = given.get(f.name);
        if (!g) return fail();
        const v = translate(g, env, ft);
        if (!v || !assignable(v.t, ft)) return fail();
        args.push(v.code);
      }
      return { code: `${indent}// emit ${stmt.event}\n${indent}${ctx.pkg}.SpecklRuntime.emit(exchange, new ${ctx.pkg}.event.${ev.name}(${args.join(', ')}));` };
    }
    case 'return': {
      const posts = postconditionsToJava(env, indent);
      if (!value) return { code: [...posts, `${indent}return;`].join('\n'), returns: true };
      const v = translate(value, env);
      if (!v) return fail();
      return { code: [`${indent}exchange.getMessage().setBody(${v.code});`, ...posts, `${indent}return;`].join('\n'), returns: true };
    }
    case 'if': {
      if (!value) return fail();
      const c = translate(value, env, BOOL);
      if (!c || c.t.k !== 'bool') return fail();
      const inner = indent + '    ';
      const thenLines = stmtsToJava(stmt.thenBlock ?? [], env.child(), inner);
      let code = `${indent}if (${c.code}) {\n${thenLines.join('\n')}\n${indent}}`;
      if (stmt.elseBlock && stmt.elseBlock.length > 0) {
        const elseLines = stmtsToJava(stmt.elseBlock, env.child(), inner);
        code += ` else {\n${elseLines.join('\n')}\n${indent}}`;
      }
      return { code };
    }
    default:
      return fail();
  }
}

/** A value passed where a reference type is needed (collections). */
function boxed(v: { code: string; t: JT }, target: JT, ctx: SpeckContext): string {
  // long → Long works by boxing, but a long where Double is expected does not.
  if (v.t.k === 'long' && target.k === 'double') return `(double) (${v.code})`;
  return v.code;
}

// ─────────────────────────────────────────────────────────────────────
// Expression → Java translation
// ─────────────────────────────────────────────────────────────────────

type TExpr = { code: string; t: JT };

function lookupName(name: string, env: Env): TExpr | null {
  const local = env.locals.get(name);
  if (local) return { code: local.java, t: local.t };
  const st = env.ctx.stateVars.get(name);
  if (st) return { code: `${env.stateRef}.get${cap(javaIdent(name))}()`, t: st };
  return null;
}

/**
 * Translate an expression with its type, or return null when it has no
 * well-typed Java form (the caller then fails closed). `expected` only
 * guides context-typed forms such as empty collections and enum variants.
 */
function translate(expr: IRExpr | undefined, env: Env, expected?: JT): TExpr | null {
  if (!expr || typeof expr !== 'object' || !expr.kind) return null;
  const ctx = env.ctx;
  switch (expr.kind) {
    case 'bool_lit':
      if (expr.parseFailed || expr.value === undefined) return null;
      return { code: String(expr.value), t: BOOL };
    case 'int_lit':
      if (!Number.isSafeInteger(expr.value)) return null;
      return { code: `${expr.value}L`, t: LONG };
    case 'float_lit':
      if (!Number.isFinite(expr.value)) return null;
      return { code: `${expr.value}d`, t: DOUBLE };
    case 'string_lit':
      return { code: `"${escapeString(expr.value)}"`, t: STRING };
    case 'ident': {
      const n = lookupName(expr.name, env);
      if (n) return n;
      // `emptyMap` written without parentheses, as most specs do.
      if (['emptySet', 'emptyMap', 'emptyList'].includes(expr.name)) return translateCall(expr.name, [], env, expected);
      const owners = ctx.variants.get(expr.name);
      if (owners) {
        const owner = expected?.k === 'enum' && owners.includes(expected.name) ? expected.name
          : owners.length === 1 ? owners[0] : undefined;
        if (owner) return { code: `${ctx.pkg}.model.${owner}.${javaIdent(expr.name)}`, t: { k: 'enum', name: owner } };
      }
      return null;
    }
    case 'field': {
      // `this.x` is the state variable x.
      if (expr.target.kind === 'ident' && expr.target.name === 'this') {
        const st = ctx.stateVars.get(expr.field);
        return st ? { code: `${env.stateRef}.get${cap(javaIdent(expr.field))}()`, t: st } : null;
      }
      const target = translate(expr.target, env);
      if (!target) return null;
      if (target.t.k === 'record') {
        const ft = ctx.recordField(target.t.name, expr.field);
        return ft ? { code: `${target.code}.get${cap(javaIdent(expr.field))}()`, t: ft } : null;
      }
      if (target.t.k === 'map' && expr.field === 'keys') {
        return { code: `${target.code}.keySet()`, t: { k: 'set', elem: target.t.key } };
      }
      return null;
    }
    case 'index': {
      const target = translate(expr.target, env);
      if (!target) return null;
      if (target.t.k === 'map') {
        const k = translate(expr.index, env, target.t.key);
        if (!k || !assignable(k.t, target.t.key)) return null;
        // A key the map does not hold throws naming the map and the key
        // (SPEC.md 2.5); nothing is defaulted. A nullable value type keeps
        // get(): a missing key and a stored null both read null.
        if (!target.t.val.nullable) {
          const name = escapeString(expr.target.kind === 'ident' ? expr.target.name : target.code);
          return { code: `${ctx.pkg}.SpecklRuntime.mustGet(${target.code}, ${boxed(k, target.t.key, ctx)}, "${name}")`, t: { ...target.t.val } };
        }
        return { code: `${target.code}.get(${boxed(k, target.t.key, ctx)})`, t: { ...target.t.val, nullable: true } };
      }
      if (target.t.k === 'list') {
        const i = translate(expr.index, env, LONG);
        if (!i || i.t.k !== 'long') return null;
        return { code: `${target.code}.get((int) (${i.code}))`, t: { ...target.t.elem, nullable: true } };
      }
      return null;
    }
    case 'unop': {
      const v = translate(expr.operand, env);
      if (!v) return null;
      if ((expr.op === '!' || expr.op === 'not') && v.t.k === 'bool') return { code: `(!${v.code})`, t: BOOL };
      if (expr.op === '-' && isNumeric(v.t)) return { code: `(-${v.code})`, t: { k: v.t.k } as JT };
      return null;
    }
    case 'binop':
      return translateBinop(expr.op, expr.left, expr.right, env);
    case 'call':
      return translateCall(expr.fn, expr.args, env, expected);
  }
  return null;
}

function translateBinop(op: string, le: IRExpr, re: IRExpr, env: Env): TExpr | null {
  const ctx = env.ctx;
  if (op === 'in' || op === '!in' || op === 'notIn' || op === 'not in') {
    const coll = translate(re, env);
    if (!coll) return null;
    const elemT = coll.t.k === 'map' ? coll.t.key : coll.t.k === 'list' || coll.t.k === 'set' ? coll.t.elem : null;
    if (!elemT) return null;
    const item = translate(le, env, elemT);
    if (!item || !assignable(item.t, elemT)) return null;
    const call = coll.t.k === 'map' ? 'containsKey' : 'contains';
    const code = `${coll.code}.${call}(${boxed(item, elemT, ctx)})`;
    return { code: op === 'in' ? code : `(!${code})`, t: BOOL };
  }

  const l = translate(le, env);
  // An enum variant on the right is typed by the left side, and vice versa.
  const r = translate(re, env, l?.t);
  const l2 = l ?? (r ? translate(le, env, r.t) : null);
  if (!l2 || !r) return null;
  const L = l2.t;
  const R = r.t;
  const num = isNumeric(L) && isNumeric(R);
  const numT: JT = L.k === 'double' || R.k === 'double' ? DOUBLE : LONG;

  switch (op) {
    case '&&':
    case 'and':
    case '||':
    case 'or':
      if (L.k !== 'bool' || R.k !== 'bool') return null;
      return { code: `(${l2.code} ${op === '&&' || op === 'and' ? '&&' : '||'} ${r.code})`, t: BOOL };
    case 'implies':
    case '=>':
      if (L.k !== 'bool' || R.k !== 'bool') return null;
      return { code: `(!${l2.code} || ${r.code})`, t: BOOL };
    case '+':
      if (num) return { code: `(${l2.code} + ${r.code})`, t: numT };
      if ((L.k === 'string' && R.k !== 'object') || (R.k === 'string' && L.k !== 'object')) {
        return { code: `(${l2.code} + ${r.code})`, t: STRING };
      }
      return null;
    case '-':
    case '*':
    case '/':
    case '%':
      if (!num) return null;
      return { code: `(${l2.code} ${op} ${r.code})`, t: numT };
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (!num) return null;
      return { code: `(${l2.code} ${op} ${r.code})`, t: BOOL };
    case '==':
    case '!=': {
      const neg = op === '!=';
      // Primitive comparison only when neither side is boxed: == on two
      // Longs compares references.
      if ((num || (L.k === 'bool' && R.k === 'bool')) && !L.nullable && !R.nullable) {
        return { code: `(${l2.code} ${op} ${r.code})`, t: BOOL };
      }
      if (L.k === 'enum' && R.k === 'enum' && L.name === R.name) {
        return { code: `(${l2.code} ${op} ${r.code})`, t: BOOL };
      }
      if (L.k === 'object' || R.k === 'object') return null;
      if (num ? L.k !== R.k : !(assignable(L, R) || assignable(R, L))) return null;
      const code = `java.util.Objects.equals(${l2.code}, ${r.code})`;
      return { code: neg ? `(!${code})` : code, t: BOOL };
    }
    default:
      // union, diff, intersect and other set algebra have no translation yet.
      return null;
  }
}

function translateCall(fn: string, argExprs: IRExpr[], env: Env, expected?: JT): TExpr | null {
  const ctx = env.ctx;
  // Context-typed empty collections.
  if (['emptySet', 'emptyMap', 'emptyList', 'empty'].includes(fn)) {
    if (!expected) return null;
    // Specs use emptySet()/emptyList() for either collection kind.
    const fits = fn === 'empty' || (fn === 'emptyMap' ? expected.k === 'map' : expected.k === 'list' || expected.k === 'set');
    const empty = fits ? ctx.emptyOf(expected) : undefined;
    return empty ? { code: empty, t: expected } : null;
  }
  const args: TExpr[] = [];
  for (const a of argExprs) {
    const v = translate(a, env);
    if (!v) return null;
    args.push(v);
  }
  const [a, b] = args;
  switch (fn) {
    case 'length':
    case 'len':
    case 'size':
    case 'count':
      if (args.length !== 1) return null;
      if (a.t.k === 'list' || a.t.k === 'set' || a.t.k === 'map') return { code: `((long) ${a.code}.size())`, t: LONG };
      if (a.t.k === 'string') return { code: `((long) ${a.code}.length())`, t: LONG };
      return null;
    case 'has':
      if (args.length !== 2 || a.t.k !== 'map' || !assignable(b.t, a.t.key)) return null;
      return { code: `${a.code}.containsKey(${boxed(b, a.t.key, ctx)})`, t: BOOL };
    case 'contains':
      if (args.length !== 2) return null;
      if ((a.t.k === 'list' || a.t.k === 'set') && assignable(b.t, a.t.elem)) return { code: `${a.code}.contains(${boxed(b, a.t.elem, ctx)})`, t: BOOL };
      if (a.t.k === 'string' && b.t.k === 'string') return { code: `${a.code}.contains(${b.code})`, t: BOOL };
      return null;
    case 'implies':
      if (args.length !== 2 || a.t.k !== 'bool' || b.t.k !== 'bool') return null;
      return { code: `(!${a.code} || ${b.code})`, t: BOOL };
    case 'min':
    case 'max': {
      if (args.length !== 2 || !isNumeric(a.t) || !isNumeric(b.t)) return null;
      const t = a.t.k === 'double' || b.t.k === 'double' ? DOUBLE : LONG;
      return { code: `Math.${fn}(${a.code}, ${b.code})`, t };
    }
    case 'append':
      if (args.length !== 2 || a.t.k !== 'list') return null;
      if (sameType(b.t, a.t)) return { code: `${ctx.pkg}.SpecklRuntime.appendAll(${a.code}, ${b.code})`, t: { k: 'list', elem: a.t.elem } };
      if (assignable(b.t, a.t.elem)) return { code: `${ctx.pkg}.SpecklRuntime.append(${a.code}, ${boxed(b, a.t.elem, ctx)})`, t: { k: 'list', elem: a.t.elem } };
      return null;
    default:
      return null;
  }
}

/** Single-line text that is safe inside a Java block or line comment. */
function javaCommentText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\*\//g, '* /').replace(/\\u/g, '\\ u').trim();
}

// ─────────────────────────────────────────────────────────────────────
// Naming utilities
// ─────────────────────────────────────────────────────────────────────

const JAVA_RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null', '_', 'var', 'yield', 'record', 'sealed', 'permits',
]);

/** A spec identifier as a legal Java identifier. */
function javaIdent(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;
  if (s === '' ) s = '_x';
  return JAVA_RESERVED.has(s) ? `${s}_` : s;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function kebabCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Text as the inside of a Java string literal. */
function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function derivePackageName(speck: IRSpeck): string {
  const proto = speck.protoPackage;
  if (proto) {
    // "speckl.v1alpha1" → "speckl.v1alpha1.camel"
    return `${proto}.camel`;
  }
  // Fallback: lowercase speck name
  return `${speck.name.toLowerCase()}.camel`;
}
