# Show HN Launch Day Operations Checklist
**For: Scott Scoble | Launch: May 12 (Monday) or May 13 (Tuesday), 2026**
**Prepared: May 9, 2026, 2:04 AM PT (Ventures 🚀)**

---

## TL;DR: What Scott Actually Does

1. Pick Monday or Tuesday morning
2. Run the 5-minute pre-flight check below
3. Paste the Show HN post
4. Watch comments for the first hour — use the comment playbook
5. At +4 hours, cross-post to Reddit + share link on Discord/Slack groups
6. At +24 hours, check if it hit front page and decide next steps

---

## PRE-LAUNCH: Day Before (Sunday or Monday night)

### 5-Minute Pre-Flight Check

Run these in a terminal:

```bash
# 1. ALL LINKS WORK
curl -sI https://speckl.scoble.me | head -1        # → 200 OK
curl -sI https://os.scoble.me/forgejo/sscoble/speckl | head -1  # → 200
curl -sI https://codeberg.org/sscoble/speckl | head -1  # → 200

# 2. COMPILER IS STABLE
cd ~/speckl/compiler && npm test                     # → 41/41 passing

# 3. DEMO PAGE WORKS
curl -sI https://speckl.scoble.me/demo/index.html | head -1  # → 200 OK

# 4. WHITEPAPER IS ACCESSIBLE
wc -l ~/speckl/docs/whitepaper-v2.md                # → ~1,300+ lines

# 5. BLOG POSTS RENDER (optional — pick your 2 best for linking)
#    Blog posts: ~/speckl/docs/blog-*.md
```

If Storj is still down: **abort launch**. Without the landing page, the post loses all credibility. Scott must fix `rclone config` or republish the landing page another way first.

### Choose Your Timing

| Option | Day | Post Time PT | UTC | Why |
|--------|-----|-------------|-----|-----|
| **A (best)** | Tue May 13 | 1:00 AM PT | 8:00 AM UTC | Catches EU morning + US late night |
| **B** | Tue May 13 | 6:00 AM PT | 1:00 PM UTC | Catches US morning, EU afternoon |
| **C** | Mon May 12 | 6:00 AM PT | 1:00 PM UTC | Monday is slightly worse than Tuesday |

**Recommendation:** Option A if Scott can pre-schedule or wake up early. Option B if he wants a normal morning.

### HN Account Check
- Log into HN. Verify karma ≥ 2 (minimum to post Show HN).
- If karma < 2: Reply to 2-3 comments on front page stories to get karma. Takes 10 minutes.
- Bookmark: https://news.ycombinator.com/submit

---

## LAUNCH DAY: T-5 Minutes

### Open These Tabs

1. **HN Submit:** https://news.ycombinator.com/submit
2. **Comment Playbook:** Find it at `~/speckl/docs/show-hn-comment-playbook.md` (open in editor or browser)
3. **Your HN Threads page:** https://news.ycombinator.com/threads?id=YOUR_USERNAME (to monitor comments)
4. **Announcement post source:** `~/speckl/docs/show-hn-announcement.md`

### Final Sanity Check (30 seconds)
- Title starts with "Show HN:" ✅
- Landing page resolves ✅
- GitHub/code link is a real repo (not just docs) ✅
- Post body has actual code examples or links to them ✅
- Whitepaper link works ✅

---

## T+0: POST IT

Go to https://news.ycombinator.com/submit

**Title:** 
```
Show HN: Speckl — Write specs like TLA+, compile to runnable TypeScript and WASM
```

**URL:** 
```
https://speckl.scoble.me
```
(Link to the landing page — it has links to the repo, whitepaper, demo. HN prefers clean landing pages over direct repo links for Show HN.)

**Text:** (optional — only if using self-post format)
Paste the body from `show-hn-announcement.md`. If HN's URL field is used (recommended), add the first paragraph as the first comment instead.

