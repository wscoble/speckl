# Prove SQLite — Project Plan

> *The most deployed database in the world. Never formally verified. We're going to fix that.*

---

## Objective

Specify SQLite's core state machines in SpeckDL — pager, WAL mode, VDBE bytecode engine, and B-Tree — then verify their critical invariants with Z3. Publish findings. This is the sequel to Prove Kafka (docs/PROVE-KAFKA-PLAN.md, now complete).

---

## Why SQLite

SQLite is the most deployed database engine in the world — every smartphone, every browser, countless embedded systems. Its testing infrastructure (TH3, 100% branch coverage, mutation testing) is among the best in the industry. But coverage is not proof.

Formal verification of SQLite's core invariants would be a first. Not a theoretical exercise — this is software running on billions of devices.

---

## Phases

### Phase 1 — SQLite Pager & Journal Modes

**Target:** Specify and verify the pager state machine, including transaction lifecycle, journal modes, and WAL concurrency.

| Milestone | Description | Dependencies | Status |
|-----------|-------------|--------------|--------|
| DB.1 | Research doc: pager, WAL, VDBE, B-Tree | None | 🚧 In progress |
| DB.2 | `SQLitePager.speck` | DB.1 | ⬜ |
| DB.3 | Z3 verification of pager invariants | DB.2 | ⬜ |
| DB.4 | `SQLiteWAL.speck` | DB.1 | ⬜ |
| DB.5 | Z3 verification of WAL concurrency | DB.4 | ⬜ |
| DB.6 | Blog post: "Prove SQLite" | DB.3, DB.5 | 🚧 In progress |

### Phase 2 — SQLite VDBE Bytecode Engine

**Target:** Specify the VDBE execution model — program counter, registers, key opcodes, transaction integration.

| Milestone | Description | Dependencies | Status |
|-----------|-------------|--------------|--------|
| DB.7 | `SQLiteVDBE.speck` | DB.1 | ⬜ |
| DB.8 | Z3 verification of VDBE invariants | DB.7 | ⬜ |
| DB.9 | B-Tree cursor integration spec | DB.8 | ⬜ |

### Phase 3 — B-Tree

**Target:** Specify the B-Tree structure — page organization, splits, merges, cursor operations.

| Milestone | Description | Dependencies | Status |
|-----------|-------------|--------------|--------|
| DB.10 | `SQLiteBTree.speck` | DB.7 | ⬜ |
| DB.11 | Z3 verification of B-Tree invariants | DB.10 | ⬜ |
| DB.12 | Synthesis: unified SQLite verification report | DB.3, DB.5, DB.8, DB.11 | ⬜ |

---

## Target Invariants (by layer)

### Pager Invariants
1. **Transaction atomicity:** pages are either fully written or fully rolled back
2. **Journal integrity:** journal reflects committed state, is cleaned on rollback
3. **Cache consistency:** dirty pages are written back before journal deletion
4. **File format:** page size is consistent across the database file

### WAL Invariants
1. **Read consistency:** a reader sees a consistent snapshot (no partial WAL writes)
2. **Write serialization:** at most one writer at a time
3. **Checkpoint safety:** checkpoint does not remove frames still needed by active readers
4. **Frame ordering:** WAL frames are committed in sequence, no gaps

### VDBE Invariants
1. **Program counter validity:** PC stays within instruction bounds
2. **Register type safety:** read register types match write register types
3. **Cursor consistency:** open cursors point to valid B-Tree positions
4. **HALT guarantee:** every program reaches HALT (no infinite loops)

### B-Tree Invariants
1. **Page organization:** every page has valid header and cell pointers
2. **Key ordering:** keys are sorted within a page and across sibling pages
3. **Balance:** tree depth is uniform across all leaves
4. **Split correctness:** splitting a page preserves key ordering and parent linkage

---

## Deliverables

- `docs/db-sqlite-reference.md` — research source material
- `examples/SQLitePager.speck` — pager + WAL specification
- `examples/SQLiteVDBE.speck` — VDBE specification
- `examples/SQLiteBTree.speck` — B-Tree specification
- `docs/blog-07-prove-sqlite.md` — blog post
- Z3 verification results (sat/unsat per invariant)
- For any gaps found: documented counterexample traces

---

## Guiding Principle

Dependencies only. No wall-time estimates. Each milestone lists what must be true before it can start.

Same approach as Prove Kafka, bigger target.
