# Speckl Distribution Strategy

> *The whitepaper is done. Now it needs a path to the world.*

**Created:** May 7, 2026 (8:05 PM heartbeat)
**Status:** All items pending — blocked on Scott for human-required actions

---

## The Asset: Whitepaper v2

- **~19,000 words** across 8 complete sections
- **Commit:** `6121fd6` — pushed to Forgejo
- **Sections:** The Spec-Code Gap, SpeckDL Language, Compiler Architecture, Embedded Provenance, Consensus Protocols, Real-World Applications, Related Work, Future Work & Roadmap
- **Positioning:** "specification language with compiler-level provenance for teams that need evidence of correctness more than proof of correctness"

---

## Priority-Ordered Distribution Plan

### P0: Show HN (May 12-13)

**No gatekeepers. Post is ready.**

- **Post:** `docs/show-hn-announcement.md` — written, copy-paste ready
- **Optimal timing:** Tuesday or Wednesday, 8-11 AM UTC (based on analysis of 1,200 launches)
- **What it needs:** Scott's HN account, click "submit"
- **Expected:** ~50-200 upvotes for a well-written open source technical tool, potential for front page
- **Risk:** Low — even a modest response builds awareness and creates a permalink

### P1: arXiv Preprint + Weekly Blog Posts

**Builds the knowledge graph around Speckl before conference submissions open.**

- **arXiv:** Submit whitepaper as a preprint to cs.SE or cs.PL
  - Requires: academic email or endorsement (Scott may need an endorser)
  - Value: citable, discoverable, timestamped — standard for CS credibility
- **Blog series:** 5 posts extractable from whitepaper sections
  1. "The Spec-Code Gap" — why specs rot and what to do about it
  2. "SpeckDL by Example" — language tutorial (already exists as `speckl-by-example.md`)
  3. "Compiling Provenance" — how Speckl generates PROV-O, CycloneDX, SPDX
  4. "Consensus from Spec" — Paxos, Raft, Two-Phase Commit in SpeckDL
  5. "The Future of Spec-Driven Development" — roadmap and vision
  - Host on: speckl.scoble.me/blog (Storj static) or scott.scoble.me/blog
  - Each post cross-links to Show HN thread and whitepaper

### P2: Conference Submissions (2027 Cycle)

**All major 2026 cycles are closed.** Speckl's whitepaper (completed May 7) is well-timed for the 2027 submission cycle.

#### Target Venues (2027)

| Venue | Focus | Typical Deadline | Fit |
|-------|-------|-----------------|-----|
| **FMCAD 2027** | Formal methods + CAD | Apr-May 2027 | Strong — state machines, verification |
| **FM 2027** | Formal methods (broad) | ~Dec 2026 | Strong — methodology + tool |
| **ICSE 2027** | Software engineering | ~Aug 2026 | Good — spec-driven dev is an SE topic |
| **ASE 2027** | Automated SE | ~May 2027 | Good — compiler-level generation |
| **NFM 2027** | NASA Formal Methods | ~Dec 2026 | Strong — provenance + verification |
| **SPLASH Onward! 2026** | New ideas in programming | ~Jun 2026 | Possible — "grand visions" track |

#### Note on FMCAD 2026

FMCAD 2026 (Graz, Sept 14-18, co-located with VSTTE) has **already closed**: abstract deadline April 26, paper deadline May 3. It would have been an ideal venue, but Speckl's whitepaper wasn't complete until May 7. 2027 is the target.

### P3: QCon SF Talk Proposal (~Jun 2026)

**Practitioner conference, not academic. Faster cycle.**

- QCon SF 2026 call for proposals typically opens ~June
- Topic: "Spec-Driven Development: From TLA+ to TypeScript" or "Building Evidence into Specs"
- Less competitive than academic venues, reaches working engineers
- Scott's existing speaking experience (3 talk forks) positions him well

### P4: Journal Publication (Rolling)

- **TOSEM (ACM Transactions on Software Engineering and Methodology):** rolling submissions, high prestige
- **JAR (Journal of Automated Reasoning):** rolling, good fit for formal methods + automation
- Both take 12-18 months but produce durable citations

### P5: Cold Email → First Consulting Client (Summer 2026)

**When: After at least one public artifact is circulating (Show HN + arXiv).**

- **Pipeline already built:** `speckl/outreach.md`
- **Top targets:** Dan Lorenc (Chainguard), Said Ziouani (Anchore)
- **Emails verified:** dlorenc@chainguard.dev ✅, sziouani@anchore.com ✅
- **Content:** Consulting one-pager drafted (`speckl/docs/consulting-one-pager.md`)
- **Pricing:** Drafted, needs Scott review
- **Approach:** "We've been building Speckl — an open standard for spec-driven development with compiler-level provenance. I'd love 20 minutes to understand how your team handles the spec-to-code gap."

---

## Blockers Inventory

| Blocker | Priority | Owner | Status |
|---------|----------|-------|--------|
| Show HN submission | P0 | Scott | Post ready, needs HN account |
| arXiv endorsement/account | P1 | Scott | Whitepaper ready |
| Blog posts publishing | P1 | Scott or @content | Content mostly written |
| Consulting one-pager review | P3 | Scott | Draft complete, needs pricing validation |
| Cold email send | P3 | Scott | Targets identified, emails verified |
| engineering#9 (parser fix) | P0 tech | @engineering | 4-bug scope documented |
| Storj credentials | — | Scott | Expired, blocks new deploys |
| ClawHub/npm auth | — | Scott | Blocks MCP experiment |

---

## Timeline (Ideal)

```
May 12-13:  Show HN goes live (P0)
May 14:     arXiv preprint submitted (P1)
May 15+:    Blog post #1 published, weekly cadence (P1)
Jun:        QCon SF proposal submitted (P3)
Jul:        First cold emails sent (P5)
Aug:        ICSE 2027 deadline (P2)
Sep:        First consulting engagement (P5)
Late 2026:  Conference submissions for 2027 cycle (P2)
```

---

## Decision Framework

**If Show HN gets strong traction (>200 upvotes):**
→ Prioritize blog series, community building, open source contributions
→ Defer consulting — let inbound interest come naturally

**If Show HN gets modest traction (<50 upvotes):**
→ Still publish arXiv + blog for credibility
→ Proceed to cold email for consulting (validates need regardless of HN)

**If Scott can't get to Show HN by May 20:**
→ Skip it — publish arXiv first, blog series second
→ Show HN can happen anytime, but momentum matters

---

## What NOT to Do

- ❌ Don't rush a paper to a 2026 venue with a late deadline — a rejected rushed paper is worse than a polished 2027 submission
- ❌ Don't cold email without at least one public artifact circulating — credibility gap
- ❌ Don't build more compiler features before distribution — the compiler works well enough to demonstrate the concept
- ❌ Don't start a new venture — Speckl is the highest-ROI path to revenue
