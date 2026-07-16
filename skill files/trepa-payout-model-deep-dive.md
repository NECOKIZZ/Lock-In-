# Trepa Payout Model — Deep-Dive Research Report

*Compiled from Trepa's official developer documentation (docs.trepa.io), July 2026.*

---

## 0. Executive Summary

Trepa is a Solana-based "Flash Pool" game where players predict where BTC's price will land 60 seconds out. It is **not** a binary yes/no market. The payout model has two layers that are easy to conflate but are functionally separate:

1. **Round payouts** — real money, paid every 60 seconds, driven entirely by how close your price estimate was *relative to the other players in that specific round*.
2. **Precision Score / Streaks / Leaderboards** — a skill-rating layer, driven by how close your estimate was *in absolute terms*, which does not directly pay you but unlocks a separate "accumulator" jackpot and leaderboard status.

The proximity mechanic you asked about lives almost entirely in layer 1, specifically in a formula called **Accuracy Weight**, which is deliberately steep (an exponent of 6) so that being modestly closer than your rivals can multiply your payout several times over. Below is every mechanical piece of that system, in order, with real formulas and fully worked numeric examples.

---

## 1. What Trepa Actually Is (a quick note on product history)

Worth flagging up front: earlier press coverage (mid-to-late 2025) described Trepa as a platform for forecasting macroeconomic indicators — inflation, bond yields, employment data. That positioning has been superseded. The live product on trepa.app is a fast-paced **Bitcoin Flash Pool**: continuous 60-second rounds where you slide to a BTC price target and stake against the crowd. Everything below reflects the current, live mechanism, not the earlier macro-forecasting concept.

---

## 2. Anatomy of One Round

Every round runs exactly 60 seconds, split into two windows:

| Window | Duration | What happens |
|---|---|---|
| Forecasting window | 30 sec | You slide to a BTC price estimate and pay a fixed entry fee (currently $1). Submissions lock at the end of this window. |
| Resolution window | 30 sec | No more predictions accepted. The **outcome** — the actual BTC price — is captured at the end of this window and the round settles automatically on-chain. |

The outcome itself isn't arbitrary — it's pulled from **Binance's BTC/USDT aggregate-trades API**: the system takes the last executed trade price at or immediately before the round's reference timestamp, rounded to two decimal places. That single number is what every player's estimate gets measured against.

---

## 3. Step 1 — Who Even Qualifies to Win: The Median-Error Rule

This is the gate you have to clear before proximity-based payout math applies at all.

**Definitions:**
- **Error** for player *i*: `e_i = |x_i − y|` (your estimate minus the actual outcome, absolute value)
- **Median error**: sort everyone's errors; take the *k*-th smallest, where `k = ⌊(N+1)/2⌋`

**The rule:** You win only if your error is *strictly less than* the median error. Tying the median, or being worse than it, is a loss. In a large field this produces a natural ~50% win rate before anyone's individual skill is considered.

### Worked example (5 players, real numbers from Trepa's own docs)

Outcome = $97,100.

| Player | Estimate | Error | Result |
|---|---|---|---|
| P1 | $95,000 | 2,100 | Loss |
| P2 | $96,500 | 600 | **Win** |
| P3 | $97,000 | 100 | **Win** |
| P4 | $98,200 | 1,100 | Loss (exactly ties the median) |
| P5 | $99,500 | 2,400 | Loss |

Sorted errors: 100, 600, **1,100**, 2,100, 2,400 → k = ⌊6/2⌋ = 3rd smallest = 1,100. Only errors strictly below 1,100 win — so P2 and P3 advance to the payout stage; P1, P4, P5 get nothing back.

### The edge case: Best-Coalition Exception

If **half or more of the field shares the exact same lowest error**, the median rule technically leaves nobody strictly below the cutoff — which would unfairly zero out the best guessers. Trepa patches this: if that condition triggers, everyone tied at that minimum error forms a "coalition" and all of them win.

**Example (straight from the docs):** Outcome = $97,000. Three players guess $96,800 (error 200 each), one guesses $97,500 (error 500), one guesses $98,000 (error 1,000). Errors sorted: 200, 200, 200, 500, 1,000 — median (3rd smallest) is 200. Under the plain rule, nobody is *strictly* below 200, so nobody would win. Since 3 of 5 players (≥ half) share that minimum error, they form a best-coalition and **all three win**, funded by the two losers.

