# Speckl Extraction Protocol — Design Document

## Overview

The Extraction Layer bridges chaotic human/agent conversation and the Structured Intermediate Representation (SIR). It continuously (or batch) identifies formal elements — entities, transitions, constraints, relationships — and populates the SIR with typed, versioned, provenance-tracked records.

Every element in the SIR traces back to the conversation turn(s) that produced it. Every element carries a confidence score. And every element can be refined incrementally as the conversation evolves.

---

## 1. Core Data Structures

### 1.1 ConversationTurn

The raw input to the extraction layer.

```typescript
interface ConversationTurn {
  id: string;                    // UUID, globally unique
  timestamp: number;             // Unix ms
  speaker: SpeakerRole;          // "human" | "agent"
  agentId?: string;              // e.g. "speckl-extractor", "senior-eng"
  content: string;               // Raw text or structured block
  parentTurnId?: string;         // For threaded replies
  metadata?: {
    explicitMarkers?: string[];  // e.g. ["spec:", "state:"]
    structuredBlock?: {          // Extracted by pre-parser
      type: "spec" | "code" | "diagram";
      language?: string;
      content: string;
    };
  };
}

type SpeakerRole = "human" | "agent";
```

### 1.2 SIRElement

The core unit of structured representation. All SIR elements share a common header and then specialize by domain.

```typescript
// Common header for every SIR element
interface SIRHeader {
  id: string;                      // UUID, stable across revisions
  elementType: SIRType;            // Domain-specific type discriminator
  domain: DomainId;                // "state-machine" | "data-model" | etc.
  confidence: number;              // 0.0 – 1.0
  status: ElementStatus;           // Lifecycle state
  createdAt: number;               // Unix ms
  updatedAt: number;               // Last modification
  version: number;                 // Monotonic counter, bumped on mutation
  provenance: ProvenanceChain;     // Full trace
  flags: SIRFlags;                 // See below
}

type SIRType = string;             // e.g. "state", "transition", "guard", "event"
type DomainId = string;            // e.g. "state-machine", "data-model"

type ElementStatus =
  | "proposed"       // Extracted, never confirmed by human
  | "confirmed"      // Human explicitly confirmed
  | "deprecated"     // Later conversation contradicted this
  | "replaced"       // Superseded by another element (holds replacedById)
  | "error";         // Extraction was wrong, human flagged it

interface SIRFlags {
  needsReview: boolean;            // True when confidence < autoAcceptThreshold
  isAmbiguous: boolean;            // Multiple possible interpretations
  isTentative: boolean;            // Extracted from implicit cues, not explicit markers
  isContradicted: boolean;         // Later conversation conflicts
  sourceIsExplicit: boolean;       // Came from spec: prefix or structured block
}
```

### 1.3 ProvenanceChain

Every SIR element has a complete, immutable provenance trail.

```typescript
interface ProvenanceChain {
  entries: ProvenanceEntry[];
}

interface ProvenanceEntry {
  turnId: string;                  // ConversationTurn that produced/modified this
  action: ProvenanceAction;        // What happened in this turn
  agentId?: string;                // Which agent performed the action
  humanConfirmed: boolean;         // Did the human explicitly confirm?
  timestamp: number;
  confidenceAtTime: number;        // Snapshot of confidence when entry was created
  extractionRationale?: string;    // Why the extractor thought this was relevant
  diff?: ElementDiff;              // For "refined" or "updated" actions
}

type ProvenanceAction =
  | "extracted"       // First creation
  | "refined"         // Incremental update, same element
  | "confirmed"       // Human confirmed
  | "deprecated"      // Marked as no longer valid
  | "replaced"        // Superseded by new element
  | "merged"          // Two elements combined
  | "split";          // One element split into multiple
```

### 1.4 ElementDiff

Captures what changed between versions of a SIR element.

```typescript
interface ElementDiff {
  fromVersion: number;
  toVersion: number;
  triggerTurnId: string;
  changes: FieldChange[];
}

interface FieldChange {
  field: string;                   // Path, e.g. "transition.guard", "state.name"
  oldValue: any;
  newValue: any;
  reason: string;                  // Why this changed, extracted from turn
}
```

### 1.5 Domain-Specific Element Examples

State machine domain specialization:

```typescript
// A state in a state machine
interface StateElement extends SIRHeader {
  elementType: "state";
  domain: "state-machine";
  data: {
    name: string;                  // e.g. "idle"
    parent?: string;               // For hierarchical states
    isInitial?: boolean;
    isFinal?: boolean;
    entryActions?: string[];
    exitActions?: string[];
    invariants?: string[];         // Properties that must hold in this state
  };
}

// A transition between states
interface TransitionElement extends SIRHeader {
  elementType: "transition";
  domain: "state-machine";
  data: {
    from: string;                  // State name or element ID
    to: string;                    // State name or element ID
    event: string;                 // Triggering event
    guard?: string;                // Condition that must be true
    actions?: string[];            // Actions fired on transition
    priority?: number;             // For conflict resolution
  };
}
```

---

## 2. Extraction Modes

The extraction layer supports four modes, selected per-turn or configured globally.

### 2.1 Real-Time Extraction

Extraction runs incrementally as each message arrives, before the next speaker responds.

```
Sequence:
  Human sends turn → [pre-parser] → [extractor] → SIR updated → Agent responds
```

**Use case:** Live specification sessions where the human is describing a system and the agent provides immediate feedback ("I've captured state 'loading'. Did you mean it has a timeout transition?").

**Implementation:**

