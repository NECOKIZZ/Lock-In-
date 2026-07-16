# Proximity Markets — Specification v1.0
**Two markets, two data providers, no cross-mixing.**
Market A (Full-Time Score) runs on **TxOdds/TxLINE World Cup Scores feed**. Market B (Player Performance) runs on **APIfootball**. Each market is settleable entirely from its own provider — if one feed goes down or changes plans, only one market is affected.

---

## 0. Design Principles (read this before the formulas)

1. **"Closeness" is not raw numeric distance.** A guess that gets the winner wrong should basically never beat a guess that gets the winner right — regardless of how far off the scoreline magnitude is. This is enforced structurally below (proven, not assumed — see §1.4).
2. **Big, obvious signals dominate; small signals nudge.** Goals and assists must swing the score far more than a stray key pass. We borrowed FPL's ratio of "big event weight vs. minor event weight" because it's a live-tested balance, not because we're copying FPL's exact data (we can't — FPL has proprietary inputs neither of your feeds expose).
3. **Every formula must be settleable from fields the provider actually documents.** Nothing below references a field that isn't in the inventory tables in §2. If your builder finds a field name doesn't match the live payload, that's a data-mapping bug, not a spec bug — the *shape* of the formula stays the same.
4. **Position matters for players.** A center-back and a striker cannot use the same scoring formula and produce a fair market — this mirrors why FPL scores goals differently by position.

---

## 1. Market A — Full-Time Score Proximity (TxOdds / TxLINE)

### 1.1 What traders guess
Before kickoff (or at any point pre-settlement, per your product's cutoff rules), a trader submits a guessed final score `(home_goals_guess, away_goals_guess)`. Settlement uses the **TxLINE Scores feed's full-time state** for the fixture (the score at whatever phase code your feed marks as full-time/end-of-90 — see §1.6 on ET/penalties).

### 1.2 Data fields used (TxLINE Scores feed only)
| Field (conceptual) | Use |
|---|---|
| Home team score, full time | `ha` (actual home goals) |
| Away team score, full time | `aa` (actual away goals) |
| Match phase / status code | Determines *when* to settle (full-time state reached) and flags postponed/abandoned |

No odds fields, no player fields, no other provider's data goes into this market.

### 1.3 The formula

Split the score into two independent signals instead of comparing raw numbers directly — this is what lets us treat "wrong winner" as categorically worse than "right winner, wrong margin."

```
GD = home_goals - away_goals          (goal difference)
TG = home_goals + away_goals          (total goals)

outcome(GD) = "Home" if GD > 0
              "Away" if GD < 0
              "Draw" if GD = 0

correct = 1 if outcome(GD_guess) == outcome(GD_actual) else 0

ΔGD = min( |GD_guess − GD_actual| , CAP_GD )
ΔTG = min( |TG_guess − TG_actual| , CAP_TG )

CS_home_guess  = 1 if away_goals_guess  = 0 else 0     (guessed home clean sheet)
CS_home_actual = 1 if away_goals_actual = 0 else 0
CS_away_guess  = 1 if home_goals_guess  = 0 else 0     (guessed away clean sheet)
CS_away_actual = 1 if home_goals_actual = 0 else 0

Distance D = (1 − correct) × P
           + W_GD × ΔGD
           + W_TG × ΔTG
           + W_CS × ( |CS_home_guess − CS_home_actual| + |CS_away_guess − CS_away_actual| )

Similarity S = 1 / (1 + D)
```

**Default parameters** (tunable — see §1.7):

| Param | Default | Meaning |
|---|---|---|
| `P` | 4.0 | Flat penalty for guessing the wrong outcome (Home/Draw/Away) |
| `W_GD` | 1.0 | Weight on goal-difference error |
| `W_TG` | 0.5 | Weight on total-goals error |
| `W_CS` | 0.25 | Weight on clean-sheet-call mismatch (each side) |
| `CAP_GD` | 3 | Cap on how much goal-difference error can count |
| `CAP_TG` | 4 | Cap on how much total-goals error can count |

Payout: convert `S` to either **winner-take-all** (lowest `D` in the pool wins) or **pari-mutuel** (each guess's share of the pool ∝ its `S` relative to the sum of all `S` in that fixture's pool). Pari-mutuel is recommended — it rewards *everyone* who was close, not just the single closest guess, which is friendlier for a retail product.

### 1.4 Why the caps exist (the fairness guarantee)

Without `CAP_GD`/`CAP_TG`, a correct-outcome guess with a wild magnitude error (e.g., actual 1-0, guessed 6-1) can score *worse* than a wrong-outcome guess with a small magnitude error (e.g., actual 1-0, guessed 0-0 draw). That's not obviously wrong, but it's a property most traders won't expect: they'll assume "I called the winner" should always beat "I called the wrong winner."

We ran an exhaustive check: for every actual scoreline from 0-0 up to 7-7, and every possible guess from 0-0 up to 9-9, does *any* correct-outcome guess ever score worse (higher `D`) than *any* wrong-outcome guess for that same actual result?

**With the caps in place: no.** The smallest margin by which correct-outcome guesses beat wrong-outcome guesses, across the entire grid, is 0.25 — meaning the property holds with no exceptions found. Without the caps, this property breaks in blowout scenarios. **Recommendation: keep the caps.**

### 1.5 Worked examples (computed, not estimated)

| Actual | Guess | Outcome match? | Distance `D` | Similarity `S` | Note |
|---|---|---|---|---|---|
| 1-1 | 1-1 | — | 0.00 | 1.000 | Exact match |
| 1-1 | 2-2 | yes (Draw) | 1.00 | 0.500 | Right result, wrong scoreline |
| 1-1 | 2-1 | **no** | 5.50 | 0.154 | Called a winner on a draw |
| 1-1 | 1-0 | **no** | 5.75 | 0.148 | Called a winner on a draw + wrongly implied away clean sheet |
| 1-0 | 0-0 | **no** | 5.75 | 0.148 | Called a draw on a narrow win |
| 1-0 | 2-0 | yes (Home) | 1.50 | 0.400 | Right winner, close margin |
| 1-0 | 6-1 | yes (Home) | 5.25 | 0.160 | Right winner, wildly wrong margin — still beats every wrong-outcome row for this actual result |
| 3-0 | 1-0 | yes (Home) | 3.00 | 0.250 | Right shape, low total |
| 3-0 | 1-1 | **no** | 7.75 | 0.114 | Called a draw on a 3-0 |
| 2-1 | 1-2 | **no** | 6.00 | 0.143 | Reversed the scoreline entirely |
| 0-0 | 1-1 | yes (Draw) | 1.50 | 0.400 | Right result, wrong scoreline |
| 2-2 | 3-3 | yes (Draw) | 1.00 | 0.500 | Right result, wrong scoreline |

This confirms the intuition from your original question: for an actual 1-1, a guess of 2-2 (`D=1.00`) clearly beats guesses of 1-0 or 2-1 (`D=5.5–5.75`), even though 2-2 is numerically 2 goals off and the others are only 1 goal off — because the *result* is what matters most.

### 1.6 Edge cases specific to TxOdds/TxLINE
- **Settlement point**: settle on the score at the phase the feed marks as "F" (full-time), not extra-time or penalty-shootout score. If a knockout match goes to ET/penalties, decide up front whether the market settles at 90'/F or waits for the final phase — this is a product decision, not a data limitation (the feed reports phase distinctly).
- **VAR-overturned goals**: if a goal is later disallowed by VAR, use the corrected score after the overturn event, not the initial signal. The feed's VAR event typing (Stands/Overturned) tells you which value is final.
- **Postponed/abandoned matches**: void all guesses, refund stakes. Do not attempt to settle on a partial score.
- **Pre-flight check**: before opening a market on a given fixture, confirm the feed is actively returning score updates for it (TxOdds' own docs note coverage should be verified per fixture, not assumed from the spec).

### 1.7 Tunable parameters for the builder
`P`, `W_GD`, `W_TG`, `W_CS`, `CAP_GD`, `CAP_TG` are all business/product levers, not fixed constants. Raising `P` relative to the caps makes "calling the winner" matter even more; narrowing `CAP_TG` makes high-scoring-game magnitude errors matter less. Whatever values you land on, re-run the exhaustive check in §1.4 to confirm the fairness guarantee still holds before shipping.

---

## 2. Market B — Player Performance Proximity (APIfootball)

### 2.1 What traders guess
Pre-match (per-fixture, per selected player), a trader guesses a single number: that player's final **Performance Score** for the match. Settlement is `|guess − actual|` — no outcome-direction complexity here, because it's one scalar, not a 2D score.

### 2.2 Data fields used (APIfootball only)
| Field (conceptual) | Use |
|---|---|
| Player position (from lineup) | Selects which weight table applies (GK/DEF/MID/FWD) |
| Minutes played | Playing-time points; also gates clean-sheet and pass-accuracy bonuses |
| Goals | Position-weighted goal points |
| Assists | Assist points |
| Team conceded 0 (derived from match score + player on pitch 60'+) | Clean-sheet points |
| Saves (GK) | Save points |
| Penalty saves (GK) | Penalty-save points |
| Goals conceded while on pitch (GK/DEF) | Conceded-goals deduction |
| Penalties missed | Deduction |
| Yellow cards | Deduction |
| Red cards | Deduction |
| Own goals | Deduction |
| Key passes | Small creativity bonus |
| Shots on target (non-goal) | Small attacking bonus |
| Successful dribbles | Small bonus |
| Tackles won | Small bonus |
| Duels won | Small bonus |
| Fouls committed | Small deduction (this is your explicit "negative behavior" weighting) |
| Times dispossessed | Small deduction |
| Pass accuracy % + pass attempts | Flat bonus if both volume and accuracy clear a threshold |

**Confirm before building:** apifootball's per-player stats (`withPlayerStats=1` on `get_events`/`get_statistics`) must actually populate for World Cup fixtures on your specific plan. International-tournament coverage is not guaranteed just because club-league coverage exists — this is a live-key test, not something the docs settle.

### 2.3 The formula

```
Playing-time points:
    0 minutes            → player did not play; VOID this guess (see §2.6)
    1–59 minutes          → 1 point
    60+ minutes           → 2 points

Goal points (position-weighted, mirrors FPL's tested ratio):
    GK/DEF → 6 per goal    MID → 5 per goal    FWD → 4 per goal

Assist points:            3 per assist (all positions)

Clean sheet (only if minutes ≥ 60 AND team conceded 0):
    GK/DEF → 4            MID → 1              FWD → 0

Goalkeeper-only:
    +1 per 3 saves (integer division)
    +5 per penalty save

GK/DEF only:
    −1 per 2 goals conceded while on pitch (integer division)

All positions:
    Penalty missed        −2 each
    Yellow card            −1 each
    Red card               −3 each
    Own goal               −2 each

Minor contribution terms (all positions, same weight — see note below):
    Key pass               +0.25 each
    Shot on target (non-goal) +0.15 each
    Successful dribble     +0.10 each
    Tackle won              +0.10 each
    Duel won                +0.05 each
    Foul committed          −0.15 each
    Dispossessed             −0.10 each

Pass accuracy bonus:
    +1.0 flat IF pass_attempts ≥ 20 AND pass_accuracy ≥ 85%
    (volume floor stops a sub who made 3/3 passes from farming this bonus)

Total = sum of all applicable terms above, rounded to 2 decimals.
```

**Distance & payout**: `D = |guess − actual|`. Similarity `S = 1 / (1 + D)`. Same pari-mutuel-vs-winner-take-all choice as Market A. Consider rounding `actual` to the nearest 0.5 before settlement so guesses aren't chasing unresolvable rounding disputes over a 0.05 discrepancy.

### 2.4 Worked examples (computed)

| Scenario | Position | Key inputs | Score |
|---|---|---|---|
| Star forward, brace + assist | FWD | 90', 2 goals, 1 assist, 4 shots on target, 3 key passes | **15.40** |
| Heroic keeper | GK | 90', clean sheet, 6 saves, 1 penalty save | **13.00** |
| Clean-sheet center-back, quiet game | DEF | 90', clean sheet, 4 tackles, 5 duels won, 1 foul | **7.75** |
| Deep-lying playmaker | MID | 90', 1 assist, 5 key passes, 6 tackles, 1 yellow | **7.10** |
| Impact sub, late goal | FWD | 20', 1 goal, 1 shot on target | **5.15** |
| Anonymous 90 minutes | MID | 90', 1 key pass, 1 duel, no cards | **2.30** |
| Sent-off player | MID | 35', red card, 1 foul | **−2.15** |
| Error-prone defender | DEF | 90', own goal, team concedes 3, 1 yellow | **−2.45** |
| Did not play | FWD | 0' | **VOID** |

This spread is the fairness check: goal contributions clearly dominate (15.4 for a brace+assist vs. 7.75 for a shutout defensive display), a goalkeeper's standout game is competitive with a good attacking midfielder's game (13.0 vs 7.1 — matches real fantasy-football intuition that keepers *can* be premium picks on a good night), and genuinely bad performances (red card, own goal) land clearly negative without being wildly punitive.

### 2.5 Position-weighting rationale
Goal weighting (GK/DEF: 6, MID: 5, FWD: 4) is not arbitrary — it mirrors FPL's own tested ratio, which exists precisely because a defender scoring is rarer and more match-defining than a striker doing their job. Reusing this ratio means you inherit years of real-money balance testing instead of guessing from scratch. Everything *else* (the minor-contribution weights) is new, since it's built from fields FPL doesn't expose and TxOdds doesn't have — those weights are the ones most worth A/B testing once real data comes in.

### 2.6 Edge cases specific to APIfootball
- **Did not play (0 minutes)**: void the guess, refund the stake. Don't settle a 0.
- **Subbed off/on mid-match**: use final match totals for that player regardless of when they entered/exited — minutes played still gates the playing-time tier and clean-sheet eligibility (60' threshold).
- **Position ambiguity**: a player listed as a wing-back or attacking-mid hybrid needs one canonical position source (the lineup endpoint's declared position) — don't let the builder infer position from in-match events.
- **Red card mid-match**: stats accrued before the sending-off still count; nothing after does, since the player's match is over. No special formula change needed — this falls out naturally from using final box-score totals.
- **Data lag / incomplete stats**: if `withPlayerStats` doesn't populate certain fields for a given match, default those specific terms to 0 rather than voiding the whole market, and log it — but this should be rare enough after your pre-flight coverage check that it's an alert-worthy event, not routine handling.

### 2.7 Tunable parameters for the builder
All the "minor contribution" weights (key pass, shot on target, dribble, tackle, duel, foul, dispossessed) and the pass-accuracy bonus threshold are the least battle-tested numbers in this spec — they're a reasonable starting point, not a proven ratio like the goal weights. Expect to revisit these after a few live matches' worth of actual score distributions.

---

## 3. Shared Implementation Notes

- **Guess lock time**: define per-market whether guesses lock at kickoff or allow in-play adjustment. Nothing in either formula assumes pre-match-only; both can support in-play if your product wants that, but in-play changes the UX (traders see events happen before locking).
- **Rounding**: settle both markets' `D` and `S` to a fixed number of decimals (2 recommended) to avoid disputes over floating-point precision.
- **Source of truth**: Market A never reads APIfootball; Market B never reads TxOdds. If a builder is tempted to cross-reference for validation, that's fine internally, but no formula term should *require* the other provider's data — that reintroduces the dependency risk we're deliberately avoiding.
- **Auditability**: log the raw field values pulled from each provider at settlement time, not just the final computed score — you'll want this for dispute resolution and for re-tuning the weights later.

## 4. Settlement Mechanics: Ranking Multiple Guesses (worked leaderboard)

Both `D` and `S` exist to **rank competing guesses against each other**, not just to grade one guess in isolation. Here's that in action.

**Market A — actual result 2-1, five traders guess:**

| Rank | Trader | Guess | `D` | `S` |
|---|---|---|---|---|
| 1 | A | 2-1 | 0.00 | 1.000 |
| 2 | C | 3-1 | 1.50 | 0.400 |
| 3 | B | 2-0 | 1.75 | 0.364 |
| 4 | D | 1-1 | 5.50 | 0.154 |
| 5 | E | 1-2 | 6.00 | 0.143 |

Note B (2-0) ranks *behind* C (3-1) despite both getting the winner right and being "1 goal off" on the surface — B's guess also wrongly implies a home clean sheet, which the `W_CS` term penalizes. Both correctly-called guesses (B, C) still clearly outrank the two wrong-winner guesses (D, E), consistent with the fairness guarantee in §1.4.

**Market B — actual performance score 8.5, five traders guess:**

| Rank | Trader | Guess | `D` | `S` |
|---|---|---|---|---|
| 1 | C | 8.5 | 0.0 | 1.000 |
| 2 | A | 9.0 | 0.5 | 0.667 |
| 3 | B | 6.0 | 2.5 | 0.286 |
| 4 | D | 12.0 | 3.5 | 0.222 |
| 5 | E | 2.0 | 6.5 | 0.133 |

Simple absolute-distance ranking, since a single scalar has no "direction" to get wrong.

**Settlement**: `D` drives the ranking (sort ascending); `S` feeds the actual payout math below. `S` alone is not the whole payout formula — you also need each trader's **stake**, because someone risking $50 and someone risking $5 shouldn't get equal payouts for equal accuracy.

### 4.1 Payout formula (accuracy-weighted, stake-weighted, convex pari-mutuel)

This is the actual mechanism you asked about — the one Trepa runs, not the toy pari-mutuel note from earlier drafts. Trepa's own team has publicly described their mechanism as a **"convex, accuracy-score, time-weighted pari-mutuel funding mechanism"** — they haven't published the exact constants yet (their docs are still forthcoming as of this writing), but the *shape* of the mechanism is confirmed, and it's the same shape you should implement:

```
Pool          = sum of every trader's stake on that fixture/player, minus platform rake (if any)

For each trader i:
    Weight_i  = stake_i × (S_i)^k

    where S_i = 1 / (1 + D_i)   ← same S already defined in §1.3 / §2.3
          k   = convexity exponent (tunable — see below)

Payout_i      = Pool × ( Weight_i / Σ_j Weight_j )
```

`k` is the "convex" part of Trepa's description. It controls how aggressively the pool concentrates toward the most accurate guesses:

- `k = 1`: payout share is directly proportional to stake × accuracy. Gentle — even mediocre guesses keep a meaningful slice.
- `k = 2` or `3`: **convex** — the most accurate guesses take a disproportionately larger share, and mediocre guesses shrink toward losing most of their stake. This is closer to what "convex accuracy-score" implies, and is what makes precision feel worth chasing rather than just directionally-fine.

### 4.2 Worked example with real deposited money

Five traders stake real money on the same Market A fixture (actual result 2-1) from the leaderboard in §4:

| Trader | Guess | Stake | `S` | k=1 payout | k=1 ROI | k=2 payout | k=2 ROI | k=3 payout | k=3 ROI |
|---|---|---|---|---|---|---|---|---|---|
| A | 2-1 (exact) | $50 | 1.000 | $112.92 | 2.26× | $161.12 | 3.22× | $184.33 | 3.69× |
| C | 3-1 | $40 | 0.400 | $36.13 | 0.90× | $20.62 | 0.52× | $9.44 | 0.24× |
| B | 2-0 | $30 | 0.364 | $24.63 | 0.82× | $12.78 | 0.43× | $5.32 | 0.18× |
| D | 1-1 | $20 | 0.154 | $6.95 | 0.35× | $1.52 | 0.08× | $0.27 | 0.01× |
| E | 1-2 | $60 | 0.143 | $19.36 | 0.32× | $3.95 | 0.07× | $0.65 | 0.01× |
| **Pool** | | **$200** | | **$200.00** | | **$200.00** | | **$200.00** | |

Every column sums back to the full $200 pool exactly — that's the pari-mutuel property (payouts are a *redistribution* of the pool, not new money; bad guesses fund good ones). What changes with `k` is how sharply it redistributes: at `k=1` even the worst guess (E, wrong winner) keeps 32% of their stake back; at `k=3` the exact-match trader takes home $184 of the $200 pool from a $50 stake (3.69× return) while everyone else is left with pennies.

**Recommendation**: start at `k=2` for launch — it rewards precision meaningfully without being as punishing as `k=3` on traders who were close-but-not-exact. Treat `k` as a live-tunable dial, same as Trepa presumably arrived at their constants through their own beta testing (their team has said as much — hundreds of testers, thousands of predictions, before mainnet).

### 4.3 The "time-weighted" piece (flagged, not fully specified)

Trepa's own description includes "time-weighted" alongside convex and accuracy-score, but they haven't published what that weighting actually does. The likely intent — locking in a guess further from resolution carries more uncertainty than guessing minutes before kickoff, so an early guess could be worth a small multiplier on its stake or weight. This is a real open design choice for your builder, not something this spec can pin down from public information: decide whether an early guess and a last-minute guess of equal accuracy should be paid equally, or whether early conviction should be rewarded with a small bonus multiplier on `Weight_i`.

### 4.4 Platform rake
Decide up front what percentage (if any) the platform takes off the top of `Pool` before distribution. Trepa's marketing says "no hidden costs, fair fees for every stake" — meaning a fee exists and is disclosed, not that it's zero. This is a business decision, not a formula input.

### 4.5 Stake representation: fixed units, not arbitrary decimals (decided)

Escrow tracks stakes as **N units of a fixed value** (e.g., 1 unit = $10, a trader stakes 5 units = $50), not arbitrary decimal amounts. This is mathematically identical to the formula in §4.1 — `Weight_i = stake_i × Sᵢᵏ` doesn't care whether `stake_i` is a raw decimal or `units × unit_value` — but it buys cleaner integer escrow accounting (no floating-point money bugs) and maps naturally onto a token-ledger-style system, which fits well if your escrow ends up on the same kind of on-chain rails TxOdds already uses for TxLINE. **This is the recommended default for the builder.**

## 5. Future Upgrades (Parked — Not Built Yet)

These are explicitly out of scope for the initial build. Documented here so they aren't lost, not because they're ready to implement.

### 5.1 Time-weighted stake bonus (theorized, unverified)

Trepa's team has publicly flagged "time-weighted" as part of their mechanism without publishing the mechanics. A locked escrow does **not** block this — the lock only restricts custody (a trader can't withdraw or change a stake after committing), not what the settlement math later does with the timestamp recorded at deposit time. A candidate formula, offered as a starting hypothesis rather than a verified copy of Trepa's approach:

```
T_i = 1 + λ × (1 − t_i / t_lock)

t_i     = time elapsed from market open to this trader's stake
t_lock  = total window from market open to lock (e.g., kickoff)
λ       = time-weight strength, tunable (e.g. 0.3–0.5 → up to 30–50% bonus for staking at market open)

Weight_i = stake_i × (S_i)^k × T_i     (replaces the Weight_i formula in §4.1)
```

Rewards conviction staked under more uncertainty (before lineups, injury news, or in-play events narrow the outcome space) relative to a stake placed moments before lock. Needs simulation against real guess-timing distributions before it's trustworthy — don't ship this without testing it the way §1.4's fairness guarantee was tested.

### 5.2 Order books

Parked. A future alternative (or complement) to the pari-mutuel pool model: let traders post/take specific prices on outcomes rather than all staking into one shared pool. This is a materially different market structure (continuous liquidity vs. discrete pool-and-settle) and should be scoped as its own spec when the pari-mutuel version has live data to justify the added complexity.

## 6. Open Decisions for You / the Builder

1. Winner-take-all vs. pari-mutuel payout (recommend pari-mutuel).
2. ET/penalties handling for Market A on knockout-stage matches.
3. In-play vs. pre-match-only guess locking, for both markets.
4. Confirm `withPlayerStats` actually returns World Cup data on your apifootball plan before building Market B at all — this is the single biggest open risk in this spec.
5. Whether to revisit the "minor contribution" weights in Market B after seeing real match data (recommended after ~10–20 live matches).
6. The convexity exponent `k` in the payout formula (§4.1) — recommend starting at 2, then tune from real pool behavior.
7. Whether to implement a time-weighting bonus for early guesses (§4.3) — Trepa has flagged this as part of their model but hasn't published specifics; it's a genuine open design call.
8. Platform rake percentage on the pool (§4.4).
