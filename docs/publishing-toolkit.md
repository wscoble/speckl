# Speckl Publishing Toolkit
**Ready to publish — all content drafted, this is the checklist.**

---

## Quick Start: Publish Order & Cadence

**Week 1 (Show HN week — May 12-13):**
1. Blog #1 on Dev.to + Medium (Monday May 11, day before Show HN)
2. Show HN post on HN (Tuesday May 12 or Wednesday May 13, 8-11 AM UTC = 1-4 AM PT)
3. Reddit cross-post: r/programming + r/Compilers (same day as Show HN)

**Week 2+ (weekly cadence):**
- Week 2: Blog #2 — Tuesday or Wednesday (~May 19-20)
- Week 3: Blog #3 — Tuesday or Wednesday (~May 26-27)
- Week 4: Blog #4 — Tuesday or Wednesday (~Jun 2-3)
- Week 5: Blog #5 — Tuesday or Wednesday (~Jun 9-10)

---

## Blog Post #1: "Spec-Code Drift Is a Provenance Problem"
**File:** `speckl/docs/blog-01-spec-code-gap.md` | **Words:** ~900

### Dev.to Post

```markdown
Title: Spec-Code Drift Is a Provenance Problem
Tags: formalmethods, compilers, softwareengineering, compliance, provenance
Canonical URL: (leave blank — Dev.to is primary)

---

[Content from blog-01-spec-code-gap.md — copy paste]

---

*This is Part 1 of a 5-part series on Speckl, a specification language with compiler-level provenance. [Part 2 →]()*
```

### Medium Post

```markdown
Title: Spec-Code Drift Is a Provenance Problem
Subtitle: AI is accelerating code generation. Without embedded provenance, we're accelerating drift too.
Tags: Formal Methods, Software Engineering, Compiler Design

---

[Content from blog-01-spec-code-gap.md — copy paste]

---

*This is Part 1 of a 5-part series on Speckl, a specification language with compiler-level provenance. [Part 2 →]()*
```

### Social Blurbs

**LinkedIn / Bluesky / Mastodon:**
> AI writes code faster than ever. But can you prove what ran came from what you wrote? I've been working on Speckl — a spec language that embeds provenance directly into compiled output. Part 1 of a series on why spec-code drift is really a provenance problem. https://speckl.scoble.me

**Reddit (r/programming):**
> Title: Spec-Code Drift Is a Provenance Problem [blog post]
> Text: I've been building a specification language that embeds provenance (PROV-O audit trails, SBOMs, signed manifests) directly into compiled code. The core argument: spec-code drift is fundamentally a provenance problem, not a documentation problem. Would love feedback from anyone working in formal methods or compliance.

**HN (if posting separately from Show HN):**
> Title: Spec-Code Drift Is a Provenance Problem
> (link to Dev.to or speckl.scoble.me)

---

## Blog Post #2: "Designing SpeckDL: What a Spec Language Needs in 2026"
**File:** `speckl/docs/blog-02-designing-speckdl.md` | **Words:** ~1,000

### Dev.to Post

```markdown
Title: Designing SpeckDL: What a Spec Language Needs in 2026
Tags: formallanguages, compilers, typesystems, softwareengineering, provenance
Series: Speckl
Canonical URL: (leave blank)

---

[Content from blog-02-designing-speckdl.md — copy paste]

---

*Part 2 of 5. [Part 1: Spec-Code Drift Is a Provenance Problem →](link to part 1) | [Part 3 →]()*
```

### Medium Post

```markdown
Title: Designing SpeckDL: What a Spec Language Needs in 2026
Subtitle: State machines, embedded provenance, and compile-to-code — the design decisions behind a new spec language.
Tags: Programming Languages, Compiler Design, Formal Methods

---

[Content from blog-02-designing-speckdl.md — copy paste]

---

*Part 2 of 5. [Part 1 →](link) | [Part 3 →]()*
```

### Social Blurbs