```typescript
async function extractRealtime(turn: ConversationTurn, sir: SIRDocument): Promise<ExtractionResult> {
  // 1. Pre-parse for explicit markers
  const markers = detectExplicitMarkers(turn);

  // 2. If markers found, do targeted extraction
  if (markers.length > 0) {
    return extractFromMarkers(turn, markers, sir);
  }

  // 3. Otherwise, run lightweight pattern matching
  const candidates = runLightweightPatterns(turn, sir.domain);

  // 4. Only auto-extract high-confidence candidates
  const highConf = candidates.filter(c => c.confidence >= AUTO_ACCEPT_THRESHOLD);
  const lowConf = candidates.filter(c => c.confidence < AUTO_ACCEPT_THRESHOLD && c.confidence >= FLAG_THRESHOLD);

  // 5. Apply high-confidence, flag low-confidence for review
  const applied = applyExtractions(highConf, sir, turn, false);
  const flagged = flagForReview(lowConf, sir, turn);

  return { applied, flagged, candidates: lowConf };
}
```

### 2.2 Batch Extraction

Extraction runs after a segment of conversation (a "batch" of N turns, or a pause in conversation).

```
Sequence:
  [Turn 1] → [Turn 2] → [Turn 3] → (batch trigger) → [extractor] → SIR updated
```

**Use case:** After a multi-turn discussion where the human brainstormed possibilities and you want to extract the settled decisions.

**Implementation:**

```typescript
async function extractBatch(
  turns: ConversationTurn[],
  sir: SIRDocument,
  options?: BatchOptions
): Promise<ExtractionResult> {
  // 1. Concatenate turns into a coherent transcript
  const transcript = buildTranscript(turns);

  // 2. Run the full LLM-based extractor over the transcript
  const extraction = await llmExtract(
    transcript,
    sir.domain,
    sir.getExistingElements()  // Pass current SIR for refinement context
  );

  // 3. Diff against existing SIR elements
  const { added, refined, deprecated, conflicts } = diffAgainstSIR(extraction, sir);

  // 4. Apply changes with full provenance
  // ...
}

interface BatchOptions {
  deduplicate: boolean;           // Merge near-duplicate extractions
  summarize: boolean;             // Generate human-readable summary of changes
  confirmBeforeApply: boolean;    // Show diff to human before applying
}
```

### 2.3 Deliberative Extraction

Multiple agents debate before elements are committed. This is the highest-quality mode.

```
Sequence:
  Human sends turn
    → [Agent A proposes extraction]
    → [Agent B critiques]
    → [Agent C synthesizes]
    → [Consensus extraction] → SIR updated
```

**Implementation:**

```typescript
async function extractDeliberative(
  turn: ConversationTurn,
  sir: SIRDocument,
  debaters: DebaterConfig[]
): Promise<ExtractionResult> {
  const proposals: ExtractionProposal[] = [];

  // Phase 1: Each debater independently extracts
  for (const debater of debaters) {
    const proposal = await debater.extract(turn, sir);
    proposals.push(proposal);
  }

  // Phase 2: Cross-critique
  const critiques: Critique[] = [];
  for (let i = 0; i < proposals.length; i++) {
    for (let j = 0; j < proposals.length; j++) {
      if (i === j) continue;
      const critique = await debaters[j].critique(proposals[i], turn, sir);
      critiques.push(critique);
    }
  }

  // Phase 3: Synthesize
  const synthesizer = debaters.find(d => d.role === "synthesizer") || debaters[0];
  const consensus = await synthesizer.synthesize(proposals, critiques, turn, sir);

  // Phase 4: Apply with deliberation provenance
  return applyDeliberated(consensus, proposals, critiques, sir, turn);
}

interface DebaterConfig {
  id: string;
  role: "proposer" | "critic" | "synthesizer";
  model?: string;
  extract: (turn: ConversationTurn, sir: SIRDocument) => Promise<ExtractionProposal>;
  critique: (proposal: ExtractionProposal, turn: ConversationTurn, sir: SIRDocument) => Promise<Critique>;
  synthesize: (proposals: ExtractionProposal[], critiques: Critique[], turn: ConversationTurn, sir: SIRDocument) => Promise<ConsensusExtraction>;
}
```

### 2.4 Interactive Extraction

When extraction ambiguity exceeds a threshold, the extractor asks clarifying questions rather than guessing.

```
Sequence:
  Human sends turn
    → [extractor] identifies ambiguity
    → [extractor] generates clarifying question
    → Human answers
    → [extractor] resolves ambiguity → SIR updated
```

**Implementation:**

```typescript
async function extractInteractive(
  turn: ConversationTurn,
  sir: SIRDocument
): Promise<ExtractionResult | ClarificationNeeded> {
  const candidates = await extractCandidates(turn, sir);

  // Identify ambiguities
  const ambiguities = detectAmbiguities(candidates);

  if (ambiguities.length > 0) {
    // Generate the best clarifying question
    const question = await generateClarifyingQuestion(ambiguities, turn);

    // Store pending ambiguity so resolution can be matched later
    sir.pendingAmbiguities.push({
      id: generateId(),
      sourceTurnId: turn.id,
      candidates: candidates.map(c => c.id),
      ambiguities,
      question,
      timestamp: Date.now(),
    });

    return {
      status: "clarification_needed",
      question,
      ambiguities,
    };
  }

  // No ambiguity — proceed with auto-extraction
  return applyExtractions(candidates, sir, turn);
}
```

---

## 3. Confidence and Ambiguity Handling

### 3.1 Confidence Thresholds

```typescript
// Global thresholds, domain-overridable
const CONFIDENCE = {
  // >= this: auto-extract, mark confirmed
  AUTO_ACCEPT: 0.85,

  // >= this: extract but mark needsReview=true, isTentative=true
  // Agent should surface these to the human
  REVIEW: 0.60,

  // >= this: extract to a "candidate" pool, do NOT add to main SIR
  // Agent only surfaces if asked
  CANDIDATE: 0.40,

  // < this: discard (noise)
  DISCARD: 0.40,
};
```

