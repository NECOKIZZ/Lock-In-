# Player Perps — Trepa-Mapped Payout Model (v1.0)

Replaces the convex stake-weighted pari-mutuel payout in `proximity-markets-spec.md §4.1` with Trepa's confirmed median-rule + accuracy-weight mechanism. `D` and `S` (§1.3/§2.3) are untouched — this only changes how `D` gets turned into money.

---

## 1. The mapping

| Trepa (BTC Flash Pool) | Player Perps | Notes |
|---|---|---|
| `e_i = \|x_i − y\|` (raw price error) | `D_i` (your existing distance score, Market A or B) | `D` already *is* an error metric — wrong-winner penalty + magnitude, or `\|guess−actual\|`. Same role, drop-in swap. |
| `m` = median error | `m` = median `D` in the pool | Same `k = ⌊(N+1)/2⌋` rule. |
| Win condition `e_i < m` | Win condition `D_i < m` | Strict inequality, identical. |
| `r_i = e_i/m` | `r_i = D_i/m` | Scale-invariant ratio — works regardless of whether `D` is a football-scoreline distance or a BTC dollar error. |
| `a_i = (1/(1+r_i))^6` | same | γ=6 is Trepa's confirmed live value, not a guess. |
| Dividend pool = losers' stakes − 20% take | same | 20% is Trepa's confirmed number; treat as a tunable default. |
| 100× cap + water-filling | same | Rarely binds at your likely pool sizes — see §4. |

**The identity that answers "how do I match D/S to Trepa":** your existing `S_i = 1/(1+D_i)` and Trepa's accuracy weight are the *same function*, just evaluated on a different input:

```
S_i  = 1 / (1 + D_i)        ← your existing similarity score (ranking/display)
a_i  = (1 / (1 + D_i/m))^6  = (m / (m + D_i))^6
```

`a_i` is `S` recomputed with `D` normalized by the field's median error instead of raw, then raised to the 6th power. Keep `S_i` exactly as-is for leaderboards/UI ranking (§4 of the spec already uses it that way). Use `a_i` only for the payout math. They will rank traders identically (both are monotonically decreasing in `D`) — they just pay out very differently.

**Why this transplant is valid:** Trepa's win-gate and accuracy-weight formulas don't reference BTC, dollars, or 60-second rounds anywhere in their math — they operate purely on `e_i` and `m`, both of which are just "error" and "median error" in whatever units the game defines. Your `D` already plays that role. Nothing about the formula requires it to come from a price feed.

---

## 2. Full mechanism, ported step-by-step

For one settling market (one Market-A fixture, or one Market-B player-fixture):