This is rare in live play — it requires a real cluster of identical/symmetric guesses lining up with the outcome.

### Two full-void conditions worth knowing

- **Zero or one participant**: round is void, everyone refunded, no fees taken.
- **Every participant has the exact same error** (e.g., everyone guessed identically): round is void, everyone refunded.

---

## 4. Step 2 — Where the Prize Money Actually Comes From

Money flow per round, in Trepa's own structure:

```
Total entry fees
 ├── Winners → get their entry fee back
 └── Losers → forfeit entry fee
       ├── Platform take (20% of losing fees)
       │     ├── half → Trepa (the company)
       │     └── half → the streak Accumulator pool
       └── Remaining 80% of losing fees → Prize pool, split among winners by Accuracy Weight
```

Key numbers, straight from the docs:
- Entry fee is currently **$1**, identical for every player.
- The 20% platform take applies **only to losing entry fees** — winners are guaranteed to get their $1 back before any of this math happens.
- Roughly ~95 cents of every dollar staked eventually returns to players in some form (same-round prizes + accumulator payouts); the other ~5 cents goes to Trepa's treasury.

This confirms the model is **not zero-sum against the house** in the way a casino game is — it's a redistribution mechanism where losers directly fund winners, with the platform skimming a fixed cut only from the losing side.

---

## 5. Step 3 — The Actual Proximity Mechanic: Accuracy Weight

This is the formula you're really after — it's what converts "you were closer" into "you got paid more."

**Normalized error:**
```
r_i = e_i / m
```
where `e_i` is your error and `m` is the round's median error.

**Accuracy weight:**
```
a_i = (1 / (1 + r_i))^γ
```
Currently **γ (gamma) = 6**.

That's it — that's the whole proximity engine. But the exponent is doing a lot of work, so let's unpack why.

### Why γ = 6 matters so much

Because the base `1/(1+r_i)` is always between 0 and 1 for any winner (since `r_i < 1` for all winners, by definition of the median rule), raising it to the 6th power **compresses the weight curve dramatically toward the single most accurate player**. A player who is, say, 2x closer than another winner doesn't just get 2x the weight — they get roughly `2^6 = 64x` the weight advantage from that ratio alone, before the pool-normalization step even happens.

To make this concrete, here's what accuracy weight looks like across a range of normalized errors, holding γ = 6 fixed:

| r_i (your error ÷ median error) | a_i = (1/(1+r_i))^6 |
|---|---|
| 0.00 (you nailed the median exactly — theoretical best) | 1.000 |
| 0.10 | 0.564 |
| 0.25 | 0.262 |
| 0.50 | 0.088 |
| 0.75 | 0.033 |
| 0.99 (barely inside the winning cutoff) | 0.016 |

Notice the shape: going from r = 0.10 to r = 0.50 (5x worse, in relative terms) drops your weight by more than 6x. This is a convex, winner-skewed curve — Trepa's documentation itself calls it "steep," and the numbers bear that out.

---

## 6. Step 4 — The 100× Cap and "Water-Filling"

Accuracy weight alone would let a single dominant winner theoretically claim the entire prize pool. Trepa caps that.

**The rule:** No winner can receive more than **100× their entry fee as profit** in a single round.

**Formulas:**
```
Dividend pool (winners' total prize money) = losers' entry fees − platform take
Gain cap for winner i:  cap_i = entry_fee_i × 100
Gain:  gain_i = min(α × a_i, cap_i)
Payout:  payout_i = entry_fee_i + gain_i        (losers get $0)
```

Here `α` (alpha) is a single scale factor chosen so that (1) all winners' gains sum to exactly the dividend pool, and (2) nobody exceeds their cap. If proportional splitting would push someone over their cap, they simply get their cap instead, and the **leftover money is redistributed among the remaining winners by weight** — repeating this process (a technique called "water-filling") until every dollar in the pool is allocated and every cap is respected.

---

## 7. Full Worked Example: Combining Every Step (small pool, cap doesn't bind)

Let's run actual dollars through the whole pipeline using the 5-player round from Section 3.

**Setup:** Outcome $97,100. Entry fee $1 each. Winners: P2 (error 600), P3 (error 100). Losers: P1, P4, P5. Median error m = 1,100.

**Step A — Pool size:**
- Losers' fees: 3 × $1 = $3.00
- Platform take (20%): $0.60
- Dividend pool for winners: $3.00 − $0.60 = **$2.40**