### 3.2 Confidence Scoring Algorithm

Confidence is computed from multiple signals:

```typescript
function computeConfidence(
  candidate: ExtractionCandidate,
  turn: ConversationTurn,
  context: ExtractionContext
): number {
  let score = 0.0;
  const weights = context.domainWeights;

  // Signal 1: Explicit markers (strongest)
  if (candidate.fromExplicitMarker) score += weights.explicitMarker * 1.0;   // e.g. 0.40

  // Signal 2: Structured block (code fence, diagram)
  if (candidate.fromStructuredBlock) score += weights.structuredBlock * 1.0; // e.g. 0.35

  // Signal 3: Linguistic pattern match strength
  score += candidate.patternMatchScore * weights.patternMatch;               // e.g. 0.25

  // Signal 4: Consistency with existing SIR
  const consistencyScore = checkConsistency(candidate, context.existingElements);
  score += consistencyScore * weights.consistency;                           // e.g. 0.15

  // Signal 5: Repetition — same extraction from multiple turns
  if (candidate.repetitionCount > 1) {
    score += Math.min(candidate.repetitionCount * 0.05, 0.15);
  }

  // Signal 6: Speaker authority
  if (turn.speaker === "human") score += 0.05;

  // Cap at 1.0
  return Math.min(score, 1.0);
}
```

### 3.3 Ambiguity Representation in the SIR

When multiple interpretations exist for the same conversation fragment:

```typescript
interface AmbiguousElement extends SIRHeader {
  isAmbiguous: true;
  interpretations: Interpretation[];
  resolvedInterpretationId?: string;  // Set once resolved
}

interface Interpretation {
  id: string;
  element: SIRElement;             // The proposed element
  confidence: number;
  rationale: string;
  proposedBy: string;              // Agent ID
}
```

**Example:** The human says "when the user logs in, go to the main screen."

```
Extraction yields two interpretations:

Interpretation A (confidence: 0.72):
  "login" is a state, "main screen" is a state, there's a transition "login → main screen"

Interpretation B (confidence: 0.65):
  "logs in" is an event, the transition fires on "login" event from any state → "main screen"
```

The extractor creates an `AmbiguousElement` with both interpretations and flags it for review. The agent surfaces: *"I captured a transition after login. Did you mean (A) login is a state that transitions to main screen, or (B) the login event triggers a transition from any state?"*

### 3.4 Conflict Resolution

When later conversation contradicts an earlier extraction:

```typescript
function resolveConflict(
  existing: SIRElement,
  incoming: ExtractionCandidate,
  provenance: ProvenanceChain
): ConflictResolution {
  // Case 1: Incoming confidence >> existing confidence
  // → Deprecate old, create new, link them
  if (incoming.confidence > existing.confidence + 0.2) {
    return {
      action: "replace",
      existingElement: markDeprecated(existing, incoming.sourceTurnId),
      newElement: createFromCandidate(incoming, {
        replacedId: existing.id,
        version: 1,
      }),
      rationale: `Higher-confidence extraction replaces previous`,
    };
  }

  // Case 2: Comparable confidence → flag for human resolution
  if (Math.abs(incoming.confidence - existing.confidence) < 0.2) {
    return {
      action: "flag_conflict",
      existingElement: setFlag(existing, "isContradicted", true),
      pendingResolution: {
        existingId: existing.id,
        incomingCandidate: incoming,
        question: generateResolutionQuestion(existing, incoming),
      },
    };
  }

  // Case 3: Incoming confidence << existing → discard incoming
  return {
    action: "reject",
    reason: `Incoming confidence (${incoming.confidence}) too low vs existing (${existing.confidence})`,
  };
}
```

---

## 4. Provenance Model

### 4.1 Full Traceability

Every SIR element **must** trace back to one or more conversation turns. This is non-negotiable — no element enters the SIR without provenance.

```
Element → ProvenanceChain → ProvenanceEntry[] → ConversationTurn
```

Each entry records:
- **Which turn** triggered the change
- **Which agent** proposed it (if multi-agent)
- **Whether the human confirmed** (explicitly or implicitly)
- **What changed** (the diff)
- **Why** (extraction rationale)

### 4.2 Multi-Turn Refinement Provenance

When an element gets refined across multiple turns, the chain grows:

```
Turn 3: Human: "the idle state has a timeout of 30s"
  → ProvenanceEntry { action: "extracted", element: State(idle), confidence: 0.70 }

Turn 7: Human: "actually, make that 60 seconds"
  → ProvenanceEntry { action: "refined", diff: { timeout: 30→60 }, confidence: 0.95 }

Turn 12: Human: "spec: state idle { timeout: 120s, onTimeout: → error }"
  → ProvenanceEntry { action: "refined", diff: { timeout: 60→120, +onTimeout }, confidence: 0.98 }
```

The provenance chain is **append-only**. Old entries are never modified — they are the historical record.

### 4.3 Source Attribution

Every extraction records who (or what) proposed it:

```typescript
// Attribution taxonomy
type Attributor =
  | { type: "human"; speakerId: string }           // Direct human statement
  | { type: "agent"; agentId: string; model?: string }  // Agent extraction
  | { type: "system"; component: string }          // Automated pattern match
  | { type: "consensus"; agents: string[] };       // Multi-agent agreement
```

### 4.4 Provenance Queries

