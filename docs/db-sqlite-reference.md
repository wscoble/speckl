# SQLite Pager, WAL, VDBE, and B-Tree Reference

> Author: Marcus (agent-cos) <cos@marcus.local>
> Date: 2026-05-09
> Purpose: Engineering source material for SpeckDL formal verification
> Target: SQLite version 3.53.1 (check-in c88b22011a54b, 2026-05-05)

---

## 1. Pager State Machine

The pager is SQLite's storage engine — manages page cache, transactions, and crash recovery. Located in `src/pager.c` (~12K lines). The pager owns the lock state, journal state, and page cache.

### 1.1 Pager State Enum (from `pager.c` header comment)

```
PAGER_UNLOCK       (0) — No lock held. Initial state.
PAGER_SHARED       (1) — Read lock (SQLITE_LOCK_SHARED). Read-only access.
PAGER_RESERVED     (2) — Reserved lock (SQLITE_LOCK_RESERVED). Preparing to write.
PAGER_EXCLUSIVE    (3) — Exclusive lock (SQLITE_LOCK_EXCLUSIVE). Actively writing.
PAGER_SYNCED       (4) — All dirty pages written + synced. Journal can be deleted.
PAGER_ERROR        (5) — Error occurred. No further operations allowed.
PAGER_OPEN         (6) — Special state: connection open but no lock. Transitional.
```

### 1.2 State Transition Table

| From | To | Trigger / Guard | Side Effects |
|------|----|-----------------|--------------|
| PAGER_OPEN | PAGER_SHARED | First `pager_acquire()` / `pager_begin()` | Obtain SQLITE_LOCK_SHARED |
| PAGER_UNLOCK | PAGER_SHARED | sqlite3PagerSharedLock() | Obtain shared lock, recover hot journal if present |
| PAGER_SHARED | PAGER_UNLOCK | `pager_unlock()` / end of read tx | Release shared lock |
| PAGER_SHARED | PAGER_RESERVED | `pager_write()` or `pager_begin()` | Obtain SQLITE_LOCK_RESERVED. **No other writer can proceed.** |
| PAGER_RESERVED | PAGER_EXCLUSIVE | First page modification (in `PAGER_RESERVED`) | - |
| PAGER_RESERVED | PAGER_EXCLUSIVE | Commit begins | Obtain PENDING then EXCLUSIVE lock |
| PAGER_RESERVED | PAGER_SHARED | ROLLBACK | Discard changes, release reserved lock |
| PAGER_EXCLUSIVE | PAGER_SYNCED | All dirty pages written + fsynced | Journal header updated to sync state |
| PAGER_SYNCED | PAGER_SHARED (journal-mode) or PAGER_UNLOCK (WAL) | Delete journal file (COMMIT point) | Transaction atomically committed |
| PAGER_EXCLUSIVE | PAGER_ERROR | I/O error, disk full, etc. | errCode set, hot journal preserved |
| PAGER_SYNCED | PAGER_ERROR | I/O error during sync | errCode set, journal preserved for recovery |
| any → | PAGER_ERROR | Any I/O error during pager operation | Further ops blocked |
| PAGER_ERROR | PAGER_OPEN | `pager_unlock()` forced close | Resets connection but keeps db open |

### 1.3 Journal Mode Variants

Three rollback journal modes (non-WAL):

- **DELETE** (default): Journal file deleted on commit. If crash before delete → hot journal → recovery rolls back.
- **TRUNCATE**: Journal file truncated to zero length on commit. Faster on some filesystems than delete.
- **PERSIST**: Journal header zeroed on commit, file left on disk. Slightly faster, but leaves journal files around.

The pager tracks `journalMode` and adjusts the commit-delete step accordingly.

### 1.4 Pager Invariants (to formally specify)

- **I1 (Lock State Consistency)**: `eState` must be consistent with actual file lock held. If `eState==PAGER_SHARED`, must hold `SQLITE_LOCK_SHARED`. If `eState==PAGER_EXCLUSIVE`, must hold `SQLITE_LOCK_EXCLUSIVE`.
- **I2 (Dirty Page Tracking)**: For any page in the cache, `isDirty` iff the page has been modified since last checkpoint/journal write.
- **I3 (Journal Existence)**: The journal file exists iff `eState >= PAGER_RESERVED` and `eState != PAGER_ERROR` (except during recovery).
- **I4 (Hot Journal Detection)**: A journal is "hot" iff it exists but the database was not cleanly closed. On first shared lock, hot journals must be rolled back.
- **I5 (Error Propagation)**: Once `eState == PAGER_ERROR`, all subsequent pager operations must return the stored `errCode`.
- **I6 (Read-Only Pager)**: If `readOnly` flag is set, `eState` must never exceed `PAGER_SHARED`.
- **I7 (Sync Before Commit)**: No dirty page is persisted to the database file until after the journal is synced to disk AND the exclusive lock is held.
- **I8 (Commit Atomicity)**: The commit point is the deletion of the journal file. Before this: crash → rollback. After this: crash → committed state visible.

