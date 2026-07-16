//! Trepa median-gate + accuracy-weight settlement — fixed-point port of
//! `settleTrepa` (reference engine, `proximity-markets-simulator-trepa.html:540`).
//!
//! Pipeline (Solana build spec §3, trepa-payout-model §2):
//! 1. Void checks: `N ≤ 1`, or every staker on the exact same `D`.
//! 2. Best-coalition: if `≥ N/2` stakers tie at the minimum `D`, they win as a
//!    group (the median is still computed, and still used for accuracy weights).
//! 3. Median gate: `k = floor((N+1)/2)`, `m` = k-th smallest `D`; winners `D < m`.
//! 4. Accuracy weight: `r = D/m`, `a = (1/(1+r))^gamma`.
//! 5. Pool: losers' stakes × `(1 − take_rate)`.
//! 6. Cap (`stake × cap_multiple`) + water-fill.
//! 7. Payout: `stake + gain` for winners, `0` for losers.
//!
//! All divisions round **down** (favour conservation — never pay out more than
//! the pool holds). Whatever isn't paid out as winner gain becomes
//! `platform_cut`, so `Σ payout + platform_cut == total_pool` holds *exactly*
//! (integer dust and any undistributed residual route to the platform take, per
//! spec §4 / §6). [`SettleResult::conserves`] asserts this.

use crate::SCALE;

/// Per-fixture payout parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PayoutParams {
    /// Accuracy exponent γ (Trepa's confirmed live value is 6).
    pub gamma: u32,
    /// Platform take on losers' stakes, in basis points (2000 = 20%).
    pub take_rate_bps: u16,
    /// Per-winner gain cap as a multiple of their stake (Trepa uses 100×).
    pub cap_multiple: u64,
}

impl PayoutParams {
    /// Spec defaults: `gamma=6, take_rate=20%, cap=100×`.
    pub const fn defaults() -> Self {
        Self { gamma: 6, take_rate_bps: 2000, cap_multiple: 100 }
    }
}

impl Default for PayoutParams {
    fn default() -> Self {
        Self::defaults()
    }
}

/// One staker's input to settlement: how much they staked and their computed `D`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    /// Stake in USDC base units.
    pub stake: u64,
    /// Distance `D`, fixed-point (× [`SCALE`]).
    pub d: u64,
}

/// Why a round was voided (everyone refunded).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    /// Fewer than two stakers.
    FewerThanTwo,
    /// Every staker landed on the exact same `D`.
    AllEqualD,
}

/// Per-staker settlement result, index-aligned with the input slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionOutcome {
    pub is_winner: bool,
    /// Accuracy weight `a`, fixed-point (winners only; `0` otherwise).
    pub a: u128,
    /// Gain in USDC base units (on top of the returned stake).
    pub gain: u64,
    /// Total paid: `stake + gain` for winners, refunded `stake` on void, `0` for losers.
    pub payout: u64,
    /// True if this winner's gain was clamped to their cap during water-fill.
    pub capped: bool,
}

/// Full settlement outcome for a fixture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleResult {
    /// `Some(reason)` if the round is void (everyone refunded via `payout`).
    pub void: Option<VoidReason>,
    pub median_d: u64,
    pub min_d: u64,
    pub count_at_min: u16,
    pub coalition_mode: bool,
    /// Order statistic `k = floor((N+1)/2)`.
    pub k: usize,
    pub losers_stake_sum: u64,
    /// The take-adjusted dividend pool intended for winners (before flooring dust).
    pub dividend_pool: u64,
    /// Platform take — absorbs the nominal take, integer dust, and any
    /// undistributed residual, so conservation holds exactly.
    pub platform_cut: u64,
    /// Residual left when water-fill caps every winner (logged separately, spec §6).
    pub undistributed: u64,
    pub total_pool: u64,
    pub outcomes: Vec<PositionOutcome>,
}

impl SettleResult {
    /// The conservation invariant the on-chain program must check before marking
    /// a fixture `Settled` (Solana build spec §4): every base unit is accounted for.
    pub fn conserves(&self) -> bool {
        let paid: u128 = self.outcomes.iter().map(|o| o.payout as u128).sum();
        paid + self.platform_cut as u128 == self.total_pool as u128
    }
}

/// `a = (1/(1+r))^gamma` in fixed-point — Solana build spec §4. No general
/// `pow()`: `base = SCALE²/(SCALE+r)`, then multiply γ times. Inputs and output
/// are scaled by [`SCALE`].
pub fn accuracy_weight(r: u128, gamma: u32) -> u128 {
    let scale = SCALE as u128;
    // base = 1/(1+r) in fixed-point.
    let base = scale.checked_mul(scale).unwrap() / (scale + r);
    let mut result = scale; // 1.0
    for _ in 0..gamma {
        result = result.checked_mul(base).unwrap() / scale;
    }
    result
}

