//! On-chain account layouts and the fixture state machine (Solana build spec §5.2/§5.3).

use anchor_lang::prelude::*;

/// Fixture lifecycle. `Void` is reachable from any settlement check.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FixtureStatus {
    Open,
    Locked,
    ScoreValidated,
    DistancesComputed,
    MedianVerified,
    Settled,
    Void,
}

/// Distance parameters, stored on the fixture. Mirrors [`engine::DistParams`];
/// weights are fixed-point (× `engine::SCALE`), caps are integer goals.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct DistParams {
    pub p: u64,
    pub w_gd: u64,
    pub w_tg: u64,
    pub w_cs: u64,
    pub cap_gd: u8,
    pub cap_tg: u8,
}

impl DistParams {
    pub const SIZE: usize = 8 * 4 + 1 * 2;
    /// Convert to the engine's type so both the program and keeper share one formula.
    pub fn to_engine(&self) -> engine::DistParams {
        engine::DistParams {
            p: self.p,
            w_gd: self.w_gd,
            w_tg: self.w_tg,
            w_cs: self.w_cs,
            cap_gd: self.cap_gd,
            cap_tg: self.cap_tg,
        }
    }
    pub fn defaults() -> Self {
        let e = engine::DistParams::defaults();
        Self { p: e.p, w_gd: e.w_gd, w_tg: e.w_tg, w_cs: e.w_cs, cap_gd: e.cap_gd, cap_tg: e.cap_tg }
    }
}

/// Payout parameters, stored on the fixture. Mirrors [`engine::PayoutParams`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PayoutParams {
    pub gamma: u32,
    pub take_rate_bps: u16,
    pub cap_multiple: u64,
}

impl PayoutParams {
    pub const SIZE: usize = 4 + 2 + 8;
    pub fn to_engine(&self) -> engine::PayoutParams {
        engine::PayoutParams {
            gamma: self.gamma,
            take_rate_bps: self.take_rate_bps,
            cap_multiple: self.cap_multiple,
        }
    }
    pub fn defaults() -> Self {
        let e = engine::PayoutParams::defaults();
        Self { gamma: e.gamma, take_rate_bps: e.take_rate_bps, cap_multiple: e.cap_multiple }
    }
}

/// One fixture (one football match's market). PDA: `["fixture", txline_fixture_id]`.
#[account]
pub struct Fixture {
    pub txline_fixture_id: u64,
    /// Kickoff (staking-close), from TxLine's Kickoff message. Unix seconds.
    pub lock_time: i64,
    pub status: FixtureStatus,
    pub dist_params: DistParams,
    pub payout_params: PayoutParams,
    pub actual_home: u8,
    pub actual_away: u8,
    pub total_pool: u64,
    pub staker_count: u16,
    /// USDC mint used for this fixture's escrow.
    pub usdc_mint: Pubkey,
    /// Escrow token account (owned by this fixture PDA).
    pub escrow: Pubkey,
    /// Authority allowed to run the keeper/pipeline instructions.
    pub authority: Pubkey,
    pub bump: u8,

    // ---- settlement-pipeline accumulators (all 0 at init) ----
    pub distances_computed_count: u16,
    pub running_min_d: u64,
    pub running_max_d: u64,
    pub running_count_at_min: u16,
    pub median_candidate: u64,
    pub median_count_below: u16,
    pub median_count_equal: u16,
    pub median_verify_count: u16,
    pub median_d: u64,
    pub median_verified: bool,
    pub coalition_mode: bool,
    pub winners_processed_count: u16,
    pub sum_a: u128,
    pub losers_stake_sum: u64,
    pub dividend_pool: u64,
    pub platform_cut: u64,
    pub waterfill_round: u8,
    pub capped_gain_sum: u64,
    pub capped_a_sum: u128,
    pub payouts_finalized_count: u16,
    pub undistributed: u64,
}

impl Fixture {
    /// 8 discriminator + fields. Generously padded; tighten before mainnet.
    pub const SIZE: usize = 8
        + 8            // txline_fixture_id
        + 8            // lock_time
        + 1            // status
        + DistParams::SIZE
        + PayoutParams::SIZE
        + 1 + 1        // actual_home/away
        + 8            // total_pool
        + 2            // staker_count
        + 32 * 3       // usdc_mint, escrow, authority
        + 1            // bump
        + 2 + 8 + 8 + 2 // distances_computed_count, running_min/max_d, count_at_min
        + 8 + 2 + 2 + 2 + 8 + 1 + 1 // median_candidate, counts, verify_count, median_d, verified, coalition
        + 2 + 16 + 8 + 8 + 8 // winners_processed, sum_a, losers_stake, dividend_pool, platform_cut
        + 1 + 8 + 16 + 2 + 8; // waterfill_round, capped_gain_sum, capped_a_sum, payouts_finalized, undistributed
}

/// One staker's position. PDA: `["stake", txline_fixture_id, staker]` — the
/// derivation enforces exactly one guess per staker per fixture.
#[account]
pub struct StakePosition {
    pub fixture: Pubkey,
    pub staker: Pubkey,
    pub guess_home: u8,
    pub guess_away: u8,
    pub stake_amount: u64,
    /// Distance `D`, fixed-point — filled in phase 2 (compute_distances / verify).
    pub distance_d: u64,
    pub is_winner: bool,
    /// Accuracy weight `a`, fixed-point — filled for winners in phase 4.
    pub accuracy_a: u128,
    pub capped: bool,
    /// Final payout — filled in phase 5 (or the fast path).
    pub payout_amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

impl StakePosition {
    pub const SIZE: usize = 8
        + 32 + 32      // fixture, staker
        + 1 + 1        // guess_home/away
        + 8            // stake_amount
        + 8            // distance_d
        + 1            // is_winner
        + 16           // accuracy_a
        + 1            // capped
        + 8            // payout_amount
        + 1            // claimed
        + 1; // bump
}