### 1.5 Lock Escalation Sequence (from `atomiccommit.html`)

```
NO_LOCK → SHARED (read) → RESERVED (intent to write) → PENDING (block new readers)
    → EXCLUSIVE (writing) → no lock (after commit journal deletion)
```

Key subtlety: PENDING lock allows existing readers to finish but blocks new readers. This prevents writer starvation in the face of constant new read connections.

---

## 2. WAL Mode State Machine

WAL mode inverts the rollback journal: original data stays in the database file, changes are appended to the WAL file. Commit = appending a commit record to WAL.

### 2.1 WAL Files

| File | Purpose | Lifecycle |
|------|---------|-----------|
| `X-wal` | Write-ahead log. Sequential append of frames. | Exists while connections are open. Deleted on clean close. |
| `X-shm` | Shared memory (wal-index). Hash table for frame location. | mmap'd. Not fsynced. Omitted under EXCLUSIVE locking mode. |
| `X` | Main database file. Contains original + checkpointed pages. | Persistent. |

### 2.2 WAL-Index Header Fields (from `walformat.html`)

| Field | Bytes | Description |
|-------|-------|-------------|
| iVersion | 0-3 | WAL-index format version (3007000) |
| iChange | 8-11 | Transaction counter, incremented per tx |
| isInit | 12 | 1 when shm file initialized |
| bigEndCksum | 13 | Checksum endianness flag |
| szPage | 14-15 | Page size (or 1 for 65536) |
| mxFrame | 16-19 | Number of valid commit frames in WAL |
| nPage | 20-23 | Database size in pages |
| aFrameCksum | 24-31 | Checksum of last frame |
| aSalt | 32-39 | Two salt values from WAL header |
| nBackfill | 96-99 | Frames already backfilled by checkpoints |
| read-mark[0..4] | 100-119 | Five reader end marks |
| nBackfillAttempted | 128-132 | Frames attempted but not confirmed backfilled |

### 2.3 WAL Locks

| Lock | Byte | Purpose |
|------|------|---------|
| WAL_WRITE_LOCK | 120 | Exclusive: appending frames to WAL |
| WAL_CKPT_LOCK | 121 | Exclusive: running checkpoint |
| WAL_RECOVER_LOCK | 122 | Exclusive: running recovery |
| WAL_READ_LOCK(0) | 123 | Reader end-marks (0-4) |
| WAL_READ_LOCK(1) | 124 | |
| WAL_READ_LOCK(2) | 125 | |
| WAL_READ_LOCK(3) | 126 | |
| WAL_READ_LOCK(4) | 127 | |

### 2.4 WAL Frame Lifecycle

```
Frame format (in WAL file): [page-number] [db-size-after-commit] [salt-1] [salt-2] [checksum-1] [checksum-2]
  followed by page data.

Frame lifecycle states:
  1. WRITER appends frames to end of WAL file (holding WAL_WRITE_LOCK exclusive)
  2. Last frame of a transaction marks "commit" via non-zero db-size field
  3. READERS snapshot mxFrame at transaction start → their "end mark"
  4. CHECKPOINTER copies frames back to database (holding WAL_CKPT_LOCK), increments nBackfill
  5. RESET: When nBackfill == mxFrame and no reader holds WAL_READ_LOCK(N) for N>0,
     writer rewinds WAL to beginning (resets mxFrame, nBackfill to 0)
```

### 2.5 Reader Snapshot (End Mark) Protocol

- When a read transaction begins, the reader notes current `mxFrame` value → this is its "end mark"
- The reader acquires one of WAL_READ_LOCK(0..4) to declare its end mark
- To read page P, the reader calls `FindFrame(P, end_mark)`: find the latest frame for page P in WAL with frame number ≤ end_mark
- If found: read from WAL frame. If not found: read from database file.
- Readers hold WAL_READ_LOCK(N) for the duration of their read transaction
- This prevents checkpointer from overwriting pages the reader still needs