1. **Void checks** (carry over verbatim): `N ≤ 1` → void, refund all. Every trader has identical `D` → void, refund all.
2. **Best-coalition check** (carry over verbatim): let `minD` = the lowest `D` in the field. If the count of traders at `minD` is `≥ N/2`, they all win as a coalition (skip to step 4 using only that group as winners).
3. **Otherwise**, compute `m` (k-th smallest `D`, `k = ⌊(N+1)/2⌋`). Winners = `D_i < m`. Losers = everyone else.
4. **Accuracy weight**: for each winner, `r_i = D_i/m`, `a_i = (1/(1+r_i))^6`.
5. **Pool**: `losers' stakes × (1 − take_rate)`, `take_rate` default 20% (Trepa's number, tunable).
6. **Cap + water-filling**: `cap_i = stake_i × 100`. Distribute the pool proportional to `a_i`; anyone whose naive share exceeds their cap gets capped, and the excess cascades to the remaining uncapped winners — repeat until every dollar is placed or every winner is capped.
7. **Payout**: `stake_i + gain_i` for winners, `0` for losers.

**One edge case Trepa's docs don't cover, worth deciding now:** if the pool is large relative to the number of winners, water-filling can cap *every* winner and still have money left over (only happens with very few winners and a lopsided pool — unlikely at your scale, but it's a real code path, not hypothetical). Decision needed: does the residual roll to the platform take, or fund a future-round reserve? Recommend platform take by default, but log it separately from the normal 20% cut so it's auditable.

---

## 3. Worked example (uses your simulator's own default pool, so you can check it by hand)

Actual: 2-1. Five traders, same stakes as the spec's §4.2 example:

| Trader | Guess | `D` | Stake |
|---|---|---|---|
| A | 2-1 | 0.00 | $50 |
| C | 3-1 | 1.50 | $40 |
| B | 2-0 | 1.75 | $30 |
| D | 1-1 | 5.50 | $20 |
| E | 1-2 | 6.00 | $60 |

`N=5`, `k=3` → sorted `D` = [0.00, 1.50, **1.75**, 5.50, 6.00] → `m = 1.75`. `minD=0.00`, only 1 trader at it (1 < 2.5) → no coalition, normal cut applies.

**Winners** (`D < 1.75`): A, C. **Losers** (`D ≥ 1.75`): B, D, E.

- `r_A = 0/1.75 = 0` → `a_A = 1.000`
- `r_C = 1.50/1.75 = 0.857` → `a_C = (7/13)^6 ≈ 0.0244`

Losers' stakes = $30+$20+$60 = $110. 20% take = $22. Dividend pool = **$88**.

`Σa = 1.0244` → `α = 88/1.0244 ≈ 85.90`.

| Trader | Gain | Payout | ROI |
|---|---|---|---|
| A | $85.91 | **$135.91** | 2.72× |
| C | $2.09 | **$42.09** | 1.05× |
| B | — | **$0** | −100% |
| D | — | **$0** | −100% |
| E | — | **$0** | −100% |

Check: $135.91 + $42.09 = $178.00 = $200 stake − $22 platform take. ✓ Conservation holds.

**Contrast with the old model (k=2, same inputs):** old payouts were A $161.12, C $20.62, B $12.78, D $1.52, E $3.95 — every trader kept *something*. Under Trepa's rule, B/D/E now go to **exactly $0**. This is the material behavior change you're signing up for, laid out plainly in §5.

---

## 4. What actually changes for your users vs. the current spec

The old model (stake × Sᵏ pari-mutuel across everyone) is a **continuous** redistribution — bad guesses shrink but never fully zero out. Trepa's model is a **binary gate**: clear the median or lose your entire stake, no partial credit. Roughly half the field loses 100% of their stake every settlement, by construction ("this produces a natural ~50% win rate before anyone's individual skill is considered" — straight from Trepa's own docs).

This is worth saying plainly since you flagged not wanting people to lose money: Trepa's mechanism is **more punishing**, not less, than what you already had. That's not a reason to reject it — the median-gate + steep accuracy-weight design is exactly what makes precision worth chasing rather than just "being in the room," and it's a real, live, working mechanism — but it changes who's exposed to full downside, and your UI/copy should say this explicitly before someone stakes (e.g., "you win your stake back only if you beat the field median — otherwise you lose it all," not soft-pedaled as "smaller payout for less accurate guesses").

---

## 5. Market B (player performance) — same engine, no changes needed

`D = |guess − actual|` is already a scalar error term, so it drops into the exact same pipeline: rank, find median `D`, gate at the median, accuracy-weight the winners, cap, water-fill. No formula changes required for Market B — it's the same settlement function with a different `D` calculator feeding it. Verified against the spec's own §4 leaderboard example (actual 8.5, traders at D = 0/0.5/2.5/3.5/6.5): `m=2.5`, winners = C(0), A(0.5), same structural pattern as Market A.

**A genuinely useful side-benefit for your FPL-style season product**: Trepa's *second* layer — Precision Score (log-error based, independent of win/loss) feeding a geometric-mean leaderboard (CAR) — maps naturally onto season-long consistency scoring, which is a different problem than round-by-round payout. Worth keeping in your back pocket for the full-season product, since geometric-mean CAR explicitly punishes one disastrous gameweek harder than it rewards one brilliant one — which is a defensible design for a season-long leaderboard even if you don't touch it before the 17th/19th.

---

## 6. Liquidity pool vs. time-decay — what the research actually supports

You asked me to check backing before you build either. Here's what's real, not what sounds plausible.

### Secondary market / sell-your-position: real, peer-reviewed, implemented elsewhere — but not a free lunch

This is a documented mechanism design problem with a name: the **Dynamic Pari-Mutuel Market (DPM)**, introduced by David Pennock (Yahoo! Research, 2004). <cite index="1-1">A DPM acts as a hybrid between a pari-mutuel market and a continuous double auction, offering infinite buy-in liquidity like a pari-mutuel market while allowing traders to lock in gains or limit losses by selling prior to event resolution like a continuous double auction.</cite> It's not just theory — <cite index="8-1">the 9Lives prediction market protocol explicitly built a DPM combining pari-mutuel betting with a continuous double auction, citing Pennock's paper directly, specifically to let participants sell their shares before the outcome settles.</cite>

The important caveat, straight from the source paper: <cite index="4-1">while there is always a market maker willing to accept buy orders, there is no guaranteed liquidity for selling — instead, selling is accomplished via a standard continuous-double-auction mechanism, and traders can always "hedge-sell" by purchasing the opposite outcome to net out their exposure.</cite>

That last part is the catch for you specifically: "hedge-selling" (buy the opposite side to flatten your position) works cleanly for **binary** markets (A vs. B). Your Market A guess space is a full scoreline grid (0-0 through anything), and Market B is a continuous scalar — neither has a clean "opposite" to buy. To actually build this you'd need one of:
- An **order book** matching your position against someone else's opposing view (real liquidity risk — no guarantee anyone's on the other side of your specific guess).
- A **synthetic exit price**, computed from live match state + your current accuracy-weight standing, that the platform itself quotes you (this is a mini pricing-oracle problem in its own right, not a formula you already have).

**Verdict: real backing, genuinely reduces trader risk (which is your stated goal), but nontrivial to build for continuous/multi-outcome markets like yours** — it's a bigger lift than it sounds, and the literature's clean version assumes binary outcomes you don't have.

### Time-decay for early entry / late exit: no real backing found, and Trepa hasn't shipped it either

Two things work against this one:

1. Trepa's own team has *mentioned* "time-weighted" as part of their mechanism, but — per the deep-dive report you supplied (§4.3, §14) — they haven't published what it does. You told me to use what's confirmed and works; this specifically isn't that. It's a roadmap mention, not a shipped mechanic.
2. The closest empirical evidence I found points the other way. A study of real forecasting-tournament prediction markets found that <cite index="10-1">trading tends to be front-loaded, with 65% of total error reduction happening in the first hour and 90% within the first week, after which the average error fluctuates without consistently improving — indicating that late trades tend to be noisy rather than informative — and applying a time-weighting scheme to smooth out post-week-one trades did not produce a significant increase in accuracy.</cite> If anything, that's evidence for down-weighting stale aggregation, not for paying early stakers a bonus.

There's also a structural fairness problem specific to football: a time-decay bonus rewards an *early, possibly stale* guess over a *late, well-informed* one — e.g., someone who reacts correctly to a starting-lineup or injury announcement 20 minutes before kickoff should arguably be worth *more*, not less, than someone who locked in a guess three days earlier with less information. That runs directly against your spec's own founding principle (§0.1): closeness to truth is what should win, not when you committed.

**Verdict: no backing found, actively works against your own design principle, and your own spec (§5.1) already flags it as "needs simulation... don't ship this without testing" — treat that as still true.**

### Recommendation

Build the secondary-market/exit feature when you have real capacity for it (it has genuine research and production precedent, and it's the one that reduces — not adds to — trader losses, which is what you said you cared about). Shelve time-decay indefinitely; nothing here justifies it over just leaving it out. **Neither belongs in the July 17 or July 19 builds** — ship the Trepa-mapped payout core first, since that's the part with a confirmed, working reference implementation behind it. Document the secondary market as a v2 item the same way your spec already parks order books in §5.2.

---

## 7. Open decisions carried forward

1. Platform take rate: 20% default (Trepa's number), tunable.
2. Cap multiple: 100× default (Trepa's number) — will essentially never bind at hackathon-scale pools; confirm you're fine with that or lower it for smaller test pools so the mechanic is visibly demonstrable.
3. Residual-after-full-cap edge case (§2, step 6) — decide where it rolls.
4. Whether to expose the win/lose median gate prominently in the UI *before* stake confirmation (recommended, given §4's fairness point).
5. Secondary-market and time-decay: both explicitly out of scope for now, per §6.
