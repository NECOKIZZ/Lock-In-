# Player Perps — Market A Build Spec (Solana)

**Audience:** the engineer implementing this. Everything here is meant to be buildable directly — account layouts, instruction lists, the exact math, and the real Solana constraints that change the architecture (compute units, account limits, no native floats).

**Scope:** Market A only (full-time score proximity). Trepa payout model. Solana, single chain, no bridging. TxLine as the data source.

---

## 1. What this system does, end to end

A fixture opens for staking. Each staker locks USDC plus a scoreline guess. At kickoff, staking closes. TxLine reports the match live and, at full time, the final score is validated against TxLine's on-chain Merkle proof. Every staker's distance from the truth (`D`) is computed from their guess vs. the validated score. Whoever beats the field's median `D` wins; losers' stakes (minus a platform cut) get redistributed to winners, weighted by how close they were, capped and water-filled. Winners claim their payout; if the round is void, everyone reclaims their stake.

Two things make this a genuine Solana build, not just "run the JS engine on-chain": (1) Solana transactions have compute-unit and account-count ceilings, so settlement can't be one instruction once you have real numbers of stakers — it has to be a batched, resumable pipeline; (2) on-chain math should not use floats — everything below is specified in fixed-point integers.

---

## 2. Proximity & Similarity model (Market A)

This is unchanged from the spec you already have — reproduced here so this document is self-contained.

For a guess `(gh, ga)` against actual `(ah, aa)`:

```
gd_guess = gh - ga        gd_actual = ah - aa
tg_guess = gh + ga        tg_actual = ah + aa
correct  = 1 if sign(gd_guess) == sign(gd_actual) else 0   // Home/Away/Draw match
d_gd     = min(|gd_guess - gd_actual|, CAP_GD)
d_tg     = min(|tg_guess - tg_actual|, CAP_TG)
cs_home_guess  = 1 if ga==0 else 0     cs_home_actual = 1 if aa==0 else 0
cs_away_guess  = 1 if gh==0 else 0     cs_away_actual = 1 if ah==0 else 0

D = (1 - correct) * P
  + W_GD * d_gd
  + W_TG * d_tg
  + W_CS * (|cs_home_guess - cs_home_actual| + |cs_away_guess - cs_away_actual|)

S = 1 / (1 + D)   // similarity — display/ranking only, not used in payout math
```

Defaults: `P=4.0, W_GD=1.0, W_TG=0.5, W_CS=0.25, CAP_GD=3, CAP_TG=4`. These are per-fixture parameters, set at fixture creation, not hardcoded — a builder should be able to tune them per competition if needed.

---

## 3. Payout model (Trepa mapping)

`D` plays the role of Trepa's error term `e_i`. Full algorithm:

1. **Void checks:** `N ≤ 1` stakers → void, refund all. Every staker has identical `D` → void, refund all.
2. **Best-coalition check:** let `minD` = lowest `D` in the field, `countAtMin` = stakers at that value. If `countAtMin ≥ N/2`, they are the winners as a group (skip the win-gate below; the median is still computed and still used in step 4).
3. **Median gate (otherwise):** `k = floor((N+1)/2)`, `m` = the k-th smallest `D`. Winners: `D_i < m`. Losers: `D_i ≥ m`.
4. **Accuracy weight (winners only):** `r_i = D_i / m`, `a_i = (1/(1+r_i))^6`.
5. **Pool:** `losers' stakes × (1 − take_rate)`, `take_rate` default 20%.
6. **Cap + water-fill:** `cap_i = stake_i × 100`. Distribute pool proportional to `a_i`; anyone whose naive share exceeds their cap is capped, excess cascades to remaining uncapped winners, repeat.
7. **Payout:** `stake_i + gain_i` for winners, `0` for losers.

**Edge case not covered in Trepa's own public docs:** if the pool is large relative to winner count, water-filling can cap every winner and still have residual pool left over. Route that residual to the platform take and log it separately from the normal cut — don't let it silently disappear from the accounting.

---

## 4. Fixed-point math — no floats on-chain