### 2.6 Checkpoint States

| Checkpoint Mode | Behavior |
|----------------|----------|
| PASSIVE | Non-blocking. Works around readers. May not complete. Default. |
| FULL | Blocks until checkpoint completes or a writer appears. More aggressive. |
| RESTART | Full checkpoint then blocks until no readers. Ensures WAL reset. |
| TRUNCATE | Like RESTART, also truncates WAL file to zero bytes. |

Checkpoint progress constraint: MUST STOP at the minimum `end_mark` across all active readers.
- `nBackfill ≤ min(read_mark[0..4])`
- `nBackfillAttempted ≥ nBackfill` (may be ahead if reader blocked a backfill)

### 2.7 WAL Reset Condition

The WAL is reset (wound back to start) when:
1. `nBackfill == mxFrame` (all frames backfilled)
2. No reader holds `WAL_READ_LOCK(N)` for any N > 0 (no readers using WAL)
3. Writer holds WAL_WRITE_LOCK exclusively
4. On reset: `mxFrame = 0`, `nBackfill = 0`, file position rewound

### 2.8 WAL Invariants (to formally specify)

- **W1 (mxFrame Monotonic)**: `mxFrame` is non-decreasing except during WAL reset.
- **W2 (nBackfill Bound)**: `nBackfill ≤ mxFrame` always.
- **W3 (Backfill ≤ Readers)**: `nBackfillAttempted ≤ min(read_mark[0..4])` for any checkpoint that respects readers.
- **W4 (Frame Validity)**: All frames 1..mxFrame have valid checksums. Frames > mxFrame are undefined.
- **W5 (Commit Detection)**: Frame k is a commit frame iff its db-size-after-commit field ≠ 0.
- **W6 (Read Consistency)**: A reader with end-mark M sees exactly the database state as of the last commit frame ≤ M.
- **W7 (WAL Write Serialization)**: Only one connection may append to WAL at a time (WAL_WRITE_LOCK exclusive).
- **W8 (Checkpoint Isolation)**: Checkpoint must not overwrite pages needed by any active reader (nBackfill ≤ min(read_marks)).
- **W9 (Salt Match)**: WAL file header salt values must match `aSalt` in the WAL-index header. Mismatch → WAL is stale → must recover.
- **W10 (WAL Reset Safety)**: WAL may only be reset when `nBackfill == mxFrame` AND no reader locks exist.

---

## 3. VDBE Instruction Set (Key Opcodes)

The VDBE is SQLite's bytecode virtual machine. Each prepared statement is a bytecode program. Source: `vdbe.c` (~8K lines). 192 opcodes in version 3.53.1.

### 3.1 Instruction Format

```
Each instruction: [opcode] P1 P2 P3 P4 P5
  P1, P2, P3: 32-bit signed integers (registers, cursor numbers, jump targets)
  P4: various (int, string, function pointer, collation)
  P5: 16-bit unsigned flags
```

### 3.2 Transaction & Locking Opcodes

| Opcode | P1 | P2 | P4 | Effect |
|--------|----|----|----|--------|
| **Transaction** | iDb | write_flag | | Begin a transaction on database P1. P2=1 for write, 0 for read. Opens pager transaction. |
| **AutoCommit** | autocommit_flag | rollback_flag | | Set auto-commit on/off. If P2 set, rollback first. Causes VM halt. |
| **Checkpoint** | iDb | mode | | Run checkpoint on database P1. P2 = PASSIVE(0)/FULL(1)/RESTART(2)/TRUNCATE(3). |
| **Savepoint** | start_flag | savepoint_name | | Begin/Release/Rollback a savepoint. |
| **TableLock** | iDb | root_page | table_name | Lock a table before modifying. write_flag in P3. |
| **SchemaLock** | iDb | | schema_name | Lock schema objects. |

### 3.3 Cursor Opcodes