**Step B — Accuracy weights (γ = 6):**

| Player | Error | r_i = e_i/m | a_i = (1/(1+r_i))^6 |
|---|---|---|---|
| P2 | 600 | 0.545 | 0.0734 |
| P3 | 100 | 0.091 | 0.5934 |

Sum of weights = 0.6668

**Step C — Cap check:** Cap is $100 profit per $1 entry. The whole dividend pool is only $2.40, nowhere near that — so the cap doesn't bind, and α is simply `$2.40 / 0.6668 ≈ 3.599`.

**Step D — Final payouts:**

| Player | Error | Gain (α × a_i) | Total Payout | Profit | ROI |
|---|---|---|---|---|---|
| P2 | 600 | $0.26 | $1.26 | $0.26 | +26% |
| P3 | 100 | $2.14 | $3.14 | $2.14 | +214% |

**The lesson in the numbers:** P3's error (100) was only 500 units — about 6x — better than P2's (600). But P3's *profit* ended up more than **8x** P2's profit ($2.14 vs $0.26). That gap between "how much more accurate" and "how much more you got paid" is the γ = 6 exponent visibly doing its job.

---

## 8. Second Worked Example: What Happens When the Cap *Does* Bind

The docs don't publish a numeric example where the 100× cap actually kicks in, so here's one derived from their own formulas to show the water-filling mechanism at work — useful for understanding what happens in a "jackpot" round where one player dominates a much larger field.

**Hypothetical setup:** A round with a much larger dividend pool of **$150** (large field, many losers), and 5 winners whose accuracy weights work out to:

| Player | Accuracy weight (a_i) |
|---|---|
| W1 (by far the closest) | 0.90 |
| W2 | 0.05 |
| W3 | 0.02 |
| W4 | 0.02 |
| W5 | 0.01 |

Sum of weights = 1.00.

**Naive proportional split (before applying the cap):** `gain_i = $150 × a_i`
- W1 would get $150 × 0.90 = **$135** — but the cap on a $1 entry is only $100 profit. **This exceeds the cap.**
- W2–W5 are nowhere near the cap at this stage.

**Water-filling correction:**
1. W1 is capped at exactly **$100** profit.
2. Remaining pool to distribute: $150 − $100 = $50.
3. Remaining weight among W2–W5: 0.05 + 0.02 + 0.02 + 0.01 = 0.10.
4. New scale factor for the remainder: α′ = $50 / 0.10 = 500.
5. Re-split: W2 = 500 × 0.05 = $25, W3 = 500 × 0.02 = $10, W4 = 500 × 0.02 = $10, W5 = 500 × 0.01 = $5.

**Final payouts:**

| Player | Gain | Total Payout | Profit |
|---|---|---|---|
| W1 | $100 (capped) | $101 | $100 |
| W2 | $25 | $26 | $25 |
| W3 | $10 | $11 | $10 |
| W4 | $10 | $11 | $10 |
| W5 | $5 | $6 | $5 |

Total paid out: $101+$26+$11+$11+$6 = $155 → minus the $5 in returned entry fees = $150 in gains, exactly matching the dividend pool. Nothing is lost or over-allocated; the excess that would have gone to W1 simply cascades down to the next-most-accurate winners.

---

## 9. The Separate Layer: Precision Score (Not a Payout — But Feeds Everything Else)

Precision Score is a 100–1000 rating of how good *your* prediction was on its own terms — it does **not** compare you to other players, and it is explicitly **not used to calculate round payouts**. Instead it drives streaks and leaderboards.

**Why log returns, not raw dollars:** Using `|ln(estimate) − ln(outcome)|` instead of a raw dollar difference means a 10%-high guess and a 10%-low guess score identically, and scores stay comparable whether BTC is at $40,000 or $140,000.