### Immediately After Posting:
- Copy the post URL (it'll be `https://news.ycombinator.com/item?id=XXXXXXX`)
- Save it — you'll need it for cross-posting

---

## FIRST HOUR: The Golden Window (T+0 to T+60)

This is when HN's ranking algorithm is most sensitive to engagement. Every upvote and comment thread counts quadruple.

### What To Do:
1. **Reply to comments within 5 minutes.** Speed signals "builder is present."
2. **Use the comment playbook** (`show-hn-comment-playbook.md`) — it has responses to 14 common objections pre-written. Copy-paste-adapt. Do NOT write responses from scratch under time pressure.
3. **Be human.** If someone says "cool project," say thanks and ask if they have a use case. If someone finds a bug, thank them and log it.
4. **Don't get defensive.** Someone WILL call Speckl "another TLA+ clone." Use the pre-written response. Don't argue. Move on.
5. **Upvote helpful comments** from others — it keeps the thread active.

### Do NOT:
- Ask friends to upvote (HN detects voting rings)
- Post multiple top-level comments yourself
- Link to "buy now" or pricing (there is none — keep it pure Show HN)
- Engage with obvious trolls. One polite reply, then ignore.

### Monitor Metrics:
- Upvote count (refresh every 10 min)
- Comment count
- Position on /show or /new vs /news (front page)

---

## T+1 TO T+4: Sustain Engagement

- Check comments every 30 min
- Reply to new questions using the playbook
- If post is on /show but not /news: normal. Show HN needs ~10+ upvotes in first 2 hours to graduate to /news.

### First Cross-Post: Reddit

**Only if the post has 15+ upvotes and positive comments.** A dead post doesn't need amplification.

Post to r/programming (2.5M members):

**Title:** Speckl — Write specs like TLA+, compile to TypeScript and WASM (open source, Show HN'd today)

**Link:** Your HN post URL (not the landing page — Redditors want to see the HN discussion)

**Flair:** Use if available.

---

## T+4 TO T+24: Extended Monitoring

- Check comments every 2-3 hours
- If post hits front page (top 30 on /news): engage actively with ALL comments — this is your moment
- If post stalls at 5-15 upvotes and sinks: don't despair. Bookmark the HN post URL. You can reuse the announcement for a future Show HN in 3-6 months with "v0.3" or a major milestone.

### Additional Cross-Posts (Only If Traction Is Good):

| Platform | When | Post Type |
|----------|------|-----------|
| r/Compilers (28K) | T+4h | Link to HN discussion |
| r/rust (300K) | T+4h | WASM angle — "compiles to WASM from formal specs" |
| Twitter/Bluesky | T+1h | Link to HN post + screenshot of compiler output |
| Lobsters | T+2h | Submit as "Speckl: a spec language that compiles to TypeScript + WASM" |

---

## T+24: Debrief

### If It Hit Front Page (top 30 on /news):
- 🎉 You have developer credibility. Now:
  1. Submit whitepaper to arXiv TODAY (ride the momentum)
  2. Cross-post to all platforms listed above
  3. Email the formal methods communities (tlaplus group, FME, etc.)
  4. Consider a follow-up Show HN in 2-4 weeks with "Speckl v0.3: now compiling real-world state machines"

### If It Got Moderate Traction (10-30 upvotes, some comments):
- Valuable signal. Extract every comment as product feedback.
- Update the FAQ/landing page based on common questions.
- Re-submit after a major compiler milestone (pre/postcondition support, record types, etc.)

### If It Got No Traction (< 10 upvotes):
- Show HN timing is fickle. Does NOT mean the project is bad.
- Check: was the title good? Was the landing page slow/down? Did you post at a bad time?
- Try again in 3-6 months with a substantially improved product.
- Don't delete the post — HN doesn't let you. Just move on.

---

## CONTINGENCY: If Something Breaks

| Problem | Response |
|---------|----------|
| **Landing page down** | Post a comment immediately: "Landing page is struggling — here's the direct repo link." Link to Forgejo. |
| **Compiler tests failing** | Don't mention it unless asked. Fix it after the post dies down. |
| **Someone finds a real bug** | "Great catch — filed. Here's the issue link." Link to marcus/engineering. Shows you take bugs seriously. |
| **Troll/spam comments** | Flag. Do not engage beyond one polite reply. HN mods are active. |
| **Post flagged as spam** | Email hn@ycombinator.com. Explain it's open source, no commercial product. They unflag quickly. |
| **Storj goes down mid-launch** | You're hosed for landing page links. Post the Forgejo repo link as a comment. Redirect the landing page to a GitHub Pages mirror (if you set one up in advance). |

---

## SEEDED QUESTIONS (Optional — Use Sparingly)

If you have 1-2 trusted friends who can post natural-sounding questions, pick from these:

1. "How does provenance tracking work in the compiler? Do you embed hashes in the artifacts?"
   → Use Response 4 from the playbook.

2. "What made you choose to generate both TypeScript AND WASM instead of picking one?"
   → Use Response 10 from the playbook.

Do NOT fabricate fake accounts. HN detects this and it's worse than no engagement.

---

## Post-Launch: What Ships Next

Regardless of Show HN outcome, the compiler needs these fixes before it's "real":

1. **engineering#9:** Parser must capture `precondition:` / `postcondition:` blocks in action bodies
2. **engineering#11:** TypeScript generator must emit type aliases for record declarations (`Transfer`, `LogEntry`)
3. **engineering#10 (if exists):** Host-side record boxing + `in` operator for WASM

These are the blockers between "cool demo" and "usable tool." Show HN traction helps motivate these fixes; no traction just means they take longer.

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────┐
│  SHOW HN LAUNCH — SPEEDRUN                               │
│                                                          │
│  Day Before:                                             │
│    ☐ 5-min pre-flight (curl landing, test compiler)     │
│    ☐ Storj is up? (if not, ABORT)                       │
│    ☐ HN karma ≥ 2?                                      │
│                                                          │
│  T-5 min:                                                │
│    ☐ Open HN submit + comment playbook + threads page   │
│                                                          │
│  T+0:                                                    │
│    ☐ Paste title + URL + body                           │
│    ☐ Save post URL                                      │
│                                                          │
│  T+0 to T+60 (GOLDEN HOUR):                              │
│    ☐ Reply within 5 min using playbook                   │
│    ☐ Monitor upvote count every 10 min                  │
│    ☐ Be human, don't argue, don't astroturf             │
│                                                          │
│  T+4h:                                                   │
│    ☐ Cross-post to Reddit (if 15+ upvotes)              │
│    ☐ Share on Discord/Slack/Twitter                     │
│                                                          │
│  T+24h:                                                  │
│    ☐ Debrief: front page / moderate / dead              │
│    ☐ Act based on outcome                               │
│                                                          │
│  CONTINGENCY: If landing page dies → link to repo       │
│                        If flagged → email hn@ycombinator │
└─────────────────────────────────────────────────────────┘
```