| Opcode | P1 | P2 | P3 | P4 | Effect |
|--------|----|----|----|----|--------|
| **OpenRead** | cursor | root_page | iDb | | Open cursor P1 for read on root page P2 of db P3 |
| **OpenWrite** | cursor | root_page | iDb | table_name | Open cursor P1 for write on root page P2 of db P3 |
| **OpenAutoindex** | cursor | key_cols | nCol | | Open ephemeral auto-index cursor |
| **OpenEphemeral** | cursor | nCol | | | Open temporary table, auto-clears on close |
| **Close** | cursor | | | | Close cursor P1 |
| **SeekGT** | cursor | jump_target | | key_reg | Seek cursor P1 to first entry > key in register |
| **SeekGE** | cursor | jump_target | | key_reg | Seek cursor P1 to first entry >= key in register |
| **SeekLT** | cursor | jump_target | | key_reg | Seek cursor P1 to first entry < key in register |
| **SeekLE** | cursor | jump_target | | key_reg | Seek cursor P1 to first entry <= key in register |
| **SeekRowid** | cursor | | | | Seek cursor P1 to entry with given rowid |
| **NotFound** | cursor | jump_target | | | Jump if key not found in index |
| **Found** | cursor | jump_target | | | Jump if key found in index |
| **Next** | cursor | jump_target | | | Advance cursor P1 to next entry. Jump to P2 if no more rows. |
| **Prev** | cursor | jump_target | | | Move cursor P1 to previous entry. Jump to P2 if at beginning. |
| **Last** | cursor | | | | Move cursor P1 to last entry. |
| **Rewind** | cursor | jump_target | | | Move to first entry. Jump to P2 if empty. |
| **Column** | cursor | column_idx | dest_reg | | Read column P2 from cursor P1 into register P3 |
| **Rowid** | cursor | dest_reg | | | Write rowid of cursor P1 into register P2 |
| **IdxInsert** | cursor | | | key | Insert entry into index cursor |
| **IdxDelete** | cursor | | | key | Delete entry from index cursor |
| **Insert** | cursor | | | | Insert current record into table cursor |
| **Delete** | cursor | | | | Delete current record from table cursor |
| **SorterSort** | cursor | | | | Sort sorter cursor P1 |
| **SorterData** | cursor | dest_reg | | | Read current sorter row |

### 3.4 Value & Register Opcodes

| Opcode | P1 | P2 | P3 | Effect |
|--------|----|----|----|--------|
| **Integer** | value | dest | | Store integer value in register P2 (P1 is the value) |
| **Real** | value (P4) | dest | | Store real value in register P2 |
| **String8** | | dest | string | Store UTF-8 string in register P2. Self-modifying → becomes String opcode. |
| **Null** | start | count | | Set P2 registers starting at P1 to NULL |
| **Blob** | size | dest | data | Store P1-byte blob in register P2 |
| **Copy** | src | dest | count | Copy P3 registers from P1 to P2 |
| **Move** | src | dest | count | Move P3 registers from P1 to P2 (clear source) |
| **SCopy** | src | dest | | Soft copy (shallow) register P1 to P2 |
| **ResultRow** | reg_start | nReg | | Pause VM: emit result row from registers P1..P1+P2-1. sqlite3_step() returns SQLITE_ROW. |
| **Yield** | pc_store | | | Coroutine yield. Swap PC with value in register P1. |
| **Halt** | p1 | p2 | p3 | Halt execution. If P1==SQLITE_OK and P2==OE_Abort, auto-rollback. |

### 3.5 Arithmetic & Comparison Opcodes

| Opcode | P1 | P2 | P3 | P4 | Effect |
|--------|----|----|----|----|--------|
| **Add** | r1 | r2 | result | | r[P3] = r[P1] + r[P2] |
| **Subtract** | r1 | r2 | result | | r[P3] = r[P1] - r[P2] |
| **Multiply** | r1 | r2 | result | | r[P3] = r[P1] * r[P2] |
| **Divide** | r1 | r2 | result | | r[P3] = r[P1] / r[P2] |
| **Remainder** | r1 | r2 | result | | r[P3] = r[P1] % r[P2] |
| **Eq** | r1 | r2 | jump | coll | Compare r[P1] and r[P2]. Jump to P3 if equal. |
| **Ne** | r1 | r2 | jump | coll | Jump if not equal |
| **Lt** | r1 | r2 | jump | coll | Jump if r[P1] < r[P2] |
| **Le** | r1 | r2 | jump | coll | Jump if r[P1] ≤ r[P2] |
| **Gt** | r1 | r2 | jump | coll | Jump if r[P1] > r[P2] |
| **Ge** | r1 | r2 | jump | coll | Jump if r[P1] ≥ r[P2] |
| **BitAnd** | r1 | r2 | result | | r[P3] = r[P1] & r[P2] |
| **BitOr** | r1 | r2 | result | | r[P3] = r[P1] \| r[P2] |
| **BitNot** | src | dest | | | r[P2] = ~r[P1] |
| **Concat** | r1 | r2 | result | | r[P3] = r[P1] \|\| r[P2] |