**LinkedIn / Bluesky / Mastodon:**
> Part 2 of the Speckl series: designing a spec language for 2026. SpeckDL has a 9-type system, state machine primitives, embedded provenance, and compiles to 5 auditable artifacts. Here's why each design decision matters. https://speckl.scoble.me

**Reddit (r/ProgrammingLanguages):**
> Title: Designing SpeckDL: What a spec language needs in 2026
> Text: I'm designing a specification language that compiles to TypeScript + WASM with embedded provenance (PROV-O, CycloneDX, SPDX). This post covers the 4 core design principles, the type system, and why state machines are first-class. Feedback from PL designers especially welcome.

---

## Blog Post #3: "How Speckl's Compiler Works: From Spec to Five Auditable Artifacts"
**File:** `speckl/docs/blog-03-compiler-architecture.md` | **Words:** ~1,200

### Dev.to Post

```markdown
Title: How Speckl's Compiler Works: From Spec to Five Auditable Artifacts
Tags: compilers, typescript, webassembly, formalmethods, opensource
Series: Speckl
Canonical URL: (leave blank)

---

[Content from blog-03-compiler-architecture.md — copy paste]

---

*Part 3 of 5. [Part 1 →]() | [Part 2 →]() | [Part 4 →]()*
```

### Medium Post

```markdown
Title: How Speckl's Compiler Works: From Spec to Five Auditable Artifacts
Subtitle: A deep dive into the Speckl compiler pipeline — parser, type checker, and five independent code generators.
Tags: Compiler Design, TypeScript, WebAssembly

---

[Content from blog-03-compiler-architecture.md — copy paste]

---

*Part 3 of 5. [Part 1 →]() | [Part 2 →]() | [Part 4 →]()*
```

### Social Blurbs

**LinkedIn / Bluesky / Mastodon:**
> The Speckl compiler generates 5 artifacts from one spec: PROV-O audit trail, CycloneDX SBOM, SPDX license metadata, TypeScript state machine, and WASM. Here's the full pipeline architecture — ~850 lines of parser, 5 independent generators, 41 tests in 2 seconds. https://speckl.scoble.me