Use a fixed-point scale, `SCALE = 1_000_000` (6 decimals — matches USDC's own decimal count, convenient). Every ratio (`D`, `S`, `r`, `a`, distance-formula weights) is stored as a `u64`/`u128` scaled integer, not a float. Floats are avoided on Solana programs both for determinism and because they cost more compute than integer ops.

`a_i = (1/(1+r_i))^6` with a fixed integer exponent (6) is cheap to compute exactly with repeated fixed-point multiplication — no general `pow()` needed:

```rust
// r is fixed-point scaled by SCALE. Returns a_i, fixed-point scaled by SCALE.
fn accuracy_weight(r: u128, scale: u128, gamma: u32) -> u128 {
    // base = 1 / (1 + r), fixed-point: base = scale * scale / (scale + r)
    let base = scale
        .checked_mul(scale).unwrap()
        .checked_div(scale + r).unwrap();
    let mut result = scale; // 1.0 in fixed point
    for _ in 0..gamma {
        result = result.checked_mul(base).unwrap().checked_div(scale).unwrap();
    }
    result
}
```

Use `u128` intermediates throughout to avoid overflow (stakes in USDC base units × `SCALE` × cap multiples can get large). Every division needs a corresponding rounding-direction decision — round down on payouts (favor conservation: never pay out fractionally more than the pool holds), and check the final conservation invariant (`Σ payout_i + platform_cut == total_pool`, allowing for integer-division dust that also routes to platform take) before marking a fixture `Settled`.

---

## 5. Solana program architecture

### 5.1 Why settlement can't be one instruction

Finding the median and running water-filling both require knowing every staker's `D` — this is a global aggregate, not a per-account-isolated computation. Solana transactions have a compute-unit ceiling (200k default, extendable with priority fees to ~1.4M) and a practical account-count ceiling per transaction (transaction size limits mean realistically tens of accounts per call, not hundreds). A fixture with more than a couple dozen stakers cannot be settled in a single instruction. The architecture below is a **batched, resumable pipeline** — each phase processes a slice of stakers via `remaining_accounts`, and the fixture tracks how much of each phase is done so anyone (a keeper, or the frontend itself) can drive it forward with repeated calls.

### 5.2 Accounts

**`Fixture` (PDA, seeds `["fixture", txline_fixture_id]`)**

```
txline_fixture_id: u64
lock_time: i64                    // kickoff, from TxLine's Kickoff message
status: FixtureStatus             // enum, see 5.3
dist_params: { p, w_gd, w_tg, w_cs, cap_gd, cap_tg }   // fixed-point u32s
payout_params: { gamma: u32, take_rate_bps: u16, cap_multiple: u32 }
actual_home: u8
actual_away: u8
total_pool: u64
staker_count: u16
escrow_ata: Pubkey

// settlement-pipeline accumulators (all reset to 0 at fixture init)
distances_computed_count: u16
running_min_d: u64
running_count_at_min: u16
median_candidate: u64
median_verify_count_below: u16
median_verify_count_equal: u16
median_d: u64
median_verified: bool
coalition_mode: bool
winners_processed_count: u16
sum_a: u128
losers_stake_sum: u64
dividend_pool: u64
platform_cut: u64
waterfill_round: u8
capped_gain_sum: u64
capped_a_sum: u128
payouts_finalized_count: u16
```

**`StakePosition` (PDA, seeds `["stake", fixture_id, staker_pubkey]`)** — one per staker per fixture, enforced by PDA derivation:

```
staker: Pubkey
guess_home: u8
guess_away: u8
stake_amount: u64
distance_d: u64        // fixed-point, filled in phase 2
is_winner: bool         // filled in phase 4
accuracy_a: u128        // fixed-point, filled in phase 4 (winners only)
capped: bool
payout_amount: u64      // filled in phase 5
claimed: bool
```

**Escrow:** a standard SPL-Token (USDC mint) associated token account, authority = the `Fixture` PDA. Not Token-2022 — that's what TxLine uses for its own TxL subscription token; unrelated, don't conflate the two.

### 5.3 State machine

```
Open → Locked → ScoreValidated → DistancesComputed → MedianVerified
     → Settled (claims open)              [or → Void at any check in steps 2-4]
```

### 5.4 Instruction list

1. **`initialize_fixture`** — creates `Fixture`, sets `lock_time`, `dist_params`, `payout_params`, references the TxLine fixture ID. `status = Open`.
2. **`stake(guess_home, guess_away, amount)`** — signer = staker. Requires `status == Open`, `clock < lock_time`. Creates the staker's `StakePosition` (PDA uniqueness = one guess per staker per fixture). Transfers `amount` from staker's USDC ATA to escrow. Increments `total_pool`, `staker_count`.
3. **`lock_fixture`** — permissionless, requires `clock >= lock_time`. `status = Locked`.
4. **`validate_score`** — CPI into TxLine's on-chain program to fetch/prove `Participant1`/`Participant2` Total Goals (their Merkle-proof keys 1 and 2) for this fixture, only once TxLine's `StatusId` shows the match finished (5/10/13 — F/FET/FPE). Writes `actual_home`, `actual_away`. `status = ScoreValidated`.

   **Pull the real interface before wiring this** — the exact accounts and instruction discriminator for TxLine's validation call aren't something to guess at. Get them from TxLine's own `Program Reference` (mainnet/devnet addresses) and `On-Chain Validation` example pages before writing this instruction. Everything else in this document is independent of that interface; this is the one CPI boundary where you need their actual IDL, not an assumption.

5. **`compute_distances_batch(remaining_accounts: [StakePosition...])`** — permissionless keeper call, repeatable across batches. For each account in the batch: compute `D_i` from `dist_params` and the validated score, write it, and update `Fixture.running_min_d` / `running_count_at_min`. Increment `distances_computed_count`. When it reaches `staker_count`, check the void conditions (`staker_count <= 1` was already checkable at step 3; "all `D` equal" is checkable here via `running_min_d == running_max_d`, so track a `running_max_d` too) — if void, `status = Void` and skip to claims. Otherwise `status = DistancesComputed`, and set `coalition_mode = (running_count_at_min >= staker_count / 2)`.
6. **`verify_median_candidate(candidate, remaining_accounts)`** — a keeper sorts all `D_i` off-chain (this is public on-chain data — anyone can read every `StakePosition` via RPC and compute the true median themselves; there's nothing to trust here, only to verify) and submits the candidate median. For the batch, tally `count_below` (`D_i < candidate`) and `count_equal` (`D_i == candidate`) into the running accumulators. After the final batch, `finalize_median` checks the order-statistic condition: `running_count_below < k <= running_count_below + running_count_equal` where `k = floor((staker_count+1)/2)`. If it holds, `median_d = candidate`, `median_verified = true`, `status = MedianVerified`. If not, the counters reset and the keeper must resubmit — this only happens on a keeper arithmetic error, since the correct median is a deterministic function of public data.
7. **`settle_batch(remaining_accounts)`** — for each account: `is_winner = coalition_mode ? (D_i == running_min_d) : (D_i < median_d)`. If winner: `r_i = D_i * SCALE / median_d` (guard `median_d == 0` → `r_i = 0`), `a_i = accuracy_weight(r_i)` (§4), accumulate `sum_a += a_i`. If loser: accumulate `losers_stake_sum += stake_i`. Increment `winners_processed_count` appropriately. Once all accounts processed: `dividend_pool = losers_stake_sum * (10000 - take_rate_bps) / 10000`, `platform_cut = losers_stake_sum - dividend_pool`.
8. **`compute_payouts_batch(remaining_accounts)`** — water-filling, one round per call across all winners: `alpha = (dividend_pool - capped_gain_sum) * SCALE / (sum_a - capped_a_sum)`. For each uncapped winner in the batch: `naive_gain = alpha * a_i / SCALE`; if it exceeds `cap_i = stake_i * cap_multiple`, mark `capped = true`, `payout_amount = stake_i + cap_i`, and fold `cap_i`/`a_i` into `capped_gain_sum`/`capped_a_sum` for the next round. Track whether *any* new cap occurred this round in a transient flag; if a full pass produces no new caps, finalize all remaining uncapped winners' payouts at the current `alpha` and mark `status = Settled`. Bound this at a small number of rounds (e.g. 10, matching the reference engine's safety limit) — if it somehow doesn't converge, route whatever's left to `platform_cut` and settle anyway rather than leaving the fixture stuck.
9. **`claim_payout`** — signer = staker, requires `status == Settled` (transfers `payout_amount`) or `status == Void` (transfers original `stake_amount`). Transfers from escrow to the staker's ATA, sets `claimed = true` (idempotency).

### 5.5 The pragmatic hackathon path

The full pipeline above is the correct, trust-minimized design and is what to build once there's runway. For July 19, given the timeline, there's a faster and still-honest alternative: **a keeper computes the entire settlement off-chain** (median, winners, `a_i`, gains, payouts — same deterministic algorithm, same inputs, all of which are public on-chain data), and submits the final numbers in one instruction. The on-chain program does a cheap verification pass instead of the full batched compute: recompute `D_i` for every `StakePosition` from the validated score (this part is genuinely cheap, one guess per account), and check the conservation invariant (`Σ payout_i + platform_cut == total_pool`) plus a couple of spot checks (the claimed median satisfies the order-statistic condition against the recomputed `D_i`s). This is weaker than the full pipeline — you're trusting the keeper's off-chain water-filling arithmetic rather than verifying every step on-chain — but it's still fully auditable, since anyone can independently recompute the whole thing from public inputs and challenge a wrong submission. Ship this for the deadline; migrate to the full batched pipeline once Market A has real, larger pools where a keeper being wrong actually matters economically.

---

## 6. Edge cases — checklist

| Case | Where it's handled | Behavior |
|---|---|---|
| `N ≤ 1` staker | step 5 (after distances) or earlier at lock | Void, refund |
| All `D_i` identical | step 5, via `running_min_d == running_max_d` | Void, refund |
| ≥half field tied at minimum `D` | step 5, `coalition_mode` flag | All tied stakers win as a group; `median_d` still computed and still used for `a_i` |
| Water-fill caps every winner with residual pool left | step 8, bounded round loop | Residual routed to `platform_cut`, logged separately, fixture still settles |
| Keeper submits wrong median candidate | step 6 verification | Rejected by the order-statistic check; counters reset, keeper resubmits |
| Match doesn't finish (abandoned/cancelled) — TxLine `StatusId` 14/15/16 | gate in `validate_score` | Don't allow validation; fixture stays `Locked` — decide a manual-void path for this (not automatic, since abandonment handling is a product decision, not a formula one) |
| Staker tries to claim twice | `claimed` flag on `StakePosition` | Second claim rejected |
| Integer-division dust in payouts | conservation check before `Settled` | Dust rounds to `platform_cut`, never silently vanishes |

---

## 7. Worked example (use this to test your implementation against known-correct output)

Actual score 2-1. Five stakers:

| Staker | Guess | `D` | Stake |
|---|---|---|---|
| A | 2-1 | 0.00 | $50 |
| C | 3-1 | 1.50 | $40 |
| B | 2-0 | 1.75 | $30 |
| D | 1-1 | 5.50 | $20 |
| E | 1-2 | 6.00 | $60 |

`N=5`, `k=3`, sorted `D = [0.00, 1.50, 1.75, 5.50, 6.00]` → `median_d = 1.75`. `running_min_d = 0.00`, `running_count_at_min = 1` → `1 < 5/2` → not coalition mode. Winners: A (`D<1.75`), C (`D<1.75`). Losers: B, D, E.

`losers_stake_sum = 110`, `take_rate = 20%` → `platform_cut = 22`, `dividend_pool = 88`.

`r_A = 0 → a_A = 1.000000`. `r_C = 1.50/1.75 = 0.857143 → a_C ≈ 0.024376`. `sum_a ≈ 1.024376`. No caps bind (`cap_A = $5000`, `cap_C = $4000`, both far above the pool).

`alpha = 88 / 1.024376 ≈ 85.905`. `gain_A ≈ $85.91`, `gain_C ≈ $2.09`.

**Expected final state:** `payout_A = $135.91` (`claimed=false` until claim), `payout_C = $42.09`, `payout_B = payout_D = payout_E = $0`. `Σ payout = $178.00`, `platform_cut = $22.00`, conservation: `178 + 22 = 200 = total_pool`. If your implementation produces anything else on this exact input, the bug is in your build, not in this spec — this was validated numerically before being written down here.

---

## 8. Things to get right that aren't in the formulas

- **Front-running the lock:** don't allow a `stake` transaction to land in the same slot as `lock_fixture` in a way that lets someone see the last stakes before deciding their own guess. Standard mitigation: `lock_time` should be set meaningfully before actual kickoff (not exactly at it), and the frontend should stop accepting new stake submissions client-side a buffer before `lock_time` to avoid last-second transaction races.
- **TxLine `StatusId` gating:** don't call `validate_score` on anything other than a genuinely finished match (5/10/13). Watch for `TXCC`/`TXCS` (17/18 — TX coverage cancelled/suspended) as a signal that the data feed itself lost coverage, which should route to a manual-void path, not a stalled instruction.
- **Rent:** every `StakePosition` PDA needs rent-exempt minimum funded at creation (paid by the staker as part of `stake`, standard Anchor pattern) — budget for this in the amount actually transferred vs. staked, or fund rent separately so the full stake amount is what's at risk in the market, not silently reduced by rent.
- **Escrow authority:** the `Fixture` PDA must be the escrow ATA's authority so `claim_payout` and refunds can sign the transfer via `invoke_signed` with the fixture's seeds — get this wrong and funds are stuck.