### 3.6 Control Flow Opcodes

| Opcode | P1 | P2 | Effect |
|--------|----|----|--------|
| **Goto** | | target | Unconditional jump to P2 |
| **Gosub** | return_reg | target | Push PC to register P1, jump to P2 |
| **Return** | return_reg | | Jump to address stored in P1 + 1 |
| **If** | jump_target | dest | Conditional jump |
| **IfNot** | jump_target | dest | Conditional jump (negated) |
| **IfNull** | reg | jump_target | Jump if register contains NULL |
| **NotNull** | reg | jump_target | Jump if register is not NULL |
| **IfPos** | reg | jump_target | Jump if register > 0 |
| **IfNeg** | reg | jump_target | Jump if register < 0 |
| **Once** | flag | | NOP if flag was set. Execute body exactly once. |
| **Init** | flags | max_addr | First opcode. Sets trace flags. Self-modifying: increments P1 each invocation. |
| **Program** | | sub_program_addr | Invoke a subprogram (trigger). |
| **Param** | param_idx | dest_reg | Read parameter from caller into destination register. |

### 3.7 Aggregate Function Opcodes

| Opcode | P1 | P2 | P3 | Effect |
|--------|----|----|----|--------|
| **AggStep** | | arg_reg | accum | Execute xStep for aggregate function |
| **AggStep1** | step/inverse | arg_reg | accum | Execute xStep (P1=0) or xInverse (P1!=0) |
| **AggInverse** | | arg_reg | accum | Execute xInverse (window functions) |
| **AggFinal** | | | accum | Finalize aggregate, store result |
| **AggValue** | | | result | Store current aggregate value |

### 3.8 VDBE Invariants (to formally specify)

- **V1 (PC Bounds)**: Program counter must remain within [0, nOp] during execution.
- **V2 (Register Type Safety)**: Each register holds exactly one type at a time (NULL, int, real, text, blob, RowSet, Frame, Undefined).
- **V3 (Cursor Validity)**: An opcode must not reference a cursor unless it was previously opened (OpenRead/OpenWrite/OpenEphemeral) and not yet closed.
- **V4 (Transaction Guard)**: Before any write opcode executes, a transaction must be open. Read opcodes may run outside a transaction but must obtain shared lock.
- **V5 (ResultRow Protocol)**: ResultRow must be preceded by opcodes that fill the output registers. sqlite3_step() returns SQLITE_ROW; subsequent call resumes after ResultRow.
- **V6 (Halt Termination)**: Execution terminates only via Halt opcode, PC exceeding last opcode address, or error.
- **V7 (Error Cleanup)**: On error or HALT with error, all open cursors are closed, memory freed, and active transactions rolled back.
- **V8 (Subprogram Isolation)**: Each Program invocation gets its own register set. Params are the only communication channel to the caller.
- **V9 (Coroutine Symmetry)**: Yield stores PC to register; subsequent Yield reads register to PC. Coroutine execution must return to same point.

---

## 4. B-Tree Invariants

SQLite uses B+tree for tables, B-tree for indices. Source: `btree.c`.

### 4.1 Page Types

| Type | Value | Description |
|------|-------|-------------|
| Interior index | 0x02 | Index b-tree interior page |
| Interior table | 0x05 | Table b-tree interior page |
| Leaf index | 0x0a | Index b-tree leaf page |
| Leaf table | 0x0d | Table b-tree leaf page |

### 4.2 Page Layout

```
Page header:
  [page_type:1] [first_freeblock:2] [cell_count:2] [cell_content_start:2] [fragmented_free_bytes:1]
  
Followed by:
  [right_child_pointer:4] (interior pages only)
  [cell_pointer_array: cell_count * 2 bytes] — offsets to cells, in key order
  [unallocated space in middle]
  [cells: packed from end of page backwards]
```

### 4.3 B-Tree Cell Format

**Table leaf cell:**
```
[payload_size: varint] [rowid: varint] [payload: header + columns]
```

**Table interior cell:**
```
[left_child_page:4] [rowid: varint] [payload: partial row data]
```

**Index leaf cell:**
```
[payload_size: varint] [payload: header + index columns + rowid]
```