**Reddit (r/Compilers):**
> Title: How Speckl's Compiler Works: From Spec to Five Auditable Artifacts
> Text: Built a compiler that takes specification files and emits 5 independent artifacts: PROV-O provenance, CycloneDX SBOM, SPDX metadata, TypeScript state machines, and WASM. All generators are independent (failures don't cascade) and the whole test suite runs in ~2 seconds. Would love compiler dev feedback.

---

## Blog Post #4: "Embedded Provenance: Proving What Ran Came From What You Wrote"
**File:** `speckl/docs/blog-04-embedded-provenance.md` | **Words:** ~1,200

### Dev.to Post

```markdown
Title: Embedded Provenance: Proving What Ran Came From What You Wrote
Tags: provenance, compliance, sbom, cybersecurity, formalmethods
Series: Speckl
Canonical URL: (leave blank)

---

[Content from blog-04-embedded-provenance.md — copy paste]

---

*Part 4 of 5. [Part 1 →]() | [Part 2 →]() | [Part 3 →]() | [Part 5 →]()*
```

### Medium Post

```markdown
Title: Embedded Provenance: Proving What Ran Came From What You Wrote
Subtitle: SBOMs shouldn't come from scanners. They should come from your spec.
Tags: Cybersecurity, Compliance, Software Supply Chain

---

[Content from blog-04-embedded-provenance.md — copy paste]

---

*Part 4 of 5. [Part 1 →]() | [Part 2 →]() | [Part 3 →]() | [Part 5 →]()*
```

### Social Blurbs

**LinkedIn / Bluesky / Mastodon:**
> Your SBOM should come from your spec, not your scanner. Speckl embeds provenance at the compiler level — every compiled artifact carries a cryptographic chain proving it came from the specification. Part 4 of the Speckl series: Embedded Provenance. https://speckl.scoble.me

**Reddit (r/cybersecurity):**
> Title: Embedded Provenance: Why your SBOM should come from your spec, not your scanner
> Text: Most SBOMs are generated post-hoc by scanning dependencies. Speckl generates CycloneDX SBOMs + PROV-O audit trails + SPDX license manifests at compile time — provenance by construction, not by detection. This maps to NIST SA-11 controls for human-in-the-loop validation of automated outputs.

---

## Blog Post #5: "Consensus Protocols in SpeckDL: From TLA+ to Runnable Code"
**File:** `speckl/docs/blog-05-consensus-protocols.md` | **Words:** ~1,400

### Dev.to Post

```markdown
Title: Consensus Protocols in SpeckDL: From TLA+ to Runnable Code
Tags: distributedsystems, consensus, formalmethods, tlaplus, compilers
Series: Speckl
Canonical URL: (leave blank)

---

[Content from blog-05-consensus-protocols.md — copy paste]

---

*Part 5 of 5. [Part 1 →]() | [Part 2 →]() | [Part 3 →]() | [Part 4 →]()*
```

### Medium Post

```markdown
Title: Consensus Protocols in SpeckDL: From TLA+ to Runnable Code
Subtitle: Two-Phase Commit, Paxos, and Raft — specified, type-checked, and compiled to runnable code.
Tags: Distributed Systems, Consensus, TLA+, Formal Verification

---

[Content from blog-05-consensus-protocols.md — copy paste]

---

*Part 5 of 5. [Part 1 →]() | [Part 2 →]() | [Part 3 →]() | [Part 4 →]()*
```

### Social Blurbs

**LinkedIn / Bluesky / Mastodon:**
> Two-Phase Commit in 45 lines. Paxos in 120. Raft in 230. All compile to runnable TypeScript + WASM with provenance baked in. The final post in the Speckl series: consensus protocols from TLA+ to production code. https://speckl.scoble.me

**TLA+ Google Group (respectful intro):**
> Subject: Speckl: Compiling TLA+-style specs to runnable code (complementary tool)
> Hi all — I've built Speckl, a specification language inspired by TLA+ but designed for a different purpose: compiling specs to runnable code with embedded provenance. It's not a replacement for TLA+ (no model checking — yet), but it solves a different problem: proving that deployed code matches its specification. Would love feedback from anyone who's wrestled with the spec-to-implementation gap. https://speckl.scoble.me

**Reddit (r/distributedsystems):**
> Title: Consensus Protocols in SpeckDL: Compiling TLA+-style specs to runnable code
> Text: I specified Two-Phase Commit (45 lines), Paxos (120 lines), and Raft (230 lines) in SpeckDL, a specification language that compiles to TypeScript + WASM with embedded provenance. All three compile correctly and pass type checking. This post covers the approach, the safety invariants, and a comparison to TLA+.

---

## Show HN: Announcement Post
**File:** `speckl/docs/show-hn-announcement.md`

### HN Post

```markdown
Title: Show HN: Speckl — A spec language that compiles to runnable code with provenance

[Content from show-hn-announcement.md — copy paste. Update any dates/status flags if needed.]
```

### HN Discussion Prep (likely objections + responses)

**Objection 1: "How is this different from TLA+?"**
> Speckl is complementary, not competing. TLA+ excels at model checking — proving your design is correct before building. Speckl solves the downstream problem: proving that deployed code matches its spec. It compiles specs to runnable TypeScript + WASM with embedded provenance (PROV-O audit trails, CycloneDX SBOMs). TLA+ for design verification, Speckl for implementation verification.

**Objection 2: "What about fuzzing / property testing?"**
> Those test behavior. Speckl provides provenance — a cryptographic chain proving that compiled code came from a specific specification. This matters for compliance (NIST SA-11, EO 14028) where you need to demonstrate human-in-the-loop validation of automated outputs. Different layer of the verification stack.

**Objection 3: "The compiler only has 41 tests?"**
> It's early. The 41 tests cover the full pipeline end-to-end: parser → type checker → all 5 generators → WASM assembly. The compiler is functional for spec-to-code workflows. More tests (property-based, fuzzing) are on the roadmap. I'm sharing now in the spirit of "working software over comprehensive test coverage."

**Objection 4: "Why not just use Rust/Go with good types?"**
> Types catch type errors. They don't catch specification errors. A Rust `Transfer` struct with `amount: u64` tells you the amount is an unsigned 64-bit integer. It doesn't tell you that transfers must be unique, that debits must equal credits, or that account balances must never go negative. SpeckDL expresses these invariants directly and the compiler enforces them.

**Objection 5: "Another spec language? We have enough DSLs."**
> This isn't a general-purpose DSL. It's purpose-built for a specific gap: the absence of provenance between specification and running code. Every compiled artifact carries a cryptographic trail back to the spec. If compliance or auditability matter to your domain, this solves a real problem no existing tool addresses.

**Objection 6: "Independent researcher, no institutional backing — why should I trust this?"**
> The code is MIT-licensed and public (Forgejo + Codeberg). The whitepaper is complete and available. The compiler runs on any Node.js. You don't need to trust me — you can read the source, run the tests, and verify the output yourself. That's the whole point of open source + provenance.

### Reddit Cross-Post (r/programming)

> Title: Show HN: Speckl — A specification language that compiles to runnable code with embedded provenance
> Text: [2-3 sentence summary of what Speckl does, link to Show HN, invitation for feedback]

---

## Platform Quick Reference

### Dev.to Publishing
1. Go to https://dev.to/new
2. Paste the blog content from the relevant Markdown section above
3. Add tags (listed in each section)
4. Add series name ("Speckl") for posts 2-5
5. Publish

### Medium Publishing
1. Go to https://medium.com/new-story
2. Paste the blog content from the relevant section
3. Add tags
4. Publish — Medium auto-formats Markdown

### Hacker News
1. Go to https://news.ycombinator.com/submit
2. Paste the Show HN content
3. Title must start with "Show HN:"
4. Post on Tue/Wed between 8-11 AM UTC for optimal visibility

### Reddit
1. Go to the relevant subreddit
2. "Submit Link" or "Submit Text" as indicated
3. Post between 6-10 AM ET for best visibility

### TLA+ Google Group
1. Go to https://groups.google.com/g/tlaplus
2. "New Topic"
3. Keep tone respectful — Speckl is complementary, not competing

---

## Pre-Publish Checklist

Before publishing ANY post:
- [ ] Update all "Part N →" links to point to actual published URLs
- [ ] Verify speckl.scoble.me is live
- [ ] Verify Forgejo repo is public and accessible
- [ ] Verify Codeberg mirror is synced
- [ ] Have the whitepaper v2 link ready: (Forgejo raw URL)
- [ ] Have the Speckl by Example link ready: (Forgejo raw URL)

---

## Content Repurposing Ladder

Each blog post can ladder into more formats:
1. **Blog post** (Dev.to + Medium) → primary
2. **Twitter thread** (5-7 tweets extracting key points) → same day
3. **LinkedIn post** (long-form, use social blurb as opener) → same day
4. **Reddit discussion** (link post + top comment with summary) → same day
5. **HN submission** (if not already covered by Show HN) → same week
6. **Newsletter roundup** (end of 5-week series, "What I learned from X readers") → week 6

---

## Metrics to Track

- [ ] Dev.to views/comments on each post
- [ ] Medium reads/fans on each post
- [ ] HN points/comments on Show HN
- [ ] Reddit upvotes/comments per subreddit
- [ ] GitHub/Forgejo stars before and after each wave
- [ ] speckl.scoble.me unique visitors (need analytics)
- [ ] Inbound emails / DMs from posts
- [ ] New watchers/stars on Forgejo repo

---

*This toolkit was compiled May 8, 2026. Update links as posts go live.*
