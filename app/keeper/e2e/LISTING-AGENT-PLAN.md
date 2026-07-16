# Market-Listing Agent — Plan (NOT built yet)

Goal: an agent that lists fixtures on Player Perps **only if they are 100% verifiable
on-chain via TxLine**. It must be impossible for it to open a market we can't settle
trustlessly.

## Discovery pipeline (all endpoints proven live on devnet, 2026-07-14)

1. **Discover** — `GET /fixtures/snapshot?competitionId=72&startEpochDay=<today>`
   Returns upcoming fixtures with: `FixtureId`, `Participant1/2` (+ids), `StartTime` (ms),
   `Competition(Id)`, `GameState`, `Participant1IsHome`. Proven: returned France–Spain
   (18237038, KO 2026-07-14T19:00Z) and England–Argentina (18241006) on devnet.
   No filter → all competitions (devnet: World Cup 72 + Friendlies 430).

2. **Verifiability gates — a fixture is listable ONLY if ALL pass:**
   - **G1 Feed live**: `/scores/snapshot/{FixtureId}` returns records (proven: 6 recs for FRA-ESP).
     Guards against fixtures TxLine knows about but doesn't cover with score data.
   - **G2 Oracle root exists**: `daily_scores_roots` PDA for the *current* epoch day exists
     on-chain (proven: day 20648 EXISTS, 9232B). For future KO days the root doesn't exist
     yet (proven: 20649 absent) → **G2 is checked at kickoff-day, not at listing time**;
     listing requires only G1 + G3 + a root-history heuristic (roots have existed for the
     past N days ⇒ publisher is alive).
   - **G3 Sport/keys**: SportId is soccer (statKeys 1/2 = total goals exist for it).
     Only list sports whose stat-key mapping we've implemented.
   - **G4 Timing**: `StartTime` far enough out (> X min) to give stakers a window;
     GameState == scheduled (1).

3. **List** — for each fixture passing gates: keeper calls `initialize_fixture(FixtureId,
   lock_time = StartTime, params)` — lock_time IS the kickoff from the feed, so staking
   closes exactly at KO. Then write/append the UI market registry (fixtures.json served
   next to config.js: id, teams, KO, competition, PDA) — app.html reads it instead of the
   single hardcoded fixture.

4. **Monitor loop** (same agent, cron): for each open fixture:
   - at KO: call `lock_fixture`
   - poll `/scores/updates` (or SSE) for `game_finalised` → fetch stat-validation-v3 →
     `validate_score` (CPI-proven) → `submit_settlement`
   - **G2 recheck at settlement**: if the daily root PDA for the finalised record's day
     never appears within T hours → leave Locked, alert; VOID path only by explicit
     operator action (program has Void status).

## Safety invariants (why it can't list junk)
- The program itself re-verifies everything: even if the agent lists a bad fixture,
  `validate_score` rejects any score that doesn't Merkle-prove against the on-chain root
  (require! fixture_id match + period==100 + CPI true). Worst case for a bad listing is
  a market that can never settle → refund/void path, never a wrong payout.
- Agent never holds user funds; it only signs `initialize_fixture`/`lock`/settlement.

## Network split
- devnet: competitionId=72 sample WC fixtures (the ones discovered above) — full rehearsal.
- mainnet: same code, TXLINE_MAINNET=1 (mainnet txoracle 9Exb…cKaA), real WC fixtures,
  re-measure proof tx size (devnet 632B; mainnet trees deeper).

## Open questions before build
- SSE vs polling for finalisation (SSE proven to exist: /scores/stream; polling simpler on cron).
- Where fixtures.json lives once UI is hosted (static file next to page vs tiny API).
- Refund/void UX for markets whose oracle data dies mid-match.

## Probes to reuse (in /tmp/tx-on-chain/examples/devnet/scripts/)
- probe-fixtures.ts — discovery shape
- probe-fixtures2.ts — the three gates, live-verified