**Index interior cell:**
```
[left_child_page:4] [payload_size: varint] [payload: header + index columns + rowid]
```

### 4.4 Key Ordering Properties

- **Table B-Tree**: Ordered by rowid (integer primary key). Interior cells store the rowid of the first entry in each child page.
- **Index B-Tree**: Ordered by indexed column(s) + rowid. Interior cells store the key of the first entry in each child page.
- All keys within a page are in ascending order.
- For any interior page: all keys in child subtree i are ≤ the key at position i in the interior page, and ≤ all keys in child subtree i+1. (For indices, strict < for key columns, ≤ for rowid as tiebreaker.)

### 4.5 Page Split Condition

A page splits when inserting a cell would exceed the usable page space.
1. A new page is allocated.
2. Cells are distributed (roughly half each) between old and new page.
3. Parent interior page gets a new cell pointing to the new page.

### 4.6 Page Merge Condition

When deleting, if a page's content falls below the minimum fill threshold (roughly 25-50% depending on implementation), the page may be merged with a sibling:
1. Cells are moved to sibling page.
2. Parent pointer to the empty page is removed.
3. Empty page is added to freelist.

### 4.7 B-Tree Cursor Operations

```
Cursor state: { Btree*, root page, current page, cell index, cache of page stack }

Operations:
  sqlite3BtreeCursor(): Create cursor on B-tree identified by root page + flags
  sqlite3BtreeMoveto(): Position cursor to entry that matches key (or nearest)
  sqlite3BtreeNext(): Advance cursor. Page crossing handled automatically.
  sqlite3BtreePrevious(): Move cursor backwards. Page crossing handled.
  sqlite3BtreeInsert(): Insert cell into current position
  sqlite3BtreeDelete(): Delete entry at cursor position
```

### 4.8 B-Tree Invariants (to formally specify)

- **B1 (Page Type Consistency)**: A page's type field must match its role. Interior pages reference child pages; leaf pages do not.
- **B2 (Key Order Monotonic)**: For any interior page, keys in child page i are less than or equal to keys in child page i+1. Cells within a page are sorted ascending.
- **B3 (Pointer Integrity)**: Every child page reference must point to a valid allocated page of the correct type (or overflow page, or freelist page).
- **B4 (Cell Count Consistency)**: `cell_count` in the page header must equal the number of entries in the cell pointer array.
- **B5 (Free Space Accounting)**: `fragmented_free_bytes` + unallocated space between cell pointer array and cells must sum correctly to the page's available free space.
- **B6 (Page Size Boundary)**: Usable page size = page_size - reserved_bytes. All cells must fit within the usable page.
- **B7 (Root Page Integrity)**: The b-tree root page number must be a valid, allocated b-tree page. The schema table's root page mappings must be consistent.
- **B8 (Balance Preserved)**: After every insert/delete operation, the b-tree must satisfy all internal structural invariants (fill ratio, parent-child pointer correctness, key ordering).
- **B9 (Overflow Chain Integrity)**: If a cell's payload spills to overflow pages, the chain of overflow pages must: (a) form a proper linked list, (b) be bounded in length by the payload size, (c) contain no cycles.
- **B10 (Freelist Consistency)**: Freelist pages must not be reachable from any b-tree root. Freelist trunk pages must point to valid leaf pages or 0.

---

## 5. Known Bugs and Formal Verification Precedents

### 5.1 Notable SQLite CVEs

| CVE | Year | Type | Module | Fixed In | Severity |
|-----|------|------|--------|----------|----------|
| CVE-2022-35737 | 2022 | Integer overflow → buffer overrun → RCE/DoS | printf/str_vappendf | 3.39.2 | High (7.5) |
| CVE-2025-3277 | 2025 | Write past end of malloc'd array via integer overflow | concat_ws() function | 3.49.1 | Moderate |
| CVE-2025-6965 | 2025 | Integer overflow → array bounds read | SQL injection path | 3.50.2 | Moderate |
| CVE-2024-0232 | 2024 | Use-after-free in JSON parser | JSON | 3.43.2 | Moderate |
| CVE-2023-7104 | 2023 | Corruption in session extension changeset processing | Session (ext) | 3.43.1 | Low |
| CVE-2025-29088 | 2025 | Crash via bad args to sqlite3_db_config | Config API | 3.49.1 | Low |

