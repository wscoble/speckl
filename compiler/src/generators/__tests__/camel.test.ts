// src/generators/__tests__/camel.test.ts
//
// Tests for the Apache Camel (camel-quarkus) target generator.
// The generator must:
//   - Emit a RouteBuilder with one route per action
//   - Emit model classes for each record type
//   - Emit enums for each interface-as-enum
//   - Emit event classes for each event
//   - Emit a state holder bean
//   - Emit a Processor per action
//   - Emit a pom.xml with camel-quarkus dependencies
//   - Emit application.properties
//
// Tests run against the existing parser-compatible specs (ToggleSwitch,
// RetryHandler) and inline simple specs.

import { describe, it, expect } from 'vitest';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { parseSpeckFile } from '../../parser.js';
import { lower } from '../../ir/lower.js';
import { generateCamel } from '../camel.js';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

function compileCamelFromExample(name: string): { outDir: string; speckDir: string } {
  const filePath = join(REPO, 'examples', name);
  const ast = parseSpeckFile(filePath);
  const ir = lower(ast, { filePath, resolveImports: false });

  const tmp = mkdtempSync(join(tmpdir(), 'speckl-camel-'));
  generateCamel(ir, { outputDir: tmp });
  const camelDir = join(tmp, 'camel');
  const entries = readdirSync(camelDir);
  return { outDir: tmp, speckDir: join(camelDir, entries[0]) };
}

function compileCamelFromString(src: string): { outDir: string; speckDir: string } {
  const filePath = '/tmp/speckl-camel-test.speckdl';
  writeFileSync(filePath, src);
  const ast = parseSpeckFile(filePath);
  const ir = lower(ast, { filePath, resolveImports: false });

  const tmp = mkdtempSync(join(tmpdir(), 'speckl-camel-'));
  generateCamel(ir, { outputDir: tmp });
  const camelDir = join(tmp, 'camel');
  const entries = readdirSync(camelDir);
  return { outDir: tmp, speckDir: join(camelDir, entries[0]) };
}

function readFileSafe(filePath: string): string {
  if (!existsSync(filePath)) return '';
  return readFileSync(filePath, 'utf-8');
}

