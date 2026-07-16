//! Fast settlement path (Solana build spec §5.5).
//!
//! A keeper runs the *entire* deterministic settlement off-chain (median,
//! winners, accuracy weights, gains, payouts — all from public on-chain data)
//! and submits the final numbers. The program does a **cheap** verify pass
//! instead of the full batched compute:
//!   1. recompute every `D_i` from the validated score (one guess per account),
//!   2. check the median order-statistic against those `D_i`,
//!   3. check the conservation invariant `Σ payout + platform_cut == total_pool`.
//! This trusts the keeper's water-fill arithmetic but is fully auditable — any
//! observer can recompute the whole thing and challenge a wrong submission.
//! `remaining_accounts[i]` is the `StakePosition` for `entries[i]`, same order.

use anchor_lang::prelude::*;

use crate::errors::PerpError;
use crate::state::{Fixture, FixtureStatus, StakePosition};

/// One staker's claimed settlement result, submitted by the keeper.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SettlementEntry {
    /// Claimed distance `D` (fixed-point) — must match the on-chain recompute.
    pub distance_d: u64,
    pub is_winner: bool,
    pub accuracy_a: u128,
    pub payout_amount: u64,
}

#[derive(Accounts)]
pub struct SubmitSettlement<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"fixture", &fixture.txline_fixture_id.to_le_bytes()],
        bump = fixture.bump,
        constraint = fixture.authority == authority.key() @ PerpError::AccountMismatch,
    )]
    pub fixture: Account<'info, Fixture>,
    // StakePositions passed as remaining_accounts, aligned 1:1 with `entries`.
}

pub fn submit_settlement<'info>(
    ctx: Context<'_, '_, '_, 'info, SubmitSettlement<'info>>,
    median_d: u64,
    platform_cut: u64,
    entries: Vec<SettlementEntry>,
) -> Result<()> {
    let f = &mut ctx.accounts.fixture;
    require!(f.status == FixtureStatus::ScoreValidated, PerpError::WrongStatus);

    let n = entries.len();
    require!(n == f.staker_count as usize, PerpError::EntryCountMismatch);
    require!(ctx.remaining_accounts.len() == n, PerpError::EntryCountMismatch);

    let dp = f.dist_params.to_engine();
    let (ah, aa) = (f.actual_home, f.actual_away);

    let mut count_below: usize = 0;
    let mut count_equal: usize = 0;
    let mut sum_payout: u128 = 0;

    for (i, acc) in ctx.remaining_accounts.iter().enumerate() {
        let entry = entries[i];

        let mut data = acc.try_borrow_mut_data()?;
        let mut pos = StakePosition::try_deserialize(&mut &data[..])?;
        require_keys_eq!(pos.fixture, f.key(), PerpError::WrongFixture);

        // (1) Recompute D from the validated score — this is the cheap, trustless part.
        let d = engine::distance_a(pos.guess_home, pos.guess_away, ah, aa, &dp);
        require!(d == entry.distance_d, PerpError::DistanceMismatch);

        // Tally the distribution for the median order-statistic check.
        if d < median_d {
            count_below += 1;
        } else if d == median_d {
            count_equal += 1;
        }
        sum_payout = sum_payout.checked_add(entry.payout_amount as u128).ok_or(PerpError::Overflow)?;

        // Write the keeper's claimed result into the position.
        pos.distance_d = d;
        pos.is_winner = entry.is_winner;
        pos.accuracy_a = entry.accuracy_a;
        pos.payout_amount = entry.payout_amount;
        pos.try_serialize(&mut &mut data[..])?;
    }

    // (2) Median order-statistic: k = floor((N+1)/2), and the k-th smallest D
    //     is `median_d` iff below < k <= below + equal.
    let k = (n + 1) / 2;
    require!(count_below < k && k <= count_below + count_equal, PerpError::BadMedian);

    // (3) Conservation: every base unit accounted for.
    let total = sum_payout
        .checked_add(platform_cut as u128)
        .ok_or(PerpError::Overflow)?;
    require!(total == f.total_pool as u128, PerpError::ConservationFailed);

    f.median_d = median_d;
    f.median_verified = true;
    f.platform_cut = platform_cut;
    f.status = FixtureStatus::Settled;
    Ok(())
}
