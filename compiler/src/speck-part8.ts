import { AgentAwaitSpec, AgentBoundPrompt, AgentHarnessRule, AgentHarnessSpec, AgentMemberNode, AgentPrompt, AgentStagesMap, AgentToolBinding, NextMemberNode } from './speck-part0.js';
import { braceCounts, findBlockEnd } from './speck-part1.js';
import { inlineActionBody } from './speck-part4.js';
import { parseDurationToMs, parseHarnessMapLine } from './speck-part9.js';

export function stripLineComment(l: string): string {
  const c = l.indexOf('//');
  return (c >= 0 ? l.slice(0, c) : l).trim();
}

/**
 * Parse `next: A | B | ...` starting at `startIndex`. The relation continues
 * onto following lines only while the text so far is empty or ends with `|`,
 * or the next significant line starts with `|`. Every alternative must be a
 * bare action identifier; anything else is a parse error rather than being
 * silently folded into a name (which made the relation vacuous).
 */
export function parseNextRelation(lines: string[], startIndex: number): { node: NextMemberNode; endIndex: number } {
  let text = stripLineComment(lines[startIndex].trim().slice('next:'.length));
  let end = startIndex;
  if (text.startsWith('{')) {
    // Block form. Only the empty block (comments allowed) is defined: any action.
    let body = text.slice(1);
    while (!body.includes('}') && end + 1 < lines.length) {
      end++;
      body += ' ' + stripLineComment(lines[end].trim());
    }
    const close = body.indexOf('}');
    if (close < 0 || body.slice(0, close).replace(/\/\*[\s\S]*?\*\//g, '').trim() !== '' || body.slice(close + 1).trim() !== '') {
      throw new Error(`Parse error at line ${startIndex + 1}: next: { ... } must be empty (meaning any action); list alternatives as next: A | B`);
    }
    return { node: { type: 'next', actions: [], anyAction: true }, endIndex: end };
  }
  for (let j = startIndex + 1; j < lines.length; j++) {
    const t = stripLineComment(lines[j].trim());
    if (!t || t.startsWith('/*')) continue;
    const needMore = text === '' || text.endsWith('|');
    if (!needMore && !t.startsWith('|')) break;
    text += ' ' + t;
    end = j;
  }
  const actions = text.split('|').map(a => a.trim());
  for (const a of actions) {
    if (!/^[A-Za-z_]\w*$/.test(a)) {
      throw new Error(`Parse error at line ${startIndex + 1}: next: alternative ${JSON.stringify(a)} is not an action name`);
    }
  }
  return { node: { type: 'next', actions }, endIndex: end };
}

/**
 * Parse `agent { ... }` into an AgentMemberNode.
 * Body forms:
 *   stages <var> { Name = n ... }
 *   tool <Action> [-> <name>] effect act|observe
 *   tool <name> -> <Action> effect act|observe  (legacy)
 *   pending timeout <dur>
 *   await <State> { signal ...; mode near|in; require outcome in { approve, reject! };
 *                   require claims { k: T }; bind call [on outcome, ...];
 *                   on outcome -> Target; timeout <dur> -> reject }
 */
/** Derive the agent-facing tool name from an action, preserving acronym boundaries. */
export function inferAgentToolName(action: string): string {
  return action.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function parseAgentBlockMultiline(lines: string[], startIndex: number, startBraceCount: number, actionNames: Set<string>): AgentMemberNode {
  // A one-line agent closes on its own braces. The body is that span, so a
  // later member is not read as part of the block. A `{` or `}` inside an
  // instruction, prompt, or description string is not that brace.
  const inline = inlineActionBody(lines[startIndex].trim());
  const bodyLines = inline !== null
    ? (inline.trim() ? [inline] : [])
    : lines.slice(startIndex + 1, findBlockEnd(lines, startIndex + 1, startBraceCount));
  const tools: AgentToolBinding[] = [];
  const awaits: AgentAwaitSpec[] = [];
  const instructions: AgentPrompt[] = [];
  const prompts: AgentBoundPrompt[] = [];
  let stages: AgentStagesMap | undefined;
  let pendingTimeout: AgentMemberNode['pendingTimeout'];
  const harnesses: AgentHarnessSpec[] = [];
  let i = 0;

  while (i < bodyLines.length) {
    const raw = bodyLines[i];
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*')) {
      i++;
      continue;
    }

    // stages <var> { ... }
    const stagesHeader = line.match(/^stages\s+(\w+)\s*\{/);
    if (stagesHeader) {
      const variable = stagesHeader[1];
      const openOnLine = braceCounts(raw).open;
      const closeOnLine = braceCounts(raw).close;
      let inner: string[] = [];
      if (closeOnLine >= openOnLine && openOnLine > 0) {
        // single-line stages block — unlikely but handle
        const m = line.match(/\{([^}]*)\}/);
        inner = m ? [m[1]] : [];
        i++;
      } else {
        const subEnd = findBlockEnd(bodyLines, i + 1, openOnLine);
        inner = bodyLines.slice(i + 1, subEnd);
        i = subEnd + 1;
      }
      const labels: { name: string; value: number }[] = [];
      for (const il of inner) {
        const t = il.trim();
        if (!t || t.startsWith('//') || t === '}') continue;
        const lm = t.match(/^(\w+)\s*=\s*(\d+)\s*,?$/);
        if (!lm) {
          throw new Error(`Parse error in agent stages: expected Name = n, got ${JSON.stringify(t)}`);
        }
        labels.push({ name: lm[1], value: parseInt(lm[2], 10) });
      }
      stages = { variable, labels };
      continue;
    }

    // JSON string literals provide unambiguous escaping and printer round trips.
    const instructionMatch = line.match(/^instruction\s+(?:(file)\s+)?("(?:[^"\\]|\\.)*")\s*$/);
    if (instructionMatch) {
      instructions.push(instructionMatch[1] ? { file: JSON.parse(instructionMatch[2]) } : JSON.parse(instructionMatch[2]));
      i++;
      continue;
    }

    // prompt tool <name> [stage <label>] [await <state>] [file] "..."
    const promptMatch = line.match(/^prompt\s+tool\s+([A-Za-z_][\w-]*)(?:\s+stage\s+(\w+))?(?:\s+await\s+(\w+))?\s+(?:(file)\s+)?("(?:[^"\\]|\\.)*")\s*$/);
    if (promptMatch) {
      prompts.push({ tool: promptMatch[1], ...(promptMatch[2] ? { stage: promptMatch[2] } : {}),
        ...(promptMatch[3] ? { await: promptMatch[3] } : {}),
        prompt: promptMatch[4] ? { file: JSON.parse(promptMatch[5]) } : JSON.parse(promptMatch[5]) });
      i++;
      continue;
    }

    // Action-first syntax, with the historical lowercase tool -> Action form.
    const toolMatch = line.match(/^tool\s+([A-Za-z_][\w-]*)(?:\s*->\s*([A-Za-z_][\w-]*))?\s+effect\s+(act|observe)(?:\s+description\s+(?:(file)\s+)?("(?:[^"\\]|\\.)*"))?\s*$/);
    if (toolMatch) {
      const first = toolMatch[1], second = toolMatch[2];
      // When only one side names a declared action its position is decisive.
      // If both (or neither) do, preserve the historical name -> action form.
      const legacy = second !== undefined && (!actionNames.has(first) || actionNames.has(second));
      const action = legacy ? second : first;
      const name = legacy ? first : (second ?? inferAgentToolName(action));
      const tool: AgentToolBinding = { name, action, effect: toolMatch[3] as 'act' | 'observe' };
      if (toolMatch[5] !== undefined) tool.description = toolMatch[4] ? { file: JSON.parse(toolMatch[5]) } : JSON.parse(toolMatch[5]);
      tools.push(tool);
      i++;
      continue;
    }

    // pending timeout <dur>
    const pendM = line.match(/^pending\s+timeout\s+(\S+)\s*$/);
    if (pendM) {
      if (pendingTimeout) throw new Error('Parse error in agent block: duplicate pending timeout');
      pendingTimeout = { durationMs: parseDurationToMs(pendM[1]), durationText: pendM[1] };
      i++;
      continue;
    }

    // harness <name> { map ... }
    const harnessHeader = line.match(/^harness\s+([A-Za-z][\w-]*)\s*\{\s*$/);
    if (harnessHeader) {
      const openOnLine = braceCounts(raw).open;
      const subEnd = findBlockEnd(bodyLines, i + 1, openOnLine);
      const inner = bodyLines.slice(i + 1, subEnd);
      i = subEnd + 1;
      const rules: AgentHarnessRule[] = [];
      for (const il of inner) {
        const t = il.trim();
        if (!t || t.startsWith('//') || t === '}') continue;
        rules.push(parseHarnessMapLine(t, harnessHeader[1]));
      }
      harnesses.push({ name: harnessHeader[1], rules });
      continue;
    }

    // await State { ... }
    const awaitHeader = line.match(/^await\s+(\w+)\s*\{/);
    if (awaitHeader) {
      const state = awaitHeader[1];
      const openOnLine = braceCounts(raw).open;
      const subEnd = findBlockEnd(bodyLines, i + 1, openOnLine);
      const awaitInner = bodyLines.slice(i + 1, subEnd).map(l => l.trim()).filter(l => l && !l.startsWith('//') && l !== '}');
      i = subEnd + 1;

      let signal = '';
      let mode: 'near' | 'in' | '' = '';
      let outcomes: string[] = [];
      let rejects: string[] = [];
      const claims: { name: string; typeName: string }[] = [];
      const on: { outcome: string; target: string }[] = [];
      let timeout: AgentAwaitSpec['timeout'];
      // null = no clause. names === null = `bind call` (every accepting outcome).
      let bindClause: { names: string[] | null } | null = null;

      let j = 0;
      while (j < awaitInner.length) {
        const al = awaitInner[j];

        const sigM = al.match(/^signal\s+(\w+)\s*$/);
        if (sigM) { signal = sigM[1]; j++; continue; }

        const modeM = al.match(/^mode\s+(near|in)\s*$/);
        if (modeM) { mode = modeM[1] as 'near' | 'in'; j++; continue; }

        const outM = al.match(/^require\s+outcome\s+in\s*\{([^}]+)\}\s*$/);
        if (outM) {
          const raw = outM[1].split(',').map(s => s.trim()).filter(Boolean);
          outcomes = [];
          rejects = [];
          for (const r of raw) {
            const om = r.match(/^([A-Za-z_]\w*)\s*(!?)$/);
            if (!om) {
              throw new Error(`Parse error in await ${state}: outcome ${JSON.stringify(r)} is not an identifier (mark reject outcomes as name!)`);
            }
            if (outcomes.includes(om[1])) {
              throw new Error(`Parse error in await ${state}: duplicate outcome ${om[1]}`);
            }
            outcomes.push(om[1]);
            if (om[2]) rejects.push(om[1]);
          }
          j++;
          continue;
        }

        // require claims { ... } — may span lines collected already as separate entries
        if (al.startsWith('require claims')) {
          let claimsText = al;
          if (!claimsText.includes('{')) {
            throw new Error(`Parse error in await ${state}: require claims must open a block`);
          }
          while (!claimsText.includes('}') && j + 1 < awaitInner.length) {
            j++;
            claimsText += ' ' + awaitInner[j];
          }
          const cm = claimsText.match(/^require\s+claims\s*\{([^}]*)\}\s*$/);
          if (!cm) {
            throw new Error(`Parse error in await ${state}: malformed require claims block`);
          }
          const body = cm[1].trim();
          if (body) {
            for (const part of body.split(',')) {
              const p = part.trim();
              if (!p) continue;
              const pm = p.match(/^(\w+)\s*:\s*(\w+)$/);
              if (!pm) {
                throw new Error(`Parse error in await ${state}: claim must be name: Type, got ${JSON.stringify(p)}`);
              }
              claims.push({ name: pm[1], typeName: pm[2] });
            }
          }
          j++;
          continue;
        }

        const onM = al.match(/^on\s+(\w+)\s*->\s*(\w+)\s*$/);
        if (onM) {
          on.push({ outcome: onM[1], target: onM[2] });
          j++;
          continue;
        }

        const toM = al.match(/^timeout\s+(\S+)\s*->\s*(\w+)\s*$/);
        if (toM) {
          const durationMs = parseDurationToMs(toM[1]);
          timeout = { durationMs, durationText: toM[1], outcome: toM[2] };
          j++;
          continue;
        }

        if (/^bind\s+call\s*$/.test(al)) {
          if (bindClause) throw new Error(`Parse error in await ${state}: duplicate bind call`);
          bindClause = { names: null };
          j++;
          continue;
        }
        const bindOn = al.match(/^bind\s+call\s+on\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*$/);
        if (bindOn) {
          if (bindClause) throw new Error(`Parse error in await ${state}: duplicate bind call`);
          const names: string[] = [];
          for (const part of bindOn[1].split(',')) {
            const name = part.trim();
            if (names.includes(name)) {
              throw new Error(`Parse error in await ${state}: duplicate bind call outcome ${name}`);
            }
            names.push(name);
          }
          bindClause = { names };
          j++;
          continue;
        }

        throw new Error(`Parse error in await ${state}: unexpected line ${JSON.stringify(al)}`);
      }

      if (!signal) throw new Error(`Parse error in await ${state}: missing signal`);
      if (!mode) throw new Error(`Parse error in await ${state}: missing mode (near|in)`);
      if (outcomes.length === 0) throw new Error(`Parse error in await ${state}: missing require outcome in {...}`);
      if (on.length === 0) throw new Error(`Parse error in await ${state}: missing on outcome -> Target`);
      for (const o of on) {
        if (!outcomes.includes(o.outcome)) {
          throw new Error(`Parse error in await ${state}: on ${o.outcome} is not in require outcome in {${outcomes.join(', ')}}`);
        }
      }
      if (timeout && !outcomes.includes(timeout.outcome)) {
        throw new Error(`Parse error in await ${state}: timeout outcome ${timeout.outcome} is not in require outcome in {...}`);
      }

      let bindCall: string[] = [];
      if (bindClause) {
        if (bindClause.names === null) {
          bindCall = outcomes.filter(o => !rejects.includes(o));
          if (bindCall.length === 0) {
            throw new Error(`Parse error in await ${state}: bind call matches no accepting outcome`);
          }
        } else {
          for (const name of bindClause.names) {
            if (!outcomes.includes(name)) {
              throw new Error(`Parse error in await ${state}: bind call outcome ${name} is not in require outcome in {${outcomes.join(', ')}}`);
            }
            if (rejects.includes(name)) {
              throw new Error(`Parse error in await ${state}: bind call outcome ${name} is a reject outcome; a reject authorizes no call`);
            }
          }
          bindCall = bindClause.names;
        }
      }

      awaits.push({ state, signal, mode, outcomes, rejects, claims, on, timeout, bindCall });
      continue;
    }

    throw new Error(`Parse error in agent block: unexpected line ${JSON.stringify(line)}`);
  }

  const node: AgentMemberNode = { type: 'agent', stages, tools, awaits };
  if (instructions.length) node.instructions = instructions;
  for (const p of prompts) {
    if (!tools.some(t => t.name === p.tool)) throw new Error(`Parse error in agent prompt: unknown tool ${p.tool}`);
    if (p.stage && !stages?.labels.some(l => l.name === p.stage)) throw new Error(`Parse error in agent prompt: unknown stage ${p.stage}`);
    if (p.await && !awaits.some(a => a.state === p.await)) throw new Error(`Parse error in agent prompt: unknown await ${p.await}`);
  }
  if (prompts.length) node.prompts = prompts;
  if (pendingTimeout) node.pendingTimeout = pendingTimeout;
  if (harnesses.length > 0) node.harnesses = harnesses;
  return node;
}

