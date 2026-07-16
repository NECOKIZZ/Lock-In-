# Player Perps — Market A (Solana)

The initial build of Player Perps: a Solana prediction market where each staker
locks **USDC + a guessed full-time football score**. After the match, the score
is validated against **TxLine**'s on-chain data, every staker's distance `D` from
the truth is computed, and the **Trepa median-gate + accuracy-weight** payout
redistributes losers' stakes to whoever beat the field.

This is **Market A only** (full-time score proximity), single-chain, no bridging —
the scope from `../player-perps-market-a-solana-build-spec.md`. The larger vision
(Market B, multichain, order books, season leaderboards) lives in `../skill files/`
and is deliberately **not** built here.

## Layout

```
app/
  engine/                     ← pure-Rust, fixed-point, no Solana deps. The single
    src/lib.rs                  source of truth for the D formula + Trepa settlement.
    src/distance.rs             distance_a()  — Market A proximity distance
    src/settle.rs               settle()      — void→coalition→median→accuracy→water-fill
    tests/worked_example.rs     reproduces the spec's worked example exactly
  programs/player_perps/      ← thin Anchor program: escrow, state machine, both paths
    src/state.rs                Fixture + StakePosition accounts, FixtureStatus
    src/instructions/
      lifecycle.rs              initialize · stake · lock · validate_score · claim
      fast_path.rs              submit_settlement  (keeper path, §5.5)
      pipeline.rs               full batched on-chain settlement (§5.4)
  keeper/                     ← TypeScript mirror of the engine + demo
    src/engine.ts               byte-identical fixed-point math (BigInt)
    src/settle-keeper.ts        buildSettlement() + submit skeleton
    src/demo.ts                 runs the worked example, node-verifiable now
```

**Why the split?** The multichain plan (`../skill files/player-perps-multichain-plan.md`
§2) is explicit: *only the escrow layer is chain-specific; the D/S formulas and the
settlement engine are not.* So the math is a standalone crate, reused verbatim by
the on-chain program and mirrored in the keeper/UI. When Phase 2 adds other chains,
the engine doesn't change.

## The math, once

`engine` (Rust) and `keeper/src/engine.ts` (TypeScript) are line-for-line ports of
the tested reference `settleTrepa` in
`../proximity-markets-simulator-trepa.html`. Everything is **fixed-point integers**
(`SCALE = 1_000_000`, matching USDC's 6 decimals) — **no floats** on-chain, per
build spec §4. The same formula is evaluated in three places (program, keeper, and
the UI's live cash-out quote per `../player-perps-ui-spec.md` §3), so they always
agree.

Distance: `D = (1−correct)·P + W_GD·min(|Δgd|,CAP_GD) + W_TG·min(|Δtg|,CAP_TG) + W_CS·Δcs`.
Payout: median gate (`D < m`), accuracy weight `a = (1/(1+D/m))^γ`, losers' stakes ×
`(1−take)` split ∝ `a`, capped and water-filled. Conservation
`Σ payout + platform_cut == total_pool` is asserted before any fixture settles.

## Two settlement paths (both built)

Settlement is a global aggregate over every staker, but Solana caps compute units
and accounts per transaction, so it can't be one instruction at real staker counts.

- **Fast path — `submit_settlement`** (build spec §5.5): a keeper computes the whole
  settlement off-chain (all public data) and submits the result; the program does a
  cheap verify — recompute every `D`, check the median order-statistic, check
  conservation. Trusts the keeper's water-fill arithmetic but is fully auditable
  (anyone can recompute and challenge). **Ship this for the deadline.**
- **Full path — batched pipeline** (build spec §5.4): `compute_distances_batch` →
  `verify_median_candidate` → `finalize_median` → `settle_batch` →
  `compute_payouts_batch`. Same math, chunked across `remaining_accounts` with
  accumulators on the `Fixture`, fully on-chain, nothing trusted. Resumable by any
  keeper or the frontend.

Both converge on `StakePosition.payout_amount`, drained by `claim_payout`
(`Void` refunds the original stake).

## What's verified vs deferred

**Everything below is proven live on devnet** (program
`6krdS27r9oHpiTwHemWXwcKSns7Dj3616pFwKNDgmE26`):

- full lifecycle: initialize → stake ×5 → lock → **validate_score via the real
  txoracle CPI** → submit_settlement → claim, with on-chain payouts matching the
  engine byte-for-byte (see `keeper/e2e/README.md` for tx-level detail);
- the tamper test: a wrong score fails Merkle verification and the tx reverts;
- the **listing agent** (`keeper/e2e/lister.ts`) and **monitor loop**
  (`keeper/e2e/monitor.ts`): discover → gate → list → lock at KO → prove → settle
  (or Void→refund), driving the market registry `ui/fixtures.json`;
- the browser UI (`ui/app.html`): real wallet staking against devnet plus a
  settlement-proof panel with explorer links.

Local, offline checks:

```bash
# Rust engine — reproduces the spec §7 worked example exactly + edge cases
cd engine && cargo test

# TypeScript keeper — same numbers from the mirror (engine parity)
cd keeper && node src/demo.ts     # or: npm run demo   (no install needed)
```

Both print/assert the spec §7 ledger: actual 2-1, median `D = 1.75`, winners A & C,
**payout A = $135.91, payout C = $42.09**, platform take **$22.00**, exact
conservation to **$200.00** — plus void (`N≤1`, all-`D`-equal), best-coalition, and
water-fill cap-residual cases.

Build the program with `cargo-build-sbf` (toolchain gotchas + shims documented in
`keeper/e2e/README.md`); the `dev-validate` feature injects a score without the
TxLine CPI for local testing.

## The score oracle — trustless by construction

`validate_score` CPIs into TxLine's on-chain `txoracle.validate_stat_v3`, proving
the submitted final score against the Merkle root TxLine publishes daily on-chain
(`daily_scores_roots` PDA, pinned by seeds from the proof's own timestamp). A wrong
score cannot pass; a malicious keeper's worst case is a market that voids and
refunds. **Full walkthrough + demo-video script: `docs/PROOF.md`.**

## Docs

- `docs/PROOF.md` — how the settlement proof works, what to show in a demo video
  (real devnet tx hashes + explorer links included)
- `docs/LEADERBOARD-PLAN.md` — season leaderboard design (planned, not built)
- `keeper/e2e/README.md` — devnet runbook: e2e scripts, lister/monitor, build gotchas
- `keeper/e2e/LISTING-AGENT-PLAN.md` — listing-agent design (now implemented)

## Not in this build (see `../skill files/`)

Market B (player performance / APIfootball), Circle CCTP/Gateway/Paymaster
multichain, order books / position resale, Tier 1/2 cash-out, accumulator / CAR /
Crowd Signal, `.arc` identity. The reference UI already exists at
`../player-perps-ui-mockup.html`.