**Key observation from SQLite's CVE page:**
> Almost all CVEs written against SQLite require the ability to inject and run arbitrary SQL. The core storage layer (pager, WAL, B-tree) has remarkably few logic bugs. Most CVEs are in SQL-level functions, extensions, or edge cases in the printf/logging subsystem.

### 5.2 22-Year-Old Integer Overflow (CVE-2022-35737)

Introduced October 2000 (version 1.0.12), discovered 2022 by Trail of Bits. Exploitable on 64-bit systems when large strings (>2GB) passed to printf functions with `!` unicode flag. Arbitrary code execution possible without stack canaries. Not a pager/journal bug — but illustrates how old, untested edge cases survive.

### 5.3 Formal Verification Precedents

#### 5.3.1 FoundationDB (Apple)
- **What**: Distributed transactional key-value store, formally verified in Flow (their deterministic simulation language)
- **Method**: Deterministic simulation testing — run all DB processes as fibers on a single thread with simulated network/disk, inject faults, check invariants. Run millions of random seeds nightly.
- **Result**: Found ~70 bugs before release. Flow-based simulation verified correctness of their distributed transaction, replication, and recovery protocols.
- **Relevance to SQLite**: The determinism approach parallels what could be done for SQLite's pager. SQLite is single-process by design, making deterministic replay easier.

#### 5.3.2 TigerBeetle
- **What**: Distributed financial accounting database. VOPR (Viewstamped Operation Replicator) deterministic simulator.
- **Method**: Entire cluster runs on single thread. 1000x speed. Injects network, storage, and process faults. Swarm testing + fuzzer. Continuous verification.
- **Relevance to SQLite**: The VOPR approach of running the real implementation under controlled simulation is directly applicable to testing SQLite's recovery paths in the pager.

#### 5.3.3 Amazon (DynamoDB, S3)
- **What**: TLA+ specifications for AWS distributed services
- **Method**: Model checking (TLC) + manual proofs (TLAPS). Found bugs in replication protocols, quorum membership, leader election.
- **Paper**: "Use of Formal Methods at Amazon Web Services" (Newcombe et al., 2014)
- **Relevance to SQLite**: TLA+ is ideal for specifying state machines like the pager's locking protocol. The pager state machine is small enough for tractable TLC model checking.

#### 5.3.4 MongoDB Transactions (VLDB 2025)
- **What**: "Design and Modular Verification of Distributed Transactions in MongoDB"
- **Method**: TLA+ specification + model checking + test-case generation.
- **Relevance to SQLite**: Demonstrates that even complex transactional protocols can be verified with TLA+.

#### 5.3.5 Formal Land's Rocq Translation of SQLite B-Tree (2025-2026)
- **What**: AI-assisted translation of SQLite C code to Rocq (Coq variant). Translation only (not full proof of equivalence).
- **Result**: "Still a big project to run with current technologies." Covered substantial part of B-tree but deemed too unstable for full verification at current AI capability levels.
- **Relevance**: Direct precedent that SQLite formal verification is hard. Suggests model-level verification (state machine specs) is more tractable than code-level proofs.

#### 5.3.6 Richard Hipp's Own Attempt (SQLite Lead)
- Dr. Hipp reports spending "years" trying to write a formal design specification for SQLite but found it never added value and abandoned it. This is telling — both about the difficulty and about the value proposition.

### 5.4 SQLite's Existing Testing (Non-Formal)