The provenance model supports queries like:
- "Show all elements the human hasn't confirmed yet" → `WHERE NOT humanConfirmed`
- "What did agent X propose that got rejected?" → `WHERE agentId = X AND action = 'deprecated'`
- "Trace the full evolution of state 'loading'" → `WHERE elementId = loading.id ORDER BY version`
- "Which turns contributed to more than 3 elements?" → `GROUP BY turnId HAVING COUNT > 3`

---

## 5. Extraction Triggers

### 5.1 Explicit Markers

The strongest triggers. These produce high-confidence extractions immediately.

| Marker | Example | Action |
|--------|---------|--------|
| `spec:` prefix | `spec: state idle { entry: resetTimer() }` | Parse the structured spec snippet directly |
| Fenced code block with language tag | ` ```speckl state idle { ... } ``` ` | Parse as Speckl micro-syntax |
| `state:` prefix | `state: loading` | Extract state element |
| `transition:` prefix | `transition: idle → loading on START` | Extract transition element |
| `event:` prefix | `event: USER_LOGIN { payload: { userId } }` | Extract event definition |
| `constraint:` prefix | `constraint: no transition from shutdown to any state` | Extract invariant |

**Pre-parser for explicit markers:**

```typescript
function detectExplicitMarkers(turn: ConversationTurn): MarkerDetection[] {
  const markers: MarkerDetection[] = [];

  // Check message prefix
  for (const marker of REGISTERED_MARKERS) {
    if (turn.content.trimStart().startsWith(marker.prefix)) {
      markers.push({
        marker: marker.prefix,
        content: turn.content.slice(marker.prefix.length).trim(),
        confidence: 0.98,  // Explicit markers are near-certain
      });
    }
  }

  // Check structured blocks
  if (turn.metadata?.structuredBlock) {
    markers.push({
      marker: "structured_block",
      content: turn.metadata.structuredBlock.content,
      language: turn.metadata.structuredBlock.language,
      confidence: 0.95,
    });
  }

  return markers;
}
```

### 5.2 Implicit Linguistic Patterns

When no explicit markers exist, the extractor uses NLP patterns keyed to the active domain.

**State machine domain patterns:**

| Pattern | Example | Extraction |
|---------|---------|------------|
| "when [event], [action]" | "when the user clicks submit, validate the form" | Transition with event="click submit" |
| "if [condition] then [action]" | "if the balance is zero, show an error" | Guard condition on transition |
| "[noun] is a state" | "idle is the starting state" | State with isInitial=true |
| "goes from [A] to [B]" | "it goes from loading to ready" | Transition from→to |
| "while in [state], [invariant]" | "while in loading, the spinner is visible" | State invariant |
| "after [event], enter [state]" | "after timeout, enter the error state" | Transition on event |
| "can't [action] when [state]" | "can't submit when loading" | Negative constraint |

**Implementation** as pluggable pattern sets:

```typescript
interface ExtractionPattern {
  id: string;
  domain: DomainId;
  regex: RegExp;                   // or NLP intent classifier
  extract: (match: RegExpMatchArray, turn: ConversationTurn, sir: SIRDocument) => ExtractionCandidate;
  baseConfidence: number;          // Starting confidence before modifiers
}

// Registered by domain
const STATE_MACHINE_PATTERNS: ExtractionPattern[] = [
  {
    id: "transition-when",
    domain: "state-machine",
    regex: /when\s+(?:the\s+)?(.+?)(?:\s*,\s*|\s+then\s+)(.+)/i,
    extract: (match, turn) => ({
      elementType: "transition",
      data: {
        event: match[1].trim(),
        actions: [match[2].trim()],
      },
      confidence: 0.55,
    }),
    baseConfidence: 0.55,
  },
  {
    id: "state-declaration",
    domain: "state-machine",
    regex: /(\w+)\s+is\s+(?:a|the)\s+(initial|starting|final|end|error)\s+state/i,
    extract: (match) => ({
      elementType: "state",
      data: {
        name: match[1],
        isInitial: ["initial", "starting"].includes(match[2]),
        isFinal: ["final", "end"].includes(match[2]),
      },
      confidence: 0.50,
    }),
    baseConfidence: 0.50,
  },
  // ... more patterns
];
```

### 5.3 Hybrid Trigger: The "Spec Block"

A special trigger: when the human writes a spec-like block without the explicit `spec:` prefix, the extractor can still recognize the structure:

```
The system has these states:

- IDLE: waiting for input, spinner hidden
- LOADING: fetching data, spinner visible
- ERROR: request failed, shows error toast
- SUCCESS: data rendered

Transitions:
- IDLE → LOADING when user submits query
- LOADING → SUCCESS when data arrives
- LOADING → ERROR when request fails
- ERROR → IDLE when user dismisses toast
```

The extractor detects this as a "structured specification block" using heuristics:
- Bullet lists with `→` arrows
- Semicolon-separated key-value pairs
- Sections with headers like "States:" / "Transitions:"

---

## 6. Incremental Refinement

### 6.1 Refinement Protocol

When a new conversation turn modifies an existing SIR element:

