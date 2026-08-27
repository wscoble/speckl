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
// See OB1 #3642 for the architecture rationale.

import * as fs from 'fs';
import * as path from 'path';
import {
  IR,
  IRSpeck,
  IRRecordType,
  IREnumType,
  IRFieldDef,
  IRTypeRef,
  IRAction,
  IRStmt,
  IRExpr,
  IRStateVar,
  IREvent,
  IRConstraint,
} from '../ir/types.js';

export interface CamelOptions {
  /** Output directory. */
  outputDir: string;
  /** Override the Java package name. Default: derived from protoPackage or speck name. */
  packageName?: string;
  /** Override the Maven artifactId. Default: kebab-case of speck name. */
  artifactId?: string;
  /** Override the Maven groupId. Default: com.greybeard. */
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
    const groupId = options.groupId || 'com.greybeard';
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

  const types = speck.facets.typed_schema.types;
  const behavior = speck.facets.behavior;

  // 1. Model classes (records/enums)
  for (const [name, type] of types.entries()) {
    if (type.kind === 'record') {
      const code = emitModelClass(speck, type as IRRecordType, pkg);
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
    const code = emitEventClass(ev, pkg);
    fs.writeFileSync(path.join(javaDir, pkgPath, 'event', `${ev.name}.java`), code);
    console.log(`Generated Camel event: ${ev.name}.java`);
  }

  // 3. State holder bean
  const stateCode = emitStateBean(speck, behavior.stateVars, behavior.init, pkg);
  fs.writeFileSync(path.join(javaDir, pkgPath, `${speck.name}State.java`), stateCode);
  console.log(`Generated Camel state bean: ${speck.name}State.java`);

  // 4. Processor classes — one per action
  for (const action of behavior.actions) {
    const code = emitProcessor(speck, action, pkg);
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
// Model classes
// ─────────────────────────────────────────────────────────────────────

function emitModelClass(speck: IRSpeck, record: IRRecordType, pkg: string): string {
  const className = record.name;
  const fields = record.fields;

  const fieldDecls = fields.map((f) => {
    const javaType = typeRefToJava(f.type, speck);
    const nullable = f.type.nullable ? ' = null' : '';
    return `    private ${javaType} ${f.name}${nullable};`;
  }).join('\n');

  const gettersSetters = fields.map((f) => {
    const javaType = typeRefToJava(f.type, speck);
    const capped = cap(f.name);
    return `    public ${javaType} get${capped}() { return ${f.name}; }
    public void set${capped}(${javaType} ${f.name}) { this.${f.name} = ${f.name}; }`;
  }).join('\n\n');

  const doc = record.doc ? `/**\n * ${record.doc}\n */\n` : '';

  return `package ${pkg}.model;

${doc}public class ${className} {

${fieldDecls}

    public ${className}() {}

${gettersSetters}
}
`;
}

function emitEnumClass(enumType: IREnumType, pkg: string): string {
  const variants = enumType.variants.map((v) => `    ${v}`).join(',\n');
  const doc = enumType.doc ? `/**\n * ${enumType.doc}\n */\n` : '';

  return `package ${pkg}.model;

${doc}public enum ${enumType.name} {
${variants}
}
`;
}

// ─────────────────────────────────────────────────────────────────────
// Event classes
// ─────────────────────────────────────────────────────────────────────

function emitEventClass(ev: IREvent, pkg: string): string {
  const fields = ev.fields;
  const fieldDecls = fields.map((f) => {
    return `    private ${typeRefToJava(f.type, null)} ${f.name};`;
  }).join('\n');

  const ctorParams = fields.map((f) => `${typeRefToJava(f.type, null)} ${f.name}`).join(', ');
  const ctorAssigns = fields.map((f) => `        this.${f.name} = ${f.name};`).join('\n');

  const getters = fields.map((f) => {
    const capped = cap(f.name);
    return `    public ${typeRefToJava(f.type, null)} get${capped}() { return ${f.name}; }`;
  }).join('\n');

  const doc = ev.doc ? `/**\n * ${ev.doc}\n */\n` : '';

  return `package ${pkg}.event;

${doc}public class ${ev.name} {

${fieldDecls}

    public ${ev.name}() {}

    public ${ev.name}(${ctorParams}) {
${ctorAssigns}
    }

${getters}
}
`;
}

// ─────────────────────────────────────────────────────────────────────
// State holder bean
// ─────────────────────────────────────────────────────────────────────

function emitStateBean(
  speck: IRSpeck,
  stateVars: IRStateVar[],
  init: { target: string; expr: IRExpr }[],
  pkg: string,
): string {
  const className = `${speck.name}State`;

  const fieldDecls = stateVars.map((sv) => {
    const javaType = typeRefToJava(sv.type, speck);
    return `    private ${javaType} ${sv.name};`;
  }).join('\n');

  const initLines = init.map((a) => {
    const expr = exprToJava(a.expr);
    return `        this.${a.target} = ${expr};`;
  }).join('\n');

  const gettersSetters = stateVars.map((sv) => {
    const javaType = typeRefToJava(sv.type, speck);
    const capped = cap(sv.name);
    return `    public ${javaType} get${capped}() { return ${sv.name}; }
    public void set${capped}(${javaType} ${sv.name}) { this.${sv.name} = ${sv.name}; }`;
  }).join('\n\n');

  return `package ${pkg};

import jakarta.enterprise.context.ApplicationScoped;

/**
 * State holder for the ${speck.name} speck.
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

// ─────────────────────────────────────────────────────────────────────
// Processor classes
// ─────────────────────────────────────────────────────────────────────

function emitProcessor(speck: IRSpeck, action: IRAction, pkg: string): string {
  const className = `${action.name}Processor`;
  const stateBean = `${speck.name}State`;
  const stateBeanVar = lcFirst(speck.name) + 'State';

  // Build the body: preconditions, statements, postconditions
  const body = action.statements.map((stmt) => stmtToJava(stmt, speck)).join('\n\n');

  // Build parameter extraction from exchange body
  const paramExtracts = action.params.length > 0
    ? action.params.map((p) => {
        const javaType = typeRefToJava(p.type, speck);
        return `        ${javaType} ${p.name} = exchange.getIn().getBody(${javaType}.class);`;
      }).join('\n') + '\n'
    : '';

  const doc = action.doc ? `/**\n * ${action.doc}\n */\n` : `/**\n * Processor for the ${action.name} action.\n */\n`;

  return `package ${pkg}.processor;

import org.apache.camel.Exchange;
import org.apache.camel.Processor;
import ${pkg}.${stateBean};
import jakarta.inject.Inject;
import jakarta.enterprise.context.ApplicationScoped;

${doc}@ApplicationScoped
public class ${className} implements Processor {

    @Inject
    ${stateBean} ${stateBeanVar};

    @Override
    public void process(Exchange exchange) throws Exception {
${paramExtracts}
${body}
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
import ${pkg}.processor.*;

/**
 * Camel RouteBuilder for the ${speck.name} speck.
 *
 * Each action in the spec becomes a Camel route. Timer-triggered
 * actions use a timer endpoint; service RPC actions use platform-http
 * endpoints. Each route delegates to a dedicated Processor that
 * encodes the state transition.
 *
 * Generated by speckl-compile from ${speck.sourcePath}.
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

function stmtToJava(stmt: IRStmt, speck: IRSpeck): string {
  switch (stmt.kind) {
    case 'assign': {
      const expr = exprToJava(stmt.value || stmt.expr!);
      return `        ${stmt.target} = ${expr};`;
    }
    case 'let': {
      const expr = exprToJava(stmt.value || stmt.expr!);
      const javaType = inferJavaType(stmt.value || stmt.expr, speck);
      return `        var ${stmt.letName} = ${expr};`;
    }
    case 'require': {
      const expr = exprToJava(stmt.value!);
      return `        // require: ${exprToJavaRaw(stmt.value!)}
        if (!(${expr})) {
            throw new IllegalStateException("Precondition failed: ${escapeString(exprToJavaRaw(stmt.value!))}");
        }`;
    }
    case 'precondition': {
      const expr = exprToJava(stmt.value!);
      return `        // precondition: ${exprToJavaRaw(stmt.value!)}
        if (!(${expr})) {
            throw new IllegalStateException("Precondition failed");
        }`;
    }
    case 'postcondition': {
      const expr = exprToJava(stmt.value!);
      return `        // postcondition: ${exprToJavaRaw(stmt.value!)}
        if (!(${expr})) {
            throw new IllegalStateException("Postcondition failed");
        }`;
    }
    case 'emit': {
      const fields = (stmt.fields || []).map((f) => {
        return `                ${f.name} = ${exprToJava(f.value)}`;
      }).join(',\n');
      const eventType = stmt.event || 'Event';
      if (fields) {
        return `        // emit ${eventType}\n        var ${lcFirst(eventType)}Event = new ${eventType}(\n${fields}\n        );`;
      }
      return `        // emit ${eventType}\n        var ${lcFirst(eventType)}Event = new ${eventType}();`;
    }
    case 'return': {
      const expr = stmt.expr ? exprToJava(stmt.expr) : '';
      return `        return ${expr};`;
    }
    case 'if': {
      const cond = exprToJava(stmt.expr!);
      const thenBlock = (stmt.thenBlock || []).map((s) => stmtToJava(s, speck)).join('\n');
      const elseBlock = (stmt.elseBlock || []).map((s) => stmtToJava(s, speck)).join('\n');
      let result = `        if (${cond}) {\n${thenBlock}\n        }`;
      if (stmt.elseBlock && stmt.elseBlock.length > 0) {
        result = `        if (${cond}) {\n${thenBlock}\n        } else {\n${elseBlock}\n        }`;
      }
      return result;
    }
    default:
      return `        // TODO: ${stmt.kind}`;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Expression → Java translation
// ─────────────────────────────────────────────────────────────────────

function exprToJava(expr: IRExpr): string {
  switch (expr.kind) {
    case 'bool_lit':
      return String(expr.value);
    case 'int_lit':
      return String(expr.value);
    case 'float_lit':
      return String(expr.value);
    case 'string_lit':
      return `"${escapeString(expr.value)}"`;
    case 'ident':
      return expr.name;
    case 'field':
      return `${exprToJava(expr.target)}.get${cap(expr.field)}()`;
    case 'index':
      return `${exprToJava(expr.target)}.get(${exprToJava(expr.index)})`;
    case 'binop':
      return `(${exprToJava(expr.left)} ${binopToJava(expr.op)} ${exprToJava(expr.right)})`;
    case 'unop':
      return `(${unopToJava(expr.op)}${exprToJava(expr.operand)})`;
    case 'call':
      return `${expr.fn}(${expr.args.map(exprToJava).join(', ')})`;
    default: {
      // Unreachable — all IRExpr kinds are handled above.
      const _exhaustive: never = expr;
      return `/* TODO: ${(_exhaustive as any).kind} */`;
    }
  }
}

function exprToJavaRaw(expr: IRExpr): string {
  // For comments — closer to the source language
  switch (expr.kind) {
    case 'bool_lit':
      return String(expr.value);
    case 'int_lit':
      return String(expr.value);
    case 'float_lit':
      return String(expr.value);
    case 'string_lit':
      return `"${escapeString(expr.value)}"`;
    case 'ident':
      return expr.name;
    case 'field':
      return `${exprToJavaRaw(expr.target)}.${expr.field}`;
    case 'index':
      return `${exprToJavaRaw(expr.target)}[${exprToJavaRaw(expr.index)}]`;
    case 'binop':
      return `${exprToJavaRaw(expr.left)} ${expr.op} ${exprToJavaRaw(expr.right)}`;
    case 'unop':
      return `${expr.op}${exprToJavaRaw(expr.operand)}`;
    case 'call':
      return `${expr.fn}(${expr.args.map(exprToJavaRaw).join(', ')})`;
    default: {
      // Unreachable — all IRExpr kinds are handled above.
      const _exhaustive: never = expr;
      return `/* ${(_exhaustive as any).kind} */`;
    }
  }
}

function binopToJava(op: string): string {
  switch (op) {
    case '&&':
      return '&&';
    case '||':
      return '||';
    case 'in':
      return 'in'; // Java doesn't have 'in' — but this is a placeholder
    default:
      return op; // ==, !=, <, <=, >, >=, +, -, *, /, % all map directly
  }
}

function unopToJava(op: string): string {
  switch (op) {
    case '!':
      return '!';
    case '-':
      return '-';
    default:
      return op;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Type mapping: SpeckDL IRTypeRef → Java type
// ─────────────────────────────────────────────────────────────────────

function typeRefToJava(typeRef: IRTypeRef, speck: IRSpeck | null): string {
  if (typeRef.kind === 'primitive') {
    return primitiveToJava(typeRef.primitive || 'string', typeRef.nullable);
  } else if (typeRef.kind === 'list' || typeRef.kind === 'set') {
    const elemType = typeRefToJava(typeRef.elementType!, speck);
    return `java.util.List<${elemType}>`;
  } else if (typeRef.kind === 'map') {
    const keyType = typeRefToJava(typeRef.keyType!, speck);
    const valType = typeRefToJava(typeRef.valueType!, speck);
    return `java.util.Map<${keyType}, ${valType}>`;
  } else if (typeRef.kind === 'ident') {
    const name = typeRef.name || 'Object';
    // For nullable idents, wrap in Optional or just allow null
    return name;
  }
  return 'Object';
}

function primitiveToJava(prim: string, nullable?: boolean): string {
  switch (prim) {
    case 'String':
      return 'String';
    case 'Nat':
    case 'Int':
      return nullable ? 'Long' : 'long';
    case 'Real':
      return nullable ? 'Double' : 'double';
    case 'Bool':
      return nullable ? 'Boolean' : 'boolean';
    case 'Bytes':
      return 'byte[]';
    case 'Date':
      return 'java.time.Instant';
    default:
      return 'String';
  }
}

function inferJavaType(expr: IRExpr | undefined, speck: IRSpeck | null): string {
  if (!expr) return 'var';
  switch (expr.kind) {
    case 'bool_lit':
      return 'boolean';
    case 'int_lit':
      return 'long';
    case 'float_lit':
      return 'double';
    case 'string_lit':
      return 'String';
    default:
      return 'var';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Naming utilities
// ─────────────────────────────────────────────────────────────────────

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function kebabCase(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function derivePackageName(speck: IRSpeck): string {
  const proto = speck.protoPackage;
  if (proto) {
    // "greybeard.v1alpha1" → "greybeard.v1alpha1.camel"
    return `${proto}.camel`;
  }
  // Fallback: lowercase speck name
  return `${speck.name.toLowerCase()}.camel`;
}