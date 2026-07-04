# CATCOR — Feature Map

Third panel/page in ArgentVigil. Personal macro-intelligence view with scrutiny on silver — automates the "why did it move" research loop that would otherwise be manual news reconstruction, and the "is this claim real" loop that currently happens ad hoc over coffee.

Detail intentionally drops off at later iterations — architecture and even feasibility for those is expected to shift as tooling evolves. Early iterations are spec-ready; late ones are directional intent, not commitments.

---

## Anchor Points (governing principle)

CATCOR's cross-check features are built on two trusted anchors, chosen specifically because they're hard to game:

1. **Government/exchange-published data** — trusted not because it's authoritative, but because it's the same number regardless of who's asking. If this is fabricated wholesale, that's a problem outside AV's scope to solve.
2. **AV's own live market-observed data** — exchange inventory, price action, positioning: things AV pulls and persists itself, sourced and traceable by you.

Note these aren't fully independent — AV's DB is partly *built from* government data (FRED, CFTC) — so consistency between them is itself weak evidence, not two unrelated checks. The real second independent anchor is AV's own directly-observed market data (inventory, price).

**Everything ingested from outside these two anchors — news, commentary, social feeds, watchlisted domains — is untrusted input.** It's a source of *claims to test*, never a source of conclusions to adopt. This applies to every current and future CATCOR feature, including later interpretive layers (sentiment scoring, personas): none of them are permitted to be treated as ground truth.

---

## Iteration 1 — Event/Reaction Spine (MVP)
**Goal:** answer "which catalysts actually move silver" with real data, no interpretation layer yet.

- Event calendar table: `event_id, event_name, event_type, scheduled_time, consensus_value, actual_value, surprise_delta, source_url`
- Actual/consensus sourced via **ALFRED** where available (point-in-time vintage — not today's revised numbers) rather than manual entry
- Price snapshot capture at T-30min / T+5min / T+30min / T+2hr, reusing existing metalcharts.org pull; lightweight scheduler (cron/APScheduler) keyed off `scheduled_time`
- `macro_price_reaction` join table: `event_id (FK), metal, price_delta_pct per window, surprise_magnitude`
- Dashboard: scatter (surprise magnitude × price reaction, faceted by event type) + rolling "next scheduled catalysts" table
- No sentiment, no FedWatch, no ingestion, no personas — pure observed-data correlation

**Open questions to close before build:** backfill depth (30/60/90 days), snapshot granularity (does silver need T+1min for fast catalysts).

---

## Iteration 2 — Chat-Based Ingestion (claim extraction & anchor cross-check)
**Goal:** replace the manual "paste article into a chat window" habit with a built-in pane that does the same thing, anchored to AV's own data.

- Chat pane in the CATCOR page, with a persistent base-context wrapper: states the debasement thesis, skepticism posture, and what "supported / contradicted / unverifiable" mean as verdicts
- Manual trigger to start: paste a URL or article text
- Pipeline: extract falsifiable claims from the text → cross-check each claim against AV's own tables (CoT positioning percentile, exchange inventory levels, M2/WALCL trend, market balance) where checkable → verdict per claim, plus a general read on the rest
- Explicitly does not adopt the source's framing or conclusions — only extracts testable claims (see Anchor Points above)
- Output persisted, not just displayed live (see companion re-architecture spec) — so a claim tested today can be revisited later

---

## Iteration 3 — Market Expectations Layer
**Goal:** add "what the market already priced in" alongside "what happened."

- CME FedWatch integration (EOD tier likely sufficient; confirm current pricing before committing — first paid dependency in AV)
- Displayed alongside reaction table: implied-probability shift vs. actual outcome, per FOMC-relevant event
- Decide build-vs-`pyfedwatch` (official API vs. self-computed from futures pricing you already source) here, not earlier

---

## Iteration 4 — Standing Watchlist Automation
**Goal:** extend Iteration 2 from manual paste to a standing, scheduled pull.

- Domain/topic watchlist — persisted with *reasons* attached, not just bare URLs (a decision worth version-tracking, same instinct as a locked rubric)
- Scheduled search/ingest per domain or topic, feeding the same claim-extraction/cross-check pipeline from Iteration 2
- Not a constant poll — pull on a cadence that matches how often the sources actually publish, not a tight loop

---

## Iteration 5 — Sentiment Scoring (single rubric)
**Goal:** stop manually reading Fed speeches; get a consistent hawkish/dovish read.

- Fed communication tagging (speeches, testimony, Beige Book) tied to same snapshot mechanism as Iteration 1
- Scored -5 to +5 hawkish/dovish + one-line rationale, via LLM against a **locked rubric prompt** (version-pinned — edits create a new version, not silent drift)
- Tagged by regional bank, not just date (NY/Chicago/Cleveland/KC/Dallas — treat as competing desks, not a monolith)
- Schema: `(date, source_bank, topic_tag, score, rationale, rubric_version)`

---

## Iteration 6 — Multi-Lens Sentiment
**Goal:** read the same material through different, explicitly-defined trait-based lenses instead of one fixed voice.

- `sentiment_profiles` table: named archetypes defined by trait/influence combinations (not "me," but composable descriptors — institutional skepticism, class position, sector exposure, etc.)
- Same event scored in parallel across profiles, versioned independently
- UI: profile picker/toggle on the sentiment view; compare divergence across profiles on the same event, not just trend one score over time

---

## Iteration 7 — Global Cross-Check
**Goal:** stop treating Fed stance in isolation — debasement is relative, not absolute.

- BIS Data Portal integration (ECB/BOJ comparison)
- SOFR as a real-time "cost of money" companion to FedWatch's directional signal
- Likely just new chart layers on existing views, not new architecture

---

## Iteration 8+ — Speculative / Parked

Deliberately underspecified. Revisit only once the iterations above are proving out.

- **Persona Debate** — archetypal personas argue rather than independently score; output becomes structured disagreement, not a number. Expected to benefit from model capability improvements before attempting.
- **Archive / Memory Layer** — relevance-linking across ingested content over time (an item that meant nothing on ingestion later connects to something new), plus self-grading: log what CATCOR flagged and when, compare against how the underlying data actually moved, and see over time how well its calls held up. A different subsystem from claim-extraction (needs embedding/similarity search over the archive), and depends on Iteration 2/4 ingestion already running long enough to have something to grade.

---

## Dependency Notes
- Iterations 2–7 all attach to the Iteration 1 event/reaction spine, and to persisted local data more broadly — see the companion **persist-on-fetch re-architecture spec**, which CATCOR's cross-check features assume is in place
- Paid/licensed dependencies enter at Iteration 3 (FedWatch) — everything before it is free/reverse-engineered
- Voice-rules framing (no editorializing) applies to AV's *other* panels, built for external users; CATCOR's sentiment and ingestion layers are personal research tooling and aren't bound by the same display constraints — though the Anchor Points principle above is a stricter internal discipline of its own