```typescript
async function refineElement(
  existingElement: SIRElement,
  refinementCandidate: ExtractionCandidate,
  sourceTurn: ConversationTurn
): Promise<RefinementResult> {
  // 1. Compute the field-level diff
  const diff = computeDiff(existingElement.data, refinementCandidate.data);

  // 2. Check if confidence drops below threshold after revision
  const newConfidence = computeConfidence(refinementCandidate, sourceTurn,
    { existingElement, domainWeights: getDomainWeights(existingElement.domain) }
  );

  // 3. If confidence dropped too far, flag instead of applying
  if (newConfidence < CONFIDENCE.REVIEW) {
    return {
      action: "flag_revision_uncertain",
      element: setFlag(existingElement, "needsReview", true),
      message: `Refinement of '${existingElement.id}' would drop confidence to ${newConfidence}. Holding for review.`,
      diff,
    };
  }

  // 4. Apply the refinement — bump version, append provenance
  const refined: SIRElement = {
    ...existingElement,
    data: { ...existingElement.data, ...refinementCandidate.data },
    confidence: newConfidence,
    version: existingElement.version + 1,
    updatedAt: Date.now(),
    provenance: {
      entries: [
        ...existingElement.provenance.entries,
        {
          turnId: sourceTurn.id,
          action: "refined",
          agentId: sourceTurn.agentId,
          humanConfirmed: sourceTurn.speaker === "human",
          timestamp: sourceTurn.timestamp,
          confidenceAtTime: newConfidence,
          diff,
        },
      ],
    },
  };

  return { action: "applied", element: refined, diff };
}
```

### 6.2 Version History

Every element maintains its full version history. The SIR can reconstruct any element at any point in time:

```typescript
function getElementAtVersion(element: SIRElement, targetVersion: number): SIRElement {
  let current = element.data;
  const entries = element.provenance.entries
    .filter(e => e.version && e.version <= targetVersion)
    .sort((a, b) => a.version! - b.version!);

  for (const entry of entries) {
    if (entry.diff) {
      for (const change of entry.diff.changes) {
        // Reverse the change to reconstruct previous state
        setNestedValue(current, change.field, change.oldValue);
      }
    }
  }

  return { ...element, data: current, version: targetVersion };
}
```

### 6.3 Confidence Decay on Revision

When a human revises an element (especially implicitly), confidence should be recalculated, not just carried forward. The new confidence depends on:

1. **Explicitness of the revision**: `spec:` prefix → 0.98; vague mention → 0.45
2. **Consistency with related elements**: Does the revision make sense given transitions referencing this state?
3. **Completeness**: Did they revise one field but leave others potentially stale?

---

## 7. Domain Awareness

### 7.1 Domain Registration

The extraction layer is domain-agnostic. Domain-specific extraction logic is registered as a **Domain Backend**:

```typescript
interface DomainBackend {
  domain: DomainId;
  displayName: string;

  // What SIR element types does this domain use?
  elementTypes: SIRType[];

  // Extraction patterns for this domain
  patterns: ExtractionPattern[];

  // LLM extraction prompt template
  extractionPrompt: (transcript: string, existingElements: SIRElement[]) => string;

  // How to validate an extracted element
  validator: (element: SIRElement, sir: SIRDocument) => ValidationResult;

  // How to merge/dedup candidates
  merger: (existing: SIRElement, incoming: ExtractionCandidate) => SIRElement | null;

  // Confidence weights for this domain
  confidenceWeights: ConfidenceWeights;

  // Explicit marker prefixes this domain recognizes
  markerPrefixes: string[];
}

interface ConfidenceWeights {
  explicitMarker: number;      // How much to weight explicit markers
  structuredBlock: number;     // How much to weight code fences
  patternMatch: number;        // How much to weight NLP pattern matches
  consistency: number;         // How much to weight consistency with existing SIR
  speakerAuthority: number;    // How much human vs agent matters
  repetition: number;          // How much repeated mention matters
}
```

### 7.2 Registering a New Domain

```typescript
// Example: Registering the state-machine domain
extractionEngine.registerDomain({
  domain: "state-machine",
  displayName: "State Machine",
  elementTypes: ["state", "transition", "event", "guard", "action", "invariant"],
  patterns: STATE_MACHINE_PATTERNS,
  extractionPrompt: STATE_MACHINE_PROMPT,
  validator: validateStateMachineElement,
  merger: mergeStateMachineElement,
  confidenceWeights: {
    explicitMarker: 0.40,
    structuredBlock: 0.35,
    patternMatch: 0.25,
    consistency: 0.15,
    speakerAuthority: 0.05,
    repetition: 0.10,
  },
  markerPrefixes: ["spec:", "state:", "transition:", "event:", "guard:", "action:", "constraint:"],
});
```

### 7.3 Domain Detection

When the domain is ambiguous, the extraction layer heuristically detects it:

```typescript
function detectDomain(
  turns: ConversationTurn[],
  registeredDomains: DomainBackend[]
): DomainDetectionResult {
  const scores: Record<DomainId, number> = {};

  for (const domain of registeredDomains) {
    scores[domain.domain] = 0;

    for (const turn of turns) {
      // Check explicit markers
      for (const marker of domain.markerPrefixes) {
        if (turn.content.includes(marker)) {
          scores[domain.domain] += 5;
        }
      }

      // Check pattern matches
      for (const pattern of domain.patterns) {
        if (pattern.regex.test(turn.content)) {
          scores[domain.domain] += 2;
        }
      }

      // Check keyword density
      const keywords = getDomainKeywords(domain.domain);
      for (const kw of keywords) {
        const count = (turn.content.match(new RegExp(kw, 'gi')) || []).length;
        scores[domain.domain] += count * 0.5;
      }
    }
  }

  // Return best match, or "general" if no clear winner
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];

  if (best[1] < 3) {
    return { domain: "general", confidence: 0.3, scores };
  }

  return {
    domain: best[0] as DomainId,
    confidence: Math.min(best[1] / 20, 1.0),
    scores,
  };
}
```

### 7.4 Default Fallback Domain

When no domain is detected, the extraction layer operates in "general" mode:
- Extracts only `entity`, `relationship`, `property`, and `constraint` element types
- Uses generic NLP patterns (noun phrases as entities, verb phrases as relationships)
- Confidence is capped at 0.60 (tentative)
- Flags everything for review by default

---

## 8. Practical API Design

### 8.1 ExtractionEngine

