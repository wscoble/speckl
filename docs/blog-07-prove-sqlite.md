# We're Going to Formally Verify SQLite

SQLite runs on every smartphone, every browser, every embedded system. Its core state machines have never been formally verified. We're going to fix that.

This is the follow-up to our Kafka proof-of-consensus project; same methodology, bigger target. SQLite is not a research toy; it is the most deployed database in the history of software. If we can prove its invariants, we prove something that matters.

---

## Why SQLite

SQLite is not a theoretical construct. It ships inside:

- Every iPhone and Android device (iOS, Android system libraries)
- Every major browser (Chrome, Firefox, Safari, Edge)
- Countless embedded systems, IoT devices, and automotive platforms
- macOS, Windows, and most Linux distributions by default

The SQLite Consortium estimates **one trillion** active SQLite databases. Not one billion; one trillion. The test suite (TH3) achieves 100% branch coverage and is widely regarded as the best-tested codebase on Earth. But 100% branch coverage is not proof. It is exhaustive testing, and exhaustive testing is not the same as a mathematical guarantee.

SQLite's internals are exceptionally well-documented. D. Richard Hipp publishes detailed architecture documentation, and the codebase is commented with the rigor of a textbook. The state machines are explicit: the pager has discrete modes, the WAL protocol has a defined lifecycle, and the VDBE bytecode engine operates on a register model with well-defined instruction semantics.

This is not a black box. It is a glass box with a published manual. That makes it an ideal target for formal specification.

## What We'll Verify (Phase 1)

We are not attempting to verify all of SQLite. The full engine is hundreds of thousands of lines of C. Our Phase 1 scope targets three core subsystems whose state machines are both critical and amenable to SpeckDL specification:

### 1. The Pager State Machine

The pager manages the transaction lifecycle: reading pages from disk, caching them, tracking dirtiness, and orchestrating writes. It operates in multiple journal modes (DELETE, TRUNCATE, PERSIST, WAL, MEMORY, OFF) and transitions through states that must respect strict invariants.

The pager state machine is where SQLite's durability guarantee lives. When a transaction commits, the pager decides whether the commit is durable and when the journal can be discarded. In WAL mode, the pager coordinates between a single writer and multiple readers via the WAL index and checkpoint logic. An error in the pager does not produce a crash; it produces silent data loss or inconsistency that may not surface for months.

Key properties to verify:
- A dirty page is never evicted without being written
- WAL mode maintains read consistency across concurrent readers and a single writer
- Journal mode transitions are atomic with respect to crash recovery
- The pager never enters an inconsistent state after an interrupted commit
- Checkpoint operations preserve the "all committed data is in the database file" invariant

### 2. The VDBE Bytecode Engine

The Virtual Database Engine executes compiled SQL bytecode on a register machine. Each instruction manipulates registers, cursors, and the B-Tree layer. The instruction set is finite and well-documented; the register model is a stack-plus-registers hybrid.

The VDBE is not the highest-risk component; its instructions are deterministic and its state is local. But it is the component every SQL statement passes through. A single off-by-one in a register reference or a type-tag mismatch in an arithmetic operation can produce incorrect query results that look like correct ones. Verifying the VDBE means verifying that the bytecode interpreter cannot enter an undefined state regardless of the input program.

Key properties to verify:
- Register references are always within bounds
- Type tags are consistent with the operations performed on them
- Cursor operations maintain valid iterator state
- The program counter advances monotonically except for controlled jumps
- The stack depth never underflows or exceeds its declared maximum

### 3. B-Tree Invariants

The B-Tree layer is SQLite's storage backbone: tables and indexes are both B-Trees. Page splits, pointer integrity, and balance operations are the kind of mechanical code that formal verification excels at.

The B-Tree code in SQLite is dense. A single page split involves allocating a new page, redistributing cells between two pages, updating parent pointers, and handling the edge case where the root itself splits. Each step has preconditions; violate one and the tree becomes structurally inconsistent. Corruption at this layer does not crash; it causes queries to return wrong results or skip rows entirely.

Key properties to verify:
- After any page split, all keys remain reachable via tree traversal
- Sibling pointers maintain total order
- Balance operations preserve the B-Tree height bound
- Cell offsets remain within the page boundary after any insertion or deletion
- Free space within a page is always contiguous and correctly sized

## Method

Same as Prove Kafka: SpeckDL specification, Z3 bounded model checking, publish findings.

The framework is already built. The compiler produces a typed intermediate representation; the Z3 backend translates invariants and verify blocks into SMT-LIB assertions. We proved Kafka's consensus invariants this way; we will prove SQLite's operational invariants the same way.

The workflow:

1. **Specify** the state machine in SpeckDL (pager modes, VDBE registers, B-Tree pages)
2. **Compile** to Z3 SMT-LIB with `speckl verify --target=z3 --verify-depth=N`
3. **Run** bounded model checking against the invariants
4. **Document** the results: what held, what didn't, what depth we reached
5. **Publish** the specification and findings as open-source artifacts

The SpeckDL specifications will be open source. The Z3 output will be reproducible. If we find an invariant violation, you'll read about it here first.

## Why This Matters

There is no shortage of testing in SQLite. TH3 is the gold standard. But testing and proof are different categories of assurance.

Testing says: "We tried a lot of cases and didn't find a bug." Proof says: "No case exists that violates this property." The first is empirical confidence; the second is logical certainty. Both matter. SQLite has the first in abundance. It has never had the second.

Formal verification of SQLite's core invariants would be a first. Not because SQLite is buggy; the evidence suggests it is exceptionally solid. But because proof is the only assurance that does not degrade over time. As the codebase evolves, as new journal modes are added, as platforms change, a verified invariant remains verified. A test case does not.

We proved Kafka's consensus. Now we're proving the world's most deployed database.

## Follow Along

The specifications will live in the Speckl repository at `examples/SQLitePager.speck`, `examples/SQLiteVDBE.speck`, and `examples/SQLiteBTree.speck`. Verification results will be published as we complete each subsystem.

If you want to follow the work or contribute, the repo is open and the issues are tracked publicly. When we find something, you'll read it here first.

---

*This post is part of the Speckl proof catalog: formally verifying the software the world depends on. Read the [Kafka proof](/blog/prove-kafka) or explore the [Speckl compiler](https://github.com/wscoble/speckl).*

*Speckl is MIT-licensed and open source. The specifications, the compiler, and the findings are all public.*
