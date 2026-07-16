# Season Leaderboard — Design Plan (NOT built; build after Market A is stable)

Status: **planning only.** Nothing here blocks the live pipeline (lister →
monitor → settle). The design is written so we can bolt it on without touching
the settled-market math.

## 0. The idea as proposed

> Over a 38-game Premier League season, rank users by an aggregate
> distance/similarity score that grows with prediction accuracy. Take 5% from
> the loser pool per match into a season bonus account. At season end the top
> 5–10 leaderboard players share the bonus.

Verdict: **the shape is right** — accuracy-based ranking + a season-long bonus
pool funded from settlement flow is a strong retention mechanic and it
composes cleanly with the Trepa engine (every input it needs is already public
on-chain). But three parts need adjusting, argued below.

## 1. Ranking: what to rank on (volume vs precision — the argument)

**Pure volume — reject.** Ranks whales, not skill; trivially wash-traded
(stake both sides of every market from two wallets you own).

**Pure precision (e.g. average D) — reject.** Two fatal flaws:
- *Farmable*: bet $1 on 40 matches, get lucky on a few, top the board while
  contributing nothing to the pools that fund the bonus.
- *Not comparable across matches*: a D of 1.75 in a chaotic 4–3 game is a
  better prediction than D 1.75 in a 1–0 game. Raw D isn't normalized.

**Recommended: stake-weighted, field-relative accuracy points.** Per settled
match, per position:

```
percentile_i = (# stakers with D_j > D_i) / (N - 1)          // beat-the-field, 0..1
points_i     = percentile_i^2 × min(stake_i, STAKE_CAP)      // skill × skin-in-the-game
season_score = Σ points over the season
```

Why each term:
- **percentile, not raw D** — self-normalizing per match. Beating 90% of a
  50-player field says the same thing in any scoreline. It also reuses the
  median-gate philosophy: you're scored against the field, not an absolute.
- **squared** — makes the top of the field worth disproportionately more, so
  grinding mid-field finishes doesn't beat genuinely sharp predictions.
- **× stake, capped** — ties points to real risk (kills the $1-farmer), while
  the cap (e.g. $100/match) stops whales from simply buying the leaderboard.
  Between min-stake and cap, skill dominates.
- Sybil note: splitting one bankroll across 10 wallets does **not** help —
  points scale ~linearly with stake below the cap, and each split wallet
  faces the same field. The only sybil win is claiming multiple top-K slots,
  mitigated by making bonus shares score-weighted (below) rather than flat.

Track **matches_played** too and require a minimum (e.g. 20 of 38) for bonus
eligibility, so nobody snipes the board in the last 3 fixtures.

## 2. Funding: where the 5% comes from (the argument)

Proposed: "take 5% from the loser pool **and** put 5% into the leaderboard" —
i.e. 10% total extraction on top of nothing else? Current engine already takes
`take_rate_bps` (platform cut) from loser stakes. Two options:

- **(a) Additional 5% from losers** → total extraction rises; winners' gains
  shrink is avoided (it comes from losers) but losing gets 5% worse, and our
  headline "losers fund winners" pitch dilutes.