**Formulas:**
```
Log-return error:  ε_i = |ln(x_i) − ln(y)|
Precision Score:   PS_i = max(100, 1000 × exp(−λ × ε_i))
Sensitivity:       λ = ln(2) / σ
```
where σ is the recent realized volatility (standard deviation of BTC's 1-minute log returns over roughly the last 7 days — see Section 10).

**Reference table (from Trepa's docs):**

| How accurate you were | Precision Score |
|---|---|
| Perfect prediction | 1000 |
| About half a typical move off | ~700 |
| One typical move off | 500 |
| Two typical moves off | 250 |
| Three typical moves off | ~125 |

Each extra "typical move" of error roughly halves your score, down to a 100-point floor.

### Worked example (illustrative — σ varies with live market conditions)

Say recent 1-minute volatility σ = 0.20% (0.0020 in log-return terms) — a fairly calm market. Then λ = ln(2)/0.0020 ≈ 346.6.

**Scenario A — a sharp guess:** Outcome $97,100, your estimate $96,900.
- ε = |ln(96,900) − ln(97,100)| ≈ 0.00206
- PS = 1000 × exp(−346.6 × 0.00206) = 1000 × exp(−0.714) ≈ **490**

You were almost exactly one "typical move" off — and the score (490) lines up almost exactly with the documented benchmark (500 = one typical move off). This cross-check is a good sanity test that the formula behaves as described.

**Scenario B — a rough guess:** Same outcome, estimate $95,000.
- ε = |ln(95,000) − ln(97,100)| ≈ 0.02188
- PS = 1000 × exp(−346.6 × 0.02188) = 1000 × exp(−7.585) ≈ **1** → floored to **100**

A guess that's off by roughly 11 "typical moves" collapses straight to the 100-point floor.

---

## 10. Volatility Calibration — Why the Precision Score Formula Isn't Static

The λ in the Precision Score formula isn't a fixed constant — it moves with the market, which is the whole point of calling this "volatility calibration."

```
σ = stddev(log returns) over a recent window (e.g., last 7 days)
λ = ln(2) / σ
```

**The practical effect:** In a calm market, "one typical move" is a small dollar amount, so the same dollar error represents a *larger* fraction of a typical move — and your score for that same dollar error will be a bit lower. In a volatile market, the opposite happens: the same dollar error is a *smaller* fraction of a bigger typical move, so your score is a bit higher. The system is explicitly built to keep "PS = 500" meaning the same *relative* skill level whether the market is calm or wild — it scores you in units of typical move, never in raw dollars.

---

## 11. Leaderboards: The Consistency-Adjusted Rating (CAR)

Your leaderboard rank doesn't use your *average* Precision Score — it uses the **geometric mean**, called CAR:

```
CAR = (PS_1 × PS_2 × ... × PS_n)^(1/n)
```

**Why this matters — worked example (from the docs):**

| Participant | Round 1 | Round 2 | Round 3 | Arithmetic Average | CAR (geometric) |
|---|---|---|---|---|---|
| Alice | 700 | 700 | 700 | 700 | **700** |
| Bob | 400 | 400 | 1000 | 600 | **543** |
| Carol | 900 | 900 | 300 | 700 | **640** |

Notice: Carol's *arithmetic* average (700) actually ties Alice's — but her CAR (640) is lower, because geometric means punish a single bad round far more harshly than arithmetic averages do. Bob's spectacular 1000 round barely rescues his CAR from his two 400s. **The mechanism explicitly rewards consistency over occasional brilliance.**

Minimum rounds required to even appear on a leaderboard: 3 for daily, 10 for weekly, 30 for monthly.

---

## 12. Crowd Signal — A Display-Only Aggregate (Not a Payout Mechanism)

During the resolution window, the app shows a single number summarizing where the whole pool is leaning, weighted by each player's monthly CAR — so more consistently accurate forecasters pull the aggregate toward their price more than newer or less consistent players.

```
Crowd Signal = Σ(w_i × x_i) / Σ(w_i)
```
where `x_i` is player i's estimate and `w_i` is their monthly CAR (used as a non-negative weight).

**Worked example:** Three players with estimates $97,000 / $96,800 / $97,300, and monthly CAR scores of 700 / 500 / 900 respectively:

```
Crowd Signal = (97,000×700 + 96,800×500 + 97,300×900) / (700+500+900)
             = (67,900,000 + 48,400,000 + 87,570,000) / 2,100
             = 203,870,000 / 2,100
             ≈ $97,081
```

This number is purely informational — it doesn't change who wins or how much anyone gets paid. It's there so you can compare your own target against what the "smart money" in the room collectively thinks.

---

## 13. Streaks + the Accumulator: A Second, Separate Payout Channel

This is a genuinely distinct payout mechanism from the round-by-round Accuracy Weight system, and it's easy to conflate the two, so it's worth isolating clearly.

**Streaks:** A streak counts consecutive rounds where your Precision Score was **> 777**. It resets if any round scores ≤ 777, or if you skip a prediction on a given UTC calendar day. Critically: **streaks are decoupled from winning or losing the round.** You can extend a streak in a round you technically lost (median-error-wise), and you can win a round's prize pool without advancing your streak at all if your Precision Score was ≤ 777.

**The Accumulator pool:** A shared jackpot per metric (e.g., BTC 1-minute), continuously fed by a slice of every round's fees (recall from Section 4: half of the 20% platform take on losing fees flows here). When one or more players complete a qualifying streak, they trigger a payout from this pool.

```
Payout per achiever = (half of accumulator pool) / (number of simultaneous achievers)
```

The other half of the pool always rolls forward, so the jackpot keeps compounding between payouts. The pool has a floor of $100 (auto-topped-up if it dips below) and **no ceiling**.

**Worked example (from the docs):** Accumulator pool = $500. Three players complete a qualifying streak simultaneously. Half the pool ($250) splits evenly among them → **$83.33 each**. The remaining $250 stays in the pool and keeps growing.

---

## 14. Two Adjacent (Non-Round) Ways Trepa Pays Out Money

These aren't part of the proximity mechanic, but they're part of "how Trepa pays you" broadly, so they're worth including for completeness.

### Referral commissions
You earn a percentage of the **prediction volume** generated by people you refer (Level 1 = direct referrals) and a smaller cut from *their* referrals (Level 2), for 6 months from each person's code redemption. Rates scale with tier, based on your total referred network volume:

| Tier | Network volume | L1 rate | L2 rate |
|---|---|---|---|
| Bronze | Under $5,000 | 1.25% | 0.35% |
| Silver | $5,000–$24,999.99 | 1.50% | 0.50% |
| Gold | $25,000–$99,999.99 | 1.75% | 0.60% |
| Platinum | $100,000+ | 2.00% | 0.75% |

**Worked example (from the docs):** Alice is Gold tier. Her direct referral Bob generates $20,000 in volume (L1, 1.75% → $350). Bob's referral Carol generates $50,000 in volume (L2 for Alice, 0.60% → $300). Alice's total for the month: **$650**. Minimum disbursement is $5; smaller balances just accrue.

### Quests / XP
Every confirmed prediction earns 10 XP (win or lose), rising to 20 XP after 1,000 lifetime predictions, plus one-time milestone bonuses (e.g., +100 XP at 10 predictions, up to +10,000 XP at 1,000 predictions). This is a status/progression system, not a cash payout — but it's part of the broader incentive design worth knowing about.

---

## 15. Cross-Check Against an Independent Analysis

A third-party working paper — "*A Precision-Based Payout Protocol for Continuous Expectation Elicitation*," attributed to an outfit calling itself Andromeda Core Research (May 2026) — offers a formal cryptoeconomic treatment of Trepa. Because you asked for this to be cross-checked and used to strengthen the report, here's what survives scrutiny, what doesn't, and what needs a clear label.

### 15.1 A note on the source itself

Before trusting any of its content, it's worth flagging: I could not find independent confirmation that "Andromeda Core Research" is an established or peer-reviewed research group, nor that dev.andromedacomputer.net is a known publication venue. It has the formatting of an academic paper (real references to Hayek, Hanson's LMSR work, Gneiting & Raftery on proper scoring rules, Frongillo, Conitzer, and the Augur paper are all legitimate, citable literature), but the paper itself doesn't appear to be indexed anywhere I could verify, and the authorship is opaque. That doesn't mean its claims are wrong — but it means it should be treated as an **unvetted, independent secondary analysis**, not as an authoritative or official source the way docs.trepa.io is. I've separated its content below into (a) mechanical claims that check out against Trepa's own documentation, and (b) the paper's own original theoretical contributions, which are analysis/opinion/proposals, not descriptions of what Trepa actually does.

### 15.2 What checks out (matches docs.trepa.io exactly)

| Claim in the paper | Cross-check against official docs |
|---|---|
| 60-second rounds: 30s forecasting + 30s resolution | Confirmed — Section 2 of this report |
| Entry fee fixed at $1 (F = 1 USDC) for all participants | Confirmed |
| Winner rule: `e_i < median error`, strict inequality | Confirmed, matches Section 3 exactly |
| Accuracy weight `a_i = (1/(1+r_i))^γ`, γ = 6 | Confirmed, matches Section 5 exactly (this is the paper's Equation 3) |
| Per-winner profit cap of 100× entry fee, water-filling allocation | Confirmed, matches Section 6 |
| Outcome sourced from Binance BTC/USDT aggregate-trades API, last trade at/before reference time | Confirmed, matches Section 2 / official "Resolution and outcome source" page |
| Precision Score (100–1000) is independent of round win/loss and doesn't affect prize distribution | Confirmed, matches Section 9 |
| Backed by Colosseum, with participation from a Balaji-affiliated fund | Consistent with Trepa's own public fundraising announcements ($420K pre-seed led by Colosseum, with The Balaji Fund among participants) |

This is a genuinely useful sanity check: an outside party independently arrived at the same mechanical description of the protocol that Trepa's own docs state, which corroborates that this report's core sections (3–8) are accurate.

### 15.3 What's the paper's own theoretical contribution — not Trepa's documented behavior

This is the important distinction to hold onto. The following are **the author's own proposed research and analysis**, not features Trepa has built or confirmed:

- **The Bayesian Nash Equilibrium proof (Theorem 3.1)**, claiming truthful reporting is an equilibrium strategy. This is an informal proof *sketch*, not a rigorous derivation — it leans on a large-*N*, atomless-agent argument to wave away the fact that any single player's report technically does influence the median in a finite pool. It's a reasonable heuristic, but Trepa itself doesn't publish or claim this equilibrium result, and the paper's own Section 6.2 (median instability in small pools) implicitly concedes the assumption breaks down exactly where Trepa's real rounds often sit — small-to-medium field sizes, not the "large-N" limit the theorem needs.
- **The Sybil-resistance cost model and expected-return bound (Eq. 10–11).** A reasonable economic argument (fixed entry cost + need for genuine accuracy makes mass Sybil attacks unprofitable), but it's the author's own model, not a documented Trepa security claim.
- **All four "vulnerabilities" and their "mitigations" — VWAP settlement windows, a dynamic `N_min(σ)` threshold, a "Consistency Pool," and opportunity-cost discounting.** None of these are implemented by Trepa. To be explicit, since this is easy to misread: Trepa's actual resolution mechanism uses a **single last-trade price**, not a VWAP window; its actual void condition is **N ≤ 1 participants**, not a volatility-scaled dynamic minimum; and while Trepa does have a real streak-based Accumulator (Section 13 of this report), the paper's "Consistency Pool" is an author-proposed *variant* of that idea, explicitly presented as a suggestion for what Trepa *could* add — the author says as much ("echoing Trepa's existing streak-accumulator design"). Don't mistake this section of the paper for a description of current functionality.
- **The comparative positioning matrix and Figures 1–3** (granularity vs. resolution-frequency quadrants, mutual-information comparisons against binary markets) are the author's own analytical framing for situating Trepa against Polymarket-style markets and perpetual futures. It's a reasonable way to think about the design space, but it's interpretation, not fact.

### 15.4 A technical inconsistency worth flagging

Proposition 4.1 in the paper claims that, for a winner with error *e*, expected payout is "approximated by `F · exp(−λe²)` ... proportional to the kernel of a Gaussian proper score" — i.e., it claims the payout decays like a Gaussian in the raw error *e*.

Checking this against the actual formula (Section 5 of this report): for small normalized error *r = e/m*, a Taylor expansion of `(1/(1+r))^6` gives:

```
(1/(1+r))^6 = exp(−6·ln(1+r)) ≈ exp(−6r + 3r² − ...) ≈ exp(−6r)   for small r
```

That's **exponential decay linear in *e*** (since r = e/m is linear in e) — closer to a Laplace-kernel shape than a Gaussian one. A Gaussian kernel would require an *e²* term in the exponent, which doesn't appear anywhere in Trepa's actual accuracy-weight formula. This looks like an error, or at minimum a loose/unjustified approximation, in the paper's Proposition 4.1. It doesn't undermine the paper's broader point (that Trepa's payout function behaves *similarly in spirit* to a strictly proper scoring rule within the winning region), but the specific functional form claimed doesn't hold up under direct derivation from Trepa's own equation.

### 15.5 Net effect on this report

The paper strengthens confidence in Sections 2–9 of this report (independent corroboration of every core mechanical formula) and adds a genuinely useful frame for *why* a fixed-entry, median-cutoff, steep-accuracy-weight design makes sense economically (Sybil deterrence, proper-scoring-rule kinship). It should **not** be read as evidence that VWAP settlement, dynamic participant minimums, or a "Consistency Pool" exist in Trepa today — those remain one outside researcher's proposals, not documented product features.

---

## 16. Complete Formula Reference Sheet

For quick lookup — every formula in this document in one place:

| Concept | Formula |
|---|---|
| Error | `e_i = \|x_i − y\|` |
| Median error | k-th smallest error, `k = ⌊(N+1)/2⌋` |
| Win condition | `e_i < median error` (strict) |
| Normalized error | `r_i = e_i / m` |
| Accuracy weight | `a_i = (1/(1+r_i))^γ`, γ = 6 currently |
| Dividend pool | losers' entry fees − platform take (20%) |
| Gain cap | `cap_i = entry_fee_i × 100` |
| Gain (capped, water-filled) | `gain_i = min(α × a_i, cap_i)` |
| Payout | `payout_i = entry_fee_i + gain_i` (winners); `0` (losers) |
| Log-return error | `ε_i = \|ln(x_i) − ln(y)\|` |
| Precision Score | `PS_i = max(100, 1000 × exp(−λε_i))` |
| Sensitivity | `λ = ln(2) / σ` |
| Volatility | `σ = stddev(log returns)`, ~7-day window |
| Leaderboard rank (CAR) | `CAR = (PS_1 × PS_2 × ... × PS_n)^(1/n)` |
| Crowd Signal | `Σ(w_i × x_i) / Σ(w_i)`, w_i = monthly CAR |
| Accumulator payout | `(½ × pool) / (number of achievers)` |

---

## 17. Strategic Takeaways

1. **Clearing the median is table stakes, not the goal.** Once you're a winner, the real payout differentiation happens entirely in the accuracy-weight step — and that curve is steep (γ = 6). Being merely "above average" among winners leaves real money on the table compared to being the *most* accurate.
2. **Precision matters more than direction.** Because the win condition is about magnitude of error, not which side of the outcome you guessed, there's no benefit to hedging toward "definitely above" or "definitely below" — the tightest possible estimate is always correct strategy.
3. **The cap protects against total pool capture**, but in typical-sized rounds it rarely binds — it mostly matters in unusually lopsided or high-volume rounds.
4. **Precision Score and round payout are different games being played simultaneously.** You can lose money on a round while still building your streak toward an accumulator payout, or win money on a round that does nothing for your streak. Optimizing purely for round profit and optimizing purely for streak/leaderboard status are not always the same strategy.
5. **Consistency is explicitly rewarded over volatility of skill** — the geometric-mean CAR formula for leaderboards means one disastrous round costs you more than one brilliant round gains you.

---

## Sources

All figures, formulas, and quoted examples in this report are drawn directly from Trepa's official developer documentation:

- docs.trepa.io/payouts/payout-overview
- docs.trepa.io/payouts/accuracy-weight
- docs.trepa.io/payouts/capped-payout
- docs.trepa.io/game-rules/winning-and-losing
- docs.trepa.io/game-rules/best-coalition-exception
- docs.trepa.io/game-rules/winning-range
- docs.trepa.io/getting-started/quick-start
- docs.trepa.io/scoring/precision-score
- docs.trepa.io/scoring/volatility-calibration
- docs.trepa.io/scoring/leaderboards
- docs.trepa.io/scoring/crowd-signal
- docs.trepa.io/streaks-accumulator/streaks
- docs.trepa.io/streaks-accumulator/accumulator-payout
- docs.trepa.io/references/edge-cases
- docs.trepa.io/references/resolution-source
- docs.trepa.io/referral-program/overview
- docs.trepa.io/points-program/overview

Additionally cross-checked against:
- "A Precision-Based Payout Protocol for Continuous Expectation Elicitation," attributed to Andromeda Core Research, dated May 7, 2026 (user-supplied PDF). Treated as an **unverified, independent third-party analysis** — see Section 15 for a full breakdown of which of its claims corroborate the official docs versus which are the author's own original theoretical proposals not implemented by Trepa.

Sections 8 and the illustrative Precision Score example in Section 9 are original numeric derivations built by applying Trepa's published formulas to hypothetical inputs — they are clearly labeled as such and are not official Trepa examples. All economic parameters (entry fee, take rate, cap multiple, γ exponent) are described in Trepa's docs as tunable and subject to change; treat this report as a snapshot as of July 2026, and check the live docs for current values before relying on this for real decisions.