| Method | Scale | Notes |
|--------|-------|-------|
| TH3 (Test Harness #3) | Proprietary. Billions of test cases. | 100% branch coverage. Mutation testing (inject bugs, verify they're caught). |
| OSS-Fuzz | Continuous. | Google's fuzzing infrastructure. Catches memory safety bugs. |
| Release testing | ~100M tests per release | Run on multiple platforms |
| Anomaly testing | Random SQL/DB operations with crash injection | Verify recovery |

---

## 6. Target Invariants for SpeckDL Specification

Ranked by impact (what would be most impressive/valuable to prove):

### Tier 1: Impact/Feasibility Sweet Spot

1. **Pager Commit Atomicity (I8)**
   - Prove: For any sequence of pager operations and any crash point, the database file is always in either the pre-commit state (all changes rolled back) or the post-commit state (all changes applied). No partial-commit states.
   - Value: This is the fundamental SQLite guarantee. Proving it formally would be the headline achievement.
   - Feasibility: Medium. The pager state machine has only 5-6 states. The tricky part is modeling disk I/O reordering and crash-at-any-point semantics.

2. **WAL Read Isolation (W6)**
   - Prove: A reader with end-mark M sees exactly the database state as of the last commit ≤ M. Writes after M are invisible.
   - Value: WAL mode's key property. With formal proof, SQLite's WAL concurrency model gets a rigorous foundation.
   - Feasibility: Medium. Need to model the WAL-index hash tables and the FindFrame algorithm.

3. **Journal Recovery Correctness**
   - Prove: After a crash with a hot journal, recovery restores the database to its state before the incomplete transaction.
   - Value: Crash recovery is the hardest case to test exhaustively. Formal proof would eliminate a whole class of concerns.
   - Feasibility: High. Well-scoped problem with clear success criteria.

### Tier 2: High Value, Higher Difficulty

4. **B-Tree Balance Preservation (B8)**
   - Prove: After any sequence of insertions and deletions, the b-tree satisfies all structural invariants (page fill ratios, key ordering, pointer integrity, freelist consistency).
   - Value: B-tree corruption is one of the most feared failure modes. Formal proof is the gold standard.
   - Feasibility: Low-Medium. The B-tree is complex (~200KB of C code). A full proof is likely too big, but the core balancing algorithm could be specified and verified in isolation.

5. **Lock Protocol Deadlock Freedom**
   - Prove: The lock escalation protocol (shared → reserved → pending → exclusive) is deadlock-free for any number of concurrent readers and writers.
   - Value: Prevents a potential operational nightmare.
   - Feasibility: High. Small state space. Ideal for TLC model checking.

6. **WAL Checkpoint Safety (W8)**
   - Prove: Checkpoint never overwrites pages needed by active readers, even when readers and checkpointer operate concurrently.
   - Value: WAL's concurrent reader+writer+checkpointer model is nontrivial. Getting it right formally is impressive.
   - Feasibility: Medium. Requires modeling concurrent processes and the WAL-index header fields.

### Tier 3: Ambitious / Future Work

7. **Full Pager FSM Correctness (I1-I8)**
   - Prove all eight pager invariants from Section 1.4 simultaneously.
   - Feasibility: Low (large specification, many interacting components). Best done incrementally.

8. **VDBE Safety: No undefined register reads (V2)**
   - Prove that the code generator never produces bytecode that reads an Undefined register.
   - Feasibility: Low. Requires modeling the SQL compiler's code generation, which is a much larger problem.

### Recommendation: Start with Tier 1 (Items 1-3)

The pager commit atomicity + WAL read isolation + journal recovery form a coherent package:
- All three involve the pager module
- All three address crash-safety guarantees
- Together, they prove that "SQLite transactions are atomic even under arbitrary crash timing" — the single claim that matters most
- The state spaces are tractable for SpeckDL + model checking

---

## 7. Source References

| Source | Location |
|--------|----------|
| SQLite WAL documentation | https://www.sqlite.org/wal.html |
| SQLite Atomic Commit | https://www.sqlite.org/atomiccommit.html |
| SQLite Bytecode Engine | https://www.sqlite.org/opcode.html (192 opcodes, v3.53.1) |
| Database File Format | https://www.sqlite.org/fileformat2.html |
| WAL File Format | https://www.sqlite.org/walformat.html |
| Pager source | `src/pager.c` (~12K lines). States: PAGER_UNLOCK, SHARED, RESERVED, EXCLUSIVE, SYNCED, ERROR, OPEN |
| VDBE source | `src/vdbe.c` (~8K lines) + helper files |
| B-Tree source | `src/btree.c` |
| SQLite CVEs | https://sqlite.org/cves.html |
| Formal Land B-Tree translation | https://github.com/formal-land/rocq-of-db |
| FoundationDB verification | "FoundationDB: A Distributed, Unbundled, Transactional Key Value Store" (SIGMOD 2021) |
| Amazon formal methods | "Use of Formal Methods at Amazon Web Services" (2014) |
| MongoDB TLA+ | "Design and Modular Verification of Distributed Transactions in MongoDB" (VLDB 2025) |
| TigerBeetle VOPR | https://tigerbeetle.com/blog/2023-07-11-we-put-a-distributed-database-in-the-browser/ |
| CVE-2022-35737 (Trail of Bits) | https://blog.trailofbits.com/2022/10/25/sqlite-vulnerability-july-2022-library-api/ |
| Fly.io B-Tree internals | https://fly.io/blog/sqlite-internals-btree/ |

---

*End of reference document. Ready for SpeckDL specification writing.*