The central interface exposed to the Speckl agent:

```typescript
class ExtractionEngine {
  // === Configuration ===

  /** Register a domain backend for extraction */
  registerDomain(backend: DomainBackend): void;

  /** Set the active domain (switches extraction patterns, prompts, etc.) */
  setActiveDomain(domain: DomainId): void;

  /** Configure extraction mode */
  setMode(mode: ExtractionMode): void;

  /** Override confidence thresholds for this session */
  setConfidenceThresholds(thresholds: Partial<typeof CONFIDENCE>): void;

  // === Core Operations ===

  /**
   * Extract from a single conversation turn.
   * Entry point for real-time and interactive modes.
   */
  extract(turn: ConversationTurn): Promise<ExtractionResult>;

  /**
   * Extract from a batch of turns.
   * Entry point for batch mode.
   */
  extractBatch(turns: ConversationTurn[], options?: BatchOptions): Promise<ExtractionResult>;

  /**
   * Run deliberative extraction with multiple agent perspectives.
   */
  extractDeliberative(
    turn: ConversationTurn,
    debaters: DebaterConfig[]
  ): Promise<ExtractionResult>;

  /**
   * Get the current SIR document.
   */
  getSIR(): SIRDocument;

  /**
   * Get extraction statistics for this session.
   */
  getStats(): ExtractionStats;
}

type ExtractionMode = "realtime" | "batch" | "deliberative" | "interactive";
```

### 8.2 ExtractionResult

The return type from every extraction call:

```typescript
interface ExtractionResult {
  /** Unique ID for this extraction run */
  extractionId: string;

  /** Which mode was used */
  mode: ExtractionMode;

  /** Source turn(s) that triggered this extraction */
  sourceTurnIds: string[];

  /** Elements that were successfully added to the SIR */
  added: SIRMutation[];

  /** Existing elements that were refined (with diffs) */
  refined: SIRMutation[];

  /** Elements that were deprecated or replaced */
  deprecated: SIRMutation[];

  /** Candidates that didn't meet the auto-accept threshold */
  flagged: FlaggedCandidate[];

  /** Ambiguities detected during extraction */
  ambiguities: ExtractionAmbiguity[];

  /** Conflicts found between new extractions and existing elements */
  conflicts: ElementConflict[];

  /** If mode is "interactive", clarification questions */
  clarifications?: ClarificationRequest[];

  /** Human-readable summary of what changed */
  summary: string;

  /** Timestamp */
  timestamp: number;
}

interface SIRMutation {
  elementId: string;
  element: SIRElement;
  action: "created" | "updated" | "deprecated" | "replaced";
  diff?: ElementDiff;
  provenance: ProvenanceEntry;
}

interface FlaggedCandidate {
  candidateId: string;
  candidate: ExtractionCandidate;
  reason: "low_confidence" | "ambiguous" | "conflicts";
  confidence: number;
  suggestedQuestion?: string;
}

interface ExtractionAmbiguity {
  id: string;
  description: string;
  interpretations: Interpretation[];
  sourceTurnId: string;
  sourceFragment: string;  // The part of the turn that's ambiguous
}

interface ElementConflict {
  existingElementId: string;
  incomingCandidate: ExtractionCandidate;
  conflictType: "value_mismatch" | "semantic_contradiction" | "redundant";
  description: string;
  suggestedResolution: "replace" | "merge" | "reject" | "ask_human";
}

interface ClarificationRequest {
  id: string;
  question: string;
  context: string;
  options?: string[];  // If multiple-choice, provide options
  elementIds: string[];  // Which elements this clarification would affect
}
```

### 8.3 SIRDocument

The overall SIR that the extraction layer populates:

```typescript
class SIRDocument {
  /** All elements keyed by ID */
  elements: Map<string, SIRElement>;

  /** Human-readable project name */
  projectName: string;

  /** Active domain(s) */
  domains: DomainId[];

  /** Metadata about the conversation session */
  session: {
    sessionId: string;
    startedAt: number;
    turnCount: number;
    participants: string[];
  };

  /** Pending ambiguity resolutions (for interactive mode) */
  pendingAmbiguities: PendingAmbiguity[];

  /** Pending human confirmations */
  pendingConfirmations: PendingConfirmation[];

  // === Query Methods ===

  /** Get all elements of a given type in a domain */
  getElementsByType(domain: DomainId, type: SIRType): SIRElement[];

  /** Get all unconfirmed elements */
  getUnconfirmed(): SIRElement[];

  /** Get all elements that need review */
  getNeedsReview(): SIRElement[];

  /** Get element version history */
  getHistory(elementId: string): ProvenanceEntry[];

  /** Reconstruct element at a specific version */
  getElementAtVersion(elementId: string, version: number): SIRElement;

  /** Find elements contributed by a specific turn */
  getElementsByTurn(turnId: string): SIRElement[];

  /** Validate the entire SIR for consistency */
  validate(): ValidationReport;

  /** Serialize SIR to a stable format (for compilation) */
  serialize(): string;

  /** Generate a human-readable summary of the spec so far */
  summarize(): string;
}
```

### 8.4 Usage Example: Full Flow