/// Everyone refunded — used for both void reasons.
fn void_result(positions: &[Position], reason: VoidReason, total_pool: u64) -> SettleResult {
    let outcomes = positions
        .iter()
        .map(|p| PositionOutcome {
            is_winner: false,
            a: 0,
            gain: 0,
            payout: p.stake, // refund
            capped: false,
        })
        .collect();
    SettleResult {
        void: Some(reason),
        median_d: 0,
        min_d: 0,
        count_at_min: 0,
        coalition_mode: false,
        k: 0,
        losers_stake_sum: 0,
        dividend_pool: 0,
        platform_cut: 0,
        undistributed: 0,
        total_pool,
        outcomes,
    }
}

/// Run the full Trepa settlement over a fixture's positions.
pub fn settle(positions: &[Position], params: &PayoutParams) -> SettleResult {
    let n = positions.len();
    let total_pool: u64 = positions.iter().map(|p| p.stake).sum();
    let scale = SCALE as u128;

    // 1. Void checks.
    if n <= 1 {
        return void_result(positions, VoidReason::FewerThanTwo, total_pool);
    }
    let mut ds: Vec<u64> = positions.iter().map(|p| p.d).collect();
    ds.sort_unstable();
    if ds[0] == ds[n - 1] {
        return void_result(positions, VoidReason::AllEqualD, total_pool);
    }

    // 2. Best-coalition check. `count_at_min ≥ N/2` (integer form of the float
    //    comparison in the reference engine).
    let min_d = ds[0];
    let count_at_min = positions.iter().filter(|p| p.d == min_d).count();
    let coalition_mode = count_at_min * 2 >= n;

    // 3. Median gate.
    let k = (n + 1) / 2;
    let median_d = ds[k - 1];

    // Classify winners.
    let mut outcomes: Vec<PositionOutcome> = positions
        .iter()
        .map(|p| {
            let is_winner = if coalition_mode { p.d == min_d } else { p.d < median_d };
            PositionOutcome { is_winner, a: 0, gain: 0, payout: 0, capped: false }
        })
        .collect();

    // 4. Accuracy weights (winners only). Guard `median_d == 0 ⇒ r = 0`.
    for (i, p) in positions.iter().enumerate() {
        if outcomes[i].is_winner {
            let r = if median_d == 0 { 0 } else { (p.d as u128 * scale) / median_d as u128 };
            outcomes[i].a = accuracy_weight(r, params.gamma);
        }
    }

    // 5. Dividend pool from losers' stakes.
    let losers_stake_sum: u64 = positions
        .iter()
        .enumerate()
        .filter(|(i, _)| !outcomes[*i].is_winner)
        .map(|(_, p)| p.stake)
        .sum();
    let dividend_pool =
        ((losers_stake_sum as u128 * (10_000 - params.take_rate_bps as u128)) / 10_000) as u64;

    // 6. Cap + water-fill. `alpha = remaining·SCALE / Σ a_uncapped`; a winner
    //    whose naive share exceeds `stake × cap_multiple` is capped, and the
    //    excess cascades to the rest. Bounded at 10 rounds (spec §5.4 step 8).
    let winners: Vec<usize> = (0..n).filter(|&i| outcomes[i].is_winner).collect();
    let mut capped = vec![false; n];
    let mut remaining: u128 = dividend_pool as u128;
    let mut undistributed: u64 = 0;

    for _round in 0..10 {
        let uncapped: Vec<usize> = winners.iter().copied().filter(|&i| !capped[i]).collect();
        let sum_a: u128 = uncapped.iter().map(|&i| outcomes[i].a).sum();
        if uncapped.is_empty() || sum_a == 0 {
            undistributed = remaining as u64; // every winner capped — residual to platform
            remaining = 0;
            break;
        }
        let alpha = (remaining * scale) / sum_a;
        let mut any_capped = false;
        for &i in &uncapped {
            let naive = (alpha * outcomes[i].a) / scale;
            let cap = positions[i].stake as u128 * params.cap_multiple as u128;
            if naive > cap {
                outcomes[i].gain = cap as u64;
                outcomes[i].capped = true;
                capped[i] = true;
                remaining -= cap;
                any_capped = true;
            }
        }
        if !any_capped {
            for &i in &uncapped {
                outcomes[i].gain = ((alpha * outcomes[i].a) / scale) as u64;
            }
            remaining = 0;
            break;
        }
    }
    // If the loop exhausted its rounds without converging, whatever's left is
    // routed to the platform rather than leaving the fixture stuck (spec §5.4 step 8).
    undistributed = undistributed.max(remaining as u64);

    // 7. Payouts + exact conservation. platform_cut absorbs the nominal take,
    //    integer dust, and any undistributed residual.
    let mut winners_gain_sum: u64 = 0;
    for &i in &winners {
        winners_gain_sum += outcomes[i].gain;
        outcomes[i].payout = positions[i].stake + outcomes[i].gain;
    }
    let platform_cut = losers_stake_sum - winners_gain_sum;

    SettleResult {
        void: None,
        median_d,
        min_d,
        count_at_min: count_at_min as u16,
        coalition_mode,
        k,
        losers_stake_sum,
        dividend_pool,
        platform_cut,
        undistributed,
        total_pool,
        outcomes,
    }
}