- **(b) Split the existing platform take** — e.g. platform keeps its cut but
  50% of it (or a new `season_bps` slice) routes to the season pool.
  Extraction unchanged, marketing win ("half the house edge goes back to the
  best players"), zero change to staker EV.

**Recommendation: (b) at launch** — route a configurable `season_bps` slice of
the *existing* platform cut to the season pool.

In plain terms: today, when a market settles, losers' money goes to winners
minus a small house fee (say $10). Option (a) skims an *extra* 5% from losers
on top of that fee — losing gets worse, and the pitch dilutes to "losers fund
winners, the house, *and* a bonus jar." Option (b) takes the $10 the house was
already keeping and splits it — house keeps $5, season prize fund gets $5.
Nothing changes for any player: winning pays the same, losing costs the same;
the prize fund is fed from money that was already leaving the pot. And it's a
better headline: *"half the house edge goes back to the best players."* If the
fund later proves too small, moving to (a) is a one-number parameter change,
not a redesign.

Mechanically it's one added field in `PayoutParams` and one extra term in the
conservation check:

```
Σ payouts + platform_cut + season_cut == total_pool     // still exact, still enforced
```

(The engine's dust-absorption trick still works: derive `platform_cut` last
so it absorbs rounding, keep `season_cut` a clean floor-division.)

## 3. Payout: how the top-K share (the argument)

Flat "top 10 split equally" invites #10-vs-#11 grief and sybil slot-stuffing.
**Score-weighted share among top K** is fairer and sybil-resistant:

```
share_i = points_i / Σ points_topK        (K = 10, min 20 matches played)
```

Optionally floor #1's share (e.g. ≥25%) to keep a headline prize. Payout is a
one-time keeper-driven distribution at season end, same trustless-by-audit
pattern as settlement: anyone can recompute every share from public
StakePositions.

## 4. Architecture: how it bolts on (phased)

The beauty of the current design: **every input the leaderboard needs is
already on-chain and permanent.** Every StakePosition keeps `guess`, `stake`,
`distance_d`, `is_winner`, `payout_amount` after settlement, keyed by staker
pubkey. So:

**Phase L0 — off-chain leaderboard, zero program changes (demo-ready, ~a day).**
Keeper script walks all settled fixtures' StakePositions, computes
percentile²×stake points, writes `app/ui/leaderboard.json` next to
`fixtures.json`; UI gets a leaderboard page/panel. Fully recomputable by
anyone → trustless-by-audit even though it's off-chain. **This is the one to
build first** — it proves the ranking feels right before any on-chain risk.

**Phase L1 — on-chain season pool (small program change).**
- `Season` PDA: `{season_id, start/end ts, season_bps, pool_vault(ATA), status}`.
- `submit_settlement` / pipeline: split `season_cut` from the platform cut,
  transfer to the season vault. Conservation check gains one term.
- Leaderboard itself stays off-chain (L0 script), but the *money* is already
  escrowed on-chain — users can verify the bonus pool balance live.

**Phase L2 — on-chain scores + distribution (full trustlessness).**
- `PlayerSeason` PDA per (wallet, season): `{points, matches_played}`.
- New instruction `accumulate_season_points(fixture)` — permissionless, runs
  after settlement, recomputes each position's percentile on-chain (the
  distances are already stored — it's a read + compare pass, batchable like
  the pipeline) and adds points. Program-verified, keeper just cranks it.
- `distribute_season(entries[])` — keeper submits top-K shares; program
  re-verifies Σshares == pool and each claimed score against PlayerSeason
  PDAs. Same fast-path pattern as `submit_settlement`.

**What defines "a season"?** For WC-2026 demo: the tournament itself is the
season (64 matches — great fit). For PL: `Season` PDA per competition id;
lister already knows `CompetitionId` from the feed, so fixtures self-assign.

## 5. Risks / open questions

- **Small fields**: percentile is noisy with N=3 stakers. Weight match points
  by `log2(N)` or require N ≥ some floor for points to count.
- **Abandoned/void matches**: no points, no season cut (pool refunds fully) —
  falls out naturally since Void skips settlement.
- **Same-wallet multiple markets/day**: fine — points cap per match, not per day.
- **Tax on transparency**: season_bps must be in `initialize_fixture` params
  (immutable per fixture) so the cut can't be changed retroactively.
- **Claim UX**: winners claim bonus like payouts (`claim_season_bonus`), no
  push transfers — consistent with the existing claim pattern.

## 6. Sequencing (don't build yet)

1. **Now**: nothing. Lister/monitor/proof/docs are the hackathon story.
2. **L0** right after (1 keeper script + 1 UI panel) — visible leaderboard,
   zero risk, great demo slide #2.
3. **L1** when there's real staking volume to fund a pool.
4. **L2** only if/when "trustless season bonus" becomes a selling point worth
   the program-upgrade risk.