```typescript
// --- Session setup ---
const engine = new ExtractionEngine();

// Register the state machine domain
engine.registerDomain(stateMachineBackend);
engine.setActiveDomain("state-machine");
engine.setMode("realtime");

const sir = engine.getSIR();

// --- Turn 1: Human describes the system ---
const turn1: ConversationTurn = {
  id: "turn-001",
  timestamp: Date.now(),
  speaker: "human",
  content: "The system starts in an idle state. When the user clicks 'Search', it goes to a loading state.",
};

const result1 = await engine.extract(turn1);
console.log(result1.summary);
// → "Added 2 states (idle, loading) and 1 transition (idle→loading on 'Search') with low confidence."
console.log(result1.added.length);  // → 3
console.log(result1.added[0].element.confidence);  // → ~0.55 (pattern match)
console.log(result1.added[0].element.flags.isTentative);  // → true

// --- Turn 2: Human gets more specific ---
const turn2: ConversationTurn = {
  id: "turn-002",
  timestamp: Date.now(),
  speaker: "human",
  content: "spec: state idle { isInitial: true, entry: [hideSpinner] }",
};

const result2 = await engine.extract(turn2);
console.log(result2.summary);
// → "Refined state 'idle': added isInitial, entry action. Confidence: 0.98."
console.log(result2.refined[0].element.confidence);  // → 0.98
console.log(result2.refined[0].element.flags.isTentative);  // → false (explicit marker resolved it)

// --- Turn 3: Ambiguity ---
const turn3: ConversationTurn = {
  id: "turn-003",
  timestamp: Date.now(),
  speaker: "human",
  content: "After authentication, go to the dashboard. But what about failed auth?",
};

// Switch to interactive mode for this turn
engine.setMode("interactive");

const result3 = await engine.extract(turn3);
// result3.clarifications = [{
//   question: "Is 'authentication' a state or an event? Should 'dashboard' be a state?",
//   options: [
//     "authentication is a state, dashboard is a state, transition between them",
//     "authentication is an event, dashboard is a state, transition on auth event",
//     "authentication is a guard condition on the transition to dashboard"
//   ]
// }]

// --- End of session ---
const finalSIR = sir.serialize();
const stats = engine.getStats();
console.log(stats);
// → {
//     totalElements: 5,
//     confirmedElements: 2,
//     tentativeElements: 2,
//     pendingAmbiguities: 1,
//     totalTurns: 3,
//     avgConfidence: 0.67,
//     domainConfidence: 0.95,
//   }
```

---

## 9. Extraction Pipeline Architecture

### 9.1 Layered Processing

The extraction pipeline processes each turn through a series of filters:

```
ConversationTurn
    │
    ▼
┌─────────────────────┐
│  1. Pre-processor   │  ← Detect explicit markers, structured blocks
│     (deterministic) │
└─────────┬───────────┘
          │ annotated turn
          ▼
┌─────────────────────┐
│  2. Pattern Matcher │  ← Regex/NLP patterns from registered domain
│     (deterministic) │
└─────────┬───────────┘
          │ ExtractionCandidate[]
          ▼
┌─────────────────────┐
│  3. LLM Extractor   │  ← LLM call for deep semantic extraction
│     (probabilistic) │     (skipped if patterns found everything)
└─────────┬───────────┘
          │ ExtractionCandidate[] (merged)
          ▼
┌─────────────────────┐
│  4. Confidence      │  ← Score each candidate
│     Scorer          │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  5. Conflict        │  ← Diff against existing SIR elements
│     Detector        │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  6. Ambiguity       │  ← Detect multiple interpretations
│     Detector        │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  7. Decision Engine │  ← Apply thresholds → add / refine / flag / ask
│                     │
└─────────┬───────────┘
          │
          ▼
     ExtractionResult
```

### 9.2 Pipeline Configuration

```typescript
interface PipelineConfig {
  /** Skip LLM extraction when pattern matcher confidence is high enough */
  skipLLMWhenPatternConfidenceAbove: number;  // default: 0.80

  /** Maximum tokens to send to LLM extractor */
  maxLLMTokens: number;  // default: 4000

  /** Whether to cache LLM extraction results */
  cacheLLMExtractions: boolean;

  /** When to escalate to interactive mode */
  autoSwitchToInteractive: "on_ambiguity" | "on_low_confidence" | "never";

  /** Minimum number of turns before batch extraction is meaningful */
  minBatchSize: number;  // default: 3
}
```

---

## 10. Edge Cases and Error Handling

### 10.1 Silent Failures Must Be Impossible

Every error path in the extraction pipeline produces an observable result:

| Failure | Behavior |
|---------|----------|
| LLM API timeout | Falls back to pattern-only extraction, sets `result.metadata.degraded = true`, confidence capped at pattern match scores |
| Domain not registered | Falls back to "general" domain, all extractions flagged `isTentative` |
| Turn content is noise ("lol", "ok") | Returns empty ExtractionResult with `summary: "No formal elements detected"` |
| SIR element ID collision | Deterministic ID generation (content-hash based), so collisions mean true duplicates → merged |
| Human contradicts self within same turn | Extracts both, creates AmbiguousElement, forces interactive resolution |
| Agent hallucinates an element | Provenance tracks it to agent; human review catches it; `status: "error"` when flagged |

### 10.2 Recovery from Extraction Errors

```typescript
/** Human marks an element as incorrectly extracted */
function markExtractionError(elementId: string, humanTurnId: string, reason: string): void {
  const element = sir.elements.get(elementId);
  if (!element) throw new Error(`Element ${elementId} not found`);

  element.status = "error";
  element.flags.needsReview = false;  // It's been reviewed — it's wrong
  element.flags.isTentative = false;

  element.provenance.entries.push({
    turnId: humanTurnId,
    action: "deprecated",
    humanConfirmed: true,
    timestamp: Date.now(),
    confidenceAtTime: 1.0,  // Human certainty
    extractionRationale: `Marked as error: ${reason}`,
  });
}
```

---

## 11. Composition with Validation and Compilation Layers

The extraction layer feeds into the Validation and Compilation layers through the SIR:

```
[Extraction Layer] ──produces──> SIRDocument ──consumed by──> [Validation Layer] ──produces──> ValidationReport
                                                                     │
                                                                     ▼
                                                            [Compilation Layer]
```

