# Player Perps — Trepa-Model Extensions (v1.0)

Answers to: accumulator, time-based entry/exit, order book, and other features worth stealing from Trepa now that a match is 90 minutes, not 60 seconds. Builds on `player-perps-trepa-payout-model.md` — nothing here changes the core settlement engine already shipped.

---

## 1. Accumulator / Streak pool — port it, it fits your season product better than it fits Trepa

Trepa funds a jackpot from half of its 20% platform take, paid out to anyone who strings together qualifying rounds of accuracy. Direct port:

**Precision Score:** `PS_i = max(100, 1000 × exp(−λ × D_i))`, where `λ = ln(2) / D_typical` and `D_typical` = the historical average `D` for that market type. One simplification versus Trepa: they need a log-price transform because BTC's price scale drifts ($40k vs $140k); your `D` is already bounded and scale-stable by construction (the `capGD`/`capTG` caps), so the raw-`D` exponential works directly — no log-return step needed.

Worked check, `D_typical = 2.0` → `λ = 0.3466`: a guess landing `D=0.5` scores `PS ≈ 841` (qualifies). A guess landing exactly at `D_typical=2.0` scores `PS ≈ 500` (one "typical miss" = half credit, same shape as Trepa's own reference table).

**Streak:** define qualifying as `PS > 700`, gameweek cadence (not per-round — your matches don't come every 60 seconds, so tie it to GW like your FPL-style product already implies). N consecutive qualifying gameweeks completes a streak.

**Payout:** half the accumulator pool splits among everyone completing a streak simultaneously that gameweek; the other half rolls forward. Funded from half of the existing 20% take on losers (no new fee needed — you already collect it).

This is a better fit for your season-long product than for single-match settlement — it gives people a reason to keep playing in weeks they lose the round payout.

## 2. CAR leaderboard (geometric mean of weekly PS) — port it, season-only

Trepa's Consistency-Adjusted Rating punishes one disaster week harder than it rewards one brilliant one (geometric mean does that automatically). Gate a season-end bonus pool on top-N CAR. Zero interaction with per-match payout — pure leaderboard layer, cheap to add, no new financial risk.

## 3. Crowd Signal — port it, display-only

Live-updating "consensus guess," weighted by each contributor's CAR/track record, shown during the entry window. No settlement math involved — it's a trust/FOMO display feature ("smart money says 2-1"), and it's free: you already have the weighting inputs (CAR) once #2 exists.

---

## 4. Time-based entry/exit — two different questions, two different answers

**Payout-weighting by entry time (pay early stakers more)** — still no, same verdict as before. No backing found, Trepa hasn't shipped it either, and it rewards a stale early guess over someone who correctly reacted to real information (a lineup or injury announcement). That verdict doesn't change.

**Structuring when you can enter or exit as separate windows/markets** — yes, this is just product design, not a fairness violation, and it's exactly the right answer to "90 minutes is a long time." Three tiers, increasing cost and complexity:

### Tier 1 — Checkpoint cash-out (ship this first — zero new settlement math)

At any checkpoint (e.g. halftime), run the *exact same Trepa engine you already built*, feeding it the current in-match score as a stand-in "actual." That gives a live projected winner/loser split and live gains. Quote the trader a cash-out offer at a haircut off that live number:

- Projected winner: `cashout_i = stake_i + haircut_win × gain_live_i` (haircut_win ≈ 0.65)
- Projected loser: `cashout_i = haircut_lose × stake_i` (haircut_lose ≈ 0.30)

**Worked example** — same 5 traders, same guesses, actual result ends 2-1, but at halftime the live score is 1-0:

Live `D`: A=1.25, B=1.50, C=2.75, D=5.75, E=7.25 → live median `m=2.75` → **live winners: A, B** (not A, C — the full-time winners). This is the whole point: standings shift mid-match.

| Trader | Live gain | Cash-out quote | What actually happens if they stay to full-time |
|---|---|---|---|
| A | $56.63 | **$86.81** | Full-time winner anyway → $135.91 |
| B | $39.37 | **$55.59** | Full-time **loser** → $0 |
| C | — | **$12.00** | Full-time winner → $42.09 |
| D | — | **$6.00** | Full-time loser → $0 |
| E | — | **$18.00** | Full-time loser → $0 |

This is the honest picture, not a sales pitch: B and (D, E) come out ahead by cashing out early — B especially, since they were about to lose everything. C comes out behind by cashing out (they'd have won $42.09). That's what an insurance product is supposed to look like: it protects against the bad outcome, it doesn't guarantee you beat staying in.

**Where the money comes from:** don't fund this from platform capital/balance sheet. Instead, when a trader cashes out, remove their stake from the pool entirely and drop them from the final settlement (as if they never entered). The haircut is what pays for the liquidity — it stays with the remaining pool rather than going to the platform. Real tradeoff to name explicitly: a cashed-out *loser*'s stake no longer funds the eventual winners' dividend pool, so allowing loser cash-outs slightly shrinks winner upside at the margin. That's the actual price of making the product less brutal — a platform-take-funded top-up is an option if you want to fully neutralize it, but the honest default is: winners get very slightly less, in exchange for losers not being fully wiped out who chose to exit early.

### Tier 2 — Parallel live market (no new settlement math, no order book)

Instead of letting someone exit a position, open a second, independent Trepa-engine market for the same fixture that starts at kickoff and locks at some later point (e.g. 70th minute). Someone who wants to "get out" of a bad pre-match guess can instead take an offsetting position in the live market with better information — same effect as Pennock's "hedge-sell" (buy the opposite side), just achieved with two independent pools instead of one order book. Reuses your existing engine twice, no new formulas, ships fast.

### Tier 3 — Order book / position resale (real, plausible, but v2 — here's the actual architecture)

Yes, this is buildable, and there's real precedent (Pennock's Dynamic Pari-Mutuel Market, implemented by 9Lives — see the previous doc's research section). Concretely:

1. **Tokenize each position.** A stake isn't a database row, it's a transferable receipt: `{fixture_id, market, guess, units, timestamp}`. This fits the fixed-unit ledger you already decided on for accounting (spec §4.5), and it's a natural fit for your existing Circle/Arc/Solana rails — resale becomes "transfer the token," not "invent a new position object."
2. **Matching engine.** Standard price-time-priority limit order book (bid/ask on the token). This part is well-trodden — you don't need to design new mechanism theory here, just implement a CLOB.
3. **The hard part — pricing.** Nobody knows a position's true value mid-match (final pool composition isn't locked yet). Solve it by using **Tier 1's live-engine output as the reference/floor price** the order book quotes against — buyers and sellers negotiate around that number instead of pricing from scratch. This is exactly what makes Tier 3 buildable at all: you're not solving a new pricing problem, you're wrapping Tier 1's number in a marketplace.
4. **Trade suspension around match events.** Goals, red cards, and injuries instantly and dramatically move everyone's `D`. In-play sports betting exchanges universally suspend markets for ~10–20 seconds after a goal for exactly this reason — do the same here, or the order book becomes a free-money exploit for whoever has the fastest data feed.

**Recommendation:** ship Tier 1 first — it's your actual "early exit" feature, fully spec'd, reuses code you already have. Add Tier 2 if people want to hedge with information rather than just cash out. Build Tier 3 only once you have enough simultaneous traders per fixture for a peer order book to have real liquidity — before that, it's a marketplace with no one in it.

---

## 5. A few more, quick

- **Dynamic γ ramp:** launch with a gentler accuracy exponent (γ≈3) so early users don't get wiped by the full Trepa harshness while you're building trust, then dial toward γ=6 once retention data supports it. Product judgement, not research — no claim of backing here, just sequencing.
- **.arc identity on the leaderboard:** since you're already building DotArc, tie CAR/leaderboard display to `.arc` names instead of wallet hex. Free cross-project synergy.
- **XP / referral tiers:** Trepa has both, straightforward direct ports, don't touch settlement math at all — cheap wins if you want more surface area.
- **Coalition moments as a share hook:** the best-coalition tie exception is rare and a little dramatic when it fires (three people landing the exact same score) — worth a "moment" card people can share, since it's inherently a good story and costs nothing extra to detect (you already compute it).

---

## 6. What to actually build before the 17th/19th

Nothing in this document. Same discipline as before: ship the core Trepa-mapped payout engine (already built and tested). Of everything here, **Tier 1 cash-out is the only one worth prioritizing post-deadline** — it's the cheapest to build (zero new settlement math, reuses the exact engine you have), and it's the one that most directly answers "90 minutes is a long time, people will want out." Everything else in this doc is real, but it's roadmap, not sprint.