describe('Camel target — structure', () => {
  it('generates a RouteBuilder, state bean, pom.xml, and application.properties', () => {
    const { outDir, speckDir } = compileCamelFromExample('RetryHandler.speckdl');
    try {
      // pom.xml exists
      const pomPath = join(speckDir, 'pom.xml');
      expect(existsSync(pomPath)).toBe(true);
      const pom = readFileSafe(pomPath);
      expect(pom).toContain('<artifactId>retry-handler</artifactId>');
      expect(pom).toContain('camel-quarkus-platform-http');
      expect(pom).toContain('camel-quarkus-timer');

      // application.properties exists
      const propsPath = join(speckDir, 'src', 'main', 'resources', 'application.properties');
      expect(existsSync(propsPath)).toBe(true);
      const props = readFileSafe(propsPath);
      expect(props).toContain('quarkus.http.port');

      // RouteBuilder exists
      const pkgDir = join(speckDir, 'src', 'main', 'java', 'retryhandler', 'camel');
      const routesPath = join(pkgDir, 'RetryHandlerRoutes.java');
      expect(existsSync(routesPath)).toBe(true);
      const routes = readFileSafe(routesPath);
      expect(routes).toContain('extends RouteBuilder');
      expect(routes).toContain('@ApplicationScoped');

      // State bean exists
      const statePath = join(pkgDir, 'RetryHandlerState.java');
      expect(existsSync(statePath)).toBe(true);
      const state = readFileSafe(statePath);
      expect(state).toContain('@ApplicationScoped');
      expect(state).toContain('class RetryHandlerState');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('generates one route per action in the RouteBuilder', () => {
    const { outDir, speckDir } = compileCamelFromString(`
speck ActionSpec {
  state {
    counter: Nat
  }
  init {
    counter := 0
  }
  action Increment {
    counter := counter + 1
    return counter
  }
  action Reset {
    counter := 0
    return counter
  }
  next: Increment | Reset
}
`);
    try {
      const pkgDir = join(speckDir, 'src', 'main', 'java', 'actionspec', 'camel');
      const routes = readFileSafe(join(pkgDir, 'ActionSpecRoutes.java'));

      // Should have two routes: Increment and Reset
      const routeIdMatches = routes.match(/routeId\("/g);
      expect(routeIdMatches).not.toBeNull();
      expect(routeIdMatches!.length).toBe(2);

      // Each route should reference a processor
      const processorRefs = routes.match(/process\("/g);
      expect(processorRefs).not.toBeNull();
      expect(processorRefs!.length).toBe(2);

      // Both actions have zero params → timer-triggered
      expect(routes).toContain('timer:Increment');
      expect(routes).toContain('timer:Reset');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('generates model classes for record types', () => {
    const { outDir, speckDir } = compileCamelFromExample('RetryHandler.speckdl');
    try {
      const modelDir = join(speckDir, 'src', 'main', 'java', 'retryhandler', 'camel', 'model');

      // The model directory should exist and contain .java files
      expect(existsSync(modelDir)).toBe(true);
      const files = readdirSync(modelDir);
      expect(files.length).toBeGreaterThanOrEqual(1);

      // Each file should be a valid Java class or enum
      for (const f of files) {
        if (f.endsWith('.java')) {
          const content = readFileSafe(join(modelDir, f));
          expect(content).toMatch(/public (class|enum) \w+/);
        }
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('generates a Processor per action', () => {
    const { outDir, speckDir } = compileCamelFromString(`
speck ProcessorSpec {
  state {
    counter: Nat
  }
  init {
    counter := 0
  }
  action Increment {
    counter := counter + 1
  }
  action Reset {
    counter := 0
  }
  next: Increment | Reset
}
`);
    try {
      const procDir = join(speckDir, 'src', 'main', 'java', 'processorspec', 'camel', 'processor');
      expect(existsSync(procDir)).toBe(true);

      const files = readdirSync(procDir);
      expect(files.length).toBe(2);
      expect(files).toContain('IncrementProcessor.java');
      expect(files).toContain('ResetProcessor.java');

      for (const f of files) {
        const content = readFileSafe(join(procDir, f));
        expect(content).toContain('implements Processor');
        expect(content).toContain('@ApplicationScoped');
        expect(content).toContain('@Inject');
        expect(content).toContain('public void process(Exchange exchange)');
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('Camel target — ToggleSwitch (simple spec)', () => {
  it('generates valid Camel structure for a simple state machine', () => {
    const { outDir, speckDir } = compileCamelFromString(`
speck ToggleSwitch {
  state {
    isOn: Bool
  }
  init {
    isOn == false
  }
  action TurnOn {
    require not isOn
    isOn := true
    return isOn
  }
  action TurnOff {
    require isOn
    isOn := false
    return isOn
  }
  next: TurnOn | TurnOff
}
`);
    try {
      const pkgDir = join(speckDir, 'src', 'main', 'java', 'toggleswitch', 'camel');

      // RouteBuilder
      const routes = readFileSafe(join(pkgDir, 'ToggleSwitchRoutes.java'));
      expect(routes).toContain('extends RouteBuilder');
      expect(routes).toContain('timer:TurnOn');
      expect(routes).toContain('timer:TurnOff');
      expect(routes).toContain('routeId("TurnOn"');
      expect(routes).toContain('routeId("TurnOff"');

      // State bean
      const state = readFileSafe(join(pkgDir, 'ToggleSwitchState.java'));
      expect(state).toContain('boolean isOn');
      expect(state).toContain('@ApplicationScoped');

      // Processors
      const procDir = join(pkgDir, 'processor');
      expect(existsSync(join(procDir, 'TurnOnProcessor.java'))).toBe(true);
      expect(existsSync(join(procDir, 'TurnOffProcessor.java'))).toBe(true);

      const turnOn = readFileSafe(join(procDir, 'TurnOnProcessor.java'));
      expect(turnOn).toContain('implements Processor');
      expect(turnOn).toContain('@Inject');

      // pom.xml
      const pom = readFileSafe(join(speckDir, 'pom.xml'));
      expect(pom).toContain('camel-quarkus-platform-http');
      expect(pom).toContain('camel-quarkus-timer');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('Camel target — inline enum + event spec', () => {
  it('generates enums and event classes', () => {
    const { outDir, speckDir } = compileCamelFromString(`
speck TestSpec {
  interface Status {
    Idle
    Active
    Done
  }
  type Job = {
    id: Nat,
    name: String,
    status: Status
  }
  state {
    currentJob: Job
  }
  init {
    currentJob := Job { id: 0, name: "", status: Idle }
  }
  event JobStarted {
    jobId: Nat,
    jobName: String
  }
  action Start(jobId: Nat, jobName: String) {
    require jobId >= 0
    currentJob := Job { id: jobId, name: jobName, status: Active }
    emit JobStarted { jobId: jobId, jobName: jobName }
  }
  next: Start
}
`);
    try {
      const modelDir = join(speckDir, 'src', 'main', 'java', 'testspec', 'camel', 'model');

      // Status should be an enum
      const statusFile = join(modelDir, 'Status.java');
      expect(existsSync(statusFile)).toBe(true);
      const status = readFileSafe(statusFile);
      expect(status).toContain('enum Status');
      expect(status).toContain('Idle');
      expect(status).toContain('Active');
      expect(status).toContain('Done');

      // Job should be a model class
      const jobFile = join(modelDir, 'Job.java');
      expect(existsSync(jobFile)).toBe(true);
      const job = readFileSafe(jobFile);
      expect(job).toContain('class Job');
      expect(job).toContain('getId');
      expect(job).toContain('getName');
      expect(job).toContain('getStatus');

      // Event class
      const eventDir = join(speckDir, 'src', 'main', 'java', 'testspec', 'camel', 'event');
      const eventFile = join(eventDir, 'JobStarted.java');
      expect(existsSync(eventFile)).toBe(true);
      const event = readFileSafe(eventFile);
      expect(event).toContain('class JobStarted');
      expect(event).toContain('getJobId');
      expect(event).toContain('getJobName');

      // Start action should be HTTP-triggered (has params)
      const routes = readFileSafe(
        join(speckDir, 'src', 'main', 'java', 'testspec', 'camel', 'TestSpecRoutes.java')
      );
      expect(routes).toContain('platform-http:/start');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});