### 11.1 Contract with Validation Layer

The extraction layer guarantees:
1. Every element has `id`, `elementType`, `domain`, `confidence`, `provenance`
2. No element enters the SIR without at least one provenance entry
3. `confidence` is always a number in [0.0, 1.0]
4. `version` is a monotonic integer ≥ 1
5. `status` is one of the defined `ElementStatus` values

The validation layer checks:
- Domain-specific invariants (e.g., every transition references existing states)
- Cross-element consistency (e.g., no unreachable states)
- Completeness (e.g., at least one initial state)

### 11.2 Contract with Compilation Layer

The compilation layer receives the validated SIR and produces deterministic output. Because of provenance tracking, compilation errors can surface as: *"Element 'transition-7' (from turn #12, extracted by agent speckl-extractor) references non-existent state 'foo'. This state was deprecated in turn #15."*

---

## 12. Open Design Questions

These are intentionally left open for later resolution:

1. **LLM cost/performance tradeoff**: Should pattern-matching be the default, with LLM extraction as a premium upgrade? Or should LLM extraction be the primary path with patterns as fallback?

2. **Provenance storage**: Should the full provenance chain be stored inline in the SIR (increasing document size) or externalized with references? Inline simplifies queries but adds bulk.

3. **Human-in-the-loop granularity**: Should the human confirm every extraction, or only low-confidence ones? What about implicit confirmation (human doesn't object for 3 turns = confirmed)?

4. **Cross-domain elements**: If a conversation spans multiple domains (e.g., state machine + data model), how do elements reference each other across domain boundaries?

5. **Streaming extraction**: For real-time mode, should extraction be truly streaming (extract as human types each word) or per-message? Per-word seems excessive; per-sentence might be the sweet spot.

6. **Extraction caching**: If the same conversation fragment appears in multiple turns (e.g., the agent repeats what it heard), should we cache the extraction or re-extract?

---

## Appendix A: State Machine Domain — Complete Pattern Set

```typescript
const STATE_MACHINE_PATTERNS: ExtractionPattern[] = [
  // Transitions
  {
    id: "transition-explicit",
    domain: "state-machine",
    regex: /transition:\s*(\w+)\s*(?:-+>|→)\s*(\w+)\s*(?:on|when)\s+(.+)/i,
    extract: (m) => ({ elementType: "transition", data: { from: m[1], to: m[2], event: m[3] }, confidence: 0.90 }),
    baseConfidence: 0.90,
  },
  {
    id: "transition-arrow",
    domain: "state-machine",
    regex: /(\w+)\s*(?:-+>|→|goes to|transitions to)\s*(\w+)/i,
    extract: (m) => ({ elementType: "transition", data: { from: m[1], to: m[2] }, confidence: 0.50 }),
    baseConfidence: 0.50,
  },

  // States
  {
    id: "state-declaration",
    domain: "state-machine",
    regex: /(\w+)\s+is\s+(?:a|the)\s+(initial|starting|final|end|error|default)\s+state/i,
    extract: (m) => ({
      elementType: "state",
      data: { name: m[1], isInitial: m[2].match(/initial|starting|default/), isFinal: m[2].match(/final|end/) },
      confidence: 0.50,
    }),
    baseConfidence: 0.50,
  },

  // Guards
  {
    id: "guard-condition",
    domain: "state-machine",
    regex: /(?:only\s+)?if\s+(.+?)(?:\s*,\s*|\s+then\s+|$)/i,
    extract: (m) => ({ elementType: "guard", data: { condition: m[1] }, confidence: 0.45 }),
    baseConfidence: 0.45,
  },

  // Events
  {
    id: "event-definition",
    domain: "state-machine",
    regex: /event\s*:\s*(\w+)\s*(?:{([^}]*)}|with\s+(.+))?/i,
    extract: (m) => ({ elementType: "event", data: { name: m[1], payload: m[2] || m[3] }, confidence: 0.85 }),
    baseConfidence: 0.85,
  },

  // Invariants
  {
    id: "invariant-while",
    domain: "state-machine",
    regex: /(?:while|when)\s+in\s+(\w+)\s*,\s*(.+)/i,
    extract: (m) => ({ elementType: "invariant", data: { state: m[1], property: m[2] }, confidence: 0.55 }),
    baseConfidence: 0.55,
  },

  // Negative constraints
  {
    id: "negative-constraint",
    domain: "state-machine",
    regex: /(?:can't|cannot|must\s+not|shouldn't)\s+(.+?)\s+(?:when|while|in)\s+(\w+)/i,
    extract: (m) => ({ elementType: "constraint", data: { forbidden: m[1], context: m[2] }, confidence: 0.50 }),
    baseConfidence: 0.50,
  },
];
```

## Appendix B: LLM Extraction Prompt Template

```
You are a specification extraction agent for the {domain} domain.

Your task: Extract formal {domain} elements from the following conversation transcript.

Current SIR elements (for refinement/reference):
{existingElements}

Domain element types: {elementTypes}

Rules:
1. For each element you extract, provide the exact conversation fragment that supports it.
2. Assign a confidence score (0.0-1.0) for each extraction.
3. If a statement is ambiguous, note the alternative interpretations.
4. If a new statement refines an existing SIR element, reference the element ID.
5. Do NOT invent elements not present in the conversation.

Transcript:
{transcript}

Output a JSON array of ExtractionCandidate objects.
```

---

_This document describes the complete Extraction Protocol for Speckl. It is designed for domain extensibility, deterministic provenance tracking, and graceful degradation under uncertainty. The state machine domain serves as the reference implementation and running example._
